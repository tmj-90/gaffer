/**
 * MACHINE-CHECKABLE acceptance criteria.
 *
 *   - schema: `check_command` exists on a fresh DB and is ADDED to a pre-v21 DB
 *     with a NULL backfill (existing rows intact);
 *   - addAcceptanceCriterion persists check_command (facade + MCP-shaped input);
 *   - recordAcCheck (runner, system actor): exit 0 ⇒ satisfied + verified_by
 *     runner:check + test_output evidence; non-zero ⇒ failed; an AGENT actor is
 *     refused; a prose AC (no check) is refused;
 *   - done gate: a checked AC that the runner has not passed BLOCKS mark-merged
 *     (AC_CHECK_UNVERIFIED) even after human approval; the agent marking it
 *     satisfied via record_ac_evidence does NOT count; a passed runner check does.
 */
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { migrate } from "../src/db/connection.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";
import type { Actor } from "../src/domain/types.js";
import { AC_CHECK_VERIFIER } from "../src/policy/policy.js";
import { DispatchError } from "../src/util/errors.js";
import { nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const runner: Actor = { type: "system", id: "runner" };

describe("schema v21 — acceptance_criteria.check_command", () => {
  it("exists on a fresh DB", () => {
    const d = Dispatch.open(":memory:");
    const cols = (
      d.db.prepare("PRAGMA table_info(acceptance_criteria)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain("check_command");
    d.db.close();
  });

  it("is added to a pre-v21 DB with a NULL backfill and the version stamp advances", () => {
    const db = new BetterSqlite3(":memory:");
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE acceptance_criteria (
        id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, text TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','satisfied','failed','waived')),
        verification_method TEXT, evidence_required INTEGER NOT NULL DEFAULT 0,
        verified_by TEXT, verified_at TEXT, spec_clause_id TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    db.prepare("INSERT INTO schema_meta(key,value) VALUES ('schema_version','20')").run();
    db.prepare(
      "INSERT INTO acceptance_criteria (id, ticket_id, text) VALUES ('a1','t1','legacy')",
    ).run();
    migrate(db as never);
    const cols = (
      db.prepare("PRAGMA table_info(acceptance_criteria)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain("check_command");
    const row = db
      .prepare("SELECT text, check_command FROM acceptance_criteria WHERE id='a1'")
      .get() as {
      text: string;
      check_command: string | null;
    };
    expect(row.text).toBe("legacy");
    expect(row.check_command).toBeNull();
    const ver = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as {
      value: string;
    };
    expect(Number(ver.value)).toBe(SCHEMA_VERSION);
    db.close();
  });
});

describe("recordAcCheck — runner-owned verification of a checked AC", () => {
  let d: Dispatch;
  let ticketId: string;
  let checkedAcId: string;
  let proseAcId: string;
  beforeEach(() => {
    d = Dispatch.open(":memory:", undefined, nonEmptyDiffRunner);
    const t = d.createTicket({ title: "Checked" }, human);
    ticketId = t.id;
    checkedAcId = d.addAcceptanceCriterion(
      { ticket_id: t.id, text: "unit tests pass", check_command: "pnpm test" },
      human,
    ).ac.id;
    proseAcId = d.addAcceptanceCriterion({ ticket_id: t.id, text: "looks good" }, human).ac.id;
  });
  afterEach(() => d.db.close());

  it("persists check_command on the AC (and NULL for a prose AC)", () => {
    const acs = d.acs.listForTicket(ticketId);
    expect(acs.find((a) => a.id === checkedAcId)?.check_command).toBe("pnpm test");
    expect(acs.find((a) => a.id === proseAcId)?.check_command).toBeNull();
  });

  it("exit 0 ⇒ satisfied, verified_by runner:check, test_output evidence with the payload", () => {
    const res = d.recordAcCheck(
      {
        ticket_id: ticketId,
        ac_id: checkedAcId,
        exit_code: 0,
        command: "pnpm test",
        output_tail: "12 passed",
        duration_s: 3,
      },
      runner,
    );
    expect(res.status).toBe("satisfied");
    const ac = d.acs.findById(checkedAcId)!;
    expect(ac.status).toBe("satisfied");
    expect(ac.verified_by).toBe(AC_CHECK_VERIFIER);
    const ev = d.evidence.listForTicket(ticketId).find((e) => e.id === res.evidenceId)!;
    expect(ev.evidence_type).toBe("test_output");
    expect(ev.ac_id).toBe(checkedAcId);
    expect(ev.recorded_by_actor_type).toBe("system");
    expect(ev.summary).toContain("PASSED");
    expect(JSON.parse(ev.payload_json!)).toMatchObject({
      kind: "ac_check",
      passed: true,
      exit_code: 0,
      output_tail: "12 passed",
    });
  });

  it("non-zero exit ⇒ failed (still recorded as evidence)", () => {
    const res = d.recordAcCheck(
      { ticket_id: ticketId, ac_id: checkedAcId, exit_code: 1, command: "pnpm test" },
      runner,
    );
    expect(res.status).toBe("failed");
    expect(d.acs.findById(checkedAcId)!.status).toBe("failed");
    expect(d.evidence.listForTicket(ticketId).some((e) => e.summary.includes("FAILED"))).toBe(true);
  });

  it("refuses an agent actor", () => {
    expect(() =>
      d.recordAcCheck(
        { ticket_id: ticketId, ac_id: checkedAcId, exit_code: 0, command: "pnpm test" },
        { type: "agent", id: "agt" },
      ),
    ).toThrowError(DispatchError);
  });

  it("refuses a prose AC (no check_command)", () => {
    let code = "";
    try {
      d.recordAcCheck(
        { ticket_id: ticketId, ac_id: proseAcId, exit_code: 0, command: "true" },
        runner,
      );
    } catch (e) {
      code = (e as DispatchError).code;
    }
    expect(code).toBe("VALIDATION_ERROR");
  });
});

describe("done gate (fires at approval) — a checked AC must be runner-verified", () => {
  let d: Dispatch;
  afterEach(() => d.db.close());

  function deliverToReview(): { ticketId: string; acId: string } {
    d = Dispatch.open(":memory:", undefined, nonEmptyDiffRunner);
    const repo = d.registerRepository(
      { name: "svc", default_branch: "main", local_path: process.cwd() },
      human,
    );
    const t = d.createTicket({ title: "T", risk_level: "low" }, human);
    d.linkRepository(t.id, "svc", "primary", human);
    const { ac } = d.addAcceptanceCriterion(
      { ticket_id: t.id, text: "tests pass", check_command: "pnpm test" },
      human,
    );
    d.markReady(t.id, human);
    const agent = d.registerAgent({ display_name: "Bot", max_risk: "critical" }, human);
    const agentActor: Actor = { type: "agent", id: agent.id };
    const claim = d.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor)!;
    // The AGENT marks the checked AC satisfied itself — this must NOT count.
    d.recordEvidence(
      {
        claimToken: claim.claimToken,
        ticket_id: t.id,
        ac_id: ac.id,
        evidence_type: "test_output",
        summary: "trust me",
      },
      agentActor,
    );
    d.recordRepoDelivery({ ticket_id: t.id, repo_id: repo.id, branch_name: "feat/x" }, agentActor);
    d.submitForReview(
      { claimToken: claim.claimToken, ticket_id: t.id, reason: "done" },
      agentActor,
    );
    expect(d.resolveTicket(t.id).status).toBe("in_review");
    return { ticketId: t.id, acId: ac.id };
  }

  function approvalDeniedWith(ticketId: string, code: string): void {
    let err: unknown;
    try {
      d.approveReview(ticketId, human);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DispatchError);
    expect((err as DispatchError).code).toBe("POLICY_DENIED");
    expect(JSON.stringify((err as DispatchError).details)).toContain(code);
    expect(d.resolveTicket(ticketId).status).toBe("in_review");
  }

  it("blocks human approval while the checked AC is only agent-verified, then allows it after a runner pass", () => {
    const { ticketId, acId } = deliverToReview();
    // Agent-written "satisfied" ⇒ verified_by is the agent, not runner:check.
    expect(d.acs.findById(acId)!.status).toBe("satisfied");
    expect(d.acs.findById(acId)!.verified_by).not.toBe(AC_CHECK_VERIFIER);
    approvalDeniedWith(ticketId, "AC_CHECK_UNVERIFIED");

    // The runner runs the check and it passes ⇒ approval (and the merge) proceed.
    d.recordAcCheck(
      { ticket_id: ticketId, ac_id: acId, exit_code: 0, command: "pnpm test" },
      runner,
    );
    expect(d.approveReview(ticketId, human).ticket.status).toBe("ready_for_merge");
    expect(d.markMerged(ticketId, { type: "system", id: "merge-runner" }).ticket.status).toBe(
      "done",
    );
  });

  it("a FAILED runner check also blocks approval", () => {
    const { ticketId, acId } = deliverToReview();
    d.recordAcCheck(
      { ticket_id: ticketId, ac_id: acId, exit_code: 2, command: "pnpm test" },
      runner,
    );
    approvalDeniedWith(ticketId, "AC_CHECK_UNVERIFIED");
  });

  it("a prose AC (no check) keeps today's behaviour — agent evidence satisfies it", () => {
    d = Dispatch.open(":memory:", undefined, nonEmptyDiffRunner);
    const repo = d.registerRepository(
      { name: "svc", default_branch: "main", local_path: process.cwd() },
      human,
    );
    const t = d.createTicket({ title: "P", risk_level: "low" }, human);
    d.linkRepository(t.id, "svc", "primary", human);
    const { ac } = d.addAcceptanceCriterion({ ticket_id: t.id, text: "prose" }, human);
    d.markReady(t.id, human);
    const agent = d.registerAgent({ display_name: "Bot", max_risk: "critical" }, human);
    const agentActor: Actor = { type: "agent", id: agent.id };
    const claim = d.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor)!;
    d.recordEvidence(
      {
        claimToken: claim.claimToken,
        ticket_id: t.id,
        ac_id: ac.id,
        evidence_type: "test_output",
        summary: "ok",
      },
      agentActor,
    );
    d.recordRepoDelivery({ ticket_id: t.id, repo_id: repo.id, branch_name: "feat/p" }, agentActor);
    d.submitForReview(
      { claimToken: claim.claimToken, ticket_id: t.id, reason: "done" },
      agentActor,
    );
    expect(d.approveReview(t.id, human).ticket.status).toBe("ready_for_merge");
  });
});
