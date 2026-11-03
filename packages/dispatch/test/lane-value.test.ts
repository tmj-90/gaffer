/**
 * SPECIALIST VALUE REPORT (gap-specialists D1): for each judging lane, how often its verdict
 * differed from the person's decision on the same attempt, how often it was the only lane
 * that caught a send-back, and its ledger cost per attempt. Counts only: no recommendation,
 * and a safety lane is never switched off by these figures. Hand-worked fixture.
 */
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import { computeStats, renderStats } from "../src/cli/ops.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { writeEvent } from "../src/events/eventWriter.js";
import type { HealthRow } from "../src/health/healthAggregator.js";
import { laneValueReport, type LaneValueVerdict } from "../src/health/laneValue.js";
import { TestClock } from "../src/util/clock.js";

const MIN = 60_000;
const T0 = Date.parse("2026-06-01T09:00:00.000Z");
const at = (m: number) => T0 + m * MIN;
const tr = (
  ticketId: string,
  from: string | null,
  to: string,
  m: number,
  actorType = "system",
  reason: string | null = null,
) => ({ ticketId, actorType, fromStatus: from, toStatus: to, reason, atMs: at(m) });
const v = (ticketId: string, lane: string, verdict: string, m: number): LaneValueVerdict => ({
  ticketId,
  lane,
  verdict,
  atMs: at(m),
});
const row = (
  ticket: number,
  kind: string,
  usd: number,
  attempt_id: string | null,
  estimated = 0,
): HealthRow => ({
  ts: new Date(at(0)).toISOString(),
  ticket,
  kind,
  measured: estimated === 0,
  total_cost_usd: usd,
  estimated_cost_usd: estimated,
  num_turns: 1,
  duration_ms: 1000,
  models: {},
  attempt_id,
});

// Ticket A (two attempts):
//   attempt 1 (claim at 0): agent-review approve (12), security-review changes (12), the
//     person sends it back (20). The security lane was the only lane that blocked: a unique
//     catch, and it agreed with the person; agent-review differed (it passed, the person
//     blocked). The tester's held verdict (15) is no position.
//   attempt 2 (claim at 30): agent-review approve, security approve, the person approves
//     (50) into testing; the tester FAILS and sends it back (55, system), recording its
//     verdict after its own transition (56): it still belongs to attempt 2 (the next start
//     of work is at 60). The tester differed from the person (fail vs approve) and was the
//     only lane that caught the send-back.
//   attempt 3 (claim at 60): agent-review approve, tester pass, eval-judge borderline, the
//     person approves (80), done (90).
// Ticket B (one attempt): agent-review changes (5) sends it back as the agent (6): the
//   agent reviewer's unique catch with no person deciding (so not compared).
// Ticket C (one attempt): agent-review approve (5), the person sends it back (10): a
//   send-back no lane caught; agent-review differed.
const transitions = [
  tr("A", "ready", "in_progress", 0),
  tr("A", "in_progress", "in_review", 10),
  tr("A", "in_review", "refining", 20, "human"),
  tr("A", "refining", "ready", 25, "human"),
  tr("A", "ready", "in_progress", 30),
  tr("A", "in_progress", "in_review", 40),
  tr("A", "in_review", "in_testing", 50, "human"),
  tr("A", "in_testing", "refining", 55, "system"),
  tr("A", "refining", "ready", 58, "human"),
  tr("A", "ready", "in_progress", 60),
  tr("A", "in_progress", "in_review", 70),
  tr("A", "in_review", "in_testing", 80, "admin"),
  tr("A", "in_testing", "ready_for_merge", 85),
  tr("A", "ready_for_merge", "done", 90),
  tr("B", "ready", "in_progress", 0),
  tr("B", "in_progress", "in_review", 4),
  tr("B", "in_review", "ready", 6, "agent"),
  tr("C", "ready", "in_progress", 0),
  tr("C", "in_progress", "in_review", 4),
  tr("C", "in_review", "refining", 10, "human"),
];
const verdicts = [
  v("A", "agent-review", "approve", 12),
  v("A", "security-review", "changes", 12),
  v("A", "tester", "held", 15),
  v("A", "agent-review", "approve", 42),
  v("A", "security-review", "approve", 42),
  v("A", "tester", "fail", 56),
  v("A", "agent-review", "approve", 72),
  v("A", "tester", "pass", 84),
  v("A", "eval-judge", "borderline", 75),
  v("B", "agent-review", "changes", 5),
  v("C", "agent-review", "approve", 5),
];
const ledger = [
  // review: 5 calls over 5 attempts ($0.10 each) -> $0.10 per attempt
  row(1, "review", 0.1, "c1/1"),
  row(1, "review", 0.1, "c1/2"),
  row(1, "review", 0.1, "c1/3"),
  row(2, "review", 0.1, "c2/1"),
  row(3, "review", 0.1, "c3/1"),
  // security-review: two calls, one attempt-less row counted as its own attempt
  row(1, "security-review", 0.3, "c1/1"),
  row(1, "security-review", 0.1, null, 0.2),
  // tester: three calls over two attempts ($0.9) -> $0.45
  row(1, "tester", 0.3, "c1/2"),
  row(1, "tester", 0.3, "c1/2"),
  row(1, "tester", 0.3, "c1/3"),
  // a delivery row is nobody's lane
  row(1, "delivery", 5, "c1/1"),
];

describe("lane value read model (hand-worked fixture)", () => {
  const r = laneValueReport({ transitions, verdicts, ledger });
  const lane = (name: string) => r.lanes.find((l) => l.lane === name)!;

  it("segments attempts from each start of work and counts the send-backs", () => {
    expect(r.attempts).toBe(5);
    expect(r.attempts_with_person_decision).toBe(4);
    expect(r.send_backs).toBe(4);
    // C's send-back: no lane blocked, a person caught it.
    expect(r.send_backs_no_lane_caught).toBe(1);
  });

  it("agent reviewer: differed from the person twice, one unique catch with no person", () => {
    expect(lane("agent-review")).toMatchObject({
      verdicts_recorded: 5,
      by_verdict: { approve: 4, changes: 1 },
      attempts_judged: 5,
      compared: 4,
      differed: 2,
      differed_lane_passed: 2,
      differed_lane_blocked: 0,
      unique_catches: 1,
      spend_usd: 0.5,
      ledger_attempts: 5,
      cost_per_attempt_usd: 0.1,
      note: null,
    });
  });

  it("security review: agreed both times and was the only lane on A's first send-back", () => {
    expect(lane("security-review")).toMatchObject({
      safety: true,
      verdicts_recorded: 2,
      compared: 2,
      differed: 0,
      unique_catches: 1,
      spend_usd: 0.6,
      ledger_attempts: 2,
      cost_per_attempt_usd: 0.3,
    });
  });

  it("tester: its verdict after its own transition still belongs to the attempt it judged", () => {
    expect(lane("tester")).toMatchObject({
      safety: true,
      verdicts_recorded: 3,
      by_verdict: { held: 1, fail: 1, pass: 1 },
      attempts_judged: 3,
      compared: 2,
      differed: 1,
      differed_lane_blocked: 1,
      unique_catches: 1,
      spend_usd: 0.9,
      ledger_attempts: 2,
      cost_per_attempt_usd: 0.45,
    });
  });

  it("eval judge: a borderline grade takes no position; no ledger rows reads as no spend", () => {
    expect(lane("eval-judge")).toMatchObject({
      verdicts_recorded: 1,
      compared: 0,
      differed: 0,
      unique_catches: 0,
      spend_usd: 0,
      cost_per_attempt_usd: null,
    });
  });

  it("plan debate records no verdict, and says so", () => {
    expect(lane("plan-debate")).toMatchObject({
      verdicts_recorded: 0,
      compared: 0,
      spend_usd: null,
      note: "no verdicts recorded",
    });
  });

  it("recommends nothing and says a safety lane is never switched off by telemetry", () => {
    expect(r.footnote).toMatch(/never switched off by telemetry/);
    expect(JSON.stringify(r)).not.toMatch(/disable|turn off|recommend(?!ation)/i);
  });

  it("an empty factory: every lane says no verdicts recorded", () => {
    const e = laneValueReport({ transitions: [], verdicts: [], ledger: [] });
    expect(e.lanes.every((l) => l.note === "no verdicts recorded")).toBe(true);
    expect(e.attempts).toBe(0);
  });
});

describe("wg stats: what each lane changed", () => {
  it("prints a line per lane, no verdicts recorded where there are none, and the footnote", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    try {
      const out = renderStats(computeStats(wg.db, new Date().toISOString(), {}));
      expect(out).toMatch(/What each lane changed \(0 attempts/);
      expect(out).toMatch(/Plan debate: no verdicts recorded/);
      expect(out).toMatch(/never switched off by telemetry/);
    } finally {
      wg.db.close();
    }
  });
});

describe("GET /api/health lane_value", () => {
  it("serves the report from the recorded lane verdicts", async () => {
    process.env.DISPATCH_AUDIT_OFF = "1";
    const wg = Dispatch.open(":memory:", new TestClock());
    const human: Actor = { type: "human", id: "tom" };
    const system: Actor = { type: "system" };
    const server = createApiServer(wg);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const t = wg.createTicket({ title: "Judged" }, human);
      const move = (from: string, to: string, actor: Actor) =>
        writeEvent(wg.db, {
          entity_type: "ticket",
          entity_id: t.id,
          actor,
          event_type: "ticket.transitioned",
          payload: { from, to, reason: "x" },
        });
      move("ready", "in_progress", system);
      move("in_progress", "in_review", system);
      wg.recordLaneVerdict(t.id, { lane: "security-review", verdict: "changes" }, system);
      move("in_review", "refining", human);
      const port = (server.address() as AddressInfo).port;
      const body = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as {
        lane_value: { lanes: Array<{ lane: string; unique_catches: number; compared: number }> };
      };
      const sec = body.lane_value.lanes.find((l) => l.lane === "security-review");
      expect(sec).toMatchObject({ unique_catches: 1, compared: 1 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      wg.db.close();
    }
  });
});
