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
 *   approved without opening raw logs = done tickets whose approving (human) round has
 *                         an open event and no `ticket.review_raw_opened` in it, over
 *                         such instrumented tickets.
 *
 * Percentiles interpolate linearly between ranks (the common "type 7" estimate), rounded
 * to whole milliseconds. Pure: the caller supplies the events.
 */

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

export interface ReviewTimeReport {
  readonly measure: "human_review_time_per_accepted_ticket";
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

function firstInRound(opens: readonly ReviewOpen[], r: ReviewRound): number | null {
  let first: number | null = null;
  for (const o of opens) {
    if (o.ticketId !== r.ticketId || o.atMs < r.enteredMs || o.atMs > r.exitMs) continue;
    if (first === null || o.atMs < first) first = o.atMs;
  }
  return first;
}

export const REVIEW_TIME_LIMITS: readonly string[] = [
  "decision time runs from the first time a person opened the ticket in Review to their decision: it is wall-clock time with the page open, not reading time",
  "a round with no open event (older history, a decision from the CLI, a read-only viewer) counts its full span in review, queue wait included",
  "only human or admin decisions count; tickets that only an agent approved are counted apart",
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

/** The report (see the module comment). */
export function reviewTimeReport(input: {
  transitions: readonly ReviewTimeTransition[];
  opens: readonly ReviewOpen[];
  rawOpens: readonly ReviewOpen[];
  tickets: readonly { id: string; status: string }[];
}): ReviewTimeReport {
  const done = new Set(input.tickets.filter((t) => t.status === "done").map((t) => t.id));
  const rounds = reviewRounds(input.transitions);
  const humanRounds = rounds.filter((r) => isHuman(r.exitActor));

  const perTicket = new Map<string, number>();
  const ticketOpened = new Map<string, { opened: number; total: number }>();
  const queue: number[] = [];
  const decision: number[] = [];
  const spans: number[] = [];
  let withOpen = 0;
  for (const r of humanRounds) {
    const span = r.exitMs - r.enteredMs;
    spans.push(span);
    const opened = firstInRound(input.opens, r);
    let cost = span;
    if (opened !== null) {
      withOpen += 1;
      queue.push(opened - r.enteredMs);
      decision.push(r.exitMs - opened);
      cost = r.exitMs - opened;
    }
    if (!done.has(r.ticketId)) continue;
    perTicket.set(r.ticketId, (perTicket.get(r.ticketId) ?? 0) + cost);
    const o = ticketOpened.get(r.ticketId) ?? { opened: 0, total: 0 };
    o.total += 1;
    if (opened !== null) o.opened += 1;
    ticketOpened.set(r.ticketId, o);
  }

  let allOpened = true;
  let noneOpened = true;
  for (const o of ticketOpened.values()) {
    if (o.opened < o.total) allOpened = false;
    if (o.opened > 0) noneOpened = false;
  }
  const basis: ReviewTimeBasis =
    perTicket.size === 0
      ? "none"
      : allOpened
        ? "decision_time"
        : noneOpened
          ? "full_span"
          : "mixed";

  // The approving round of each accepted ticket: its last human round that approved.
  const approving = new Map<string, ReviewRound>();
  for (const r of humanRounds)
    if (done.has(r.ticketId) && isApprovingRound(r)) approving.set(r.ticketId, r);
  let instrumented = 0;
  let clean = 0;
  for (const r of approving.values()) {
    if (firstInRound(input.opens, r) === null) continue;
    instrumented += 1;
    if (firstInRound(input.rawOpens, r) === null) clean += 1;
  }

  return {
    measure: "human_review_time_per_accepted_ticket",
    basis,
    basis_note: BASIS_NOTE[basis],
    per_accepted_ticket: percentiles([...perTicket.values()]),
    accepted_without_human_decision: [...done].filter((id) => !perTicket.has(id)).length,
    rounds: { human_decided: humanRounds.length, with_open_event: withOpen },
    queue_wait: percentiles(queue),
    decision: percentiles(decision),
    review_ready_to_decision: percentiles(spans),
    approved_without_raw_logs: {
      instrumented,
      count: clean,
      pct: instrumented > 0 ? Math.round((clean / instrumented) * 1000) / 10 : null,
    },
    limits: REVIEW_TIME_LIMITS,
  };
}
