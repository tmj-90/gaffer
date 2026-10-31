import type { ReviewDecisionRow } from "../repositories/eventRepository.js";
import { RISK_LEVELS, type RiskLevel } from "../domain/types.js";

/**
 * GRADUATED-AUTONOMY (Spec 2, Phase 2) — the read-only, advisory recommendation
 * engine.
 *
 * It turns the review track record already in `work_events` (approve/reject
 * `ticket.transitioned` events, plus the Phase-1 `approved_unchanged` signal) into
 * per-repo × per-risk × per-gate recommendations: "you have approved N of M low-risk
 * deliveries in api-repo unchanged — consider auto-merge for risk=low". It computes a
 * confidence and human reasons but NEVER auto-applies anything — Phase 3 adds the
 * explicit-confirm enablement + policy table. Modelled on {@link SuggestionService}
 * (recommend-with-confidence, never auto-enforce).
 *
 * HONESTY DISCIPLINE (mirrors runner/lib/estimate.mjs):
 *   - Below {@link MIN_SAMPLES} decisions we refuse to recommend — never extrapolate
 *     autonomy from a thin track record.
 *   - Only HUMAN/ADMIN decisions count as ground truth (an agent auto-approving its
 *     own work is not evidence the operator agrees).
 *   - An `approved_unchanged` of `null` (unknown) counts toward NEITHER the unchanged
 *     nor the edited tally — an unknown must never inflate the "approved verbatim"
 *     rate that gates auto-merge.
 *   - Aggregates only: no free-text reason ever leaves this layer.
 */

/** Below this many qualifying decisions we refuse to recommend (never extrapolate). */
export const MIN_SAMPLES = 10;

/** Approve gate: recommend agent-approve only above this human agreement rate. */
export const AGREEMENT_THRESHOLD = 0.9;

/** Merge gate: recommend auto-merge only above this approved-unchanged rate. */
export const UNCHANGED_THRESHOLD = 0.9;

/** B3: a cross-repo (per-risk) PRIOR is weaker than same-repo evidence — scale its
 *  confidence by this factor so a same-repo recommendation always outranks it. */
export const CROSS_REPO_CONFIDENCE_FACTOR = 0.8;

/** The two gates a recommendation can concern. Memory is deferred (Phase 3+). */
export type AutonomyGate = "approve" | "merge";

/** How a single review-lane transition is classified for the track record. */
export type DecisionOutcome = "approved" | "rejected" | "other";

/** The reasons the approve path stamps on the transition — used to spot approvals. */
const APPROVE_REASONS: ReadonlySet<string> = new Set([
  "review_approved",
  "review_approved_to_testing",
]);

/** States a review REJECTION re-routes a delivery into (from in_review|ready_for_merge). */
const REJECT_TO_STATES: ReadonlySet<string> = new Set([
  "ready",
  "refining",
  "cancelled",
  "blocked",
]);

/** Actor types whose decisions are ground truth for the operator's preferences. */
const GROUND_TRUTH_ACTORS: ReadonlySet<string> = new Set(["human", "admin"]);

/** One advisory recommendation for a (repo × risk × gate). */
export interface AutonomyRecommendation {
  repoId: string;
  repoName: string;
  riskLevel: RiskLevel;
  gate: AutonomyGate;
  /** The mode this evidence supports — always "auto" (Phase 3 will let you enable it). */
  recommendation: "auto";
  /** 0..1 confidence, blending the observed rate with sample adequacy. */
  confidence: number;
  /** Human-readable, aggregate-only reasons (no free text from payloads). */
  reasons: string[];
  /** A ready-to-render advisory headline for the Settings surface. */
  headline: string;
  /** The evidence the recommendation rests on (counts only). */
  sample: {
    approvals: number;
    rejections: number;
    total: number;
    unchanged: number;
    unchangedKnown: number;
  };
}

/** A running tally for one (repo × risk) bucket. */
interface Bucket {
  repoId: string;
  repoName: string;
  riskLevel: RiskLevel;
  approvals: number;
  rejections: number;
  unchanged: number;
  unchangedKnown: number;
}

/**
 * Classify a single review-lane transition. Approvals are identified by the fixed
 * reason the approve path stamps; rejections by re-routing a review-lane ticket into
 * a rejected state. Everything else (merge-complete, reopen, tester verdicts that
 * slipped the from-filter) is `other` and ignored.
 */
export function classifyDecision(row: ReviewDecisionRow): DecisionOutcome {
  if (row.reason !== null && APPROVE_REASONS.has(row.reason)) return "approved";
  const from = row.fromStatus;
  const to = row.toStatus;
  if (
    (from === "in_review" || from === "ready_for_merge") &&
    to !== null &&
    REJECT_TO_STATES.has(to)
  ) {
    return "rejected";
  }
  return "other";
}

/** Confidence: the observed rate scaled by how far past MIN_SAMPLES the evidence is. */
function confidenceFor(rate: number, samples: number): number {
  const adequacy = Math.min(1, samples / (MIN_SAMPLES * 2));
  return clamp01(rate * adequacy);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function pct(rate: number): number {
  return Math.round(rate * 100);
}

function isRiskLevel(value: string): value is RiskLevel {
  return (RISK_LEVELS as readonly string[]).includes(value);
}

/**
 * Pure core: fold the ground-truth decisions into per-(repo × risk) buckets, then
 * emit the recommendations that clear both the sample floor and the rate threshold.
 * Buckets below the floor, or below the rate bar, produce NO recommendation.
 */
export function computeRecommendations(
  rows: readonly ReviewDecisionRow[],
): AutonomyRecommendation[] {
  const buckets = new Map<string, Bucket>();
  // B3 — cross-repo per-RISK aggregation. At solo volume no single repo×risk bucket
  // reaches MIN_SAMPLES, so the engine was DORMANT; aggregate per RISK across all repos.
  // Its sample is DISTINCT human decisions: one approval of a ticket that writes to ten
  // repositories yields ten rows (one per repository history) and was summed to
  // "approved 10/10 across all repos". It informs each repository's history once and
  // stays ONE observation here.
  const perRisk = new Map<string, Bucket>();
  const perRiskSeen = new Map<string, Set<string>>();
  const tally = (bucket: Bucket, outcome: DecisionOutcome, row: ReviewDecisionRow): void => {
    if (outcome === "approved") {
      bucket.approvals += 1;
      if (row.approvedUnchanged !== null) {
        bucket.unchangedKnown += 1;
        if (row.approvedUnchanged) bucket.unchanged += 1;
      }
    } else {
      bucket.rejections += 1;
    }
  };
  rows.forEach((row, index) => {
    if (!GROUND_TRUTH_ACTORS.has(row.actorType)) return; // only human/admin evidence.
    if (!isRiskLevel(row.riskLevel)) return;
    const outcome = classifyDecision(row);
    if (outcome === "other") return;
    const key = `${row.repoId}\u0000${row.riskLevel}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        repoId: row.repoId,
        repoName: row.repoName,
        riskLevel: row.riskLevel,
        approvals: 0,
        rejections: 0,
        unchanged: 0,
        unchangedKnown: 0,
      };
      buckets.set(key, bucket);
    }
    tally(bucket, outcome, row);

    let seen = perRiskSeen.get(row.riskLevel);
    if (!seen) perRiskSeen.set(row.riskLevel, (seen = new Set<string>()));
    const decision = row.decisionId ?? `row:${index}`;
    if (seen.has(decision)) return; // the same decision, another repository's row.
    seen.add(decision);
    let r = perRisk.get(row.riskLevel);
    if (!r) {
      r = {
        // `"*"` is a SYNTHETIC marker (never a real repo id) meaning "this risk tier,
        // across all repos". It maps onto the per-repo enforcement model coherently:
        // Phase-3 enablement must read a "*" recommendation as a per-risk, cross-repo
        // policy (the operator opts into the risk tier for their repos) — NOT as a repo
        // literally named "*". Same-repo recommendations always carry a real repoId.
        repoId: "*",
        repoName: "all repos",
        riskLevel: row.riskLevel,
        approvals: 0,
        rejections: 0,
        unchanged: 0,
        unchangedKnown: 0,
      };
      perRisk.set(row.riskLevel, r);
    }
    tally(r, outcome, row);
  });

  // Record which risks already have STRONG same-repo evidence so the (weaker)
  // cross-repo prior is suppressed there.
  const strongApprove = new Set<string>();
  const strongMerge = new Set<string>();
  for (const b of buckets.values()) {
    const bt = b.approvals + b.rejections;
    if (bt >= MIN_SAMPLES && b.approvals / bt >= AGREEMENT_THRESHOLD) {
      strongApprove.add(b.riskLevel);
      if (
        b.unchangedKnown >= MIN_SAMPLES &&
        b.unchanged / b.unchangedKnown >= UNCHANGED_THRESHOLD
      ) {
        strongMerge.add(b.riskLevel);
      }
    }
  }

  const out: AutonomyRecommendation[] = [];
  for (const b of buckets.values()) {
    const total = b.approvals + b.rejections;
    if (total < MIN_SAMPLES) continue; // thin track record → NO recommendation.
    const agreementRate = b.approvals / total;
    if (agreementRate < AGREEMENT_THRESHOLD) continue;

    // Approve gate: the operator consistently agrees this repo/risk is deliverable.
    out.push(
      buildRecommendation("approve", b, {
        rate: agreementRate,
        samples: total,
        headline:
          `approved ${b.approvals}/${total} ${b.riskLevel}-risk reviews in ${b.repoName} ` +
          `(${pct(agreementRate)}% agreement) — consider auto-approve for risk=${b.riskLevel}`,
        reasons: [
          `approved ${b.approvals} of ${total} ${b.riskLevel}-risk reviews in ${b.repoName}`,
          `${pct(agreementRate)}% agreement across ${total} decisions`,
        ],
      }),
    );

    // Merge gate: additionally requires enough approvals landed UNCHANGED — auto-merge
    // is only safe when the operator rarely edits before approving.
    if (b.unchangedKnown >= MIN_SAMPLES) {
      const unchangedRate = b.unchanged / b.unchangedKnown;
      if (unchangedRate >= UNCHANGED_THRESHOLD) {
        out.push(
          buildRecommendation("merge", b, {
            rate: unchangedRate,
            samples: b.unchangedKnown,
            headline:
              `approved ${b.unchanged}/${b.unchangedKnown} ${b.riskLevel}-risk deliveries in ` +
              `${b.repoName} unchanged — consider auto-merge for risk=${b.riskLevel}`,
            reasons: [
              `${b.unchanged} of ${b.unchangedKnown} ${b.riskLevel}-risk approvals in ${b.repoName} landed unchanged`,
              `${pct(unchangedRate)}% approved verbatim (no edits before merge)`,
            ],
          }),
        );
      }
    }
  }

  // B3 — cross-repo per-risk PRIORS: fill the solo-scale gap where no single repo×risk
  // bucket cleared the floor. Weaker than same-repo evidence (confidence ×factor), and
  // suppressed for a risk that already fired with strong same-repo evidence. Merge still
  // requires the varying approve-vs-reject agreement rate (the guard below), so a
  // degenerate approved-unchanged=100% cannot alone grant auto-merge.
  for (const b of perRisk.values()) {
    const total = b.approvals + b.rejections;
    if (total < MIN_SAMPLES) continue;
    const agreementRate = b.approvals / total;
    if (agreementRate < AGREEMENT_THRESHOLD) continue;

    if (!strongApprove.has(b.riskLevel)) {
      const rec = buildRecommendation("approve", b, {
        rate: agreementRate,
        samples: total,
        headline:
          `approved ${b.approvals}/${total} ${b.riskLevel}-risk reviews across all repos ` +
          `(${pct(agreementRate)}% agreement) — consider auto-approve for risk=${b.riskLevel} (cross-repo prior)`,
        reasons: [
          `approved ${b.approvals} of ${total} ${b.riskLevel}-risk reviews across all repos`,
          `${pct(agreementRate)}% agreement across ${total} decisions (aggregated across repos)`,
        ],
      });
      rec.confidence = clamp01(rec.confidence * CROSS_REPO_CONFIDENCE_FACTOR);
      out.push(rec);
    }

    if (!strongMerge.has(b.riskLevel) && b.unchangedKnown >= MIN_SAMPLES) {
      const unchangedRate = b.unchanged / b.unchangedKnown;
      if (unchangedRate >= UNCHANGED_THRESHOLD) {
        const rec = buildRecommendation("merge", b, {
          rate: unchangedRate,
          samples: b.unchangedKnown,
          headline:
            `approved ${b.unchanged}/${b.unchangedKnown} ${b.riskLevel}-risk deliveries across all repos ` +
            `unchanged (${pct(agreementRate)}% agreement) — consider auto-merge for risk=${b.riskLevel} (cross-repo prior)`,
          reasons: [
            `${b.unchanged} of ${b.unchangedKnown} ${b.riskLevel}-risk approvals across all repos landed unchanged`,
            `${pct(unchangedRate)}% approved verbatim, ${pct(agreementRate)}% approve-vs-reject agreement`,
          ],
        });
        rec.confidence = clamp01(rec.confidence * CROSS_REPO_CONFIDENCE_FACTOR);
        out.push(rec);
      }
    }
  }

  // Strongest evidence first: merge gate over approve, then confidence, then repo.
  out.sort(
    (a, x) =>
      gateRank(x.gate) - gateRank(a.gate) ||
      x.confidence - a.confidence ||
      a.repoName.localeCompare(x.repoName),
  );
  return out;
}

function gateRank(gate: AutonomyGate): number {
  return gate === "merge" ? 1 : 0;
}

function buildRecommendation(
  gate: AutonomyGate,
  bucket: Bucket,
  meta: { rate: number; samples: number; headline: string; reasons: string[] },
): AutonomyRecommendation {
  return {
    repoId: bucket.repoId,
    repoName: bucket.repoName,
    riskLevel: bucket.riskLevel,
    gate,
    recommendation: "auto",
    confidence: confidenceFor(meta.rate, meta.samples),
    reasons: meta.reasons,
    headline: meta.headline,
    sample: {
      approvals: bucket.approvals,
      rejections: bucket.rejections,
      total: bucket.approvals + bucket.rejections,
      unchanged: bucket.unchanged,
      unchangedKnown: bucket.unchangedKnown,
    },
  };
}

/** Dependencies the service reads through — just the work_events review-decision join. */
export interface AutonomyRecommendationDeps {
  reviewDecisions(): ReviewDecisionRow[];
}

/**
 * The read-only recommendation service. Advisory by design: it reads the review
 * track record and returns recommendations with confidence + reasons, and NEVER
 * enables anything itself.
 */
export class AutonomyRecommendationService {
  constructor(private readonly deps: AutonomyRecommendationDeps) {}

  /** Per-repo/per-risk/per-gate recommendations backed by the review track record. */
  recommend(): AutonomyRecommendation[] {
    return computeRecommendations(this.deps.reviewDecisions());
  }
}
