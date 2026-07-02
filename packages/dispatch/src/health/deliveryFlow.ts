/**
 * Delivery-flow analytics — the ONE authoritative, server-side definition of the
 * factory's cycle-time and throughput.
 *
 * Historically these were computed in two places: `boardService.cycleTimeByState`
 * (median time PER state, from transitions) and — separately and inconsistently —
 * a client-side recompute inside `renderOverview` (app.js) that derived an overall
 * created→done cycle time and a 14-day throughput series straight from the ticket
 * list. This module lifts that overall definition server-side so the Overview KPI
 * cards read a single source of truth instead of re-deriving it in the browser.
 *
 * The maths intentionally reproduces the previous client computation exactly so
 * the displayed numbers do not move — this is a data-source refactor, not a
 * metric change:
 *   - cycle time  = median of (updated_at - created_at) in days over `done` tickets
 *   - cycle series = per-completion-day mean cycle, carried forward across the window
 *   - throughput   = tickets `done` bucketed per UTC day over the window
 *   - last7/prev7  = trailing-7 vs prior-7 shipped counts
 */

/** Minimal ticket shape needed for delivery-flow maths. */
export interface FlowTicket {
  status: string;
  created_at: string;
  updated_at: string;
}

/** The authoritative cycle-time + throughput read model. */
export interface DeliveryFlow {
  cycle_time: {
    /** Median created→done time in days over shipped tickets (0 when none). */
    median_days: number;
    /** Per-day carried-forward mean cycle, oldest→newest, length = windowDays. */
    series: number[];
  };
  throughput: {
    /** Tickets shipped in the trailing 7 days of the window. */
    last7: number;
    /** Tickets shipped in the 7 days before that. */
    prev7: number;
    /** Tickets shipped per day, oldest→newest, length = windowDays. */
    series: number[];
  };
}

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_DAYS = 14;

/** Median of a number array (mean of the two middles when even); 0 when empty. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Compute cycle-time and throughput from the full ticket list as of `nowMs`.
 *
 * @param tickets     Every ticket (any status); only `done` rows feed the maths.
 * @param nowMs       "Now" in epoch millis — the window ends on this UTC day.
 * @param windowDays  Series length in days (default 14).
 */
export function deliveryFlow(
  tickets: readonly FlowTicket[],
  nowMs: number,
  windowDays: number = DEFAULT_WINDOW_DAYS,
): DeliveryFlow {
  // Window day-keys, oldest → newest (matches the old client `days` array).
  const dayKeys: string[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    dayKeys.push(new Date(nowMs - i * DAY_MS).toISOString().slice(0, 10));
  }
  const keyIndex = new Map(dayKeys.map((k, i) => [k, i]));

  const doneTickets = tickets.filter((t) => t.status === "done");

  // Throughput: tickets shipped (→done) bucketed by their updated_at day.
  const doneByDay = new Array<number>(windowDays).fill(0);
  // Cycle: per completion day, collect each ticket's created→done duration (days).
  const cycleByDay = new Map<number, number[]>();
  const cycleVals: number[] = [];

  for (const t of doneTickets) {
    const days = (Date.parse(t.updated_at) - Date.parse(t.created_at)) / DAY_MS;
    if (days >= 0) cycleVals.push(days);

    const idx = keyIndex.get(String(t.updated_at).slice(0, 10));
    if (idx === undefined) continue;
    doneByDay[idx] = (doneByDay[idx] ?? 0) + 1;
    if (days >= 0) {
      const bucket = cycleByDay.get(idx) ?? [];
      bucket.push(days);
      cycleByDay.set(idx, bucket);
    }
  }

  // Cycle series: mean of that day's cycles, carried forward across gaps.
  let carry: number | null = null;
  const cycleSeries = dayKeys.map((_, i) => {
    const bucket = cycleByDay.get(i);
    if (bucket && bucket.length > 0) {
      carry = bucket.reduce((a, b) => a + b, 0) / bucket.length;
    }
    return carry == null ? 0 : Math.round(carry * 100) / 100;
  });

  const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
  const last7 = sum(doneByDay.slice(-7));
  const prev7 = sum(doneByDay.slice(-14, -7));

  return {
    cycle_time: { median_days: median(cycleVals), series: cycleSeries },
    throughput: { last7, prev7, series: doneByDay },
  };
}
