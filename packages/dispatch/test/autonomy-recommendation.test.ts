/**
 * GRADUATED-AUTONOMY (Spec 2, Phase 2): the read-only recommendation engine.
 *
 * These are pure-function tests over synthetic review-decision rows — the rate
 * computation, the MIN_SAMPLES floor, the threshold boundaries, and the required
 * NEGATIVE CONTROL (a repo below threshold produces NO recommendation).
 */
import { describe, expect, it } from "vitest";
import {
  AGREEMENT_THRESHOLD,
  MIN_SAMPLES,
  UNCHANGED_THRESHOLD,
  classifyDecision,
  computeRecommendations,
  type AutonomyRecommendation,
} from "../src/services/autonomyRecommendationService.js";
import type { ReviewDecisionRow } from "../src/repositories/eventRepository.js";

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

function approval(overrides: Partial<ReviewDecisionRow> = {}): ReviewDecisionRow {
  return {
    repoId: "repo-1",
    repoName: "api-repo",
    riskLevel: "low",
    actorType: "human",
    fromStatus: "in_review",
    toStatus: "ready_for_merge",
    reason: "review_approved",
    approvedUnchanged: true,
    ...overrides,
  };
}

function rejection(overrides: Partial<ReviewDecisionRow> = {}): ReviewDecisionRow {
  return {
    repoId: "repo-1",
    repoName: "api-repo",
    riskLevel: "low",
    actorType: "human",
    fromStatus: "in_review",
    toStatus: "refining",
    reason: "not good enough",
    approvedUnchanged: null,
    ...overrides,
  };
}

/** N rows produced by `make`. */
function times(n: number, make: (i: number) => ReviewDecisionRow): ReviewDecisionRow[] {
  return Array.from({ length: n }, (_, i) => make(i));
}

function findGate(
  recs: AutonomyRecommendation[],
  gate: "approve" | "merge",
): AutonomyRecommendation | undefined {
  return recs.find((r) => r.gate === gate);
}

// ---------------------------------------------------------------------------
// classifyDecision
// ---------------------------------------------------------------------------

describe("classifyDecision", () => {
  it("classifies the approve reason as approved", () => {
    expect(classifyDecision(approval())).toBe("approved");
  });

  it("classifies the testing-lane approve reason as approved", () => {
    expect(
      classifyDecision(approval({ toStatus: "in_testing", reason: "review_approved_to_testing" })),
    ).toBe("approved");
  });

  it("classifies an in_review → refining move as rejected", () => {
    expect(classifyDecision(rejection())).toBe("rejected");
  });

  it("classifies a merge-complete (→ done) transition as other", () => {
    expect(
      classifyDecision(
        approval({ fromStatus: "ready_for_merge", toStatus: "done", reason: "merge_completed" }),
      ),
    ).toBe("other");
  });

  it("classifies a tester-fail (from in_testing) as other, not a rejection", () => {
    expect(
      classifyDecision(
        rejection({ fromStatus: "in_testing", toStatus: "refining", reason: "tester_failed:x" }),
      ),
    ).toBe("other");
  });
});

// ---------------------------------------------------------------------------
// computeRecommendations — sample floor
// ---------------------------------------------------------------------------

describe("computeRecommendations — MIN_SAMPLES floor", () => {
  it("zero samples → no recommendation", () => {
    expect(computeRecommendations([])).toEqual([]);
  });

  it("one below MIN_SAMPLES all-approved → no recommendation", () => {
    const rows = times(MIN_SAMPLES - 1, () => approval());
    expect(computeRecommendations(rows)).toEqual([]);
  });

  it("exactly MIN_SAMPLES all-approved-unchanged → approve AND merge recommendations", () => {
    const rows = times(MIN_SAMPLES, () => approval());
    const recs = computeRecommendations(rows);
    expect(findGate(recs, "approve")).toBeDefined();
    expect(findGate(recs, "merge")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// computeRecommendations — threshold boundaries
// ---------------------------------------------------------------------------

describe("computeRecommendations — threshold boundaries", () => {
  it("agreement below threshold → no approve recommendation [negative control]", () => {
    // 10 decisions, 8 approvals = 0.8 agreement, below AGREEMENT_THRESHOLD (0.9).
    const rows = [...times(8, () => approval()), ...times(2, () => rejection())];
    expect(AGREEMENT_THRESHOLD).toBeGreaterThan(0.8);
    const recs = computeRecommendations(rows);
    expect(findGate(recs, "approve")).toBeUndefined();
    expect(findGate(recs, "merge")).toBeUndefined();
  });

  it("agreement at threshold → approve recommendation appears", () => {
    // 10 approvals, 0 rejections = 1.0 agreement (>= 0.9).
    const rows = times(10, () => approval());
    expect(findGate(computeRecommendations(rows), "approve")).toBeDefined();
  });

  it("high agreement but low unchanged rate → approve YES, merge NO", () => {
    // 12 approvals (all agree) but only 6/12 unchanged = 0.5 < UNCHANGED_THRESHOLD.
    const rows = times(12, (i) => approval({ approvedUnchanged: i < 6 }));
    expect(UNCHANGED_THRESHOLD).toBeGreaterThan(0.5);
    const recs = computeRecommendations(rows);
    expect(findGate(recs, "approve")).toBeDefined();
    expect(findGate(recs, "merge")).toBeUndefined();
  });

  it("insufficient KNOWN unchanged signal → no merge recommendation", () => {
    // 12 approvals but only 4 carry a known unchanged signal (< MIN_SAMPLES).
    const rows = times(12, (i) => approval({ approvedUnchanged: i < 4 ? true : null }));
    const recs = computeRecommendations(rows);
    expect(findGate(recs, "approve")).toBeDefined();
    expect(findGate(recs, "merge")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// computeRecommendations — actor + risk bucketing
// ---------------------------------------------------------------------------

describe("computeRecommendations — ground truth + bucketing", () => {
  it("ignores agent (non-human) decisions", () => {
    // 12 agent auto-approvals are not evidence the operator agrees.
    const rows = times(12, () => approval({ actorType: "agent" }));
    expect(computeRecommendations(rows)).toEqual([]);
  });

  it("buckets per repo × risk independently", () => {
    const lowRepoA = times(10, () =>
      approval({ repoId: "a", repoName: "repo-a", riskLevel: "low" }),
    );
    const highRepoA = times(3, () =>
      approval({ repoId: "a", repoName: "repo-a", riskLevel: "high" }),
    );
    const recs = computeRecommendations([...lowRepoA, ...highRepoA]);
    // Only the low-risk bucket has enough samples.
    expect(recs.every((r) => r.riskLevel === "low")).toBe(true);
    expect(recs.length).toBeGreaterThan(0);
  });

  it("does not leak free-text reasons into the output", () => {
    const rows = [
      ...times(9, () => approval()),
      ...times(1, () => approval()),
      ...times(3, () => rejection({ reason: "SECRET internal note" })),
    ];
    const recs = computeRecommendations(rows);
    const serialized = JSON.stringify(recs);
    expect(serialized).not.toContain("SECRET internal note");
  });

  it("populates confidence, reasons, headline and sample counts", () => {
    const rows = times(20, () => approval());
    const rec = findGate(computeRecommendations(rows), "merge");
    expect(rec).toBeDefined();
    expect(rec!.confidence).toBeGreaterThan(0);
    expect(rec!.confidence).toBeLessThanOrEqual(1);
    expect(rec!.reasons.length).toBeGreaterThan(0);
    expect(rec!.headline).toContain("api-repo");
    expect(rec!.sample.approvals).toBe(20);
    expect(rec!.sample.unchangedKnown).toBe(20);
  });
});

// ── B3: cross-repo per-risk PRIOR (solo-scale re-scope) ──────────────────────
describe("computeRecommendations — cross-repo per-risk prior (B3)", () => {
  it("fires at solo volume: 12 low-risk approvals over 3 repos (none at MIN_SAMPLES) → a cross-repo prior", () => {
    const rows = [
      ...times(4, () => approval({ repoId: "r1", repoName: "svc-a" })),
      ...times(4, () => approval({ repoId: "r2", repoName: "svc-b" })),
      ...times(4, () => approval({ repoId: "r3", repoName: "svc-c" })),
    ];
    const recs = computeRecommendations(rows);
    // No single repo cleared MIN_SAMPLES, so NO same-repo recommendation…
    expect(recs.some((r) => r.repoId !== "*")).toBe(false);
    // …but the aggregated per-risk prior does.
    const prior = recs.find((r) => r.repoId === "*" && r.gate === "approve");
    expect(prior).toBeDefined();
    expect(prior!.repoName).toBe("all repos");
    expect(prior!.headline).toContain("across all repos");
    expect(prior!.sample.approvals).toBe(12);
  });

  it("a cross-repo prior is weaker than same-repo evidence (confidence scaled by the factor)", () => {
    const solo = computeRecommendations(
      times(12, () => approval({ repoId: "r1", repoName: "svc-a" })),
    );
    const same = solo.find((r) => r.repoId === "r1" && r.gate === "approve")!;
    const spread = computeRecommendations([
      ...times(4, () => approval({ repoId: "r1", repoName: "svc-a" })),
      ...times(4, () => approval({ repoId: "r2", repoName: "svc-b" })),
      ...times(4, () => approval({ repoId: "r3", repoName: "svc-c" })),
    ]).find((r) => r.repoId === "*" && r.gate === "approve")!;
    // Same evidence count, but the cross-repo prior is discounted.
    expect(spread.confidence).toBeLessThan(same.confidence);
  });

  it("strong same-repo evidence SUPPRESSES the redundant cross-repo prior for that risk", () => {
    const recs = computeRecommendations(
      times(12, () => approval({ repoId: "r1", repoName: "svc-a" })),
    );
    expect(recs.some((r) => r.repoId === "r1" && r.gate === "approve")).toBe(true);
    // low-risk already fired same-repo → no cross-repo prior for the same risk+gate.
    expect(recs.some((r) => r.repoId === "*" && r.gate === "approve")).toBe(false);
  });
});
