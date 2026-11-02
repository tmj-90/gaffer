/**
 * REVIEW TIME and FIRST-PASS ACCEPTANCE read models (Release A metrics package: A0, MF1).
 *
 * The primary Release A measure is the median human review minutes per accepted ticket.
 * Wall-clock time in review is mostly queue wait, so a `ticket.review_opened` event
 * splits each round into queue wait (entry to first open) and decision time (open to
 * the human decision). Rounds with no open event fall back to the full span, and the
 * report says which basis it used. First-pass acceptance counts done tickets that no
 * reviewer, agent or tester sent back after they first entered review, split by who
 * approved them, so agent approvals never flatter the human figure.
 */
import { describe, expect, it } from "vitest";

import { firstPassAcceptance } from "../src/health/firstPass.js";
import { percentiles, reviewTimeReport } from "../src/health/reviewTime.js";

const MIN = 60_000;
const T0 = Date.parse("2026-11-01T10:00:00.000Z");
const at = (m: number): number => T0 + m * MIN;
const iso = (m: number): string => new Date(at(m)).toISOString();

type Tr = {
  ticketId: string;
  actorType: string;
  fromStatus: string | null;
  toStatus: string | null;
  reason?: string | null;
  atMs: number;
};
const tr = (
  ticketId: string,
  from: string | null,
  to: string,
  m: number,
  actor = "system",
): Tr => ({
  ticketId,
  actorType: actor,
  fromStatus: from,
  toStatus: to,
  reason: null,
  atMs: at(m),
});

describe("percentiles", () => {
  it("interpolates between ranks and is null on no data", () => {
    expect(percentiles([])).toEqual({ n: 0, median_ms: null, p75_ms: null, p90_ms: null });
    expect(percentiles([10])).toEqual({ n: 1, median_ms: 10, p75_ms: 10, p90_ms: 10 });
    expect(percentiles([40, 10, 30, 20])).toEqual({
      n: 4,
      median_ms: 25,
      p75_ms: 33, // 30 + 0.25 * 10, rounded
      p90_ms: 37,
    });
  });
});

describe("reviewTimeReport", () => {
  // t1: one round, opened 50 minutes after it entered review, decided 10 minutes later.
  // t2: two rounds, the first sent back by a human (no open event: full span 30), the
  //     second opened after 5 and approved 20 later. Mixed basis.
  // t3: one round with no open event, approved after 60 (full span).
  // t4: agent approved, no human round: not part of the human figure.
  // t5: in review now (not accepted).
  const transitions: Tr[] = [
    tr("t1", "in_progress", "in_review", 0),
    tr("t1", "in_review", "ready_for_merge", 60, "human"),
    tr("t1", "ready_for_merge", "done", 61),
    tr("t2", "in_progress", "in_review", 0),
    tr("t2", "in_review", "refining", 30, "human"),
    tr("t2", "in_progress", "in_review", 100),
    tr("t2", "in_review", "ready_for_merge", 125, "admin"),
    tr("t2", "ready_for_merge", "done", 126),
    tr("t3", "in_progress", "in_review", 0),
    tr("t3", "in_review", "ready_for_merge", 60, "human"),
    tr("t3", "ready_for_merge", "done", 61),
    tr("t4", "in_progress", "in_review", 0),
    tr("t4", "in_review", "ready_for_merge", 2, "agent"),
    tr("t4", "ready_for_merge", "done", 3),
    tr("t5", "in_progress", "in_review", 0),
  ];
  const opens = [
    { ticketId: "t1", atMs: at(50) },
    // a second open in the same round changes nothing (the first one counts)
    { ticketId: "t1", atMs: at(55) },
    { ticketId: "t2", atMs: at(105) },
    // an open on a ticket still in review has no decision yet
    { ticketId: "t5", atMs: at(1) },
  ];
  const rawOpens = [
    // t2's approving round opened the run log: not "approved without raw logs"
    { ticketId: "t2", atMs: at(110), what: "run_log" },
  ];
  const tickets = [
    { id: "t1", status: "done" },
    { id: "t2", status: "done" },
    { id: "t3", status: "done" },
    { id: "t4", status: "done" },
    { id: "t5", status: "in_review" },
  ];
  const r = reviewTimeReport({ transitions, opens, rawOpens, tickets });

  it("reports the median, p75 and p90 of human review time per accepted ticket", () => {
    // t1 decision 10, t2 = 30 (full span, round 1) + 20 (decision, round 2) = 50, t3 = 60.
    expect(r.per_accepted_ticket.n).toBe(3);
    expect(r.per_accepted_ticket.median_ms).toBe(50 * MIN);
    expect(r.per_accepted_ticket.p75_ms).toBe(55 * MIN);
    expect(r.per_accepted_ticket.p90_ms).toBe(58 * MIN);
  });

  it("says which basis it used: decision time where an open event exists, the span otherwise", () => {
    expect(r.basis).toBe("mixed");
    expect(r.basis_note).toMatch(/full span/);
    expect(r.rounds.human_decided).toBe(4);
    expect(r.rounds.with_open_event).toBe(2);
    expect(r.queue_wait).toEqual(percentiles([50 * MIN, 5 * MIN]));
    expect(r.decision).toEqual(percentiles([10 * MIN, 20 * MIN]));
  });

  it("time from review-ready to decision is the whole span of every human-decided round", () => {
    expect(r.review_ready_to_decision).toEqual(
      percentiles([60 * MIN, 30 * MIN, 25 * MIN, 60 * MIN]),
    );
  });

  it("counts accepted tickets no human decided apart instead of as zero minutes", () => {
    expect(r.accepted_without_human_decision).toBe(1);
  });

  it("% approved without opening raw logs reads only instrumented approving rounds", () => {
    // t1 and t2's approving rounds have an open event; t2 opened the run log in it.
    expect(r.approved_without_raw_logs).toEqual({ instrumented: 2, count: 1, pct: 50 });
  });

  it("falls back to the full span and says so when no open event exists anywhere", () => {
    const plain = reviewTimeReport({ transitions, opens: [], rawOpens: [], tickets });
    expect(plain.basis).toBe("full_span");
    expect(plain.per_accepted_ticket.median_ms).toBe(60 * MIN);
    expect(plain.approved_without_raw_logs).toEqual({ instrumented: 0, count: 0, pct: null });
  });

  it("is null-honest with no accepted ticket", () => {
    const none = reviewTimeReport({ transitions: [], opens: [], rawOpens: [], tickets: [] });
    expect(none.basis).toBe("none");
    expect(none.per_accepted_ticket).toEqual({
      n: 0,
      median_ms: null,
      p75_ms: null,
      p90_ms: null,
    });
  });
});

describe("firstPassAcceptance", () => {
  const transitions: Tr[] = [
    // a: human approved first time
    tr("a", "in_progress", "in_review", 0),
    tr("a", "in_review", "ready_for_merge", 10, "human"),
    tr("a", "ready_for_merge", "done", 11),
    // b: a human sent it back once, then approved
    tr("b", "in_progress", "in_review", 0),
    tr("b", "in_review", "refining", 10, "human"),
    tr("b", "in_progress", "in_review", 20),
    tr("b", "in_review", "ready_for_merge", 30, "human"),
    tr("b", "ready_for_merge", "done", 31),
    // c: the tester failed it after an agent approve, then it passed
    tr("c", "in_progress", "in_review", 0),
    tr("c", "in_review", "in_testing", 5, "agent"),
    tr("c", "in_testing", "refining", 6, "agent"),
    tr("c", "in_progress", "in_review", 20),
    tr("c", "in_review", "in_testing", 25, "agent"),
    tr("c", "in_testing", "ready_for_merge", 26, "agent"),
    tr("c", "ready_for_merge", "done", 27),
    // d: agent approved first time
    tr("d", "in_progress", "in_review", 0),
    tr("d", "in_review", "ready_for_merge", 1, "agent"),
    tr("d", "ready_for_merge", "done", 2),
    // e: approved first time, then reopened out of done and landed again
    tr("e", "in_progress", "in_review", 0),
    tr("e", "in_review", "ready_for_merge", 5, "human"),
    tr("e", "ready_for_merge", "done", 6),
    tr("e", "done", "in_review", 50, "system"),
    tr("e", "in_review", "ready_for_merge", 55, "human"),
    tr("e", "ready_for_merge", "done", 56),
    // f: still in review
    tr("f", "in_progress", "in_review", 0),
  ];
  const tickets = ["a", "b", "c", "d", "e"]
    .map((id) => ({ id, status: "done" }))
    .concat([{ id: "f", status: "in_review" }]);
  // a's runner retried once before it ever reached review.
  const retries = [{ ticketId: "a", at: iso(-5) }];
  const r = firstPassAcceptance({ transitions, retries, tickets });

  it("first-pass = done tickets with no send-back after their first review, over done", () => {
    expect(r.done).toBe(5);
    expect(r.first_pass).toBe(2); // a, d
    expect(r.rate_pct).toBe(40);
  });

  it("a strict reading also excludes runner retries", () => {
    expect(r.strict.first_pass).toBe(1); // d
    expect(r.strict.rate_pct).toBe(20);
  });

  it("splits by the approving actor so agent approvals never flatter the human figure", () => {
    expect(r.by_approver.human).toEqual({ done: 3, first_pass: 1, rate_pct: 33.3 });
    expect(r.by_approver.agent).toEqual({ done: 2, first_pass: 1, rate_pct: 50 });
  });

  it("is null-honest with nothing done", () => {
    const none = firstPassAcceptance({ transitions: [], retries: [], tickets: [] });
    expect(none.rate_pct).toBeNull();
    expect(none.done).toBe(0);
  });
});
