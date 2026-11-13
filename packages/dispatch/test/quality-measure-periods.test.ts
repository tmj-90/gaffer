/**
 * THE FOUR QUALITY MEASURES OVER A PERIOD, worked by hand (dashboard visual pass, P3).
 *
 * Now is Friday 2026-11-13 12:00 UTC: the current ISO week is 2026-W46 (Monday
 * 2026-11-09), twelve weeks of history run from 2026-W35 (2026-08-24), six months from
 * 2026-06. A 7-day window runs from 2026-11-06 12:00; the previous one from 2026-10-30
 * 12:00 to 2026-11-06 12:00.
 *
 * Five done tickets (H = hours):
 *   A  in review at d-2, opened 30 minutes in, a human approved at +1H, done at +2H.
 *      First pass; decision time 30 minutes; a runner retry makes it fail the strict
 *      reading. Accepted 2026-11-11 (W46): in the window.
 *   B  in review at d-3, a human sent it back at +1H (no open: 60 minutes), back in
 *      review at +2H, opened at +3H, a human approved at +4H (60 minutes), done at +5H.
 *      Not first pass; 120 minutes. Accepted 2026-11-10 (W46): in the window.
 *   C  the reviewer agent approved at d-10, done 1H later. First pass, no human decision.
 *      Accepted 2026-11-03 (W45): the previous window.
 *   D  a human approved at d-50 - 1H after an hour in review (no open), done at d-50.
 *      First pass; 60 minutes. Accepted 2026-09-24 (W39): in neither window.
 *   E  done with no recorded transition (an import): all time only.
 * Two more for cost: F parked (moved to blocked at d-1), G in flight.
 */
import { describe, expect, it } from "vitest";

import { acceptedChangeCost } from "../src/health/acceptedChange.js";
import { escapedDefectReport } from "../src/health/escapedDefects.js";
import { firstPassAcceptance } from "../src/health/firstPass.js";
import type { HealthRow } from "../src/health/healthAggregator.js";
import { monthGrid, weekGrid, wilsonUpperPct } from "../src/health/measurePeriods.js";
import { reviewTimeReport } from "../src/health/reviewTime.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const d = (days: number, hours = 0, minutes = 0): number =>
  NOW - days * DAY + hours * HOUR + minutes * MIN;
const tr = (
  ticketId: string,
  from: string | null,
  to: string,
  atMs: number,
  actorType = "system",
  reason: string | null = null,
) => ({ ticketId, actorType, fromStatus: from, toStatus: to, reason, atMs });

const transitions = [
  tr("A", "in_progress", "in_review", d(2)),
  tr("A", "in_review", "ready_for_merge", d(2, 1), "human"),
  tr("A", "ready_for_merge", "done", d(2, 2)),
  tr("B", "in_progress", "in_review", d(3)),
  tr("B", "in_review", "refining", d(3, 1), "human", "needs a test"),
  tr("B", "in_progress", "in_review", d(3, 2)),
  tr("B", "in_review", "ready_for_merge", d(3, 4), "human"),
  tr("B", "ready_for_merge", "done", d(3, 5)),
  tr("C", "in_progress", "in_review", d(10, -1)),
  tr("C", "in_review", "ready_for_merge", d(10), "agent"),
  tr("C", "ready_for_merge", "done", d(10, 1)),
  tr("D", "in_progress", "in_review", d(50, -2)),
  tr("D", "in_review", "ready_for_merge", d(50, -1), "human"),
  tr("D", "ready_for_merge", "done", d(50)),
  tr("F", "in_progress", "in_review", d(1, -2)),
  tr("F", "in_review", "blocked", d(1), "human"),
  tr("G", "ready", "in_progress", d(1)),
];
const opens = [
  { ticketId: "A", atMs: d(2, 0, 30) },
  { ticketId: "B", atMs: d(3, 3) },
];
const doneTickets = ["A", "B", "C", "D", "E"].map((id) => ({ id, status: "done" }));
const retries = [{ ticketId: "A", at: new Date(d(2, -3)).toISOString() }];

describe("the period grid", () => {
  it("twelve ISO weeks ending in the current one, keyed by ISO week and Monday", () => {
    const g = weekGrid(NOW);
    expect(g.buckets).toHaveLength(12);
    expect(g.buckets[11]).toEqual({ week: "2026-W46", start: "2026-11-09", partial: true });
    expect(g.buckets[0]).toEqual({ week: "2026-W35", start: "2026-08-24", partial: false });
    expect(g.indexOf(Date.parse("2026-11-09T00:00:00.000Z"))).toBe(11);
    expect(g.indexOf(Date.parse("2026-11-08T23:59:59.999Z"))).toBe(10);
    expect(g.indexOf(Date.parse("2026-08-23T23:59:59.999Z"))).toBe(-1);
    // A time after now is in no bucket, nor is an unknown one.
    expect(g.indexOf(NOW + MIN)).toBe(-1);
    expect(g.indexOf(Number.NaN)).toBe(-1);
  });

  it("names the ISO week across a year end (2026 has 53 weeks)", () => {
    const g = weekGrid(Date.parse("2027-01-02T12:00:00.000Z"));
    expect(g.buckets[11]).toMatchObject({ week: "2026-W53", start: "2026-12-28" });
    const h = weekGrid(Date.parse("2027-01-04T00:00:00.000Z"));
    expect(h.buckets[11]).toMatchObject({ week: "2027-W01", start: "2027-01-04" });
  });

  it("six calendar months ending in the current one", () => {
    const g = monthGrid(NOW);
    expect(g.buckets.map((b) => b.month)).toEqual([
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
      "2026-11",
    ]);
    expect(g.buckets[5]!.partial).toBe(true);
    expect(g.indexOf(Date.parse("2026-06-01T00:00:00.000Z"))).toBe(0);
    expect(g.indexOf(Date.parse("2026-05-31T23:59:59.999Z"))).toBe(-1);
  });

  it("the Wilson 95% upper bound: 0 of 11 could be up to 25.9%", () => {
    expect(wilsonUpperPct(0, 11)).toBe(25.9);
    expect(wilsonUpperPct(0, 3)).toBe(56.2);
    expect(wilsonUpperPct(4, 4)).toBe(100);
    expect(wilsonUpperPct(0, 0)).toBeNull();
  });
});

describe("first-pass acceptance over a period", () => {
  it("without a window: all time, as before, with no previous", () => {
    const r = firstPassAcceptance({ transitions, retries, tickets: doneTickets }, { nowMs: NOW });
    expect(r.window_days).toBeNull();
    expect(r.previous).toBeNull();
    // A, C, D, E first pass; B sent back: 4 of 5.
    expect(r).toMatchObject({ done: 5, first_pass: 4, rate_pct: 80 });
    expect(r.all_time).toEqual({ done: 5, first_pass: 4, rate_pct: 80 });
  });

  it("a 7-day window by acceptance time, the 7 days before it, and the all-time figure", () => {
    const r = firstPassAcceptance(
      { transitions, retries, tickets: doneTickets },
      { nowMs: NOW, windowDays: 7 },
    );
    expect(r.window_days).toBe(7);
    // A and B accepted in the window: A first pass, B sent back.
    expect(r).toMatchObject({ done: 2, first_pass: 1, rate_pct: 50 });
    // Strict: A was retried by the runner, B sent back.
    expect(r.strict).toEqual({ first_pass: 0, rate_pct: 0 });
    expect(r.by_approver.human).toEqual({ done: 2, first_pass: 1, rate_pct: 50 });
    expect(r.by_approver.agent).toEqual({ done: 0, first_pass: 0, rate_pct: null });
    expect(r.previous).toEqual({
      since: "2026-10-30T12:00:00.000Z",
      until: "2026-11-06T12:00:00.000Z",
      done: 1,
      first_pass: 1,
      rate_pct: 100,
      strict: { first_pass: 1, rate_pct: 100 },
    });
    expect(r.all_time).toEqual({ done: 5, first_pass: 4, rate_pct: 80 });
  });

  it("twelve weeks by acceptance time; an empty week is done 0 with a null rate", () => {
    const r = firstPassAcceptance({ transitions, retries, tickets: doneTickets }, { nowMs: NOW });
    expect(r.by_week).toHaveLength(12);
    const week = (k: string) => r.by_week.find((w) => w.week === k);
    expect(week("2026-W46")).toEqual({
      week: "2026-W46",
      start: "2026-11-09",
      partial: true,
      done: 2,
      first_pass: 1,
      rate_pct: 50,
    });
    expect(week("2026-W45")).toMatchObject({ done: 1, first_pass: 1, rate_pct: 100 });
    expect(week("2026-W39")).toMatchObject({ done: 1, first_pass: 1, rate_pct: 100 });
    // Never a zero rate or the week before's value: nothing was accepted in W44 or W40.
    expect(week("2026-W44")).toMatchObject({ done: 0, first_pass: 0, rate_pct: null });
    expect(week("2026-W40")).toMatchObject({ done: 0, first_pass: 0, rate_pct: null });
    // E has no acceptance time: in all time, in no week.
    expect(r.by_week.reduce((k, w) => k + w.done, 0)).toBe(4);
  });
});

describe("human review time over a period", () => {
  const input = { transitions, opens, rawOpens: [], tickets: doneTickets };

  it("without a window: all time, as before", () => {
    const r = reviewTimeReport(input, { nowMs: NOW });
    expect(r.window_days).toBeNull();
    expect(r.previous).toBeNull();
    // A 30, D 60, B 120 minutes; C (agent) and E (no human decision) apart.
    expect(r.per_accepted_ticket).toMatchObject({ n: 3, median_ms: 60 * MIN });
    expect(r.accepted_without_human_decision).toBe(2);
  });

  it("a 7-day window by each ticket's last human decision, and the 7 days before it", () => {
    const r = reviewTimeReport(input, { nowMs: NOW, windowDays: 7 });
    expect(r.window_days).toBe(7);
    // A 30 and B 120 (both of B's rounds, counted at its last decision): median 75.
    expect(r.per_accepted_ticket).toMatchObject({ n: 2, median_ms: 75 * MIN });
    expect(r.accepted_without_human_decision).toBe(0);
    // Rounds decided in the window: A's, B's two and F's (a human parked it at d-1).
    expect(r.rounds).toEqual({ human_decided: 4, with_open_event: 2 });
    expect(r.basis).toBe("mixed");
    // C, accepted in the previous window, had no human decision.
    expect(r.previous).toEqual({
      since: "2026-10-30T12:00:00.000Z",
      until: "2026-11-06T12:00:00.000Z",
      per_accepted_ticket: { n: 0, median_ms: null, p75_ms: null, p90_ms: null },
      accepted_without_human_decision: 1,
    });
  });

  it("twelve weeks of the per-ticket median; an empty week is n 0 with a null median", () => {
    const r = reviewTimeReport(input, { nowMs: NOW });
    const week = (k: string) => r.by_week.find((w) => w.week === k);
    expect(week("2026-W46")).toEqual({
      week: "2026-W46",
      start: "2026-11-09",
      partial: true,
      n: 2,
      median_ms: 75 * MIN,
    });
    expect(week("2026-W39")).toMatchObject({ n: 1, median_ms: 60 * MIN });
    expect(week("2026-W45")).toMatchObject({ n: 0, median_ms: null });
  });
});

describe("cost per accepted change over a period", () => {
  const tickets = [
    { id: "A", number: 1, status: "done" },
    { id: "B", number: 2, status: "done" },
    { id: "C", number: 3, status: "done" },
    { id: "F", number: 6, status: "blocked" },
    { id: "G", number: 7, status: "in_progress" },
  ];
  const row = (
    ticket: number | null,
    usd: number,
    tsMs: number,
    attempt: string | null,
  ): HealthRow => ({
    ts: new Date(tsMs).toISOString(),
    ticket,
    kind: attempt ? "delivery" : "review",
    measured: true,
    total_cost_usd: usd,
    num_turns: 1,
    duration_ms: 1,
    models: {},
    attempt_id: attempt,
  });
  const rows = [
    row(1, 1, d(3), "a/1"),
    row(1, 2, d(3), "a/1"),
    row(2, 2, d(4), "b/1"),
    row(2, 3, d(4), "b/2"),
    row(3, 2, d(11), "c/1"),
    row(6, 4, d(2), "f/1"),
    row(7, 10, d(1), "g/1"),
    row(null, 0.5, d(1), null),
    row(null, 1, d(100), null),
  ];

  it("without a window: all time, the same figures as before", () => {
    const r = acceptedChangeCost(rows, tickets, transitions, { nowMs: NOW });
    expect(r.window_days).toBeNull();
    expect(r.previous).toBeNull();
    // Every ticket's spend (24) over the three done.
    expect(r).toMatchObject({
      accepted_changes: 3,
      attributed_spend_usd: 24,
      unattributed_usd: 1.5,
      cost_per_accepted_change_usd: 8,
      attempts_per_accepted_change: 2,
    });
    expect(r.by_outcome.in_flight).toEqual({ tickets: 1, spend_usd: 10, delivery_attempts: 1 });
  });

  it("a 7-day window by settle time: a parked ticket counts where it parked, one in flight nowhere", () => {
    const r = acceptedChangeCost(rows, tickets, transitions, { nowMs: NOW, windowDays: 7 });
    expect(r.window_days).toBe(7);
    // A (3), B (5) accepted and F (4) parked in the window; G in flight is in no period.
    expect(r).toMatchObject({
      accepted_changes: 2,
      attributed_spend_usd: 12,
      unattributed_usd: 0.5,
      cost_per_accepted_change_usd: 6,
      accepted_only_cost_per_change_usd: 4,
      attempts_per_accepted_change: 2,
    });
    expect(r.by_outcome.parked_or_failed).toEqual({
      tickets: 1,
      spend_usd: 4,
      delivery_attempts: 1,
    });
    expect(r.by_outcome.in_flight).toEqual({ tickets: 0, spend_usd: 0, delivery_attempts: 0 });
    expect(r.previous).toEqual({
      since: "2026-10-30T12:00:00.000Z",
      until: "2026-11-06T12:00:00.000Z",
      accepted_changes: 1,
      attributed_spend_usd: 2,
      cost_per_accepted_change_usd: 2,
      attempts_per_accepted_change: 1,
    });
  });

  it("twelve weeks by settle time; a week with nothing settled has a null cost", () => {
    const r = acceptedChangeCost(rows, tickets, transitions, { nowMs: NOW });
    const week = (k: string) => r.by_week.find((w) => w.week === k);
    expect(week("2026-W46")).toEqual({
      week: "2026-W46",
      start: "2026-11-09",
      partial: true,
      accepted: 2,
      spend_usd: 12,
      cost_per_accepted_change_usd: 6,
    });
    expect(week("2026-W45")).toMatchObject({
      accepted: 1,
      spend_usd: 2,
      cost_per_accepted_change_usd: 2,
    });
    expect(week("2026-W44")).toMatchObject({
      accepted: 0,
      spend_usd: 0,
      cost_per_accepted_change_usd: null,
    });
  });
});

describe("escaped-defect rate over a period", () => {
  const link = (regressionOf: string) => ({
    ticketId: `defect-of-${regressionOf}`,
    regressionOf,
    filedBy: { type: "human", id: "tom" },
    filedAt: new Date(NOW).toISOString(),
    note: null,
  });

  it("0 of 3 in the window says how high it could be; the previous window and the monthly cohorts", () => {
    const r = escapedDefectReport({
      links: [link("D")],
      transitions,
      tickets: doneTickets,
      nowMs: NOW,
      windowDays: 30,
    });
    // A, B, C accepted in the last 30 days; none escaped.
    expect(r).toMatchObject({ accepted_changes: 3, escaped: 0, rate_pct: 0, upper_95_pct: 56.2 });
    // D, accepted 50 days ago, escaped: the 30 days before.
    expect(r.previous).toEqual({
      since: "2026-09-14T12:00:00.000Z",
      until: "2026-10-14T12:00:00.000Z",
      accepted_changes: 1,
      escaped: 1,
      rate_pct: 100,
      upper_95_pct: 100,
    });
    expect(r.maturing_days).toBe(30);
    expect(r.by_month).toEqual([
      {
        month: "2026-06",
        partial: false,
        accepted: 0,
        escaped: 0,
        rate_pct: null,
        maturing: false,
      },
      {
        month: "2026-07",
        partial: false,
        accepted: 0,
        escaped: 0,
        rate_pct: null,
        maturing: false,
      },
      {
        month: "2026-08",
        partial: false,
        accepted: 0,
        escaped: 0,
        rate_pct: null,
        maturing: false,
      },
      { month: "2026-09", partial: false, accepted: 1, escaped: 1, rate_pct: 100, maturing: false },
      // October ended less than 30 days ago: its defects are still being found.
      { month: "2026-10", partial: false, accepted: 0, escaped: 0, rate_pct: null, maturing: true },
      { month: "2026-11", partial: true, accepted: 3, escaped: 0, rate_pct: 0, maturing: true },
    ]);
  });

  it("0 of 11: the rate is 0 and the upper bound 25.9%", () => {
    const ids = Array.from({ length: 11 }, (_, i) => `T${i}`);
    const r = escapedDefectReport({
      links: [],
      transitions: ids.map((id, i) => tr(id, "ready_for_merge", "done", d(i + 1))),
      tickets: ids.map((id) => ({ id, status: "done" })),
      nowMs: NOW,
      windowDays: 30,
    });
    expect(r).toMatchObject({ accepted_changes: 11, escaped: 0, rate_pct: 0, upper_95_pct: 25.9 });
  });
});
