import { describe, expect, it } from "vitest";

import { governanceRoi, type GovTransition } from "../src/health/governanceRoi.js";

const NOW = Date.parse("2026-07-16T00:00:00Z");
const DAY = 86_400_000;
const at = (daysAgo: number) => NOW - daysAgo * DAY;

/** Build a transition with sensible defaults. */
function tx(p: Partial<GovTransition> & { ticketId: string }): GovTransition {
  return {
    actorType: "system",
    fromStatus: null,
    toStatus: null,
    reason: null,
    atMs: at(1),
    ...p,
  };
}

describe("governanceRoi", () => {
  it("is empty-honest: no eligible history → every rate is null, not 0", () => {
    const r = governanceRoi([], new Map(), NOW, 30);
    expect(r.empty).toBe(true);
    expect(r.mergeRate.rate).toBeNull();
    expect(r.reworkRate.rate).toBeNull();
    expect(r.unattendedSafeRate.rate).toBeNull();
    expect(r.counts.merged).toBe(0);
  });

  it("merge rate = merged / (merged + rejected) over terminal decisions", () => {
    const evs: GovTransition[] = [
      // two merged
      tx({ ticketId: "a", reason: "merge_completed", toStatus: "done" }),
      tx({ ticketId: "b", reason: "merge_completed", toStatus: "done" }),
      // one rejected (in_review → refining)
      tx({ ticketId: "c", fromStatus: "in_review", toStatus: "refining", reason: "not good" }),
    ];
    const r = governanceRoi(evs, new Map(), NOW, 30);
    expect(r.counts.merged).toBe(2);
    expect(r.counts.rejected).toBe(1);
    expect(r.mergeRate.rate).toBeCloseTo(2 / 3);
    expect(r.mergeRate.numerator).toBe(2);
    expect(r.mergeRate.denominator).toBe(3);
    expect(r.empty).toBe(false);
  });

  it("rework rate = merged-with-rework / merged (uses the rework map)", () => {
    const evs = [
      tx({ ticketId: "a", reason: "merge_completed" }),
      tx({ ticketId: "b", reason: "merge_completed" }),
    ];
    const rework = new Map([["a", 2]]); // a needed rework, b was clean
    const r = governanceRoi(evs, rework, NOW, 30);
    expect(r.reworkRate.rate).toBeCloseTo(1 / 2);
    expect(r.counts.reworked).toBe(1);
  });

  it("unattended-safe: an agent-approved merge that stayed merged counts safe", () => {
    const evs = [
      tx({ ticketId: "a", reason: "review_approved", actorType: "agent", atMs: at(3) }),
      tx({ ticketId: "a", reason: "merge_completed", actorType: "system", atMs: at(2) }),
    ];
    const r = governanceRoi(evs, new Map(), NOW, 30);
    expect(r.counts.unattendedMerges).toBe(1);
    expect(r.counts.unattendedReopened).toBe(0);
    expect(r.unattendedSafeRate.rate).toBe(1);
  });

  it("a HUMAN-approved merge is NOT counted as unattended", () => {
    const evs = [
      tx({ ticketId: "a", reason: "review_approved", actorType: "human", atMs: at(3) }),
      tx({ ticketId: "a", reason: "merge_completed", actorType: "system", atMs: at(2) }),
    ];
    const r = governanceRoi(evs, new Map(), NOW, 30);
    expect(r.counts.merged).toBe(1);
    expect(r.counts.unattendedMerges).toBe(0);
    expect(r.unattendedSafeRate.rate).toBeNull(); // no unattended merges → honest null
  });

  it("an agent-approved merge that was later REOPENED counts unsafe", () => {
    const evs = [
      tx({ ticketId: "a", reason: "review_approved", actorType: "agent", atMs: at(4) }),
      tx({ ticketId: "a", reason: "merge_completed", atMs: at(3) }),
      tx({ ticketId: "a", fromStatus: "done", toStatus: "in_review", atMs: at(1) }), // reopened
    ];
    const r = governanceRoi(evs, new Map(), NOW, 30);
    expect(r.counts.unattendedMerges).toBe(1);
    expect(r.counts.unattendedReopened).toBe(1);
    expect(r.unattendedSafeRate.rate).toBe(0);
  });

  it("windows out old events (outside the trailing windowDays)", () => {
    const evs = [
      tx({ ticketId: "old", reason: "merge_completed", atMs: at(40) }), // outside 30d
      tx({ ticketId: "new", reason: "merge_completed", atMs: at(5) }), // inside
    ];
    const r = governanceRoi(evs, new Map(), NOW, 30);
    expect(r.counts.merged).toBe(1);
  });

  it("a ticket merged after being reworked is one merge, not a reject too", () => {
    const evs = [
      tx({ ticketId: "a", fromStatus: "in_review", toStatus: "refining", atMs: at(5) }), // bounced
      tx({ ticketId: "a", reason: "review_approved", actorType: "human", atMs: at(3) }),
      tx({ ticketId: "a", reason: "merge_completed", atMs: at(2) }),
    ];
    const rework = new Map([["a", 1]]);
    const r = governanceRoi(evs, rework, NOW, 30);
    expect(r.counts.merged).toBe(1);
    expect(r.counts.rejected).toBe(0); // merged wins — not double-counted as a reject
    expect(r.counts.reworked).toBe(1);
  });
});
