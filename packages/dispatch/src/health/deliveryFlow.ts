/**
 * Delivery-flow analytics — the ONE authoritative, server-side definition of the
 * factory's cycle-time, throughput and flow efficiency.
 *
 * Historically these were computed in two places: `boardService.cycleTimeByState`
 * (median time PER state, from transitions) and — separately and inconsistently —
 * a client-side recompute inside `renderOverview` (app.js) that derived an overall
 * created→done cycle time and a 14-day throughput series straight from the ticket
 * list. This module lifts that overall definition server-side so the Overview KPI
 * cards read a single source of truth instead of re-deriving it in the browser.
 *
 * EVENT-DERIVED, not `updated_at`-derived. The first server-side version used
 * `updated_at - created_at` as the cycle time and `updated_at` as the completion
 * day. `updated_at` moves on ANY patch — a title edit, a reopen, a feedback note —
 * so a ticket that bounced done → in_review → done, or was touched after shipping,
 * inflated its cycle and could be counted as shipped on the wrong day. The caller
 * now supplies `done_at` (the timestamp of the ticket's LAST transition into
 * `done`, from the work_events log) and the maths uses it; `updated_at` is only
 * the fallback for tickets that never emitted a transition (seeded/imported).
 *
 *   - cycle time      = median of (done_at - created_at) in days over `done` tickets
 *   - cycle series    = per-completion-day mean cycle, carried forward across the window
 *   - throughput      = tickets `done` bucketed per completion UTC day over the window
 *   - last7/prev7     = trailing-7 vs prior-7 shipped counts
 *   - flow efficiency = median over done tickets of (time in ACTIVE states) /
 *                       (done_at - created_at), as a percentage. Active states are
 *                       the ones where the factory is working the ticket (claimed,
 *                       in_progress, in_review, in_testing, ready_for_merge); time
 *                       parked in draft / refining / ready / blocked / paused is
 *                       waiting. The caller derives `active_ms` from the transition
 *                       log. `null` when no done ticket carries the signal — never a
 *                       fake 0 (the previous client-side number was a WIP ratio,
 *                       done / (done + everything in flight), which is not flow
 *                       efficiency at all).
 */

/** Minimal ticket shape needed for delivery-flow maths. */
export interface FlowTicket {
  status: string;
  created_at: string;
  updated_at: string;
  /**
   * When the ticket LAST entered `done` (from the transition log). Preferred over
   * `updated_at` for both the cycle duration and the completion day. Absent/null
   * ⇒ fall back to `updated_at` (a ticket with no transition history).
   */
  done_at?: string | null;
  /**
   * Milliseconds the ticket spent in ACTIVE states over its life (from the
   * transition log). Absent/null ⇒ the ticket contributes nothing to flow
   * efficiency (it never contributes a fake value).
   */
  active_ms?: number | null;
}

/** The authoritative cycle-time + throughput + flow-efficiency read model. */
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
  flow_efficiency: {
    /**
     * Median (active time / lead time) over shipped tickets that carry the
     * signal, 0..100 rounded to one decimal; `null` when no shipped ticket does.
     */
    median_pct: number | null;
    /** How many shipped tickets contributed to the median (0 ⇒ null above). */
    sample: number;
  };
}

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_DAYS = 14;

/** Ticket states in which the factory is actively working the ticket. */
export const FLOW_ACTIVE_STATES: ReadonlySet<string> = new Set([
  "claimed",
  "in_progress",
  "in_review",
  "in_testing",
  "ready_for_merge",
]);

/** Median of a number array (mean of the two middles when even); 0 when empty. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The completion timestamp to use for a done ticket: `done_at`, else `updated_at`. */
function completionIso(t: FlowTicket): string {
  const d = t.done_at;
  return typeof d === "string" && d.length > 0 && !Number.isNaN(Date.parse(d)) ? d : t.updated_at;
}

/**
 * Compute cycle-time, throughput and flow efficiency from the full ticket list
 * as of `nowMs`.
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

  // Throughput: tickets shipped (→done) bucketed by their completion day.
  const doneByDay = new Array<number>(windowDays).fill(0);
  // Cycle: per completion day, collect each ticket's created→done duration (days).
  const cycleByDay = new Map<number, number[]>();
  const cycleVals: number[] = [];
  // Flow efficiency: active / lead per ticket, where the signal is present.
  const effVals: number[] = [];

  for (const t of doneTickets) {
    const doneIso = completionIso(t);
    const leadMs = Date.parse(doneIso) - Date.parse(t.created_at);
    const days = leadMs / DAY_MS;
    if (days >= 0) cycleVals.push(days);

    if (
      typeof t.active_ms === "number" &&
      Number.isFinite(t.active_ms) &&
      t.active_ms >= 0 &&
      leadMs > 0
    ) {
      effVals.push(Math.min(100, (t.active_ms / leadMs) * 100));
    }

    const idx = keyIndex.get(String(doneIso).slice(0, 10));
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
    flow_efficiency: {
      median_pct: effVals.length === 0 ? null : Math.round(median(effVals) * 10) / 10,
      sample: effVals.length,
    },
  };
}

/** One state transition of a ticket, as the event log records it. */
export interface FlowTransition {
  ticket_id: string;
  from_status: string | null;
  to_status: string | null;
  created_at: string;
}

/** Per-ticket signals derived from the transition log for {@link FlowTicket}. */
export interface FlowSignals {
  done_at: string | null;
  active_ms: number | null;
}

/**
 * Reduce the ordered transition log (grouped by ticket, chronological within a
 * ticket) to the two per-ticket signals the flow maths needs: when the ticket last
 * entered `done`, and how long it spent in ACTIVE states before that. Time in an
 * active state that is still open at `done_at` is closed there; time after the
 * last `done` (a later reopen) is ignored — the metric describes the shipped
 * delivery, not what happened to the ticket afterwards.
 */
export function flowSignalsFromTransitions(
  transitions: readonly FlowTransition[],
): Map<string, FlowSignals> {
  const byTicket = new Map<string, FlowTransition[]>();
  for (const tr of transitions) {
    const list = byTicket.get(tr.ticket_id) ?? [];
    list.push(tr);
    byTicket.set(tr.ticket_id, list);
  }
  const out = new Map<string, FlowSignals>();
  for (const [ticketId, list] of byTicket) {
    const ordered = [...list].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    let doneAt: string | null = null;
    for (const tr of ordered) if (tr.to_status === "done") doneAt = tr.created_at;
    if (doneAt === null) {
      out.set(ticketId, { done_at: null, active_ms: null });
      continue;
    }
    const doneMs = Date.parse(doneAt);
    let activeMs = 0;
    let activeSince: number | null = null;
    for (const tr of ordered) {
      const at = Date.parse(tr.created_at);
      if (at > doneMs) break;
      const wasActive = activeSince !== null;
      const nowActive = tr.to_status !== null && FLOW_ACTIVE_STATES.has(tr.to_status);
      if (wasActive && !nowActive) {
        activeMs += Math.max(0, at - (activeSince as number));
        activeSince = null;
      } else if (!wasActive && nowActive) {
        activeSince = at;
      }
      if (at === doneMs && tr.to_status === "done") break;
    }
    if (activeSince !== null) activeMs += Math.max(0, doneMs - activeSince);
    out.set(ticketId, { done_at: doneAt, active_ms: activeMs });
  }
  return out;
}
