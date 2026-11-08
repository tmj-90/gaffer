/**
 * BLINDING THE EVAL JUDGE (external review finding 4, review13/4). The Review view keeps
 * the judge's grade collapsed until a person opens it; opening it before the decision is
 * recorded, and judge agreement counts a decision made after a reveal apart from the
 * blind ones its headline comes from.
 *
 *  - POST /tickets/:id/judge-revealed records `ticket.review_judge_revealed` once per
 *    review round, only for a ticket in review, only for a person; a read token is refused.
 *  - the review packet says whether the view was opened this round (judge_revealed_at).
 *  - readJudgeAgreement over a real database splits blind from revealed decisions.
 *  - the v33 migration stamps when an existing database started hiding the grade; a new
 *    database gets no stamp.
 *  - `wg review judge-view` is the terminal's way to open it, recorded the same way.
 */
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deriveReadToken } from "../src/api/auth.js";
import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import { JUDGE_BLIND_SINCE_KEY } from "../src/db/schema.js";
import type { Actor } from "../src/domain/types.js";
import { writeEvent } from "../src/events/eventWriter.js";
import { readJudgeAgreement, renderJudgeAgreement } from "../src/health/judgeAgreement.js";
import { readJudgeBlindSince } from "../src/services/reviewTelemetry.js";
import { TestClock } from "../src/util/clock.js";
import { CLI_BUILT, runBin } from "./helpers/cliBin.js";

const human: Actor = { type: "human", id: "tom" };
const system: Actor = { type: "system" };
const agent: Actor = { type: "agent", id: "gaffer-factory" };
const REVEALED = "ticket.review_judge_revealed";

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
  path: string,
  body: unknown = {},
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(`${h.baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

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

const reveals = (wg: Dispatch, id: string) =>
  wg.db
    .prepare(
      `SELECT actor_type, payload_json FROM work_events WHERE entity_id = ? AND event_type = ? ORDER BY rowid`,
    )
    .all(id, REVEALED) as Array<{ actor_type: string; payload_json: string }>;

const verdict = (overall: string, score: number) => ({
  overall,
  score,
  blocking: overall === "fail",
  judged: true,
  dimensions: [{ dimension: "correctness", score: Math.round(score), rationale: "graded" }],
  summary: "graded",
});

describe("POST /tickets/:id/judge-revealed", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("records the reveal once per round, by the person, without bumping updated_at", async () => {
    const t = inReview(h.wg);
    const before = h.wg.resolveTicket(t.id).updated_at;
    const r1 = await call(h, `/tickets/${t.id}/judge-revealed`);
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ ticket_id: t.id, recorded: true, reason: null });
    const round = h.wg.events.enteredStatusAt(t.id, "in_review")?.at;
    expect(r1.body.round_entered_at).toBe(round);
    const r2 = await call(h, `/tickets/${t.id}/judge-revealed`);
    expect(r2.body).toMatchObject({ recorded: false, reason: "already_recorded" });
    const rows = reveals(h.wg, t.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_type).toBe("human");
    expect(JSON.parse(rows[0]!.payload_json)).toEqual({ what: "judge", round_entered_at: round });
    expect(h.wg.resolveTicket(t.id).updated_at).toBe(before);
    // It is its own record: not a raw-view open, so "approved without raw logs" is unchanged.
    const raw = h.wg.db
      .prepare(
        `SELECT COUNT(*) AS n FROM work_events WHERE event_type = 'ticket.review_raw_opened'`,
      )
      .get() as { n: number };
    expect(raw.n).toBe(0);
  });

  it("records nothing for a ticket not in review; refuses an agent or the runner", async () => {
    const draft = h.wg.createTicket({ title: "Draft" }, human);
    const r = await call(h, `/tickets/${draft.id}/judge-revealed`);
    expect(r.body).toMatchObject({ recorded: false, reason: "not_in_review" });
    const t = inReview(h.wg);
    expect(() => h.wg.recordJudgeRevealed(t.id, agent)).toThrow(/Only a person/);
    expect(() => h.wg.recordJudgeRevealed(t.id, system)).toThrow(/Only a person/);
    expect(reveals(h.wg, t.id)).toHaveLength(0);
  });

  it("a read-only token cannot write it", async () => {
    const saved = process.env.DISPATCH_API_TOKEN;
    process.env.DISPATCH_API_TOKEN = "full-secret-for-judge-reveal";
    try {
      const t = inReview(h.wg);
      const r = await call(
        h,
        `/tickets/${t.id}/judge-revealed`,
        {},
        deriveReadToken("full-secret-for-judge-reveal"),
      );
      expect(r.status).toBe(403);
      expect(reveals(h.wg, t.id)).toHaveLength(0);
    } finally {
      if (saved === undefined) delete process.env.DISPATCH_API_TOKEN;
      else process.env.DISPATCH_API_TOKEN = saved;
    }
  });

  it("the review packet says when the judge's view was opened this round", () => {
    const cost = () => ({
      cost_usd: 0,
      measured_usd: 0,
      estimated_usd: 0,
      num_turns: 0,
      unknown_calls: 0,
      ledger_status: "ok" as const,
    });
    const t = inReview(h.wg);
    expect(h.wg.reviewPacket(t.id, cost).judge_revealed_at).toBeNull();
    h.wg.recordJudgeRevealed(t.id, human);
    const at = h.wg.db
      .prepare(`SELECT created_at FROM work_events WHERE event_type = ?`)
      .pluck()
      .get(REVEALED);
    expect(h.wg.reviewPacket(t.id, cost).judge_revealed_at).toBe(at);
  });
});

describe("the ticket reads hide the judge's grade while the ticket is in review", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  const get = async (path: string): Promise<Record<string, unknown>> => {
    const res = await fetch(`${h.baseUrl}${path}`);
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  type Ev = { event_type: string; payload_json: string | null };
  const judgeEvents = (events: unknown) =>
    (events as Ev[])
      .filter(
        (e) =>
          e.event_type === "ticket.eval_judged" ||
          (e.event_type === "ticket.lane_verdict" &&
            /"lane":"eval-judge"/.test(e.payload_json ?? "")),
      )
      .map((e) => JSON.parse(e.payload_json ?? "{}") as Record<string, unknown>);
  const judged = () => {
    const t = inReview(h.wg);
    h.wg.recordEvalJudgment(t.id, verdict("fail", 1.5), system);
    h.wg.recordLaneVerdict(t.id, { lane: "eval-judge", verdict: "fail" }, system);
    return t;
  };

  it("GET /tickets/:id, its events and the batched details carry no grade until the view is opened", async () => {
    const t = judged();
    const reads = async () => [
      judgeEvents((await get(`/tickets/${t.id}`)).events),
      judgeEvents((await get(`/tickets/${t.id}/events`)).events),
      judgeEvents(
        (
          (await get(`/tickets/details?ids=${t.id}&include=events`)).details as Array<{
            events: unknown;
          }>
        )[0]!.events,
      ),
    ];
    for (const evs of await reads()) {
      expect(evs).toEqual([{ hidden: true }, { lane: "eval-judge", hidden: true }]);
      expect(JSON.stringify(evs)).not.toMatch(/fail|1\.5/);
    }
    // The internal view (the packet, judge agreement, judge-view) still has it.
    expect(h.wg.view(t.id).evalJudgment).toMatchObject({ overall: "fail" });
    expect(h.wg.readerView(t.id)).toMatchObject({ evalJudgment: null, judgeHidden: true });
    await call(h, `/tickets/${t.id}/judge-revealed`);
    for (const evs of await reads()) {
      expect(evs[0]).toMatchObject({ overall: "fail" });
      expect(evs[1]).toMatchObject({ lane: "eval-judge", verdict: "fail" });
    }
    expect(h.wg.readerView(t.id)).toMatchObject({
      evalJudgment: { overall: "fail" },
      judgeHidden: false,
    });
  });

  it("a ticket out of review shows the grade; other lanes' verdicts are never hidden", async () => {
    const t = judged();
    h.wg.recordLaneVerdict(t.id, { lane: "tester", verdict: "pass" }, system);
    const lanes = ((await get(`/tickets/${t.id}`)).events as Ev[])
      .filter((e) => e.event_type === "ticket.lane_verdict")
      .map((e) => JSON.parse(e.payload_json ?? "{}") as Record<string, unknown>);
    expect(lanes.find((l) => l.lane === "tester")).toMatchObject({ verdict: "pass" });
    h.wg.db.prepare(`UPDATE tickets SET status='ready_for_merge' WHERE id=?`).run(t.id);
    const evs = judgeEvents((await get(`/tickets/${t.id}`)).events);
    expect(evs[0]).toMatchObject({ overall: "fail" });
    expect(evs[1]).toMatchObject({ verdict: "fail" });
  });
});

// BLINDING (review14/2): the reveal is recorded before the grade is shown, by ONE request.
// The review payload carries no grade while the ticket is in review and nobody opened the
// view; POST /tickets/:id/judge-revealed records the reveal and returns the grade; a
// reveal that could not be recorded returns no grade, so the decision stays blind.
describe("one request records the reveal and returns the grade", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  const packetOf = async (id: string): Promise<Record<string, unknown>> => {
    const res = await fetch(`${h.baseUrl}/tickets/${id}/dossier?include=packet`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { review_packet: Record<string, unknown> }).review_packet;
  };
  const judged = (title = "Judged") => {
    const t = inReview(h.wg, title);
    h.wg.recordEvalJudgment(t.id, verdict("fail", 1.5), system);
    return t;
  };
  const decide = (id: string) => {
    h.wg.db.prepare(`UPDATE tickets SET status='ready_for_merge' WHERE id=?`).run(id);
    writeEvent(h.wg.db, {
      entity_type: "ticket",
      entity_id: id,
      actor: human,
      event_type: "ticket.transitioned",
      payload: { from: "in_review", to: "ready_for_merge" },
    });
  };

  it("the review payload never carries the grade while the ticket is in review", async () => {
    const t = judged();
    const p = await packetOf(t.id);
    expect(p.judge).toBeNull();
    expect(p.judge_hidden).toBe(true);
    expect(p.judge_revealed_at).toBeNull();
    expect(JSON.stringify(p)).not.toMatch(/"overall"|"score":1\.5|graded/);
    // Out of review the grade is no secret: the payload carries it.
    decide(t.id);
    const after = await packetOf(t.id);
    expect(after.judge).toMatchObject({ overall: "fail", score: 1.5 });
    expect(after.judge_hidden).toBe(false);
  });

  it("a ticket with no judgment says so: nothing hidden", async () => {
    const t = inReview(h.wg, "Not judged");
    const p = await packetOf(t.id);
    expect(p.judge).toBeNull();
    expect(p.judge_hidden).toBe(false);
  });

  it("the reveal returns the grade, recorded first; the decision after it counts revealed", async () => {
    const t = judged();
    const r = await call(h, `/tickets/${t.id}/judge-revealed`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ recorded: true, reason: null });
    expect(r.body.judge).toMatchObject({ overall: "fail", score: 1.5 });
    expect(reveals(h.wg, t.id)).toHaveLength(1);
    // Asking again this round returns it again without a second record.
    const again = await call(h, `/tickets/${t.id}/judge-revealed`);
    expect(again.body).toMatchObject({ recorded: false, reason: "already_recorded" });
    expect(again.body.judge).toMatchObject({ overall: "fail" });
    expect(reveals(h.wg, t.id)).toHaveLength(1);
    // The payload now carries it (opened this round).
    expect((await packetOf(t.id)).judge).toMatchObject({ overall: "fail" });
    decide(t.id);
    const pair = readJudgeAgreement(h.wg.db).pairs.find((x) => x.ticketNumber === t.number);
    expect(pair?.seen).toBe("revealed");
  });

  it("a reveal that cannot be recorded returns no grade, and the decision counts blind", async () => {
    const t = judged();
    // The page's round is stale: the ticket went back into review since it loaded.
    const r = await call(h, `/tickets/${t.id}/judge-revealed`, {
      round_entered_at: "2000-01-01T00:00:00.000Z",
    });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).not.toMatch(/"overall"|1\.5/);
    expect(JSON.stringify(r.body)).toMatch(/reload/);
    expect(reveals(h.wg, t.id)).toHaveLength(0);
    expect((await packetOf(t.id)).judge).toBeNull();
    decide(t.id);
    const pair = readJudgeAgreement(h.wg.db).pairs.find((x) => x.ticketNumber === t.number);
    expect(pair?.seen).toBe("blind");
  });

  it("an agent is refused and gets no grade", () => {
    const t = judged();
    expect(() => h.wg.revealJudge(t.id, agent)).toThrow(/Only a person/);
    expect(reveals(h.wg, t.id)).toHaveLength(0);
  });

  it("wg judge-agreement shows no grade of a ticket in review with the view closed", async () => {
    const t = judged("Pending, closed");
    const before = readJudgeAgreement(h.wg.db);
    expect(before.pairs.find((x) => x.ticketNumber === t.number)).toBeUndefined();
    expect(before.pendingHidden).toBeGreaterThanOrEqual(1);
    expect(before.table.fail.pending).toBe(
      before.pairs.filter((p) => p.outcome === "pending" && p.overall === "fail").length,
    );
    expect(renderJudgeAgreement(before)).toMatch(/judge's view closed: their grades are not shown/);
    // Once the view is opened (recorded), the pending pair is shown like any other.
    const r = await call(h, `/tickets/${t.id}/judge-revealed`);
    expect(r.status).toBe(200);
    const after = readJudgeAgreement(h.wg.db);
    expect(after.pairs.find((x) => x.ticketNumber === t.number)).toMatchObject({
      outcome: "pending",
      overall: "fail",
    });
    expect(after.pendingHidden).toBe((before.pendingHidden ?? 0) - 1);
  });
});

describe("readJudgeAgreement splits blind from revealed decisions over a real database", () => {
  it("a decision after the reveal is revealed; one without it is blind", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const a = inReview(wg, "A");
    const b = inReview(wg, "B");
    wg.recordEvalJudgment(a.id, verdict("fail", 1.5), system);
    wg.recordEvalJudgment(b.id, verdict("fail", 1.5), system);
    wg.recordJudgeRevealed(a.id, human);
    for (const t of [a, b]) {
      wg.db.prepare(`UPDATE tickets SET status='ready_for_merge' WHERE id=?`).run(t.id);
      writeEvent(wg.db, {
        entity_type: "ticket",
        entity_id: t.id,
        actor: human,
        event_type: "ticket.transitioned",
        payload: { from: "in_review", to: "ready_for_merge" },
      });
    }
    const r = readJudgeAgreement(wg.db);
    expect(r.pairs.map((p) => [p.ticketNumber, p.seen])).toEqual([
      [a.number, "revealed"],
      [b.number, "blind"],
    ]);
    expect(r.blinding).toMatchObject({ blind: 1, revealed: 1, blindSince: null });
    expect(r.falseAlarms.map((f) => f.ticketNumber)).toEqual([b.number]);
    wg.db.close();
  });
});

describe("the v33 migration stamps when an existing database started hiding the grade", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "judge-blind-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a new database gets no stamp; one migrated from v32 does, once", () => {
    const db = join(dir, "d.sqlite");
    let wg = Dispatch.open(db, new TestClock());
    expect(readJudgeBlindSince(wg.db)).toBeNull();
    // Pretend this is a v32 database from before the hidden view.
    wg.db.prepare(`UPDATE schema_meta SET value = '32' WHERE key = 'schema_version'`).run();
    wg.db.close();
    wg = Dispatch.open(db, new TestClock());
    const stamped = readJudgeBlindSince(wg.db);
    expect(stamped).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    wg.db.prepare(`UPDATE schema_meta SET value = '32' WHERE key = 'schema_version'`).run();
    wg.db.close();
    wg = Dispatch.open(db, new TestClock());
    expect(readJudgeBlindSince(wg.db)).toBe(stamped);
    const key = wg.db
      .prepare(`SELECT COUNT(*) AS n FROM schema_meta WHERE key = ?`)
      .get(JUDGE_BLIND_SINCE_KEY) as { n: number };
    expect(key.n).toBe(1);
    wg.db.close();
  });
});

describe.skipIf(!CLI_BUILT)("wg review judge-view (built CLI)", { timeout: 60_000 }, () => {
  it("wg ticket show hides the grade in review and says how to see it", () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-show-"));
    try {
      const db = join(dir, "d.sqlite");
      const wg = Dispatch.open(db, new TestClock());
      const t = inReview(wg);
      wg.recordEvalJudgment(t.id, verdict("borderline", 3.2), system);
      wg.db.close();
      const show = () =>
        JSON.parse(runBin(db, ["ticket", "show", String(t.number)]).stdout) as {
          evalJudgment: unknown;
          evalJudgmentHidden?: string;
          events: Array<{ event_type: string; payload_json: string }>;
        };
      const hidden = show();
      expect(hidden.evalJudgment).toBeNull();
      expect(hidden.evalJudgmentHidden).toBe(
        `judge: hidden until you decide (wg review judge-view ${t.number} to see it)`,
      );
      const ev = hidden.events.find((e) => e.event_type === "ticket.eval_judged");
      expect(JSON.parse(ev!.payload_json)).toEqual({ hidden: true });
      runBin(db, ["review", "judge-view", String(t.number)], { env: { USER: "tom" } });
      const open = show();
      expect(open.evalJudgment).toMatchObject({ overall: "borderline" });
      expect(open.evalJudgmentHidden).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints the grade and records the reveal, once per round", () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-view-"));
    try {
      const db = join(dir, "d.sqlite");
      const wg = Dispatch.open(db, new TestClock());
      const t = inReview(wg);
      wg.recordEvalJudgment(t.id, verdict("borderline", 3.2), system);
      wg.db.close();
      const r1 = runBin(db, ["review", "judge-view", String(t.number)], {
        env: { USER: "tom" },
      });
      expect(r1.status).toBe(0);
      const out = JSON.parse(r1.stdout) as {
        recorded: boolean;
        judge: { overall: string; score: number } | null;
      };
      expect(out.recorded).toBe(true);
      expect(out.judge).toMatchObject({ overall: "borderline", score: 3.2 });
      const r2 = runBin(db, ["review", "judge-view", String(t.number)], { env: { USER: "tom" } });
      expect(JSON.parse(r2.stdout)).toMatchObject({ recorded: false, reason: "already_recorded" });
      const check = Dispatch.open(db, new TestClock());
      expect(reveals(check, t.id).map((r) => r.actor_type)).toEqual(["human"]);
      check.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // review14/2: the terminal goes through the same record-then-return path, so a reveal
  // that cannot be recorded prints no grade.
  it("prints no grade when the reveal cannot be recorded", () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-view-refused-"));
    try {
      const db = join(dir, "d.sqlite");
      const wg = Dispatch.open(db, new TestClock());
      // In review with no recorded entry into review: no round to record the reveal in.
      const t = wg.createTicket({ title: "No round" }, human);
      wg.db.prepare(`UPDATE tickets SET status='in_review' WHERE id=?`).run(t.id);
      wg.recordEvalJudgment(t.id, verdict("borderline", 3.2), system);
      wg.db.close();
      const r = runBin(db, ["review", "judge-view", String(t.number)], { env: { USER: "tom" } });
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).not.toMatch(/borderline|3\.2/);
      const check = Dispatch.open(db, new TestClock());
      expect(reveals(check, t.id)).toHaveLength(0);
      check.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
