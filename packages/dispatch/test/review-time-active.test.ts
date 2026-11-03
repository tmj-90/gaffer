/**
 * ACTIVE REVIEW TIME (gap-specialists MF6, the small form): beside the existing bases, the
 * review-time read model reports an approximate attention figure: per human-decided round
 * with an open event, the decision minus the LAST `ticket.review_opened` /
 * `ticket.review_raw_opened` in the round, capped at two hours. Hand-worked fixture.
 */
import { describe, expect, it } from "vitest";

import { reviewTimeReport, type ReviewOpen } from "../src/health/reviewTime.js";

const MIN = 60_000;
const T0 = Date.parse("2026-06-01T09:00:00.000Z");
const at = (m: number) => T0 + m * MIN;
const tr = (ticketId: string, from: string | null, to: string, m: number, actorType = "human") => ({
  ticketId,
  actorType,
  fromStatus: from,
  toStatus: to,
  atMs: at(m),
});
const open = (ticketId: string, m: number, what?: string): ReviewOpen => ({
  ticketId,
  atMs: at(m),
  ...(what ? { what } : {}),
});

describe("review time: the active basis", () => {
  // A: one round, open at 10, raw log at 30, approve at 50      -> 20 min
  // B: one round, open at 5, approve at 245 (4h after the round) -> capped at 120 min
  // C: round 1 open 10, send back 25 (15); round 2 enters 60, open 70, raw 80, approve 90
  //    (10)                                                       -> 25 min
  // D: one round with no open event                              -> not in the active figure
  // E: in review now (no decision)                               -> nothing
  const transitions = [
    tr("A", "in_progress", "in_review", 0, "system"),
    tr("A", "in_review", "ready_for_merge", 50),
    tr("B", "in_progress", "in_review", 0, "system"),
    tr("B", "in_review", "ready_for_merge", 245),
    tr("C", "in_progress", "in_review", 0, "system"),
    tr("C", "in_review", "refining", 25),
    tr("C", "in_progress", "in_review", 60, "system"),
    tr("C", "in_review", "ready_for_merge", 90),
    tr("D", "in_progress", "in_review", 0, "system"),
    tr("D", "in_review", "ready_for_merge", 40),
    tr("E", "in_progress", "in_review", 0, "system"),
  ];
  const opens = [open("A", 10), open("B", 5), open("C", 10), open("C", 70), open("E", 3)];
  const rawOpens = [open("A", 30, "run_log"), open("C", 80, "full_diff")];
  const tickets = ["A", "B", "C", "D"]
    .map((id) => ({ id, status: "done" }))
    .concat([{ id: "E", status: "in_review" }]);

  it("decision minus the last open in the round, capped at two hours", () => {
    const r = reviewTimeReport({ transitions, opens, rawOpens, tickets });
    expect(r.active.basis).toBe("last_open_to_decision_capped");
    expect(r.active.cap_ms).toBe(120 * MIN);
    expect(r.active.capped_rounds).toBe(1);
    // Per round: [20, 120, 15, 10] -> sorted [10, 15, 20, 120].
    expect(r.active.per_round).toEqual({
      n: 4,
      median_ms: 17.5 * MIN,
      p75_ms: 45 * MIN,
      p90_ms: 90 * MIN,
    });
    // Per accepted ticket whose every human round has an open: A 20, B 120, C 25.
    expect(r.active.per_accepted_ticket).toEqual({
      n: 3,
      median_ms: 25 * MIN,
      p75_ms: 72.5 * MIN,
      p90_ms: 101 * MIN,
    });
    expect(r.active.note).toMatch(/approximate/i);
    expect(r.active.note).toMatch(/capped at 2 hours/);
  });

  it("leaves the existing bases as they were", () => {
    const r = reviewTimeReport({ transitions, opens, rawOpens, tickets });
    expect(r.basis).toBe("mixed");
    // Decision time from the FIRST open: A 40, B 240, C 15 + 20 = 35; D full span 40.
    expect(r.per_accepted_ticket.n).toBe(4);
    expect(r.decision.n).toBe(4);
  });

  it("is empty with no open event", () => {
    const r = reviewTimeReport({ transitions, opens: [], rawOpens: [], tickets });
    expect(r.active.per_round.n).toBe(0);
    expect(r.active.per_accepted_ticket.median_ms).toBeNull();
  });
});
