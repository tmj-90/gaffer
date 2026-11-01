/**
 * COST PER ACCEPTED CHANGE counts every attempt (external review #9, evaluation gap).
 *
 * The eval harness's cost-per-pass divides only the spend on JUDGED (submitted)
 * deliveries, so parked and failed attempts were never in it. acceptedChangeCost reads
 * the usage ledger (every model call) against ticket outcomes.
 */
import { describe, expect, it } from "vitest";

import { acceptedChangeCost, reviewSpansByTicket } from "../src/health/acceptedChange.js";
import type { HealthRow } from "../src/health/healthAggregator.js";

function row(p: Partial<HealthRow> & { ticket: number | null; total_cost_usd: number }): HealthRow {
  return {
    ts: "2026-11-01T00:00:00Z",
    kind: "delivery",
    measured: true,
    num_turns: 1,
    duration_ms: 1000,
    models: {},
    estimated_cost_usd: 0,
    attempt_id: null,
    started_at: null,
    ...p,
  };
}

const tickets = [
  { id: "t1", number: 1, status: "done" },
  { id: "t2", number: 2, status: "blocked" },
  { id: "t3", number: 3, status: "cancelled" },
  { id: "t4", number: 4, status: "in_review" },
  { id: "t5", number: 5, status: "done" },
];

describe("acceptedChangeCost", () => {
  const rows = [
    row({ ticket: 1, total_cost_usd: 1, attempt_id: "c1/1" }),
    row({ ticket: 1, total_cost_usd: 1, attempt_id: "c1/2" }),
    row({ ticket: 1, total_cost_usd: 0.5, kind: "review" }),
    row({ ticket: 2, total_cost_usd: 1, attempt_id: "c2/1" }),
    row({ ticket: 2, total_cost_usd: 1, attempt_id: "c2/2" }),
    // a killed call: unmeasured, booked as a labelled estimate, still spend
    row({
      ticket: 2,
      total_cost_usd: 0,
      measured: false,
      estimated_cost_usd: 0.75,
      attempt_id: "c2/3",
    }),
    row({ ticket: 3, total_cost_usd: 0.5, attempt_id: "c3/1" }),
    row({ ticket: 4, total_cost_usd: 0.25, attempt_id: "c4/1" }),
    row({ ticket: 5, total_cost_usd: 0.5, attempt_id: "c5/1" }),
    // the same attempt id twice is one attempt
    row({ ticket: 5, total_cost_usd: 0.25, attempt_id: "c5/1" }),
    row({ ticket: null, total_cost_usd: 2, kind: "onboard" }),
  ];
  const r = acceptedChangeCost(rows, tickets);

  it("divides the spend of every attempt, whatever the outcome, over the tickets that reached done", () => {
    expect(r.accepted_changes).toBe(2);
    expect(r.attributed_spend_usd).toBe(6.75);
    expect(r.cost_per_accepted_change_usd).toBe(3.375);
    // what leaving failures out would have said
    expect(r.accepted_only_cost_per_change_usd).toBe(1.625);
    expect(r.unattributed_usd).toBe(2);
  });

  it("counts attempts on every ticket, and splits spend by outcome", () => {
    expect(r.attempts_per_accepted_change).toBe(4); // 2 + 3 + 1 + 1 + 1 over 2 done
    expect(r.by_outcome.accepted).toEqual({ tickets: 2, spend_usd: 3.25, delivery_attempts: 3 });
    expect(r.by_outcome.parked_or_failed).toEqual({
      tickets: 1,
      spend_usd: 2.75,
      delivery_attempts: 3,
    });
    expect(r.by_outcome.abandoned.spend_usd).toBe(0.5);
    expect(r.by_outcome.in_flight.spend_usd).toBe(0.25);
  });

  it("null-honest with no accepted change; limits are stated", () => {
    const none = acceptedChangeCost(
      rows,
      tickets.map((t) => ({ ...t, status: "blocked" })),
    );
    expect(none.cost_per_accepted_change_usd).toBeNull();
    expect(none.attempts_per_accepted_change).toBeNull();
    expect(r.limits.join(" ")).toMatch(/no baseline/);
  });

  it("reviewer time: human decisions out of in_review, measured from entering it", () => {
    const tr = [
      {
        ticketId: "t1",
        actorType: "system",
        fromStatus: "in_progress",
        toStatus: "in_review",
        atMs: 1_000,
      },
      {
        ticketId: "t1",
        actorType: "human",
        fromStatus: "in_review",
        toStatus: "refining",
        atMs: 61_000,
      },
      {
        ticketId: "t1",
        actorType: "system",
        fromStatus: "in_progress",
        toStatus: "in_review",
        atMs: 100_000,
      },
      {
        ticketId: "t1",
        actorType: "human",
        fromStatus: "in_review",
        toStatus: "ready_for_merge",
        atMs: 130_000,
      },
      // an agent decision is not reviewer time
      {
        ticketId: "t2",
        actorType: "system",
        fromStatus: "in_progress",
        toStatus: "in_review",
        atMs: 0,
      },
      {
        ticketId: "t2",
        actorType: "agent",
        fromStatus: "in_review",
        toStatus: "ready_for_merge",
        atMs: 5_000,
      },
    ];
    expect(reviewSpansByTicket(tr).get("t1")).toEqual([60_000, 30_000]);
    expect(reviewSpansByTicket(tr).has("t2")).toBe(false);
    const withReview = acceptedChangeCost(rows, tickets, tr);
    expect(withReview.reviewer_time).toEqual({
      recorded_reviews: 2,
      total_ms: 90_000,
      mean_ms: 45_000,
      per_accepted_change_ms: 45_000,
    });
  });
});
