/**
 * REVIEW MEASURES, worked by hand (Release A metrics package review).
 *
 * Three crafted done tickets, every number below computed by hand from the timeline:
 *
 *   A  multi-round, human: entered review at 0, opened at 20, a human sent it back at 30
 *      (queue 20, decision 10); back in review at 60, no open recorded, a human approved
 *      at 100 (full span 40). Human review time: 10 + 40 = 50 minutes. Mixed basis.
 *   B  agent-approved: entered at 0, a person glanced at 5, the reviewer agent approved at
 *      15. No human decision: counted apart, never as zero minutes. A runner retry before
 *      review makes it fail the strict first-pass reading only.
 *   C  reopened: entered at 0, opened at 10, run log opened at 12, a human approved at 25
 *      (queue 10, decision 15), landed; reopened out of done at 200, opened at 230, an
 *      admin approved at 240 (queue 30, decision 10). Human review time: 25 minutes.
 *
 * And first-pass acceptance must agree with the send-back timeline (health/sendBacks.ts,
 * which feeds the rework rate) on the same transitions: a ticket with a review send-back
 * is never first-pass, and a first-pass ticket has no review send-back.
 */
import { describe, expect, it } from "vitest";

import { firstPassAcceptance } from "../src/health/firstPass.js";
import { reviewTimeReport } from "../src/health/reviewTime.js";
import { sendBacksByTicket } from "../src/health/sendBacks.js";

const MIN = 60_000;
const T0 = Date.parse("2026-11-01T10:00:00.000Z");
const at = (m: number): number => T0 + m * MIN;
const iso = (m: number): string => new Date(at(m)).toISOString();
const tr = (
  ticketId: string,
  from: string | null,
  to: string,
  m: number,
  actorType = "system",
  reason: string | null = null,
) => ({ ticketId, actorType, fromStatus: from, toStatus: to, reason, atMs: at(m) });

const transitions = [
  tr("A", "in_progress", "in_review", 0),
  tr("A", "in_review", "refining", 30, "human", "needs a test"),
  tr("A", "in_progress", "in_review", 60),
  tr("A", "in_review", "ready_for_merge", 100, "human"),
  tr("A", "ready_for_merge", "done", 101),
  tr("B", "in_progress", "in_review", 0),
  tr("B", "in_review", "ready_for_merge", 15, "agent"),
  tr("B", "ready_for_merge", "done", 16),
  tr("C", "in_progress", "in_review", 0),
  tr("C", "in_review", "ready_for_merge", 25, "human"),
  tr("C", "ready_for_merge", "done", 26),
  tr("C", "done", "in_review", 200, "system", "conflict_reopen"),
  tr("C", "in_review", "ready_for_merge", 240, "admin"),
  tr("C", "ready_for_merge", "done", 241),
];
const opens = [
  { ticketId: "A", atMs: at(20) },
  { ticketId: "B", atMs: at(5) },
  { ticketId: "C", atMs: at(10) },
  { ticketId: "C", atMs: at(230) },
];
const rawOpens = [{ ticketId: "C", atMs: at(12), what: "run_log" }];
const tickets = ["A", "B", "C"].map((id) => ({ id, status: "done" }));
const retries = [{ ticketId: "B", at: iso(-3) }];

describe("review time on three crafted tickets", () => {
  const r = reviewTimeReport({ transitions, opens, rawOpens, tickets });

  it("per accepted ticket: A 50 and C 25 minutes, B counted apart", () => {
    // sorted [25, 50]: median 37.5, p75 25 + 0.75 * 25 = 43.75, p90 25 + 0.9 * 25 = 47.5
    expect(r.per_accepted_ticket).toEqual({
      n: 2,
      median_ms: 37.5 * MIN,
      p75_ms: 43.75 * MIN,
      p90_ms: 47.5 * MIN,
    });
    expect(r.accepted_without_human_decision).toBe(1);
  });

  it("basis is mixed (A's second round has no open), and the agent round is not counted", () => {
    expect(r.basis).toBe("mixed");
    expect(r.rounds).toEqual({ human_decided: 4, with_open_event: 3 });
    // queue waits A 20, C 10, C 30; decisions A 10, C 15, C 10
    expect(r.queue_wait.median_ms).toBe(20 * MIN);
    expect(r.decision.median_ms).toBe(10 * MIN);
    // spans 30, 40, 25, 40 -> sorted [25, 30, 40, 40]: median 35, p75 and p90 40
    expect(r.review_ready_to_decision).toEqual({
      n: 4,
      median_ms: 35 * MIN,
      p75_ms: 40 * MIN,
      p90_ms: 40 * MIN,
    });
  });

  it("approved without raw logs reads the approving round only (C's run log was round 1)", () => {
    // A's approving round has no open: not instrumented. C's approving round (200-240)
    // has an open and no raw open in it.
    expect(r.approved_without_raw_logs).toEqual({ instrumented: 1, count: 1, pct: 100 });
  });
});

describe("first-pass acceptance on the same tickets", () => {
  const f = firstPassAcceptance({ transitions, retries, tickets });

  it("only B is first-pass; the strict reading drops it for its runner retry", () => {
    expect(f.done).toBe(3);
    expect(f.first_pass).toBe(1);
    expect(f.rate_pct).toBe(33.3);
    expect(f.strict).toEqual({ first_pass: 0, rate_pct: 0 });
  });

  it("splits by approver: A and C human (an admin is a person), B agent", () => {
    expect(f.by_approver.human).toEqual({ done: 2, first_pass: 0, rate_pct: 0 });
    expect(f.by_approver.agent).toEqual({ done: 1, first_pass: 1, rate_pct: 100 });
    expect(f.by_approver.system).toEqual({ done: 0, first_pass: 0, rate_pct: null });
  });
});

describe("first-pass agrees with the send-back timeline", () => {
  // D: a legacy park to blocked out of review WITHOUT the retry-cap reason. The send-back
  // timeline does not count it as a send-back, so first-pass must not either.
  const withLegacy = [
    ...transitions,
    tr("D", "in_progress", "in_review", 0),
    tr("D", "in_review", "blocked", 5, "human", "waiting on the vendor"),
    tr("D", "blocked", "ready", 6, "human"),
    tr("D", "in_progress", "in_review", 8),
    tr("D", "in_review", "ready_for_merge", 9, "human"),
    tr("D", "ready_for_merge", "done", 10),
    // E: parked by the retry cap: a send-back in both.
    tr("E", "in_progress", "in_review", 0),
    tr("E", "in_review", "blocked", 5, "agent", "retry_cap_reached:still failing"),
    tr("E", "blocked", "ready", 6, "human"),
    tr("E", "in_progress", "in_review", 8),
    tr("E", "in_review", "ready_for_merge", 9, "human"),
    tr("E", "ready_for_merge", "done", 10),
  ];
  const all = [...tickets, { id: "D", status: "done" }, { id: "E", status: "done" }];

  it("never disagrees on which ticket was sent back after review", () => {
    const f = firstPassAcceptance({ transitions: withLegacy, retries: [], tickets: all });
    const backs = sendBacksByTicket(
      withLegacy.map((t) => ({
        ticketId: t.ticketId,
        fromStatus: t.fromStatus,
        toStatus: t.toStatus,
        reason: t.reason,
        at: new Date(t.atMs).toISOString(),
      })),
      [],
    );
    const reviewBack = (id: string) => (backs.get(id) ?? []).some((b) => b.source === "review");
    // Reopened out of done (C) is a first-pass miss that is not a send-back; nothing else
    // may differ.
    const reopened = new Set(["C"]);
    const firstPassIds = all.map((t) => t.id).filter((id) => !reviewBack(id) && !reopened.has(id));
    expect(firstPassIds.sort()).toEqual(["B", "D"]);
    expect(f.first_pass).toBe(firstPassIds.length);
  });
});

describe("a won't-do round is not an approval", () => {
  it("a person's won't-do, reopened and then agent-approved, is not an instrumented approval", () => {
    const f = [
      tr("F", "in_progress", "in_review", 0),
      tr("F", "in_review", "cancelled", 10, "human", "wont_do"),
      tr("F", "cancelled", "refining", 20, "human"),
      tr("F", "in_progress", "in_review", 30),
      tr("F", "in_review", "ready_for_merge", 31, "agent"),
      tr("F", "ready_for_merge", "done", 32),
    ];
    const r = reviewTimeReport({
      transitions: f,
      opens: [{ ticketId: "F", atMs: at(5) }],
      rawOpens: [],
      tickets: [{ id: "F", status: "done" }],
    });
    expect(r.approved_without_raw_logs).toEqual({ instrumented: 0, count: 0, pct: null });
  });
});
