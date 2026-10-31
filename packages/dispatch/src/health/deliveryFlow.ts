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
 *   - flow efficiency = median over done tickets of (time an agent was WORKING the
 *                       ticket: `claimed` / `in_progress`) / (done_at - created_at),
 *                       as a percentage. `null` when no done ticket carries the
 *                       signal — never a fake 0.
 *   - waiting         = the rest of the lead time, split by what it was waiting on:
 *                       review (`in_review` / `in_testing`), the merge queue
 *                       (`ready_for_merge`), held (`blocked` / `paused`), sent back
 *                       (draft / refining / ready AFTER work began: a reviewer's or
 *                       tester's send-back waiting for a human to refine it or the
 *                       runner to re-claim it) and the backlog before work started
 *                       (draft / refining / ready before work began). The QUEUE share
 *                       is review + merge + held + sent back over lead time.
 *
 * "Work began" is the first transition into a working, review or merge state
 * (`claimed`, `in_progress`, `in_review`, `in_testing`, `ready_for_merge`). All time
 * before it is backlog, including a hold (a draft blocked on a dependency has not
 * started). After it, draft / refining / ready mean the ticket was sent back and is
 * queued for rework, so that time counts as queued after work began rather than as
 * time "before work started". The four parts partition lead time: work, queued after
 * work began, and backlog before it.
 *
 * Why review and the merge queue are WAITING, not work (third external review): a
 * ticket that took 11 minutes to reach merge-ready and then sat there for a week read
 * as 100% flow efficiency, "time spent working", because ready_for_merge (and
 * in_review / in_testing) counted as active. The transition log shows how long a
 * ticket sat in review, never how long anyone actively reviewed it, so the metric
 * claims only what the log can establish: time with an agent on it is work, time
 * between hand-offs is a queue, and the merge wait is reported on its own.
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
   * Milliseconds an agent spent WORKING the ticket (`claimed` / `in_progress`, from
   * the transition log). Absent/null ⇒ the ticket contributes nothing to flow
   * efficiency (it never contributes a fake value).
   */
  active_ms?: number | null;
  /** Milliseconds per waiting bucket (from the transition log); absent ⇒ no signal. */
  wait_ms?: FlowWaitMs | null;
}

/** Time a shipped ticket spent waiting after it was created, by what it waited on. */
export interface FlowWaitMs {
  /** In review or testing (waiting for, or with, a reviewer or tester). */
  review: number;
  /** Approved and waiting to merge (`ready_for_merge`). */
  merge: number;
  /** Blocked or paused after work began (a hold before it is backlog). */
  held: number;
  /**
   * Back in draft / refining / ready after work began: sent back by a reviewer or
   * tester (or reset) and waiting for a human to refine it or the runner to re-claim it.
   */
  requeued: number;
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
  /**
   * Where the rest of the lead time went, medians over shipped tickets with the
   * signal (all null when none). Review is counted as waiting: the log shows how long
   * a ticket sat in review, not how long anyone actively reviewed it.
   */
  waiting: {
    sample: number;
    /**
     * Median share of lead time queued after work began (review + merge + held + sent
     * back), 0..100.
     */
    queue_pct: number | null;
    /** Median queued time (review + merge + held + sent back), ms. */
    queue_ms: number | null;
    /** Median time in review or testing, ms. */
    review_ms: number | null;
    /** Median time approved and waiting to merge, ms. */
    merge_wait_ms: number | null;
    /** The longest merge wait among shipped tickets, ms. */
    merge_wait_max_ms: number | null;
    /** Median time blocked or paused after work began, ms. */
    held_ms: number | null;
    /** Median time sent back and waiting to be reworked (draft / refining / ready after work began), ms. */
    requeued_ms: number | null;
    /** Median time before work started (everything before the first claim / review / merge state), ms. */
    backlog_ms: number | null;
  };
}

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_DAYS = 14;

/** Ticket states in which an agent is working the ticket: the only "work" time. */
export const FLOW_ACTIVE_STATES: ReadonlySet<string> = new Set(["claimed", "in_progress"]);

/** Which waiting bucket a state's time falls in (states not listed: backlog / terminal). */
export const FLOW_WAIT_BUCKET: Readonly<Record<string, keyof FlowWaitMs>> = {
  in_review: "review",
  in_testing: "review",
  ready_for_merge: "merge",
  blocked: "held",
  paused: "held",
};

/** Backlog states: before work began they are backlog, after it a send-back queue. */
export const FLOW_BACKLOG_STATES: ReadonlySet<string> = new Set(["draft", "refining", "ready"]);

/** Entering any of these means work on the ticket has begun. */
const FLOW_WORK_BEGAN_STATES: ReadonlySet<string> = new Set([
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
  // Waiting: per-ticket queue share and per-bucket durations.
  const queuePct: number[] = [];
  const queueMs: number[] = [];
  const reviewMs: number[] = [];
  const mergeMs: number[] = [];
  const heldMs: number[] = [];
  const requeuedMs: number[] = [];
  const backlogMs: number[] = [];

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
      const w = t.wait_ms;
      if (w) {
        // `requeued` may be absent on a signal built before the bucket existed.
        const requeued = typeof w.requeued === "number" ? w.requeued : 0;
        const queued = w.review + w.merge + w.held + requeued;
        queuePct.push(Math.min(100, (queued / leadMs) * 100));
        queueMs.push(queued);
        reviewMs.push(w.review);
        mergeMs.push(w.merge);
        heldMs.push(w.held);
        requeuedMs.push(requeued);
        backlogMs.push(Math.max(0, leadMs - t.active_ms - queued));
      }
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
    waiting: {
      sample: queuePct.length,
      queue_pct: queuePct.length === 0 ? null : Math.round(median(queuePct) * 10) / 10,
      queue_ms: queueMs.length === 0 ? null : Math.round(median(queueMs)),
      review_ms: reviewMs.length === 0 ? null : Math.round(median(reviewMs)),
      merge_wait_ms: mergeMs.length === 0 ? null : Math.round(median(mergeMs)),
      merge_wait_max_ms: mergeMs.length === 0 ? null : Math.max(...mergeMs),
      held_ms: heldMs.length === 0 ? null : Math.round(median(heldMs)),
      requeued_ms: requeuedMs.length === 0 ? null : Math.round(median(requeuedMs)),
      backlog_ms: backlogMs.length === 0 ? null : Math.round(median(backlogMs)),
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
  /** Time in each waiting bucket before done_at; null when the ticket never reached done. */
  wait_ms: FlowWaitMs | null;
}

/**
 * Reduce the ordered transition log (grouped by ticket, chronological within a
 * ticket) to the per-ticket signals the flow maths needs: when the ticket last
 * entered `done`, how long an agent worked it before that, and how long it waited in
 * review, the merge queue, on hold and sent back for rework. Each interval between two transitions belongs
 * to the state the earlier one entered; an interval still open at `done_at` is closed
 * there. Time after the last `done` (a later reopen) is ignored — the metric describes
 * the shipped delivery, not what happened to the ticket afterwards. Time before the
 * first transition is backlog (deliveryFlow derives it from the lead time), and so is
 * draft / refining / ready time before work began; the same states after work began
 * (a send-back) count as `requeued`.
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
      out.set(ticketId, { done_at: null, active_ms: null, wait_ms: null });
      continue;
    }
    const doneMs = Date.parse(doneAt);
    let activeMs = 0;
    const wait: FlowWaitMs = { review: 0, merge: 0, held: 0, requeued: 0 };
    let state: string | null = null;
    let since: number | null = null;
    let workBegan = false;
    const close = (until: number): void => {
      if (state === null || since === null) return;
      const span = Math.max(0, Math.min(until, doneMs) - since);
      // Everything before work began is backlog, left to deliveryFlow's remainder
      // (a draft blocked on a dependency has not started; it is not queued work).
      if (!workBegan) return;
      if (FLOW_ACTIVE_STATES.has(state)) activeMs += span;
      else if (FLOW_BACKLOG_STATES.has(state)) wait.requeued += span;
      else {
        const bucket = FLOW_WAIT_BUCKET[state];
        if (bucket) wait[bucket] += span;
      }
    };
    for (const tr of ordered) {
      const at = Date.parse(tr.created_at);
      if (at > doneMs) break;
      close(at);
      state = tr.to_status;
      since = at;
      if (state !== null && FLOW_WORK_BEGAN_STATES.has(state)) workBegan = true;
      if (at === doneMs && tr.to_status === "done") break;
    }
    close(doneMs);
    out.set(ticketId, { done_at: doneAt, active_ms: activeMs, wait_ms: wait });
  }
  return out;
}
