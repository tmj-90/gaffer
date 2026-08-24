// =====================================================================
// Eval ledger — the measurement substrate for delivery quality.
//
// The delivery-quality judge (deliveryJudge.ts) scores ONE delivery. This turns
// a stream of those verdicts into a measured quality signal over time: an
// append-only JSONL ledger of records, plus a summary that computes pass rate,
// mean score, per-dimension means, and — the headline metric — the MEMORY LIFT:
// mean delivery score WITH durable memory context present minus WITHOUT it.
//
// That last number is the whole point. Gaffer's thesis is "it builds you an
// asset — the more you run it, the more context primes the next delivery." Until
// now that was an assertion; memoryLift makes it falsifiable. A positive lift is
// evidence the memory earns its keep; ~zero (or negative) says it doesn't, and
// you should know either way.
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
   * Real cost of the delivery attempt in USD (from the worker's usage envelope,
   * `total_cost_usd`). Absent when the runner couldn't read a spend — never a
   * fake 0, so cost aggregates only over records that actually carried one.
   */
  costUsd?: number;
}

export interface EvalSummary {
  count: number;
  passRate: number; // fraction of records with overall === "pass"
  blockRate: number; // fraction blocking
  meanScore: number;
  dimensionMeans: Partial<Record<RubricDimension, number>>;
  memoryLift: {
    withMemory: { count: number; meanScore: number };
    withoutMemory: { count: number; meanScore: number };
    /** withMemory.meanScore − withoutMemory.meanScore, or null if either side is empty. */
    lift: number | null;
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
    });
  }
  return out;
}

/** Aggregate records into the quality summary, including the memory-lift metric. */
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
    },
    cost: {
      costedCount: costed.length,
      totalCostUsd: round4(totalCost),
      meanCostUsd: round4(mean(costed.map((r) => r.costUsd ?? 0))),
      costPerPass: costedPasses ? round4(totalCost / costedPasses) : null,
    },
  };
}
