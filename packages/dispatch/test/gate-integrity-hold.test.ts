/**
 * GATE INTEGRITY on the dispatch side:
 *
 *  1. RiskKind `test-modified`: the diff payload carries it (high, with one item per
 *     finding) when the delivery deleted a test and added an `it.skip`; medium and
 *     `allowed` once a human set allow_test_changes.
 *  2. observedRisk: an unallowed `test-modified` is a HARD hold — the auto-ship path is
 *     held even for a ticket DECLARED high (observed ≤ declared would otherwise ship);
 *     the allowance lifts the hold; a human's approve is never held.
 *  3. allow_test_changes: human/admin only (agent and system refused server-side),
 *     every change is a `ticket.test_changes_allowed` event; REST (a read-only
 *     principal refused, 403) and CLI.
 *  4. The v28→v29 migration adds the column (default 0) to an existing table.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setPrincipalResolver } from "../src/api/auth.js";
import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import { migrate } from "../src/db/connection.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";
import type { Actor, RiskLevel } from "../src/domain/types.js";
import { listEvents } from "../src/events/eventWriter.js";
import { observedRisk, shouldEscalate } from "../src/services/observedRisk.js";
import { RISK_KINDS, testModifiedAnnotation } from "../src/services/riskAnnotations.js";
import { analyzeTestIntegrity } from "../src/services/testIntegrity.js";
import { DispatchError } from "../src/util/errors.js";
import { TestClock } from "../src/util/clock.js";
import { nonEmptyDiffRunner, testWeakeningDiffRunner } from "./helpers/realDiff.js";
import type { GitRunner } from "../src/services/diffService.js";

const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "agt-1" };

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof DispatchError ? e.code : String(e);
  }
  return undefined;
}

/** Drive a ticket to in_review with the given declared risk_level (mirrors observed-risk-gate). */
function inReview(d: Dispatch, riskLevel: RiskLevel): string {
  const repo = d.registerRepository(
    { name: "svc", default_branch: "main", local_path: process.cwd() },
    human,
  );
  const ticket = d.createTicket({ title: "T1", priority: 1, risk_level: riskLevel }, human);
  d.linkRepository(ticket.id, "svc", "primary", human);
  const { ac } = d.addAcceptanceCriterion({ ticket_id: ticket.id, text: "Works" }, human);
  d.markReady(ticket.id, human);
  const agent = d.registerAgent({ display_name: "Bot", max_risk: "critical" }, human);
  const claim = d.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
  if (!claim) throw new Error("Expected a claim");
  d.recordEvidence(
    {
      claimToken: claim.claimToken,
      ticket_id: ticket.id,
      ac_id: ac.id,
      evidence_type: "test_output",
      summary: "all passing",
    },
    agentActor,
  );
  d.recordRepoDelivery(
    { ticket_id: ticket.id, repo_id: repo.id, branch_name: "feat/t1" },
    agentActor,
  );
  d.submitForReview(
    { claimToken: claim.claimToken, ticket_id: ticket.id, reason: "done" },
    agentActor,
  );
  return ticket.id;
}

const open = (runner: GitRunner): Dispatch => Dispatch.open(":memory:", undefined, runner);

describe("RiskKind test-modified", () => {
  it("is a documented kind", () => {
    expect(RISK_KINDS).toContain("test-modified");
  });

  it("is null for a clean change, high for a weakening one, medium + allowed once allowed", () => {
    const clean = analyzeTestIntegrity({
      nameStatus: [{ status: "M", path: "src/a.ts" }],
      patch: "",
    });
    expect(testModifiedAnnotation(clean, false)).toBeNull();
    const weak = analyzeTestIntegrity({
      nameStatus: [{ status: "D", path: "src/a.test.ts" }],
      patch: "",
    });
    const ann = testModifiedAnnotation(weak, false)!;
    expect(ann).toMatchObject({
      kind: "test-modified",
      severity: "high",
      paths: ["src/a.test.ts"],
    });
    expect(ann.items).toEqual(["deleted test file src/a.test.ts"]);
    expect(ann.allowed).toBeUndefined();
    const ok = testModifiedAnnotation(weak, true)!;
    expect(ok).toMatchObject({ severity: "medium", allowed: true });
    expect(ok.detail).toMatch(/allowed on this ticket by a human/);
  });

  it("the review diff payload carries it, computed server-side from the real change", () => {
    const d = open(testWeakeningDiffRunner);
    const id = inReview(d, "low");
    const repo = d.ticketDiff(id).repos[0]!;
    const ann = repo.riskAnnotations.find((a) => a.kind === "test-modified");
    expect(ann).toBeDefined();
    expect(ann!.severity).toBe("high");
    expect(ann!.items).toEqual([
      "deleted test file src/x.test.ts",
      "added it.skip in src/y.test.ts:4",
    ]);
    d.db.close();
  });
});

describe("observedRisk: an unallowed test-modified is a hard hold", () => {
  it("escalates whatever the declared level; the allowance lifts the hold", () => {
    const weak = analyzeTestIntegrity({
      nameStatus: [{ status: "D", path: "t/a.test.ts" }],
      patch: "",
    });
    const repo = (allowed: boolean) => ({
      repo: "svc",
      branch: "b",
      baseBranch: "main",
      diff: "x",
      files: 1,
      additions: 0,
      deletions: 3,
      truncated: false,
      riskAnnotations: [testModifiedAnnotation(weak, allowed)!],
    });
    const held = observedRisk([repo(false)], {});
    expect(held.level).toBe("high");
    expect(held.holds).toHaveLength(1);
    expect(shouldEscalate(held, "critical", {})).toBe(true);
    const allowed = observedRisk([repo(true)], {});
    expect(allowed.level).toBe("medium");
    expect(allowed.holds).toEqual([]);
    expect(shouldEscalate(allowed, "high", {})).toBe(false);
  });
});

describe("the auto-ship gate holds a test-weakening delivery", () => {
  beforeEach(() => {
    process.env.DISPATCH_ALLOW_AGENT_APPROVE = "1";
  });
  afterEach(() => {
    delete process.env.DISPATCH_ALLOW_AGENT_APPROVE;
  });

  it("an agent approve is HELD even when the ticket is declared high (stays in_review, event recorded)", () => {
    const d = open(testWeakeningDiffRunner);
    const id = inReview(d, "high");
    const reviewer: Actor = { type: "agent", id: "rev-1" };
    expect(codeOf(() => d.approveReview(id, reviewer))).toBe("OBSERVED_RISK_ESCALATED");
    expect(d.resolveTicket(id).status).toBe("in_review");
    const ev = listEvents(d.db, "ticket", id).find(
      (e) => e.event_type === "ticket.autoship_escalated",
    );
    expect(ev).toBeDefined();
    const payload = JSON.parse(ev!.payload_json ?? "{}") as { holds?: string[] };
    expect(payload.holds?.[0]).toMatch(/tests modified/);
    d.db.close();
  });

  it("a control: the same declared-high ticket with a clean diff auto-ships", () => {
    const d = open(nonEmptyDiffRunner);
    const id = inReview(d, "high");
    d.approveReview(id, { type: "agent", id: "rev-1" });
    expect(d.resolveTicket(id).status).toBe("ready_for_merge");
    d.db.close();
  });

  it("once a human allows test changes the hold lifts (declared high ⇒ ships)", () => {
    const d = open(testWeakeningDiffRunner);
    const id = inReview(d, "high");
    d.setAllowTestChanges(id, true, human, "removing the obsolete v1 suite");
    d.approveReview(id, { type: "agent", id: "rev-1" });
    expect(d.resolveTicket(id).status).toBe("ready_for_merge");
    d.db.close();
  });

  it("a human approve is never held by it", () => {
    const d = open(testWeakeningDiffRunner);
    const id = inReview(d, "low");
    d.approveReview(id, human);
    expect(d.resolveTicket(id).status).toBe("ready_for_merge");
    d.db.close();
  });
});

describe("allow_test_changes: human-set only, recorded in events", () => {
  it("a human sets and clears it; each change is an event naming who and why", () => {
    const d = open(nonEmptyDiffRunner);
    const t = d.createTicket({ title: "x" }, human);
    expect(t.allow_test_changes).toBe(0);
    const on = d.setAllowTestChanges(t.id, true, human, "  rename the e2e suite  ");
    expect(on.allowTestChanges).toBe(true);
    expect(d.resolveTicket(t.id).allow_test_changes).toBe(1);
    d.setAllowTestChanges(t.id, false, { type: "admin", id: "root" });
    expect(d.resolveTicket(t.id).allow_test_changes).toBe(0);
    const evs = listEvents(d.db, "ticket", t.id).filter(
      (e) => e.event_type === "ticket.test_changes_allowed",
    );
    expect(evs.map((e) => JSON.parse(e.payload_json ?? "{}"))).toEqual([
      { allow_test_changes: true, previous: false, reason: "rename the e2e suite" },
      { allow_test_changes: false, previous: true },
    ]);
    expect(evs.map((e) => e.actor_type)).toEqual(["human", "admin"]);
    d.db.close();
  });

  it("an agent or the runner (system) is refused — nothing changes, no event", () => {
    const d = open(nonEmptyDiffRunner);
    const t = d.createTicket({ title: "x" }, human);
    expect(codeOf(() => d.setAllowTestChanges(t.id, true, agentActor))).toBe("ACTOR_NOT_PERMITTED");
    expect(codeOf(() => d.setAllowTestChanges(t.id, true, { type: "system" }))).toBe(
      "ACTOR_NOT_PERMITTED",
    );
    expect(d.resolveTicket(t.id).allow_test_changes).toBe(0);
    expect(
      listEvents(d.db, "ticket", t.id).some((e) => e.event_type === "ticket.test_changes_allowed"),
    ).toBe(false);
    d.db.close();
  });
});

describe("allow_test_changes over REST", () => {
  const FULL = "shared-full-token-for-gate-integrity-tests-0123456789";
  const saved = process.env.DISPATCH_API_TOKEN;
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
    setPrincipalResolver(null);
    if (saved === undefined) delete process.env.DISPATCH_API_TOKEN;
    else process.env.DISPATCH_API_TOKEN = saved;
  });

  it("a human sets it (200 + event); a read-only principal is refused (403); a bad body is 422", async () => {
    process.env.DISPATCH_AUDIT_OFF = "1";
    process.env.DISPATCH_API_TOKEN = FULL;
    const wg = Dispatch.open(":memory:", new TestClock());
    const server = createApiServer(wg);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    close = () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          wg.db.close();
          resolve();
        }),
      );
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, token: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const t = wg.createTicket({ title: "x" }, human);

    const ok = await post(`/tickets/${t.id}/allow-test-changes`, FULL, {
      allow_test_changes: true,
      reason: "drop the flaky legacy suite",
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ticket_id: t.id, allow_test_changes: true });
    expect(typeof body.event_id).toBe("string");
    expect(wg.resolveTicket(t.id).allow_test_changes).toBe(1);

    // Principals are human/admin only (an agent never holds an API token: the runner
    // scrubs it from the agent env), so the REST refusal to show is the capability one:
    // a read-only principal cannot set the flag.
    const { token: readToken } = wg.createPrincipal({ name: "viewer", capability: "read" }, human);
    const denied = await post(`/tickets/${t.id}/allow-test-changes`, readToken, {
      allow_test_changes: false,
    });
    expect(denied.status).toBe(403);
    expect(wg.resolveTicket(t.id).allow_test_changes).toBe(1);

    const bad = await post(`/tickets/${t.id}/allow-test-changes`, FULL, { allow: "yes" });
    expect(bad.status).toBe(422);
  });
});

describe("allow_test_changes over the CLI (wg ticket allow-test-changes)", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("sets it as a human, --off clears it, both recorded", () => {
    dir = mkdtempSync(join(tmpdir(), "gi-cli-"));
    const db = join(dir, "d.sqlite");
    const seed = Dispatch.open(db);
    const t = seed.createTicket({ title: "x" }, human);
    seed.db.close();
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, [join(__dirname, "../dist/cli/index.js"), "--db", db, ...args], {
        encoding: "utf8",
        env: { ...process.env, DISPATCH_AUDIT_OFF: "1" },
      });
    const on = cli("ticket", "allow-test-changes", String(t.number), "--reason", "rename suite");
    expect(on.status, on.stderr).toBe(0);
    expect(JSON.parse(on.stdout)).toMatchObject({ ok: true, allowTestChanges: true });
    const off = cli("ticket", "allow-test-changes", String(t.number), "--off");
    expect(off.status, off.stderr).toBe(0);
    const check = Dispatch.open(db);
    expect(check.resolveTicket(t.id).allow_test_changes).toBe(0);
    const evs = listEvents(check.db, "ticket", t.id).filter(
      (e) => e.event_type === "ticket.test_changes_allowed",
    );
    expect(evs).toHaveLength(2);
    expect(evs[0]!.actor_type).toBe("human");
    check.db.close();
  });
});

describe("gate integrity: migration v28→v29", () => {
  it("adds tickets.allow_test_changes (default 0) to an existing table and preserves rows", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE tickets (
        id TEXT PRIMARY KEY, number INTEGER UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('draft','refining','ready','claimed','in_progress','blocked','in_review','in_testing','ready_for_merge','done','failed','cancelled','paused')),
        priority INTEGER NOT NULL DEFAULT 0, risk_level TEXT NOT NULL DEFAULT 'medium', policy_pack TEXT NOT NULL DEFAULT 'solo_loose',
        source TEXT, created_by TEXT, reviewer TEXT, branch_name TEXT, pr_url TEXT, attempt_count INTEGER NOT NULL DEFAULT 0,
        row_version INTEGER NOT NULL DEFAULT 0, scheduled_after TEXT, due_at TEXT, bootstrap INTEGER NOT NULL DEFAULT 0,
        last_review_feedback TEXT, can_be_tested INTEGER NOT NULL DEFAULT 0, test_contract TEXT,
        acceptance INTEGER NOT NULL DEFAULT 0, human_owner TEXT,
        human_delivered TEXT, delivery_budget_usd REAL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO tickets(id, number, title, status, created_at, updated_at) VALUES ('t1', 1, 'old', 'draft', 'now', 'now');
      INSERT INTO schema_meta(key,value) VALUES ('schema_version','28');
    `);
    migrate(db);
    const row = db.prepare("SELECT allow_test_changes FROM tickets WHERE id = 't1'").get() as {
      allow_test_changes: number;
    };
    expect(row.allow_test_changes).toBe(0);
    const v = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(Number(v.value)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(29);
  });
});
