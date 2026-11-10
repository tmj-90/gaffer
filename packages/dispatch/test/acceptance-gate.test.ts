import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createHash } from "node:crypto";

import { computeStats, contractHash, renderStats } from "../src/cli/ops.js";
import { Dispatch } from "../src/core.js";
import { migrate } from "../src/db/connection.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";
import type { Actor } from "../src/domain/types.js";
import { ACCEPTANCE_CRITERIA } from "../src/services/epicsService.js";
import { TestClock } from "../src/util/clock.js";
import type { GitRunner } from "../src/services/diffService.js";
import { FAKE_HEAD, giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

/**
 * ACCEPTANCE GATE — "implementation tickets merged" is not "build accepted".
 *
 * A live run delivered 13/13 tickets, every one approved and judged 4+/5, and the
 * finished application still failed a brief-level check (20 concurrent writes →
 * 8 × HTTP 500). These tests pin the gate that makes that outcome visible:
 *   1. every epic gets a factory-created acceptance ticket — dependent on every
 *      implementation ticket, testable, with a contract and the cross-cutting criteria;
 *      `epic.acceptance:false` opts out; the brief rides on it as the contract;
 *   2. an acceptance ticket is ALWAYS tested, GAFFER_TESTING off or on: TESTER FIRST, the
 *      runner sends it to the tester before a person reviews it (a person's approval of
 *      an untested commit is refused), while an ordinary ticket with the lane off still
 *      goes straight from approval to ready_for_merge;
 *   3. the regression fixture: an implementation whose ticket tests all pass, whose
 *      acceptance the tester FAILS → stats report the build as failed / not accepted,
 *      never "all clear"; a tester PASS → accepted;
 *   4. the v25→v26 migration adds `acceptance` (default 0) to an existing tickets table.
 */
const human: Actor = { type: "human", id: "tom" };
const reviewer: Actor = { type: "human", id: "rev" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };
const testerAgent: Actor = { type: "agent", id: "tester-1" };
const systemActor: Actor = { type: "system" };

/** The delivery head the stub git reports (a re-delivery moves it). */
const head = { sha: FAKE_HEAD };
const movableHeadRunner: GitRunner = (cwd, args) => {
  const last = String(args[args.length - 1] ?? "");
  if (args[0] === "rev-parse" && /^refs\/heads\/.+\^\{commit\}$/.test(last)) {
    return { status: 0, stdout: `${head.sha}\n`, stderr: "" };
  }
  return nonEmptyDiffRunner(cwd, args);
};

function freshWg(opts: { testingEnabled?: boolean } = {}): Dispatch {
  head.sha = FAKE_HEAD;
  return Dispatch.open(":memory:", new TestClock(), movableHeadRunner, {
    ...(opts.testingEnabled !== undefined ? { testingEnabled: opts.testingEnabled } : {}),
  });
}

/** Claim → deliver → submit a READY ticket so it sits in_review with a real diff. */
function deliverToReview(wg: Dispatch, ticketId: string, agentId: string): void {
  const claim = wg.claimTicket(
    { ticket_id: ticketId, agent_id: agentId, ttl_seconds: 300 },
    agentActor,
  );
  giveTicketRealDelivery(wg, ticketId, human, { repoName: `delivery-${ticketId}` });
  wg.recordDeliveryArtifact(
    { claim_token: claim.claimToken, ticket_id: ticketId, branch_name: "feat/x" },
    agentActor,
  );
  wg.submitForReview({ claimToken: claim.claimToken, ticket_id: ticketId }, agentActor);
  expect(wg.view(ticketId).ticket.status).toBe("in_review");
}

function planWithTwoTickets(wg: Dispatch, extra: Record<string, unknown> = {}) {
  wg.registerRepository({ name: "app", default_branch: "main" }, human);
  return wg.createEpic(
    {
      epic: { name: "Bookmark Vault", description: "a bookmark manager", ...extra },
      tickets: [
        { title: "Store", acceptanceCriteria: ["atomic writes"], repo: "app" },
        { title: "HTTP API", acceptanceCriteria: ["routes"], repo: "app", dependsOn: [0] },
      ],
    },
    human,
  );
}

/** The commit the tester tested: the delivery head (an approval needs its PASS on it). */
const SHA = FAKE_HEAD;
/** The revision that LANDED (the gated merge of SHA onto the default branch). */
const LANDED = "89abcdef0123456789abcdef0123456789abcdef";

/**
 * TESTER REPLAY: the runner's landing path records that the tester's assertions passed on
 * the landed revision (system only). Recorded against the ticket's delivery repo, whose
 * stub git (nonEmptyDiffRunner) reports every commit on the default branch — the real check
 * is in tester-replay-record.test.ts.
 */
function recordReplay(wg: Dispatch, ticketId: string, tested = SHA, landed = LANDED) {
  return wg.recordTesterReplay(
    ticketId,
    {
      commit: landed,
      pin: tested,
      files: ["test/bb-acceptance.test.js"],
      repo: `delivery-${ticketId}`,
      via: "local",
    },
    systemActor,
  );
}

/** The binding the runner's tester records on an automated PASS (see tester-run.mjs). */
function boundPass(wg: Dispatch, ticketId: string) {
  return {
    summary: "acceptance suite 16/16",
    tested_commit: SHA,
    contract_hash: contractHash(wg.db, ticketId)!,
    replay: "passed",
  };
}

/** TESTER FIRST: the runner sends the in_review ticket to the tester before review. */
function toTester(wg: Dispatch, ticketId: string): void {
  const [r] = wg.routeToTester(ticketId, systemActor);
  expect(r!.routed).toBe(true);
  expect(wg.view(ticketId).ticket.status).toBe("in_testing");
}

/** After the tester's PASS returned it to review, a person approves the tested commit. */
function approveTested(wg: Dispatch, ticketId: string): void {
  expect(wg.view(ticketId).ticket.status).toBe("in_review");
  expect(wg.approveReview(ticketId, reviewer).ticket.status).toBe("ready_for_merge");
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect((err as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

/** Drive a two-ticket epic to the point where its acceptance ticket sits in_review. */
function epicToReviewWith(wg: Dispatch, extra: Record<string, unknown> = {}) {
  const res = planWithTwoTickets(wg, extra);
  const agent = wg.registerAgent({ display_name: "a" }, human);
  const [n1, n2, nAcc] = res.ticketNumbers as [number, number, number];
  const id = (n: number) => wg.view(String(n)).ticket.id;
  for (const n of [n1, n2]) {
    wg.markReady(id(n), human);
    deliverToReview(wg, id(n), agent.id);
    wg.approveReview(id(n), reviewer);
    wg.markMerged(id(n), systemActor);
    expect(wg.view(id(n)).ticket.status).toBe("done");
  }
  wg.markReady(id(nAcc), human);
  deliverToReview(wg, id(nAcc), agent.id);
  return { accId: id(nAcc), implIds: [id(n1), id(n2)] };
}

describe("acceptance gate: every epic gets a factory-created acceptance ticket", () => {
  it("appends the acceptance ticket last: testable, contract, criteria, behind every implementation ticket", () => {
    const wg = freshWg();
    const res = planWithTwoTickets(wg, {
      brief: "Bookmark Vault: a local-first bookmark manager …",
    });
    expect(res.ticketNumbers).toHaveLength(3);
    expect(res.acceptanceTicketNumber).toBe(res.ticketNumbers[2]);
    const acc = wg.view(String(res.acceptanceTicketNumber)).ticket;
    expect(acc.acceptance).toBe(1);
    expect(acc.can_be_tested).toBe(1);
    expect(acc.title).toBe("Acceptance: Bookmark Vault");
    expect(acc.description).toContain("Brief (the contract):\nBookmark Vault: a local-first");
    expect(acc.test_contract).toBeTruthy();
    expect(JSON.parse(acc.test_contract!).changed_surfaces[0]).toContain("the whole build");
    const acs = wg.view(acc.id).acceptanceCriteria.map((a) => a.text);
    expect(acs).toEqual([...ACCEPTANCE_CRITERIA]);
    expect(acs.join(" ")).toMatch(/Concurrent writers/);
    expect(acs.join(" ")).toMatch(/Persistence/);
    // Depends on EVERY implementation ticket (not just the last one).
    const deps = wg
      .listDependencies(acc.id)
      .map((d) => d.number)
      .sort();
    expect(deps).toEqual([res.ticketNumbers[0], res.ticketNumbers[1]].sort());
    // Linked to the plan's repo like its siblings; contained by the epic.
    expect(wg.view(acc.id).repositories.map((r) => r.name)).toContain("app");
    // Implementation tickets are not acceptance tickets. Under the `auto` lane default they
    // are testable (eligible): the tester runs where their repo has a test command.
    const store = wg.view(String(res.ticketNumbers[0])).ticket;
    expect(store.acceptance).toBe(0);
    expect(store.can_be_tested).toBe(1);
  });

  it("epic.acceptance:false opts out; the epic description is the contract when no brief is given", () => {
    const wg = freshWg();
    const off = planWithTwoTickets(wg, { acceptance: false });
    expect(off.ticketNumbers).toHaveLength(2);
    expect(off.acceptanceTicketNumber).toBeNull();
    const wg2 = freshWg();
    const on = planWithTwoTickets(wg2);
    const acc = wg2.view(String(on.acceptanceTicketNumber)).ticket;
    expect(acc.description).toContain("Brief (the contract):\na bookmark manager");
  });

  it("a greenfield plan (repo not registered yet) defers the acceptance ticket's link too and carries the repo name on source", () => {
    const wg = freshWg();
    const res = wg.createEpic(
      {
        epic: { name: "New App" },
        tickets: [
          {
            title: "Bootstrap newapp",
            acceptanceCriteria: ["scaffold"],
            repo: "newapp",
            bootstrap: true,
          },
          { title: "Feature", acceptanceCriteria: ["works"], repo: "newapp", dependsOn: [0] },
        ],
      },
      human,
    );
    expect(res.deferredRepoLinks).toBe(3);
    const acc = wg.view(String(res.acceptanceTicketNumber)).ticket;
    expect(acc.source).toBe("newapp");
    expect(acc.bootstrap).toBe(0);
  });
});

describe("acceptance gate: an acceptance ticket always goes to the tester (before review)", () => {
  function epicToReview(wg: Dispatch) {
    return epicToReviewWith(wg);
  }

  it("GAFFER_TESTING OFF: an ordinary testable ticket goes to ready_for_merge, the acceptance ticket goes to in_testing", () => {
    const wg = freshWg({ testingEnabled: false });
    const { accId } = epicToReview(wg);
    // A person cannot approve it untested; the runner sends it to the tester first.
    expectCode(() => wg.approveReview(accId, reviewer), "STATE_CONFLICT");
    toTester(wg, accId);
    const ev = wg.view(accId).events.find((e) => e.event_type === "ticket.routed_to_testing");
    if (!ev || typeof ev.payload_json !== "string") {
      throw new Error("expected a ticket.routed_to_testing event with a JSON payload");
    }
    expect(JSON.parse(ev.payload_json).acceptance).toBe(true);
    // Control: a plain testable ticket with the toggle off still skips the lane (unchanged).
    const t = wg.createTicket(
      { title: "plain", policy_pack: "solo_loose", risk_level: "low" },
      human,
    );
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human);
    wg.setTestable(t.id, true, human);
    wg.markReady(t.id, human);
    const agent = wg.registerAgent({ display_name: "b" }, human);
    deliverToReview(wg, t.id, agent.id);
    expect(wg.approveReview(t.id, reviewer).ticket.status).toBe("ready_for_merge");
  });

  it("REGRESSION FIXTURE: implementation all merged, tester FAILS the acceptance → the build reads failed / not accepted, never all clear", () => {
    const wg = freshWg({ testingEnabled: false });
    const { accId } = epicToReview(wg);
    toTester(wg, accId);
    // Stats BEFORE the verdict: the build is in acceptance testing and counted as unaccepted.
    let a = computeStats(wg.db).acceptance;
    expect(a.epics).toHaveLength(1);
    expect(a.epics[0]!.implementation_done).toBe(2);
    expect(a.epics[0]!.implementation_total).toBe(2);
    expect(a.epics[0]!.result).toBe("testing");
    expect(a.unaccepted).toBe(1);
    // The independent tester finds the brief-level defect the ticket tests missed.
    const fail = wg.testerFail(
      accId,
      {
        summary:
          "20 concurrent POST /bookmarks: 8 × HTTP 500, 12 stored — acknowledged writes are not all durable",
      },
      testerAgent,
    );
    expect(fail.ticket.status).toBe("refining");
    a = computeStats(wg.db).acceptance;
    expect(a.epics[0]!.result).toBe("failed");
    expect(a.failed).toBe(1);
    expect(a.unaccepted).toBe(1);
    expect(a.accepted).toBe(0);
  });

  it("UNPROVABLE (H3): an acceptance ticket the tester held as tester_unprovable keeps the build NOT accepted", () => {
    const wg = freshWg({ testingEnabled: false });
    const { accId } = epicToReview(wg);
    toTester(wg, accId);
    wg.recordLaneVerdict(
      accId,
      {
        lane: "tester",
        verdict: "held",
        commit: SHA,
        held_reason: "criteria 1: no browser on this host",
        held_code: "tester_unprovable",
        criteria: [1],
      },
      systemActor,
    );
    const stats = computeStats(wg.db);
    expect(wg.view(accId).ticket.status).toBe("in_testing");
    expect(stats.acceptance.epics[0]!.result).toBe("testing");
    expect(stats.acceptance.accepted).toBe(0);
    expect(stats.acceptance.unaccepted).toBe(1);
    expect(stats.testerHolds?.held.map((h) => h.code)).toEqual(["tester_unprovable"]);
  });

  it("an automated PASS on an acceptance ticket WITHOUT a binding is refused (BINDING_REQUIRED) — it cannot become verified", () => {
    const wg = freshWg({ testingEnabled: false });
    const { accId } = epicToReview(wg);
    toTester(wg, accId);
    for (const input of [
      { summary: "acceptance suite 13/13" },
      { summary: "no hash", tested_commit: SHA },
      { summary: "no replay", tested_commit: SHA, contract_hash: contractHash(wg.db, accId)! },
      {
        summary: "replay failed",
        tested_commit: SHA,
        contract_hash: contractHash(wg.db, accId)!,
        replay: "failed",
      },
    ]) {
      expectCode(() => wg.testerPass(accId, input, testerAgent), "BINDING_REQUIRED");
    }
    expect(wg.view(accId).ticket.status).toBe("in_testing");
  });

  it("a bound PASS (commit + current contract + clean replay) whose assertions passed on the LANDED revision → done reads accepted (verified) and leaves the attention count", () => {
    const wg = freshWg({ testingEnabled: false });
    const { accId } = epicToReview(wg);
    toTester(wg, accId);
    const pass = wg.testerPass(accId, boundPass(wg, accId), testerAgent);
    expect(pass.ticket.status).toBe("in_review");
    approveTested(wg, accId);
    expect(recordReplay(wg, accId).recorded).toBe(true);
    wg.markMerged(accId, systemActor);
    const a = computeStats(wg.db).acceptance;
    expect(a.epics[0]!.result).toBe("accepted");
    expect(a.epics[0]!.accepted_commit).toBe(SHA);
    expect(a.epics[0]!.replay).toBe("passed");
    expect(a.epics[0]!.replayed_commit).toBe(LANDED);
    expect(a.epics[0]!.replayed_files).toEqual(["test/bb-acceptance.test.js"]);
    expect(a.accepted).toBe(1);
    expect(a.unaccepted).toBe(0);
  });

  it("TESTER REPLAY: a bound PASS that landed with NO record of its assertions passing on the landed revision reads unreplayed — never accepted", () => {
    const wg = freshWg({ testingEnabled: false });
    const { accId } = epicToReview(wg);
    toTester(wg, accId);
    wg.testerPass(accId, boundPass(wg, accId), testerAgent);
    approveTested(wg, accId);
    wg.markMerged(accId, systemActor);
    const a = computeStats(wg.db).acceptance;
    expect(a.epics[0]!.result).toBe("unreplayed");
    expect(a.epics[0]!.replayed_commit).toBeNull();
    expect(a.unreplayed).toBe(1);
    expect(a.accepted).toBe(0);
    expect(a.unaccepted).toBe(1);
  });

  it("TESTER REPLAY: a landing that replayed NO tester test file (stale or empty tests branch, or a PASS that saved none) reads unreplayed — zero assertions on what landed is not accepted", () => {
    const wg = freshWg({ testingEnabled: false });
    const { accId } = epicToReview(wg);
    toTester(wg, accId);
    wg.testerPass(accId, { ...boundPass(wg, accId), tests_commit: "none" }, testerAgent);
    approveTested(wg, accId);
    expect(
      wg.recordTesterReplay(
        accId,
        {
          commit: LANDED,
          pin: SHA,
          files: [],
          repo: `delivery-${accId}`,
          via: "local",
          note: "refs/heads/gaffer-tests/ticket-3 does not descend from the tested commit",
        },
        systemActor,
      ).recorded,
    ).toBe(true);
    wg.markMerged(accId, systemActor);
    const a = computeStats(wg.db).acceptance;
    expect(a.epics[0]!.result).toBe("unreplayed");
    expect(a.epics[0]!.replayed_commit).toBe(LANDED);
    expect(a.epics[0]!.replayed_files).toEqual([]);
    expect(a.accepted).toBe(0);
    expect(a.unreplayed).toBe(1);
    expect(a.unaccepted).toBe(1);
    expect(renderStats(computeStats(wg.db))).toContain("with NO tester test file replayed");
  });

  it("TESTER REPLAY: the PASS's tests_commit binding is validated (a sha or none)", () => {
    const wg = freshWg({ testingEnabled: false });
    const { accId } = epicToReview(wg);
    toTester(wg, accId);
    expectCode(
      () => wg.testerPass(accId, { ...boundPass(wg, accId), tests_commit: "HEAD" }, testerAgent),
      "VALIDATION_ERROR",
    );
    wg.testerPass(accId, { ...boundPass(wg, accId), tests_commit: LANDED }, testerAgent);
    const row = wg.db
      .prepare(
        "SELECT payload_json FROM evidence WHERE ticket_id = ? AND evidence_type = 'test_output' ORDER BY rowid DESC LIMIT 1",
      )
      .get(accId) as { payload_json: string };
    expect(JSON.parse(row.payload_json).tests_commit).toBe(LANDED);
  });

  it("TESTER REPLAY: a generic SYSTEM evidence row cannot carry the record's uri (attach-evidence)", () => {
    const wg = freshWg({ testingEnabled: false });
    const { accId } = epicToReview(wg);
    expectCode(
      () =>
        wg.attachDeliveryEvidence(
          accId,
          { evidenceType: "commit", summary: "x", uri: `gaffer-tester-replayed:${LANDED}` },
          systemActor,
        ),
      "VALIDATION_ERROR",
    );
  });

  it("TESTER REPLAY: a row shaped like the record but recorded by an agent does not count the epic", () => {
    const wg = freshWg({ testingEnabled: false });
    const { accId } = epicToReview(wg);
    toTester(wg, accId);
    wg.testerPass(accId, boundPass(wg, accId), testerAgent);
    approveTested(wg, accId);
    wg.db
      .prepare(
        "INSERT INTO evidence (id, ticket_id, evidence_type, summary, uri, payload_json, created_by, recorded_by_actor_type, created_at) VALUES ('forged', ?, 'commit', 'forged', ?, ?, 'agent-runner', 'agent', '2099-01-01T00:00:00.000Z')",
      )
      .run(
        accId,
        `gaffer-tester-replayed:${LANDED}`,
        JSON.stringify({ kind: "tester_replay", tested: SHA, pin: SHA, files: [] }),
      );
    wg.markMerged(accId, systemActor);
    const a = computeStats(wg.db).acceptance;
    expect(a.epics[0]!.result).toBe("unreplayed");
    expect(a.accepted).toBe(0);
  });

  it("TESTER REPLAY: a held replay keeps the epic out; a repaired retry that lands counts it exactly once", () => {
    const wg = freshWg({ testingEnabled: false });
    const { accId } = epicToReview(wg);
    toTester(wg, accId);
    wg.testerPass(accId, boundPass(wg, accId), testerAgent);
    approveTested(wg, accId);
    // The landing replayed the tester's assertion on the merge candidate and it FAILED:
    // held for a human, nothing recorded, the epic is not accepted.
    wg.holdForHuman(
      accId,
      {
        reasonCode: "tester_replay_red",
        reason: "the independent tester's tests (test/bb-label.test.js) fail on the merge",
      },
      systemActor,
    );
    let a = computeStats(wg.db).acceptance;
    expect(wg.view(accId).ticket.status).toBe("blocked");
    expect(a.epics[0]!.result).toBe("failed");
    expect(a.accepted).toBe(0);
    expect(a.unaccepted).toBe(1);
    // The repair: back to ready, re-delivered, re-approved, re-tested on the new commit.
    const REPAIRED = "fedcba9876543210fedcba9876543210fedcba98";
    const LANDED2 = "1111111111111111111111111111111111111111";
    wg.moveTicket(accId, "ready", human);
    const agent2 = wg.registerAgent({ display_name: "b" }, human);
    // Re-delivered on the same branch (its delivery repo is already linked).
    const claim = wg.claimTicket(
      { ticket_id: accId, agent_id: agent2.id, ttl_seconds: 300 },
      agentActor,
    );
    wg.recordDeliveryArtifact(
      { claim_token: claim.claimToken, ticket_id: accId, branch_name: "feat/x" },
      agentActor,
    );
    wg.submitForReview({ claimToken: claim.claimToken, ticket_id: accId }, agentActor);
    expect(wg.view(accId).ticket.status).toBe("in_review");
    head.sha = REPAIRED; // the re-delivery's commit is the head now
    toTester(wg, accId);
    wg.testerPass(accId, { ...boundPass(wg, accId), tested_commit: REPAIRED }, testerAgent);
    approveTested(wg, accId);
    // A record of the EARLIER tested commit does not describe this PASS.
    wg.db
      .prepare(
        "INSERT INTO evidence (id, ticket_id, evidence_type, summary, uri, payload_json, created_by, recorded_by_actor_type, created_at) VALUES ('old-replay', ?, 'commit', 'old', ?, ?, 'dispatch', 'system', '2000-01-01T00:00:00.000Z')",
      )
      .run(
        accId,
        `gaffer-tester-replayed:${LANDED}`,
        JSON.stringify({ kind: "tester_replay", tested: SHA, pin: SHA, files: [] }),
      );
    expect(() => recordReplay(wg, accId, SHA, LANDED2)).toThrow(/no tester PASS bound/);
    expect(recordReplay(wg, accId, REPAIRED, LANDED2).recorded).toBe(true);
    wg.markMerged(accId, systemActor);
    a = computeStats(wg.db).acceptance;
    expect(a.epics).toHaveLength(1);
    expect(a.epics[0]!.result).toBe("accepted");
    expect(a.epics[0]!.accepted_commit).toBe(REPAIRED);
    expect(a.epics[0]!.replayed_commit).toBe(LANDED2);
    expect(a.accepted).toBe(1);
    expect(a.unaccepted).toBe(0);
  });

  it("a HUMAN tester-pass is a waiver: allowed without a binding, reported as waived — never as verified", () => {
    const wg = freshWg({ testingEnabled: false });
    const { accId } = epicToReview(wg);
    toTester(wg, accId);
    wg.testerPass(accId, { summary: "waived: acceptance reviewed by hand" }, human);
    approveTested(wg, accId);
    wg.markMerged(accId, systemActor);
    const a = computeStats(wg.db).acceptance;
    expect(a.epics[0]!.result).toBe("waived");
    expect(a.epics[0]!.pass_provenance).toBe("human");
    expect(a.waived).toBe(1);
    expect(a.accepted).toBe(0);
    expect(a.unaccepted).toBe(0); // an explicit human decision is not pending attention
  });

  it("a done acceptance ticket with NO PASS evidence (or a legacy unbound one) reads unverified and needs attention", () => {
    const wg = freshWg({ testingEnabled: false });
    const { accId } = epicToReview(wg);
    toTester(wg, accId);
    // Simulate a legacy row: a PASS recorded before bindings existed, then merged.
    wg.db
      .prepare(
        "INSERT INTO evidence (id, ticket_id, evidence_type, summary, payload_json, created_by, recorded_by_actor_type, created_at) VALUES (?, ?, 'test_output', 'legacy pass', ?, 'tester-1', 'agent', ?)",
      )
      .run(
        "legacy-ev",
        accId,
        JSON.stringify({ verdict: "pass", provenance: "agent" }),
        "2099-01-01T00:00:00.000Z",
      );
    wg.db.prepare("UPDATE tickets SET status = 'done' WHERE id = ?").run(accId);
    const a = computeStats(wg.db).acceptance;
    expect(a.epics[0]!.result).toBe("unverified");
    expect(a.unverified).toBe(1);
    expect(a.unaccepted).toBe(1);
  });
});

describe("acceptance gate: a tester PASS binds TEST IDENTITIES (external review 10)", () => {
  const ID_SMOKE = { file: "test/bb-acceptance.test.js", name: "smoke", line: 3, column: 1 };
  const ID_V2 = { file: "test/bb-acceptance.test.js", name: "api > v2 name", line: 5, column: 3 };
  const reachTester = (wg: Dispatch) => {
    const { accId } = epicToReviewWith(wg);
    toTester(wg, accId);
    return accId;
  };
  const withIds = (wg: Dispatch, accId: string, tests: unknown = [ID_SMOKE, ID_V2]) => ({
    ...boundPass(wg, accId),
    tests_commit: LANDED,
    tests,
  });
  const record = (wg: Dispatch, accId: string, tests: unknown, evidence?: string) =>
    wg.recordTesterReplay(
      accId,
      {
        commit: LANDED,
        pin: SHA,
        files: ["test/bb-acceptance.test.js"],
        tests,
        ...(evidence ? { evidence } : {}),
        repo: `delivery-${accId}`,
        via: "local",
      },
      systemActor,
    );

  it("only the system actor records the identities: an agent, a person or an admin is refused and nothing is written", () => {
    const wg = freshWg({ testingEnabled: false });
    const accId = reachTester(wg);
    for (const actor of [testerAgent, human, { type: "admin", id: "root" } as Actor]) {
      expectCode(() => wg.testerPass(accId, withIds(wg, accId), actor), "ACTOR_NOT_PERMITTED");
    }
    expect(wg.view(accId).ticket.status).toBe("in_testing");
    const pass = wg.testerPass(accId, withIds(wg, accId), systemActor);
    expect(pass.ticket.status).toBe("in_review");
    const row = wg.db
      .prepare(
        "SELECT payload_json FROM evidence WHERE ticket_id = ? AND evidence_type = 'test_output' ORDER BY rowid DESC LIMIT 1",
      )
      .get(accId) as { payload_json: string };
    expect(JSON.parse(row.payload_json).tests).toEqual([ID_SMOKE, ID_V2]);
  });

  it("a system PASS names WHO TESTED: the tester agent and its run ride on the binding, and only the system actor sets them", () => {
    const wg = freshWg({ testingEnabled: false });
    const accId = reachTester(wg);
    const who = { id: "tester", run: "run-123" };
    for (const actor of [testerAgent, human, { type: "admin", id: "root" } as Actor]) {
      expectCode(
        () => wg.testerPass(accId, { ...boundPass(wg, accId), tester_agent: who }, actor),
        "ACTOR_NOT_PERMITTED",
      );
    }
    for (const bad of ["tester", { id: "" }, { id: "a b" }, { id: "tester", run: "x\ny" }]) {
      expectCode(
        () => wg.testerPass(accId, { ...withIds(wg, accId), tester_agent: bad }, systemActor),
        "VALIDATION_ERROR",
      );
    }
    expect(wg.view(accId).ticket.status).toBe("in_testing");
    wg.testerPass(accId, { ...withIds(wg, accId), tester_agent: who }, systemActor);
    const row = wg.db
      .prepare(
        "SELECT payload_json FROM evidence WHERE ticket_id = ? AND evidence_type = 'test_output' ORDER BY rowid DESC LIMIT 1",
      )
      .get(accId) as { payload_json: string };
    const p = JSON.parse(row.payload_json);
    expect(p.provenance).toBe("system");
    expect(p.tester_agent).toEqual(who);
  });

  it("the identities are validated: not a list, an entry without a name, or identities without a tests commit", () => {
    const wg = freshWg({ testingEnabled: false });
    const accId = reachTester(wg);
    for (const bad of ["x", [{ file: "a" }], [{ file: "a", name: "b", line: -1 }], [null]]) {
      expectCode(
        () => wg.testerPass(accId, withIds(wg, accId, bad), systemActor),
        "VALIDATION_ERROR",
      );
    }
    expectCode(
      () =>
        wg.testerPass(
          accId,
          { ...boundPass(wg, accId), tests_commit: "none", tests: [ID_SMOKE] },
          systemActor,
        ),
      "VALIDATION_ERROR",
    );
    expect(wg.view(accId).ticket.status).toBe("in_testing");
  });

  it("a replay record that does not prove EVERY bound identity is refused (a hold never becomes a green); one that does counts the epic as accepted", () => {
    const wg = freshWg({ testingEnabled: false });
    const accId = reachTester(wg);
    wg.testerPass(accId, withIds(wg, accId), systemActor);
    approveTested(wg, accId);
    // A renamed / skipped / missing bound test: the runner's proof lacks it.
    expectCode(() => record(wg, accId, [ID_SMOKE], "identities"), "STATE_CONFLICT");
    // An extra passing test does not stand in for the missing one.
    expectCode(
      () => record(wg, accId, [ID_SMOKE, { ...ID_V2, name: "api > v3 name" }], "identities"),
      "STATE_CONFLICT",
    );
    // The same name at another call site is another test.
    expectCode(
      () => record(wg, accId, [ID_SMOKE, { ...ID_V2, line: 9 }], "identities"),
      "STATE_CONFLICT",
    );
    // The runner claiming file-level evidence for a PASS that bound identities: refused.
    expectCode(() => record(wg, accId, [ID_SMOKE, ID_V2], "files"), "STATE_CONFLICT");
    expect(computeStats(wg.db).acceptance.epics[0]!.replayed_commit).toBeNull();
    const ok = record(wg, accId, [ID_SMOKE, ID_V2], "identities");
    expect(ok.recorded).toBe(true);
    expect(ok.evidence).toBe("identities");
    wg.markMerged(accId, systemActor);
    const e = computeStats(wg.db).acceptance.epics[0]!;
    expect(e.result).toBe("accepted");
    expect(e.replay_evidence).toBe("identities");
    expect(e.replayed_tests).toBe(2);
  });

  it("a PASS that bound NO identity in its files never counts the epic as accepted", () => {
    const wg = freshWg({ testingEnabled: false });
    const accId = reachTester(wg);
    wg.testerPass(accId, withIds(wg, accId, []), systemActor);
    approveTested(wg, accId);
    expect(record(wg, accId, [], "identities").recorded).toBe(true);
    wg.markMerged(accId, systemActor);
    expect(computeStats(wg.db).acceptance.epics[0]!.result).toBe("unreplayed");
  });

  it("an older PASS without identities keeps the file-level rule, recorded and shown as file-level evidence only", () => {
    const wg = freshWg({ testingEnabled: false });
    const accId = reachTester(wg);
    wg.testerPass(accId, { ...boundPass(wg, accId), tests_commit: LANDED }, testerAgent);
    approveTested(wg, accId);
    expectCode(() => record(wg, accId, [ID_SMOKE], "identities"), "STATE_CONFLICT");
    const r = record(wg, accId, [ID_SMOKE], "files");
    expect(r.recorded).toBe(true);
    expect(r.evidence).toBe("files");
    const row = wg.db
      .prepare(
        "SELECT summary, payload_json FROM evidence WHERE ticket_id = ? AND uri LIKE 'gaffer-tester-replayed:%'",
      )
      .get(accId) as { summary: string; payload_json: string };
    expect(row.summary).toMatch(/file-level evidence only/);
    expect(JSON.parse(row.payload_json).evidence).toBe("files");
    wg.markMerged(accId, systemActor);
    const e = computeStats(wg.db).acceptance.epics[0]!;
    expect(e.result).toBe("accepted");
    expect(e.replay_evidence).toBe("files");
  });
});

describe("acceptance gate: a verdict is bound to the tested commit and contract", () => {
  it("the binding is stored; a contract edited after the PASS makes the build stale (unaccepted)", () => {
    const wg = freshWg({ testingEnabled: false });
    const { accId } = epicToReviewWith(wg, { brief: "Bookmark Vault brief v1" });
    toTester(wg, accId);
    const bound = boundPass(wg, accId);
    wg.testerPass(accId, bound, testerAgent);
    approveTested(wg, accId);
    const ev = wg
      .view(accId)
      .evidence.filter((e) => e.evidence_type === "test_output")
      .pop();
    if (!ev || typeof ev.payload_json !== "string") throw new Error("expected tester evidence");
    const payload = JSON.parse(ev.payload_json) as Record<string, unknown>;
    expect(payload.tested_commit).toBe(SHA);
    expect(payload.contract_hash).toBe(bound.contract_hash);
    expect(payload.replay).toBe("passed");
    recordReplay(wg, accId);
    wg.markMerged(accId, systemActor);
    expect(computeStats(wg.db).acceptance.epics[0]!.result).toBe("accepted");
    wg.db
      .prepare(
        "UPDATE tickets SET description = description || ' (edited after PASS)' WHERE id = ?",
      )
      .run(accId);
    const a = computeStats(wg.db).acceptance;
    expect(a.epics[0]!.result).toBe("stale");
    expect(a.epics[0]!.contract_changed).toBe(true);
    expect(a.accepted).toBe(0);
    expect(a.stale).toBe(1);
    expect(a.unaccepted).toBe(1);
  });

  it("a verdict recorded against a DIFFERENT contract than the one on record is refused (CONTRACT_MISMATCH)", () => {
    const wg = freshWg({ testingEnabled: false });
    const { accId } = epicToReviewWith(wg);
    toTester(wg, accId);
    const stale = { ...boundPass(wg, accId), contract_hash: "f".repeat(64) };
    expectCode(() => wg.testerPass(accId, stale, testerAgent), "CONTRACT_MISMATCH");
  });

  it("malformed bindings are REFUSED (never silently dropped) — on PASS and FAIL, acceptance or not", () => {
    const wg = freshWg({ testingEnabled: false });
    const { accId } = epicToReviewWith(wg);
    toTester(wg, accId);
    const good = boundPass(wg, accId);
    for (const bad of [
      { tested_commit: "not a sha; rm -rf" },
      { tested_commit: "abc123" }, // abbreviated: not a full commit id
      { contract_hash: "zz" },
      { replay: "maybe" },
    ]) {
      expectCode(() => wg.testerPass(accId, { ...good, ...bad }, testerAgent), "VALIDATION_ERROR");
      expectCode(
        () => wg.testerFail(accId, { summary: "f", ...bad }, testerAgent),
        "VALIDATION_ERROR",
      );
    }
    expect(wg.view(accId).ticket.status).toBe("in_testing");
  });

  it("contractHash is the canonical sha256 over title, description, criteria and raw contract (same as the runner's tester)", () => {
    const wg = freshWg();
    const res = planWithTwoTickets(wg, { brief: "b" });
    const acc = wg.view(String(res.acceptanceTicketNumber)).ticket;
    const acs = wg.view(acc.id).acceptanceCriteria.map((c) => c.text);
    const expected = createHash("sha256")
      .update([acc.title, acc.description, ...acs, acc.test_contract ?? ""].join("\u0000"))
      .digest("hex");
    expect(contractHash(wg.db, acc.id)).toBe(expected);
  });
});

describe("acceptance gate: migration v25→v26", () => {
  it("adds tickets.acceptance (default 0) to an existing table and preserves rows", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE tickets (
        id TEXT PRIMARY KEY, number INTEGER UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('draft','refining','ready','claimed','in_progress','blocked','in_review','in_testing','ready_for_merge','done','failed','cancelled','paused')),
        priority INTEGER NOT NULL DEFAULT 0, risk_level TEXT NOT NULL DEFAULT 'medium', policy_pack TEXT NOT NULL DEFAULT 'solo_loose',
        source TEXT, created_by TEXT, reviewer TEXT, branch_name TEXT, pr_url TEXT, attempt_count INTEGER NOT NULL DEFAULT 0,
        row_version INTEGER NOT NULL DEFAULT 0, scheduled_after TEXT, due_at TEXT, bootstrap INTEGER NOT NULL DEFAULT 0,
        last_review_feedback TEXT, can_be_tested INTEGER NOT NULL DEFAULT 0, test_contract TEXT, human_owner TEXT,
        human_delivered TEXT, delivery_budget_usd REAL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO tickets(id, number, title, status, created_at, updated_at) VALUES ('t1', 1, 'old', 'draft', 'now', 'now');
      INSERT INTO schema_meta(key,value) VALUES ('schema_version','25');
    `);
    migrate(db);
    const cols = (db.prepare("PRAGMA table_info(tickets)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain("acceptance");
    const row = db.prepare("SELECT acceptance FROM tickets WHERE id = 't1'").get() as {
      acceptance: number;
    };
    expect(row.acceptance).toBe(0);
    const v = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(Number(v.value)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(26);
  });
});
