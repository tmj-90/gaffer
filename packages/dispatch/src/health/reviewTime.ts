/**
 * HUMAN REVIEW TIME per accepted ticket (Release A metrics, gap-review A0).
 *
 * The Release A measure is the median human review minutes per accepted ticket. The
 * transition log alone gives the wall-clock span of each review round (in_review entry
 * to the human decision that ends it), and most of that span is the change waiting in
 * the queue. The Review view records `ticket.review_opened` the first time a human
 * renders the ticket in a round, which splits the round:
 *
 *   queue wait     = round entry -> first review_opened in the round
 *   decision time  = first review_opened -> the human/admin decision
 *
 * A round with no open event (older history, a CLI review, a read-only viewer) falls
 * back to its full span, and the report says which basis it used: `decision_time`
 * (every accepted ticket's rounds were opened), `full_span` (none were), `mixed`, or
 * `none` (no accepted ticket had a human decision).
 *
 *   per accepted ticket = sum over its human-decided rounds of the decision time (or the
 *                         span), over tickets that reached done with at least one
 *                         human decision. Agent-only accepted tickets are counted apart
 *                         (`accepted_without_human_decision`), never as zero minutes, so widening
 *                         agent approval cannot read as faster review.
 *   review-ready to decision = the full span of every human-decided round.
 *   active (approximate) = per human-decided round with an open event, the decision minus
 *                         the LAST open (`ticket.review_opened` or `ticket.review_raw_opened`)
 *                         in the round, capped at two hours: closer to the minutes a person
 *                         spent than decision time (which starts at the first open, so a page
 *                         left open overnight counts), still not reading time. Per accepted
 *                         ticket only when every human round of it has an open.
 *   approved without opening raw logs = done tickets whose approving (human) round has
 *                         an open event and no `ticket.review_raw_opened` in it, over
 *                         such instrumented tickets.
 *
 * Percentiles interpolate linearly between ranks (the common "type 7" estimate), rounded
 * to whole milliseconds. Pure: the caller supplies the events.
 *
 * Period (health/measurePeriods.ts): with `windowDays` the report counts by decision
 * time: a round by its decision, an accepted ticket by its last human decision (all of
 * its rounds summed there), an agent-only accepted ticket by its acceptance. `previous`
 * is the N days before; `by_week` is the per-accepted-ticket median over the last 12 ISO
 * weeks by last human decision. Without it the report is all time, as before.
 */
import {
  ALL_TIME,
  inRange,
  previousRange,
  rangeIso,
  weekGrid,
  windowRange,
  type MeasureRange,
  type WeekBucket,
} from "./measurePeriods.js";

/** A status transition from the event log (`ticket.transitioned`). */
export interface ReviewTimeTransition {
  readonly ticketId: string;
  readonly actorType: string;
  readonly fromStatus: string | null;
  readonly toStatus: string | null;
  readonly atMs: number;
}

/** A `ticket.review_opened` (or `ticket.review_raw_opened`, with `what`) event. */
export interface ReviewOpen {
  readonly ticketId: string;
  readonly atMs: number;
  readonly what?: string;
}

export interface Percentiles {
  readonly n: number;
  readonly median_ms: number | null;
  readonly p75_ms: number | null;
  readonly p90_ms: number | null;
}

export type ReviewTimeBasis = "decision_time" | "full_span" | "mixed" | "none";

/** The approximate attention figure (see the module comment). */
export interface ActiveReviewTime {
  readonly basis: "last_open_to_decision_capped";
  readonly cap_ms: number;
  readonly note: string;
  readonly per_accepted_ticket: Percentiles;
  readonly per_round: Percentiles;
  /** Rounds whose last-open-to-decision span was longer than the cap. */
  readonly capped_rounds: number;
}

/** Two hours: a longer gap from the last open to the decision is not one sitting. */
export const ACTIVE_CAP_MS = 2 * 60 * 60_000;

export const ACTIVE_NOTE =
  "Active (approximate): from the last time a person opened the ticket or a raw view in the round to their decision, capped at 2 hours. Closer to attention than decision time, still not reading time.";

/** The headline over the equal window before this one. */
export interface ReviewTimePrevious {
  readonly since: string;
  readonly until: string;
  readonly per_accepted_ticket: Percentiles;
  readonly accepted_without_human_decision: number;
}

/** One ISO week, by each accepted ticket's last human decision. */
export interface ReviewTimeWeek extends WeekBucket {
  readonly n: number;
  readonly median_ms: number | null;
}

export interface ReviewTimeReport {
  readonly measure: "human_review_time_per_accepted_ticket";
  /** The window the figures cover, in days, by decision time; null is all time. */
  readonly window_days: number | null;
  readonly basis: ReviewTimeBasis;
  readonly basis_note: string;
  /** Per accepted ticket: the sum of its human rounds' decision time (or span). */
  readonly per_accepted_ticket: Percentiles;
  /** Accepted tickets that no human decided (agent or system approvals only). */
  readonly accepted_without_human_decision: number;
  readonly rounds: { readonly human_decided: number; readonly with_open_event: number };
  /** Entry -> first open, over human-decided rounds with an open event. */
  readonly queue_wait: Percentiles;
  /** First open -> decision, over human-decided rounds with an open event. */
  readonly decision: Percentiles;
  /** Entry -> decision, over every human-decided round. */
  readonly review_ready_to_decision: Percentiles;
  readonly approved_without_raw_logs: {
    readonly instrumented: number;
    readonly count: number;
    readonly pct: number | null;
  };
  /** Last open -> decision, capped: the approximate attention figure. */
  readonly active: ActiveReviewTime;
  /** The equal window before; null when the window is all time. */
  readonly previous: ReviewTimePrevious | null;
  /** The last 12 ISO weeks; an empty week has n 0 and a null median. */
  readonly by_week: readonly ReviewTimeWeek[];
  readonly limits: readonly string[];
}

/**
 * Where an approving exit from in_review goes: the merge queue, the testing lane, or
 * done. A pause at a cap, a won't-do or a send-back is not an approval.
 */
const APPROVED_TO = new Set(["ready_for_merge", "in_testing", "done"]);

const isHuman = (actorType: string): boolean => actorType === "human" || actorType === "admin";

function quantile(sorted: readonly number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const v = sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
  return Math.round(v);
}

/** Median, p75 and p90 of a sample (null on an empty one). */
export function percentiles(values: readonly number[]): Percentiles {
  if (values.length === 0) return { n: 0, median_ms: null, p75_ms: null, p90_ms: null };
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    median_ms: quantile(s, 0.5),
    p75_ms: quantile(s, 0.75),
    p90_ms: quantile(s, 0.9),
  };
}

/** One review round: from an in_review entry to the transition that ended it. */
export interface ReviewRound {
  readonly ticketId: string;
  readonly enteredMs: number;
  readonly exitMs: number;
  readonly exitActor: string;
  readonly exitTo: string | null;
}

/** Every finished review round per ticket, oldest first. Transitions in any order. */
export function reviewRounds(transitions: readonly ReviewTimeTransition[]): ReviewRound[] {
  const sorted = [...transitions].sort((a, b) => a.atMs - b.atMs);
  const entered = new Map<string, number>();
  const out: ReviewRound[] = [];
  for (const t of sorted) {
    if (t.fromStatus === "in_review") {
      const since = entered.get(t.ticketId);
      if (since !== undefined && t.atMs >= since) {
        out.push({
          ticketId: t.ticketId,
          enteredMs: since,
          exitMs: t.atMs,
          exitActor: t.actorType,
          exitTo: t.toStatus,
        });
      }
      entered.delete(t.ticketId);
    }
    if (t.toStatus === "in_review") entered.set(t.ticketId, t.atMs);
  }
  return out;
}

/** True when a round ended in an approval (not a send-back, a pause or a won't-do). */
export function isApprovingRound(r: ReviewRound): boolean {
  return r.exitTo !== null && APPROVED_TO.has(r.exitTo);
}

/** Open times per ticket, so a round looks only at its own ticket's opens. */
function opensByTicket(opens: readonly ReviewOpen[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const o of opens) {
    const list = out.get(o.ticketId);
    if (list) list.push(o.atMs);
    else out.set(o.ticketId, [o.atMs]);
  }
  return out;
}

function firstInRound(opens: Map<string, number[]>, r: ReviewRound): number | null {
  let first: number | null = null;
  for (const at of opens.get(r.ticketId) ?? []) {
    if (at < r.enteredMs || at > r.exitMs) continue;
    if (first === null || at < first) first = at;
  }
  return first;
}

function lastInRound(opens: Map<string, number[]>, r: ReviewRound): number | null {
  let last: number | null = null;
  for (const at of opens.get(r.ticketId) ?? []) {
    if (at < r.enteredMs || at > r.exitMs) continue;
    if (last === null || at > last) last = at;
  }
  return last;
}

export const REVIEW_TIME_LIMITS: readonly string[] = [
  "decision time runs from the first time a person opened the ticket in Review to their decision: it is wall-clock time with the page open, not reading time",
  "a round with no open event (older history, a decision from the CLI, a read-only viewer) counts its full span in review, queue wait included",
  "only human or admin decisions count; tickets that only an agent approved are counted apart",
  "active time runs from the last open in the round to the decision, capped at two hours: an approximation of attention, not a measurement of reading",
  "a window, the previous window and the weekly history count by decision time: an accepted ticket at its last human decision, with all of its rounds",
];

const BASIS_NOTE: Record<ReviewTimeBasis, string> = {
  decision_time:
    "Decision time: every accepted ticket's review rounds have an open event from the Review view.",
  full_span:
    "Full span in review: no accepted ticket's round has an open event yet, so queue wait is included.",
  mixed:
    "Mixed: decision time where the Review view recorded an open, the full span in review (queue wait included) where it did not.",
  none: "No accepted ticket has a human review decision yet.",
};

/** One human-decided round, with what the open events say about it. */
interface RoundFacts {
  readonly round: ReviewRound;
  readonly span: number;
  /** First `ticket.review_opened` in the round, or null. */
  readonly opened: number | null;
  /** Last open of either kind in the round, or null. */
  readonly lastOpen: number | null;
}

/** One accepted ticket's human review, summed over its human-decided rounds. */
interface TicketFacts {
  cost: number;
  rounds: number;
  opened: number;
  activeSum: number;
  activeAll: boolean;
  /** Its last human decision: where a window or a week counts it. */
  lastDecisionMs: number;
  /** Its approving human round, if one approved it. */
  approving: RoundFacts | null;
}

/** The report (see the module comment). */
export function reviewTimeReport(
  input: {
    transitions: readonly ReviewTimeTransition[];
    opens: readonly ReviewOpen[];
    rawOpens: readonly ReviewOpen[];
    tickets: readonly { id: string; status: string }[];
  },
  period: { readonly nowMs?: number; readonly windowDays?: number | null } = {},
): ReviewTimeReport {
  const done = new Set(input.tickets.filter((t) => t.status === "done").map((t) => t.id));
  const humanRounds = reviewRounds(input.transitions).filter((r) => isHuman(r.exitActor));
  const opens = opensByTicket(input.opens);
  const rawOpens = opensByTicket(input.rawOpens);
  const allOpens = opensByTicket([...input.opens, ...input.rawOpens]);

  // One pass over the rounds: each round's facts, and each accepted ticket's sum.
  const rounds: RoundFacts[] = [];
  const perTicket = new Map<string, TicketFacts>();
  for (const r of humanRounds) {
    const f: RoundFacts = {
      round: r,
      span: r.exitMs - r.enteredMs,
      opened: firstInRound(opens, r),
      lastOpen: lastInRound(allOpens, r),
    };
    rounds.push(f);
    if (!done.has(r.ticketId)) continue;
    const t = perTicket.get(r.ticketId) ?? {
      cost: 0,
      rounds: 0,
      opened: 0,
      activeSum: 0,
      activeAll: true,
      lastDecisionMs: r.exitMs,
      approving: null,
    };
    t.cost += f.opened !== null ? r.exitMs - f.opened : f.span;
    t.rounds += 1;
    if (f.opened !== null) t.opened += 1;
    if (f.lastOpen === null) t.activeAll = false;
    else t.activeSum += Math.min(r.exitMs - f.lastOpen, ACTIVE_CAP_MS);
    t.lastDecisionMs = Math.max(t.lastDecisionMs, r.exitMs);
    if (isApprovingRound(r)) t.approving = f;
    perTicket.set(r.ticketId, t);
  }
  // When each done ticket was accepted (its last move to done), for the tickets no human
  // decided: a window counts them by acceptance.
  const acceptedAt = new Map<string, number>();
  for (const t of input.transitions)
    if (t.toStatus === "done" && done.has(t.ticketId))
      acceptedAt.set(t.ticketId, Math.max(acceptedAt.get(t.ticketId) ?? t.atMs, t.atMs));
  const withoutHuman = (range: MeasureRange): number => {
    let n = 0;
    for (const id of done) {
      if (perTicket.has(id)) continue;
      if (range === ALL_TIME || inRange(range, acceptedAt.get(id) ?? Number.NaN)) n += 1;
    }
    return n;
  };
  const ticketsIn = (range: MeasureRange): TicketFacts[] =>
    [...perTicket.values()].filter((t) => range === ALL_TIME || inRange(range, t.lastDecisionMs));

  const nowMs = period.nowMs ?? Date.now();
  const windowDays = period.windowDays ?? null;
  const win = windowRange(nowMs, windowDays);
  const winRounds = rounds.filter((f) => win === ALL_TIME || inRange(win, f.round.exitMs));
  const winTickets = ticketsIn(win);

  const queue: number[] = [];
  const decision: number[] = [];
  const spans: number[] = [];
  const activeRounds: number[] = [];
  let withOpen = 0;
  let capped = 0;
  for (const f of winRounds) {
    spans.push(f.span);
    if (f.opened !== null) {
      withOpen += 1;
      queue.push(f.opened - f.round.enteredMs);
      decision.push(f.round.exitMs - f.opened);
    }
    if (f.lastOpen !== null) {
      const span = f.round.exitMs - f.lastOpen;
      if (span > ACTIVE_CAP_MS) capped += 1;
      activeRounds.push(Math.min(span, ACTIVE_CAP_MS));
    }
  }

  // ACTIVE (approximate): the last open of either kind to the decision, capped.
  const active: ActiveReviewTime = {
    basis: "last_open_to_decision_capped",
    cap_ms: ACTIVE_CAP_MS,
    note: ACTIVE_NOTE,
    per_accepted_ticket: percentiles(winTickets.filter((t) => t.activeAll).map((t) => t.activeSum)),
    per_round: percentiles(activeRounds),
    capped_rounds: capped,
  };

  let allOpened = true;
  let noneOpened = true;
  for (const t of winTickets) {
    if (t.opened < t.rounds) allOpened = false;
    if (t.opened > 0) noneOpened = false;
  }
  const basis: ReviewTimeBasis =
    winTickets.length === 0
      ? "none"
      : allOpened
        ? "decision_time"
        : noneOpened
          ? "full_span"
          : "mixed";

  // The approving round of each accepted ticket: its last human round that approved.
  let instrumented = 0;
  let clean = 0;
  for (const t of winTickets) {
    const f = t.approving;
    if (f === null || f.opened === null) continue;
    instrumented += 1;
    if (firstInRound(rawOpens, f.round) === null) clean += 1;
  }

  const prev = previousRange(nowMs, windowDays);
  const previous: ReviewTimePrevious | null = prev
    ? {
        ...rangeIso(prev),
        per_accepted_ticket: percentiles(ticketsIn(prev).map((t) => t.cost)),
        accepted_without_human_decision: withoutHuman(prev),
      }
    : null;

  // Weekly history: one pass, each accepted ticket into the week of its last decision.
  const grid = weekGrid(nowMs);
  const weeks: number[][] = grid.buckets.map(() => []);
  for (const t of perTicket.values()) {
    const i = grid.indexOf(t.lastDecisionMs);
    if (i >= 0) weeks[i]!.push(t.cost);
  }

  return {
    measure: "human_review_time_per_accepted_ticket",
    window_days: windowDays,
    basis,
    basis_note: BASIS_NOTE[basis],
    per_accepted_ticket: percentiles(winTickets.map((t) => t.cost)),
    accepted_without_human_decision: withoutHuman(win),
    rounds: { human_decided: winRounds.length, with_open_event: withOpen },
    queue_wait: percentiles(queue),
    decision: percentiles(decision),
    review_ready_to_decision: percentiles(spans),
    approved_without_raw_logs: {
      instrumented,
      count: clean,
      pct: instrumented > 0 ? Math.round((clean / instrumented) * 1000) / 10 : null,
    },
    active,
    previous,
    by_week: grid.buckets.map((b, i) => {
      const p = percentiles(weeks[i]!);
      return { ...b, n: p.n, median_ms: p.median_ms };
    }),
    limits: REVIEW_TIME_LIMITS,
  };
}
