import { describe, expect, it } from "vitest";

import { isReviewSendBack, sendBacksByTicket } from "../src/health/sendBacks.js";

const tr = (
  fromStatus: string,
  toStatus: string,
  reason: string | null = null,
  at = "2026-10-30T10:00:00.000Z",
) => ({
  ticketId: "T",
  fromStatus,
  toStatus,
  reason,
  at,
});

describe("send-backs: both kinds of rework", () => {
  it("a reviewer's or tester's rejection back to work is a send-back", () => {
    expect(isReviewSendBack(tr("in_review", "refining"))).toBe(true);
    expect(isReviewSendBack(tr("in_review", "ready"))).toBe(true);
    expect(isReviewSendBack(tr("in_testing", "refining", "tester_failed:x"))).toBe(true);
    expect(isReviewSendBack(tr("ready_for_merge", "refining"))).toBe(true);
    // The retry cap parks a rejection to blocked instead of re-queuing it.
    expect(isReviewSendBack(tr("in_review", "blocked", "retry_cap_reached:no header"))).toBe(true);
  });

  it("forward moves, abandons and other parks are not", () => {
    expect(isReviewSendBack(tr("in_review", "ready_for_merge", "review_approved"))).toBe(false);
    expect(isReviewSendBack(tr("in_review", "cancelled"))).toBe(false);
    expect(isReviewSendBack(tr("ready_for_merge", "in_review", "conflict resolved"))).toBe(false);
    expect(isReviewSendBack(tr("ready_for_merge", "blocked", "merge conflict"))).toBe(false);
    expect(isReviewSendBack(tr("in_progress", "ready"))).toBe(false);
  });

  it("joins review send-backs with the runner's retries, oldest first", () => {
    const map = sendBacksByTicket(
      [tr("in_review", "refining", "nope", "2026-10-30T12:00:00.000Z")],
      [{ ticketId: "T", at: "2026-10-30T09:00:00.000Z" }],
    );
    expect(map.get("T")).toEqual([
      { at: "2026-10-30T09:00:00.000Z", source: "retry" },
      { at: "2026-10-30T12:00:00.000Z", source: "review" },
    ]);
  });
});
