import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createHash } from "node:crypto";

import { computeStats, contractHash } from "../src/cli/ops.js";
import { Dispatch } from "../src/core.js";
import { migrate } from "../src/db/connection.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";
import type { Actor } from "../src/domain/types.js";
import { ACCEPTANCE_CRITERIA } from "../src/services/epicsService.js";
import { TestClock } from "../src/util/clock.js";
import { giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

/**
 * ACCEPTANCE GATE — "implementation tickets merged" is not "build accepted".
 *
 * A live run delivered 13/13 tickets, every one approved and judged 4+/5, and the
 * finished application still failed a brief-level check (20 concurrent writes →
 * 8 × HTTP 500). These tests pin the gate that makes that outcome visible:
 *   1. every epic gets a factory-created acceptance ticket — dependent on every
 *      implementation ticket, testable, with a contract and the cross-cutting criteria;
 *      `epic.acceptance:false` opts out; the brief rides on it as the contract;
 *   2. approving an acceptance ticket ALWAYS routes to in_testing, GAFFER_TESTING off
 *      or on, while an ordinary ticket still goes straight to ready_for_merge;
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

function freshWg(opts: { testingEnabled?: boolean } = {}): Dispatch {
  return Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner, {
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

const SHA = "0123456789abcdef0123456789abcdef01234567";

/** The binding the runner's tester records on an automated PASS (see tester-run.mjs). */
function boundPass(wg: Dispatch, ticketId: string) {
  return {
    summary: "acceptance suite 16/16",
    tested_commit: SHA,
    contract_hash: contractHash(wg.db, ticketId)!,
    replay: "passed",
  };
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
    // Implementation tickets are untouched: not acceptance, not testable.
    const store = wg.view(String(res.ticketNumbers[0])).ticket;
    expect(store.acceptance).toBe(0);
    expect(store.can_be_tested).toBe(0);
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

describe("acceptance gate: approval always routes an acceptance ticket to the tester", () => {
  function epicToReview(wg: Dispatch) {
    return epicToReviewWith(wg);
  }

  it("GAFFER_TESTING OFF: an ordinary testable ticket goes to ready_for_merge, the acceptance ticket goes to in_testing", () => {
    const wg = freshWg({ testingEnabled: false });
    const { accId } = epicToReview(wg);
    const res = wg.approveReview(accId, reviewer);
    expect(res.ticket.status).toBe("in_testing");
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
    wg.approveReview(accId, reviewer);
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

  it("an automated PASS on an acceptance ticket WITHOUT a binding is refused (BINDING_REQUIRED) — it cannot become verified", () => {
    const wg = freshWg({ testingEnabled: false });
    const { accId } = epicToReview(wg);
    wg.approveReview(accId, reviewer);
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

  it("a bound PASS (commit + current contract + clean replay) → done reads accepted (verified) and leaves the attention count", () => {
    const wg = freshWg({ testingEnabled: false });
    const { accId } = epicToReview(wg);
    wg.approveReview(accId, reviewer);
    const pass = wg.testerPass(accId, boundPass(wg, accId), testerAgent);
    expect(pass.ticket.status).toBe("ready_for_merge");
    wg.markMerged(accId, systemActor);
    const a = computeStats(wg.db).acceptance;
    expect(a.epics[0]!.result).toBe("accepted");
    expect(a.epics[0]!.accepted_commit).toBe(SHA);
    expect(a.epics[0]!.replay).toBe("passed");
    expect(a.accepted).toBe(1);
    expect(a.unaccepted).toBe(0);
  });

  it("a HUMAN tester-pass is a waiver: allowed without a binding, reported as waived — never as verified", () => {
    const wg = freshWg({ testingEnabled: false });
    const { accId } = epicToReview(wg);
    wg.approveReview(accId, reviewer);
    wg.testerPass(accId, { summary: "waived: acceptance reviewed by hand" }, human);
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
    wg.approveReview(accId, reviewer);
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

describe("acceptance gate: a verdict is bound to the tested commit and contract", () => {
  it("the binding is stored; a contract edited after the PASS makes the build stale (unaccepted)", () => {
    const wg = freshWg({ testingEnabled: false });
    const { accId } = epicToReviewWith(wg, { brief: "Bookmark Vault brief v1" });
    wg.approveReview(accId, reviewer);
    const bound = boundPass(wg, accId);
    wg.testerPass(accId, bound, testerAgent);
    const ev = wg
      .view(accId)
      .evidence.filter((e) => e.evidence_type === "test_output")
      .pop();
    if (!ev || typeof ev.payload_json !== "string") throw new Error("expected tester evidence");
    const payload = JSON.parse(ev.payload_json) as Record<string, unknown>;
    expect(payload.tested_commit).toBe(SHA);
    expect(payload.contract_hash).toBe(bound.contract_hash);
    expect(payload.replay).toBe("passed");
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
    wg.approveReview(accId, reviewer);
    const stale = { ...boundPass(wg, accId), contract_hash: "f".repeat(64) };
    expectCode(() => wg.testerPass(accId, stale, testerAgent), "CONTRACT_MISMATCH");
  });

  it("malformed bindings are REFUSED (never silently dropped) — on PASS and FAIL, acceptance or not", () => {
    const wg = freshWg({ testingEnabled: false });
    const { accId } = epicToReviewWith(wg);
    wg.approveReview(accId, reviewer);
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
    expect(SCHEMA_VERSION).toBe(26);
  });
});
