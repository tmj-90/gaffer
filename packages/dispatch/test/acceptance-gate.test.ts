import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { computeStats } from "../src/cli/ops.js";
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
    const res = planWithTwoTickets(wg);
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

  it("GAFFER_TESTING OFF: an ordinary testable ticket goes to ready_for_merge, the acceptance ticket goes to in_testing", () => {
    const wg = freshWg({ testingEnabled: false });
    const { accId } = epicToReview(wg);
    const res = wg.approveReview(accId, reviewer);
    expect(res.ticket.status).toBe("in_testing");
    const ev = wg.view(accId).events.find((e) => e.event_type === "ticket.routed_to_testing");
    expect(ev).toBeDefined();
    expect(JSON.parse(ev!.payload_json ?? "{}").acceptance).toBe(true);
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

  it("tester PASS → ready_for_merge → done: the build reads accepted and drops out of the attention count", () => {
    const wg = freshWg({ testingEnabled: false });
    const { accId } = epicToReview(wg);
    wg.approveReview(accId, reviewer);
    const pass = wg.testerPass(
      accId,
      { summary: "acceptance suite 13/13 [tested commit abc123]" },
      testerAgent,
    );
    expect(pass.ticket.status).toBe("ready_for_merge");
    wg.markMerged(accId, systemActor);
    const a = computeStats(wg.db).acceptance;
    expect(a.epics[0]!.result).toBe("accepted");
    expect(a.accepted).toBe(1);
    expect(a.unaccepted).toBe(0);
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
