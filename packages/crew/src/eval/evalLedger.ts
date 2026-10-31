// =====================================================================
// Eval ledger — the measurement substrate for delivery quality.
//
// The delivery-quality judge (deliveryJudge.ts) scores ONE delivery. This turns
// a stream of those verdicts into a measured quality signal over time: an
// append-only JSONL ledger of records, plus a summary that computes pass rate,
// mean score, per-dimension means, cost-per-pass, and the MEMORY SCORE GAP
// (MEMORY_GAP_LABEL): the mean judge score of submitted deliveries that had
// durable memory primed minus the mean of those that did not.
//
// That gap is NOT a measure of what memory causes. The two arms are different
// tickets, and the judge only ever sees work that cleared every gate and was
// submitted, so attempts that failed earlier (and their spend) are in neither
// arm (MEMORY_GAP_EXCLUDES). The honest measure is a matched-ticket comparison —
// the same tickets run with and without memory, counting every attempt, spend
// and human acceptance (docs/eval-harness.md, "Matched-ticket comparison"). It
// is not implemented; `memoryLift.matched` is its seam and stays null. The field
// keeps its historical `memoryLift` key for compatibility.
//
// All functions are pure (string/array in → value out); the fs read/append and
// the timestamp live in the CLI, so this stays fully unit-testable.
// =====================================================================

import { RUBRIC_DIMENSIONS, type Overall, type RubricDimension } from "./deliveryJudge.js";

export interface EvalRecord {
  /** ISO timestamp, supplied by the caller (kept out of here so this stays pure). */
  ts: string;
  ticketId: string;
  repo?: string;
  overall: Overall;
  score: number;
  blocking: boolean;
  /** Was durable memory context (lore / digest / product intent) primed into this delivery? */
  memoryPresent: boolean;
  /** Per-dimension 0–5 scores. */
  dims: Partial<Record<RubricDimension, number>>;
  /**
   * The judge's one-sentence rationale per dimension (capped). Without it a low
   * score is an unactionable number: a live run's "borderline 3.2, test_adequacy 2"
   * could not say WHICH test was missing. Absent when the judge gave none.
   */
  rationale?: Partial<Record<RubricDimension, string>>;
  /**
   * Real cost of the delivery attempt in USD (from the worker's usage envelope,
   * `total_cost_usd`). Absent when the runner couldn't read a spend — never a
   * fake 0, so cost aggregates only over records that actually carried one.
   */
  costUsd?: number;
  /**
   * Which model judged this delivery (the judge turn's model flag/name).
   * Recorded so a judge-model swap never silently breaks longitudinal
   * comparability of meanScore/memoryLift, and so self-grading (judge ==
   * implementer model) is visible in the data rather than hidden.
   */
  judgeModel?: string;
}

export interface EvalSummary {
  count: number;
  passRate: number; // fraction of records with overall === "pass"
  blockRate: number; // fraction blocking
  meanScore: number;
  dimensionMeans: Partial<Record<RubricDimension, number>>;
  /**
   * HONEST NAME (external review #11): this is the JUDGE SCORE GAP on SUBMITTED work —
   * the mean score of deliveries that had memory primed minus the mean of those that
   * did not. The two arms are DIFFERENT tickets, and the judge only ever sees work that
   * cleared every gate and was submitted, so this answers neither "does memory cause
   * better work" nor "what does it cost". The field keeps its historical key; `measure`,
   * `label`, `sample` and `excludes` say what it is, and `matched` is the seam for the
   * honest measurement (docs/eval-harness.md, "Matched-ticket comparison").
   */
  memoryLift: {
    withMemory: { count: number; meanScore: number };
    withoutMemory: { count: number; meanScore: number };
    /** withMemory.meanScore − withoutMemory.meanScore, or null if either side is empty. */
    lift: number | null;
    measure: "judge_score_gap_on_submitted_work";
    label: string;
    sample: { withMemory: number; withoutMemory: number; distinctTickets: number };
    excludes: string;
    /** The matched-ticket comparison: not measured yet (see `matchedReason`). */
    matched: null;
    matchedReason: string;
  };
  /**
   * Real-cost FinOps view, over the records that carried a costUsd. The headline
   * is costPerPass — total spend divided by the number of PASSING deliveries in
   * the costed set: what a delivery the judge actually rates good costs you,
   * with the spend on failures amortised in. null until a costed pass exists.
   */
  cost: {
    costedCount: number;
    totalCostUsd: number;
    meanCostUsd: number;
    costPerPass: number | null;
  };
}

/** What the memory "lift" number is, in words a reader cannot mistake for causality. */
export const MEMORY_GAP_LABEL =
  "Judge score on submitted work, memory primed vs not primed — different tickets in each " +
  "arm, so a gap, not an uplift memory caused";
/** What the judge never sees, so the gap cannot count it. */
export const MEMORY_GAP_EXCLUDES =
  "attempts that failed before submission (a failed DoD gate, a park, a refused submit) " +
  "are never judged, so their spend and outcome are not in either arm";
/** Why the matched-ticket comparison is not reported. */
export const MATCHED_REASON =
  "not measured: the honest comparison runs the SAME tickets with and without memory and " +
  "counts every attempt, its spend and the human's acceptance (docs/eval-harness.md, " +
  "Matched-ticket comparison); the ledger records judged submissions only";

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 10000) / 10000; // USD precision
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Serialise one record to a single JSONL line (no trailing newline). */
export function formatRecord(record: EvalRecord): string {
  return JSON.stringify(record);
}

/** Parse a JSONL ledger, skipping blank/corrupt lines (a ledger must never throw). */
export function parseLedger(jsonl: string): EvalRecord[] {
  const out: EvalRecord[] = [];
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const r = parsed as Record<string, unknown>;
    if (typeof r.ticketId !== "string" || typeof r.score !== "number") continue;
    out.push({
      ts: String(r.ts ?? ""),
      ticketId: r.ticketId,
      ...(typeof r.repo === "string" ? { repo: r.repo } : {}),
      overall: (r.overall === "pass" || r.overall === "borderline" ? r.overall : "fail") as Overall,
      score: r.score,
      blocking: Boolean(r.blocking),
      memoryPresent: Boolean(r.memoryPresent),
      dims:
        r.dims && typeof r.dims === "object"
          ? (r.dims as Partial<Record<RubricDimension, number>>)
          : {},
      ...(typeof r.costUsd === "number" && Number.isFinite(r.costUsd)
        ? { costUsd: r.costUsd }
        : {}),
      ...(typeof r.judgeModel === "string" && r.judgeModel ? { judgeModel: r.judgeModel } : {}),
      ...(r.rationale && typeof r.rationale === "object" && Object.keys(r.rationale).length > 0
        ? { rationale: r.rationale as Partial<Record<RubricDimension, string>> }
        : {}),
    });
  }
  return out;
}

/** Aggregate records into the quality summary, including the memory score gap. */
export function summarize(records: EvalRecord[]): EvalSummary {
  const count = records.length;
  const scores = records.map((r) => r.score);
  const passRate = count ? records.filter((r) => r.overall === "pass").length / count : 0;
  const blockRate = count ? records.filter((r) => r.blocking).length / count : 0;

  const dimensionMeans: Partial<Record<RubricDimension, number>> = {};
  for (const d of RUBRIC_DIMENSIONS) {
    const vals = records.map((r) => r.dims[d]).filter((v): v is number => typeof v === "number");
    if (vals.length) dimensionMeans[d] = round2(mean(vals));
  }

  const withMem = records.filter((r) => r.memoryPresent).map((r) => r.score);
  const withoutMem = records.filter((r) => !r.memoryPresent).map((r) => r.score);
  const withMean = round2(mean(withMem));
  const withoutMean = round2(mean(withoutMem));
  const lift = withMem.length && withoutMem.length ? round2(withMean - withoutMean) : null;

  const costed = records.filter((r) => typeof r.costUsd === "number");
  const totalCost = costed.reduce((a, r) => a + (r.costUsd ?? 0), 0);
  const costedPasses = costed.filter((r) => r.overall === "pass").length;

  return {
    count,
    passRate: round2(passRate),
    blockRate: round2(blockRate),
    meanScore: round2(mean(scores)),
    dimensionMeans,
    memoryLift: {
      withMemory: { count: withMem.length, meanScore: withMean },
      withoutMemory: { count: withoutMem.length, meanScore: withoutMean },
      lift,
      measure: "judge_score_gap_on_submitted_work",
      label: MEMORY_GAP_LABEL,
      sample: {
        withMemory: withMem.length,
        withoutMemory: withoutMem.length,
        distinctTickets: new Set(records.map((r) => r.ticketId)).size,
      },
      excludes: MEMORY_GAP_EXCLUDES,
      matched: null,
      matchedReason: MATCHED_REASON,
    },
    cost: {
      costedCount: costed.length,
      totalCostUsd: round4(totalCost),
      meanCostUsd: round4(mean(costed.map((r) => r.costUsd ?? 0))),
      costPerPass: costedPasses ? round4(totalCost / costedPasses) : null,
    },
  };
}
