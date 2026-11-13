// Statistics for the numbers the dashboard shows: the Wilson interval for a rate and
// the period-over-period delta. Pure functions, no DOM.

/**
 * The Wilson score interval for k successes in n trials (95% at the default z), as
 * fractions: { lo, hi }. Honest at small n where the normal interval is not: 4 of 4
 * is about 51% to 100%, 0 of 11 still "could be up to 26%". Null for no sample.
 */
function wilson(k, n, z = 1.96) {
  const N = Number(n);
  if (!Number.isFinite(N) || N <= 0) return null;
  const K = Math.min(N, Math.max(0, Number(k) || 0));
  const p = K / N;
  const z2 = z * z;
  const denom = 1 + z2 / N;
  const centre = (p + z2 / (2 * N)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / N + z2 / (4 * N * N))) / denom;
  // At k = 0 (or k = n) the bound is exactly 0 (or 1); float noise must not say otherwise.
  return {
    lo: K === 0 ? 0 : Math.max(0, centre - half),
    hi: K === N ? 1 : Math.min(1, centre + half),
  };
}

/** A period's figure: a number, or { value, n } when its sample size matters. */
function figure(x) {
  if (x && typeof x === "object") return { value: x.value, n: x.n };
  return { value: x, n: undefined };
}

/**
 * The change from the previous period to this one: { value, direction, verdict }.
 * `direction` is up / down / flat; `verdict` reads it against `goodWhen` ("up": more
 * is better, "down": less is better): better / worse / same. Either figure may be a
 * number or { value, n }; with `minN`, a period whose n is under it gives no delta
 * (verdict null, reason "too few"), so a small sample never reads as a trend. A
 * missing value gives no delta (reason "missing").
 */
function delta(cur, prev, { goodWhen = "up", minN } = {}) {
  const a = figure(cur);
  const b = figure(prev);
  const none = (reason) => ({ value: null, direction: null, verdict: null, reason });
  if (
    typeof a.value !== "number" ||
    typeof b.value !== "number" ||
    !Number.isFinite(a.value) ||
    !Number.isFinite(b.value)
  )
    return none("missing");
  if (typeof minN === "number" && ((a.n ?? 0) < minN || (b.n ?? 0) < minN)) return none("too few");
  const value = a.value - b.value;
  if (Math.abs(value) < 1e-9) return { value: 0, direction: "flat", verdict: "same" };
  const direction = value > 0 ? "up" : "down";
  return { value, direction, verdict: direction === goodWhen ? "better" : "worse" };
}

export { wilson, delta };
