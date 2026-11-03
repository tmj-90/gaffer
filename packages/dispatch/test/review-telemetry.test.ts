/**
 * REVIEW TELEMETRY events (Release A metrics package: A0 data model, MF2).
 *
 *  - POST /tickets/:id/review-opened records `ticket.review_opened` once per review round,
 *    with the round and the recorded delivery commits computed server-side, never bumping
 *    the ticket's updated_at (the Review queue re-renders on it).
 *  - POST /tickets/:id/review-raw-opened records `ticket.review_raw_opened {what}` once
 *    per round and kind.
 *  - Only a person records either; a read-only token is refused by the capability gate.
 *  - `ticket.lane_verdict` is recorded by the runner (system) or an admin only.
 *  - GET /api/health serves the review-time and first-pass read models, the lane verdict
 *    counts and the escaped-defect rate from the links a person filed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deriveReadToken } from "../src/api/auth.js";
import { createApiServer } from "../src/api/server.js";
import { computeStats, renderStats } from "../src/cli/ops.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { writeEvent } from "../src/events/eventWriter.js";
import { TestClock } from "../src/util/clock.js";
import { CLI_BUILT, runBin } from "./helpers/cliBin.js";

const human: Actor = { type: "human", id: "tom" };
const system: Actor = { type: "system" };
const agent: Actor = { type: "agent", id: "gaffer-factory" };

interface Harness {
  wg: Dispatch;
  baseUrl: string;
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  process.env.DISPATCH_AUDIT_OFF = "1";
  const wg = Dispatch.open(":memory:", new TestClock());
  const server = createApiServer(wg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    wg,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          wg.db.close();
          resolve();
        }),
      ),
  };
}

async function call(
  h: Harness,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(`${h.baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

/** A ticket put in review the way the log records it (a transition into in_review). */
function inReview(wg: Dispatch, title = "Review me"): { id: string; number: number } {
  const t = wg.createTicket({ title }, human);
  wg.db.prepare(`UPDATE tickets SET status='in_review' WHERE id=?`).run(t.id);
  writeEvent(wg.db, {
    entity_type: "ticket",
    entity_id: t.id,
    actor: system,
    event_type: "ticket.transitioned",
    payload: { from: "in_progress", to: "in_review", reason: "submitted" },
  });
  return { id: t.id, number: t.number ?? 0 };
}

const eventsOf = (wg: Dispatch, id: string, type: string) =>
  wg.db
    .prepare(
      `SELECT actor_type, payload_json FROM work_events WHERE entity_id = ? AND event_type = ? ORDER BY rowid`,
    )
    .all(id, type) as Array<{ actor_type: string; payload_json: string }>;

describe("POST /tickets/:id/review-opened", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("records the open once per round with the round and head commits, and never bumps updated_at", async () => {
    const t = inReview(h.wg);
    const repo = h.wg.registerRepository(
      { name: "app", default_branch: "main", local_path: process.cwd() },
      human,
    );
    h.wg.db
      .prepare(
        `INSERT INTO ticket_repo_delivery (ticket_id, repo_id, branch_name, commit_sha, status)
         VALUES (?, ?, 'gaffer/t', 'abc1234def5678', 'review_ready')`,
      )
      .run(t.id, repo.id);
    const before = h.wg.resolveTicket(t.id).updated_at;
    const r1 = await call(h, "POST", `/tickets/${t.id}/review-opened`, {});
    expect(r1.status).toBe(200);
    expect(r1.body.recorded).toBe(true);
    const round = h.wg.events.enteredStatusAt(t.id, "in_review")?.at;
    expect(r1.body.round_entered_at).toBe(round);
    const r2 = await call(h, "POST", `/tickets/${t.id}/review-opened`, {});
    expect(r2.body).toMatchObject({ recorded: false, reason: "already_recorded" });
    const rows = eventsOf(h.wg, t.id, "ticket.review_opened");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_type).toBe("human");
    expect(JSON.parse(rows[0]!.payload_json)).toEqual({
      round_entered_at: round,
      head_shas: [{ repo: "app", sha: "abc1234def5678" }],
    });
    expect(h.wg.resolveTicket(t.id).updated_at).toBe(before);
  });

  it("records nothing for a ticket not in review, or for a round the viewer did not see", async () => {
    const draft = h.wg.createTicket({ title: "Draft" }, human);
    const r = await call(h, "POST", `/tickets/${draft.id}/review-opened`, {});
    expect(r.body).toMatchObject({ recorded: false, reason: "not_in_review" });
    const t = inReview(h.wg);
    const stale = await call(h, "POST", `/tickets/${t.id}/review-opened`, {
      round_entered_at: "2020-01-01T00:00:00.000Z",
    });
    expect(stale.body).toMatchObject({ recorded: false, reason: "stale_round" });
    expect(eventsOf(h.wg, t.id, "ticket.review_opened")).toHaveLength(0);
  });

  it("refuses an agent or the runner: only a person opens a ticket in review", () => {
    const t = inReview(h.wg);
    expect(() => h.wg.recordReviewOpened(t.id, agent)).toThrow(/Only a person/);
    expect(() => h.wg.recordReviewOpened(t.id, system)).toThrow(/Only a person/);
    expect(eventsOf(h.wg, t.id, "ticket.review_opened")).toHaveLength(0);
  });

  it("a read-only token cannot write it", async () => {
    const saved = process.env.DISPATCH_API_TOKEN;
    process.env.DISPATCH_API_TOKEN = "full-secret-for-review-open";
    try {
      const t = inReview(h.wg);
      const r = await call(
        h,
        "POST",
        `/tickets/${t.id}/review-opened`,
        {},
        deriveReadToken("full-secret-for-review-open"),
      );
      expect(r.status).toBe(403);
      expect(eventsOf(h.wg, t.id, "ticket.review_opened")).toHaveLength(0);
    } finally {
      if (saved === undefined) delete process.env.DISPATCH_API_TOKEN;
      else process.env.DISPATCH_API_TOKEN = saved;
    }
  });

  it("records a raw open once per round and kind, and refuses an unknown kind", async () => {
    const t = inReview(h.wg);
    const before = h.wg.resolveTicket(t.id).updated_at;
    const a = await call(h, "POST", `/tickets/${t.id}/review-raw-opened`, { what: "run_log" });
    expect(a.body.recorded).toBe(true);
    const b = await call(h, "POST", `/tickets/${t.id}/review-raw-opened`, { what: "run_log" });
    expect(b.body.recorded).toBe(false);
    const c = await call(h, "POST", `/tickets/${t.id}/review-raw-opened`, { what: "evidence" });
    expect(c.body.recorded).toBe(true);
    const bad = await call(h, "POST", `/tickets/${t.id}/review-raw-opened`, { what: "secrets" });
    expect(bad.status).toBe(422);
    const rows = eventsOf(h.wg, t.id, "ticket.review_raw_opened").map(
      (r) => JSON.parse(r.payload_json) as { what: string },
    );
    expect(rows.map((r) => r.what)).toEqual(["run_log", "evidence"]);
    expect(h.wg.resolveTicket(t.id).updated_at).toBe(before);
  });
});

describe("ticket.lane_verdict", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("the runner records a lane's verdict on a candidate as a system event", () => {
    const t = inReview(h.wg);
    const res = h.wg.recordLaneVerdict(
      t.id,
      {
        lane: "security-review",
        verdict: "CHANGES",
        commit: "ABC1234DEF",
        attempt_id: "c0123456789ab/2",
        attempt_id_basis: "latest_delivery_row",
        model_requested: "mid-model",
      },
      system,
    );
    expect(res.verdict).toEqual({
      lane: "security-review",
      verdict: "changes",
      commit: "abc1234def",
      attempt_id: "c0123456789ab/2",
      attempt_id_basis: "latest_delivery_row",
      actor: "system",
      held_reason: null,
      model_requested: "mid-model",
    });
    const rows = eventsOf(h.wg, t.id, "ticket.lane_verdict");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_type).toBe("system");
  });

  it("refuses an agent, an unknown lane and a verdict the lane cannot give", () => {
    const t = inReview(h.wg);
    expect(() => h.wg.recordLaneVerdict(t.id, { lane: "tester", verdict: "pass" }, agent)).toThrow(
      /Only the runner/,
    );
    expect(() => h.wg.recordLaneVerdict(t.id, { lane: "vibes", verdict: "pass" }, system)).toThrow(
      /lane must be one of/,
    );
    expect(() =>
      h.wg.recordLaneVerdict(t.id, { lane: "tester", verdict: "approve" }, system),
    ).toThrow(/tester verdict is one of/);
    expect(() =>
      h.wg.recordLaneVerdict(t.id, { lane: "tester", verdict: "pass", commit: "; rm" }, system),
    ).toThrow(/git sha/);
    expect(() =>
      h.wg.recordLaneVerdict(
        t.id,
        { lane: "tester", verdict: "pass", attempt_id: "c1/1", attempt_id_basis: "commit_match" },
        system,
      ),
    ).toThrow(/attempt_id_basis is one of/);
    expect(eventsOf(h.wg, t.id, "ticket.lane_verdict")).toHaveLength(0);
  });

  it("labels how the attempt was found: a named attempt is stated, never a commit match", () => {
    const t = inReview(h.wg);
    const named = h.wg.recordLaneVerdict(
      t.id,
      { lane: "tester", verdict: "pass", attempt_id: "c0123456789ab/1" },
      system,
    );
    expect(named.verdict.attempt_id_basis).toBe("stated");
    const none = h.wg.recordLaneVerdict(t.id, { lane: "tester", verdict: "fail" }, system);
    expect(none.verdict.attempt_id).toBeNull();
    expect(none.verdict.attempt_id_basis).toBeNull();
  });
});

describe("GET /api/health review and first-pass measures", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("serves review time, first-pass acceptance, lane verdicts and the escaped-defect rate", async () => {
    const t = inReview(h.wg);
    await call(h, "POST", `/tickets/${t.id}/review-opened`, {});
    h.wg.recordLaneVerdict(t.id, { lane: "agent-review", verdict: "approve" }, system);
    writeEvent(h.wg.db, {
      entity_type: "ticket",
      entity_id: t.id,
      actor: human,
      event_type: "ticket.transitioned",
      payload: { from: "in_review", to: "ready_for_merge", reason: "review_approved" },
    });
    h.wg.db.prepare(`UPDATE tickets SET status='done' WHERE id=?`).run(t.id);
    const { status, body } = await call(h, "GET", "/api/health");
    expect(status).toBe(200);
    const rt = body.review_time as {
      basis: string;
      per_accepted_ticket: { n: number; median_ms: number | null };
      approved_without_raw_logs: { instrumented: number; count: number };
    };
    expect(rt.basis).toBe("decision_time");
    expect(rt.per_accepted_ticket.n).toBe(1);
    expect(typeof rt.per_accepted_ticket.median_ms).toBe("number");
    expect(rt.approved_without_raw_logs).toMatchObject({ instrumented: 1, count: 1 });
    const fp = body.first_pass as {
      done: number;
      first_pass: number;
      by_approver: { human: { done: number } };
    };
    expect(fp).toMatchObject({ done: 1, first_pass: 1 });
    expect(fp.by_approver.human.done).toBe(1);
    expect(body.lane_verdicts).toEqual({
      recorded: 1,
      by_lane: { "agent-review": { approve: 1 } },
    });
    // Escaped defects are recordable now (MF5): one accepted change, no link filed. Its
    // move to done is not in the log here, so it counts all time but not in the window.
    const esc = body.escaped_defects as {
      recorded: boolean;
      rate_pct: number | null;
      all_time: { rate_pct: number | null };
      note: string;
    };
    expect(esc.recorded).toBe(true);
    expect(esc.rate_pct).toBeNull();
    expect(esc.all_time.rate_pct).toBe(0);
    expect(esc.note).toMatch(/Counts only what a person filed/);
  });
});

describe("wg stats and wg ticket lane-verdict", () => {
  it("wg stats prints first-pass acceptance, the review-time percentiles and the escaped-defect rate", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    try {
      const out = renderStats(computeStats(wg.db, new Date().toISOString(), {}));
      expect(out).toContain("First-pass acceptance: n/a (0 of 0 done");
      expect(out).toContain("Human review time per accepted ticket: median n/a, p75 n/a, p90 n/a");
      expect(out).toMatch(
        /Escaped-defect rate: n\/a \(0 of 0 accepted changes.*Counts only what a person filed/,
      );
    } finally {
      wg.db.close();
    }
  });

  it.skipIf(!CLI_BUILT)("the CLI records a lane verdict as system and refuses an agent", () => {
    const dir = mkdtempSync(join(tmpdir(), "gaffer-lane-verdict-"));
    try {
      const db = join(dir, "dispatch.sqlite");
      const wg = Dispatch.open(db, new TestClock());
      const t = inReview(wg);
      wg.db.close();
      const ok = runBin(db, [
        "ticket",
        "lane-verdict",
        String(t.number),
        "--lane",
        "tester",
        "--verdict",
        "held",
        "--commit",
        "abc1234",
        "--held-reason",
        "no verdict token",
      ]);
      expect(ok.status).toBe(0);
      const parsed = JSON.parse(ok.stdout) as { verdict: { verdict: string; actor: string } };
      expect(parsed.verdict).toMatchObject({ verdict: "held", actor: "system" });
      const refused = runBin(db, [
        "ticket",
        "lane-verdict",
        String(t.number),
        "--lane",
        "tester",
        "--verdict",
        "pass",
        "--as",
        "agent",
      ]);
      expect(refused.status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
