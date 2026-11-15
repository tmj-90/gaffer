// =====================================================================
// The killed-call estimate from the factory's own measured history, in a module with no
// imports: lib/usage-ledger.mjs books it for a killed call, and lib/budget-admission.mjs
// books it when it settles a reservation whose launcher died, without importing
// usage-ledger.mjs (that would close an import cycle through lib/worker.mjs).
// =====================================================================

/**
 * Conservative kill-cost estimate from the factory's OWN measured history: the
 * P10 (cheapest-decile) of measured `total_cost_usd` across prior calls of the
 * SAME kind. Rationale: a killed call did real work, and the cheapest comparable
 * MEASURED call is a defensible floor (never invents a price table). Returns null
 * when there is not enough history (< MIN_SAMPLES) so the caller falls back to the
 * flat floor. Self-contained (a tiny JSONL scan + percentile) so this module never
 * imports estimate.mjs — whose honesty contract forbids it from reading cost, and
 * which itself imports UNKNOWN from here (avoiding an import cycle).
 */
export const KILL_ESTIMATE_MIN_SAMPLES = 5;
export function killEstimateFromHistory(text, kind, minSamples = KILL_ESTIMATE_MIN_SAMPLES) {
  if (typeof text !== "string" || !text.trim()) return null;
  const costs = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // one corrupt line never aborts the estimate
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
    if (obj.measured !== true) continue; // only REAL measured rows ground the floor
    if (kind && obj.kind !== kind) continue;
    const c = obj.total_cost_usd;
    if (typeof c === "number" && Number.isFinite(c) && c >= 0) costs.push(c);
  }
  if (costs.length < minSamples) return null;
  costs.sort((a, b) => a - b);
  // Linear-interpolated P10 (same "type 7" convention as estimate.mjs percentile).
  const rank = 0.1 * (costs.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const p10 = lo === hi ? costs[lo] : costs[lo] + (costs[hi] - costs[lo]) * (rank - lo);
  return p10 > 0 ? p10 : null;
}

