/**
 * Gaffer factory — token SPEND ESTIMATE helpers (pure, dependency-free).
 *
 * Predicts a ticket's likely token usage from the honest USAGE LEDGER written by
 * lib/usage-ledger.mjs (one JSONL record per `claude -p` agent call). The whole
 * point is HONESTY: this is a PREDICTION from history, never a measurement, and
 * never a dollar figure. The CLI (bin/estimate-usage.mjs) wires these helpers to
 * the ledger file and prints a loudly-labelled estimate.
 *
 * HONESTY RULES (enforced in code here + in the CLI):
 *   1. Estimate in TOKENS and TURNS only. No function here computes, returns, or
 *      reports a cost/dollar figure — total_cost_usd and per-model cost_usd are
 *      deliberately never read.
 *   2. It is a prediction, not a measurement — summarise() carries N and the date
 *      range so the caller can label the basis loudly; the CLI prints the
 *      "actuals may differ" banner.
 *   3. Below MIN_SAMPLES (5) measured rows → enoughHistory()===false and NO
 *      numbers are produced; the CLI prints "not enough history to estimate yet".
 *   4. measured:false / "unknown" rows contribute NOTHING — filterMeasured()
 *      drops them BEFORE any statistic is computed.
 *   5. The basis is always available: summarise() returns n, kind, and the
 *      first/last timestamps so the human sees what the prediction is built on.
 */

import { UNKNOWN } from "./usage-ledger.mjs";

/** Below this many measured rows we refuse to estimate (never extrapolate from 1–2). */
export const MIN_SAMPLES = 5;

/** Percentiles that define the reported RANGE around the median. */
export const P_LOW = 10;
export const P_HIGH = 90;

/**
 * Parse a JSONL ledger blob into records. Tolerant: blank lines are skipped and a
 * single unparseable line is dropped rather than aborting the whole estimate (a
 * corrupt telemetry line must not blind the human to the rest of the history).
 */
export function parseLedger(text) {
  if (typeof text !== "string" || !text.trim()) return [];
  const records = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) records.push(obj);
    } catch {
      /* skip one corrupt line — never abort the estimate */
    }
  }
  return records;
}

/**
 * Keep ONLY rows that are genuinely measured: measured===true AND no "unknown"
 * sentinel in the numeric fields we rely on. Honesty rule 4 — an unmeasured call
 * contributes nothing to the prediction. A row whose models map is the UNKNOWN
 * string, or whose num_turns is UNKNOWN, is dropped.
 */
export function isMeasuredRow(row) {
  if (!row || typeof row !== "object") return false;
  if (row.measured !== true) return false;
  if (row.models === UNKNOWN || !row.models || typeof row.models !== "object") return false;
  if (row.num_turns === UNKNOWN) return false;
  return true;
}

/** Filter a record list to measured rows of a given kind. */
export function filterMeasured(records, kind) {
  return records.filter((r) => isMeasuredRow(r) && r.kind === kind);
}

/**
 * Sum a single measured row's INPUT tokens across every model. Cache reads/creates
 * are deliberately excluded from the headline input figure (they are not fresh
 * input the human is "spending" anew). A row with any UNKNOWN input field is
 * treated as 0 contribution for that model only — but such rows are already
 * excluded by isMeasuredRow at the row level when num_turns is unknown; here we
 * defensively coerce a stray UNKNOWN to skip it rather than poison the sum.
 */
export function rowInputTokens(row) {
  return sumModelField(row, "input");
}

/** Sum a single measured row's OUTPUT tokens across every model. */
export function rowOutputTokens(row) {
  return sumModelField(row, "output");
}

function sumModelField(row, field) {
  const models = row && row.models;
  if (!models || typeof models !== "object" || models === UNKNOWN) return 0;
  let total = 0;
  for (const usage of Object.values(models)) {
    if (!usage || typeof usage !== "object") continue;
    const v = usage[field];
    if (typeof v === "number" && Number.isFinite(v)) total += v;
  }
  return total;
}

/** num_turns as a finite number, or null if it is not usable. */
export function rowTurns(row) {
  const v = row && row.num_turns;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Linear-interpolated percentile of a numeric array (the classic "type 7" /
 * NumPy default). Returns null for an empty input. p is 0–100.
 */
export function percentile(values, p) {
  const xs = values
    .filter((v) => typeof v === "number" && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (xs.length === 0) return null;
  if (xs.length === 1) return xs[0];
  const rank = (p / 100) * (xs.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return xs[lo];
  const frac = rank - lo;
  return xs[lo] + (xs[hi] - xs[lo]) * frac;
}

/** Median is just the 50th percentile. */
export function median(values) {
  return percentile(values, 50);
}

/** A {median, low, high} band for one metric, or null if no usable values. */
function band(values) {
  if (values.length === 0) return null;
  return {
    median: median(values),
    low: percentile(values, P_LOW),
    high: percentile(values, P_HIGH),
  };
}

/** true once there is enough measured history to estimate honestly. */
export function enoughHistory(measuredRows) {
  return Array.isArray(measuredRows) && measuredRows.length >= MIN_SAMPLES;
}

/**
 * Build the estimate SUMMARY from already-filtered measured rows of one kind.
 *
 * Returns:
 *   { kind, n, enough:false, dateRange }                      when n < MIN_SAMPLES
 *   { kind, n, enough:true, dateRange, inputTokens, outputTokens, turns }
 *                                                             otherwise
 * Each metric is a {median, low, high} band over the measured rows. NO cost field
 * is ever produced (honesty rule 1). dateRange.{first,last} are ISO timestamps so
 * the caller can show the basis (honesty rule 5).
 */
export function summarise(measuredRows, kind) {
  const rows = Array.isArray(measuredRows) ? measuredRows : [];
  const n = rows.length;
  const dateRange = computeDateRange(rows);
  if (!enoughHistory(rows)) {
    return { kind, n, enough: false, dateRange };
  }
  const inputs = rows.map(rowInputTokens);
  const outputs = rows.map(rowOutputTokens);
  const turns = rows.map(rowTurns).filter((t) => t !== null);
  return {
    kind,
    n,
    enough: true,
    dateRange,
    inputTokens: band(inputs),
    outputTokens: band(outputs),
    turns: band(turns),
  };
}

/** First/last ISO timestamp across rows, or null when none carry a usable ts. */
export function computeDateRange(rows) {
  const stamps = (Array.isArray(rows) ? rows : [])
    .map((r) => (r && typeof r.ts === "string" ? r.ts : null))
    .filter((s) => s !== null && !Number.isNaN(Date.parse(s)))
    .sort();
  if (stamps.length === 0) return null;
  return { first: stamps[0], last: stamps[stamps.length - 1] };
}

/**
 * Resolve a ticket number to a kind by looking it up in the ledger: the kind of
 * that ticket's MOST RECENT measured row. Self-contained — needs no other factory
 * file. Returns the kind string, or null when the ticket has no measured rows.
 */
export function resolveTicketKind(records, ticket) {
  const wanted = String(ticket);
  let best = null;
  for (const r of records) {
    if (!isMeasuredRow(r)) continue;
    if (r.ticket == null || String(r.ticket) !== wanted) continue;
    if (typeof r.kind !== "string" || !r.kind) continue;
    if (best === null || compareTs(r.ts, best.ts) > 0) best = r;
  }
  return best ? best.kind : null;
}

function compareTs(a, b) {
  const ta = typeof a === "string" ? Date.parse(a) : NaN;
  const tb = typeof b === "string" ? Date.parse(b) : NaN;
  const va = Number.isNaN(ta) ? -Infinity : ta;
  const vb = Number.isNaN(tb) ? -Infinity : tb;
  return va - vb;
}
