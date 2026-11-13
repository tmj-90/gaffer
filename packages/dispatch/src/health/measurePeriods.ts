/**
 * Periods for the four delivery quality measures (first-pass acceptance, human review
 * time, accepted-change cost, escaped-defect rate): the window a figure covers, the equal
 * window before it, and the calendar buckets of their history.
 *
 *   window    the last `days` days up to now; `null` days means all time (no previous)
 *   previous  the `days` days before the window, [now - 2 * days, now - days)
 *   by_week   the last 12 ISO weeks (Monday 00:00 UTC), the current partial week last
 *   by_month  the last 6 calendar months (UTC), the current partial month last
 *
 * Every bucket is present: a bucket with nothing in it carries n 0 and a null value,
 * never a zero or a value carried forward from the bucket before. Each measure places a
 * record in a bucket with one lookup (arithmetic for weeks, a year-month key for months),
 * so a history costs one pass over the records the measure already read.
 *
 * Pure: the caller supplies now.
 */

export const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** How many weeks and months of history each measure serves. */
export const HISTORY_WEEKS = 12;
export const HISTORY_MONTHS = 6;

/** A time range, [sinceMs, untilMs). Infinite ends are open. */
export interface MeasureRange {
  readonly sinceMs: number;
  readonly untilMs: number;
}

/** All time. */
export const ALL_TIME: MeasureRange = {
  sinceMs: Number.NEGATIVE_INFINITY,
  untilMs: Number.POSITIVE_INFINITY,
};

/**
 * The last `days` days; all time when days is null. Open at the end, as the escaped-defect
 * window always was, so a record stamped a moment after now is not lost.
 */
export function windowRange(nowMs: number, days: number | null): MeasureRange {
  if (days === null) return ALL_TIME;
  return { sinceMs: nowMs - days * DAY_MS, untilMs: Number.POSITIVE_INFINITY };
}

/** The equal window before {@link windowRange}; null when the window is all time. */
export function previousRange(nowMs: number, days: number | null): MeasureRange | null {
  if (days === null) return null;
  return { sinceMs: nowMs - 2 * days * DAY_MS, untilMs: nowMs - days * DAY_MS };
}

/** True when `atMs` is a known time inside the range (NaN, an unknown time, never is). */
export function inRange(r: MeasureRange, atMs: number): boolean {
  return !Number.isNaN(atMs) && atMs >= r.sinceMs && atMs < r.untilMs;
}

/** The ISO instants of a previous range, for the response. */
export function rangeIso(r: MeasureRange): { since: string; until: string } {
  return { since: new Date(r.sinceMs).toISOString(), until: new Date(r.untilMs).toISOString() };
}

/** One ISO week bucket: its key ("2026-W46") and its Monday ("2026-11-09"). */
export interface WeekBucket {
  readonly week: string;
  readonly start: string;
  /** True for the current week, which has not ended. */
  readonly partial: boolean;
}

/** One calendar month bucket ("2026-11"). */
export interface MonthBucket {
  readonly month: string;
  /** True for the current month, which has not ended. */
  readonly partial: boolean;
}

/** Monday 00:00 UTC of the ISO week holding `ms`. */
function mondayOf(ms: number): number {
  const day = Math.floor(ms / DAY_MS) * DAY_MS;
  const dow = (new Date(day).getUTCDay() + 6) % 7; // Monday 0 .. Sunday 6
  return day - dow * DAY_MS;
}

/** "2026-W46" for the ISO week starting on the Monday `mondayMs`. */
function isoWeekKey(mondayMs: number): string {
  const thursday = new Date(mondayMs + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / WEEK_MS) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/**
 * The last {@link HISTORY_WEEKS} ISO weeks up to the one holding now, oldest first, and a
 * lookup from a time to its bucket index (-1 outside them).
 */
export function weekGrid(
  nowMs: number,
  weeks: number = HISTORY_WEEKS,
): { readonly buckets: readonly WeekBucket[]; readonly indexOf: (atMs: number) => number } {
  const current = mondayOf(nowMs);
  const first = current - (weeks - 1) * WEEK_MS;
  const buckets: WeekBucket[] = [];
  for (let i = 0; i < weeks; i++) {
    const monday = first + i * WEEK_MS;
    buckets.push({
      week: isoWeekKey(monday),
      start: new Date(monday).toISOString().slice(0, 10),
      partial: i === weeks - 1,
    });
  }
  const end = current + WEEK_MS;
  return {
    buckets,
    indexOf: (atMs) =>
      Number.isFinite(atMs) && atMs >= first && atMs < end && atMs <= nowMs
        ? Math.floor((atMs - first) / WEEK_MS)
        : -1,
  };
}

/**
 * The last {@link HISTORY_MONTHS} calendar months up to the one holding now, oldest
 * first, each with its end (exclusive), and a lookup from a time to its bucket index.
 */
export function monthGrid(
  nowMs: number,
  months: number = HISTORY_MONTHS,
): {
  readonly buckets: readonly (MonthBucket & { readonly endMs: number })[];
  readonly indexOf: (atMs: number) => number;
} {
  const now = new Date(nowMs);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const buckets: (MonthBucket & { endMs: number })[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const start = new Date(Date.UTC(y, m - i, 1));
    buckets.push({
      month: start.toISOString().slice(0, 7),
      partial: i === 0,
      endMs: Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1),
    });
  }
  const firstMs = Date.UTC(y, m - (months - 1), 1);
  const index = new Map(buckets.map((b, i) => [b.month, i]));
  return {
    buckets,
    indexOf: (atMs) => {
      if (!Number.isFinite(atMs) || atMs < firstMs || atMs > nowMs) return -1;
      return index.get(new Date(atMs).toISOString().slice(0, 7)) ?? -1;
    },
  };
}

/** A rate as a percentage with one decimal, null on an empty denominator. */
export function pct1(n: number, d: number): number | null {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : null;
}

/**
 * The upper end of the Wilson score interval (95%, z = 1.96) for k of n, as a percentage
 * with one decimal; null when n is 0. At k = 0 it is z^2 / (n + z^2): 0 of 11 could be up
 * to 25.9%, which is what a zero on a small sample can honestly claim.
 */
export function wilsonUpperPct(k: number, n: number): number | null {
  if (n <= 0) return null;
  const z = 1.96;
  const z2 = z * z;
  const p = k / n;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const upper = Math.min(1, (centre + spread) / (1 + z2 / n));
  return Math.round(upper * 1000) / 10;
}

/**
 * Linear-interpolated quantile ("type 7") of an ascending sample; null when empty.
 * At q = 0.5 it equals the usual median (the mean of the two middles on an even count).
 */
export function quantileSorted(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}
