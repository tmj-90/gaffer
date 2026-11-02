/**
 * COST PER ACCEPTED CHANGE — evaluation that counts every attempt (external review #9).
 *
 * The eval harness's `costPerPass` divides the spend on JUDGED deliveries by the
 * judge-passing ones: a delivery that was parked, failed a gate, ran out of attempts or
 * was abandoned is never judged, so its spend never reached the figure, and the result
 * understated what a change that a person actually accepted costs. This report reads the
 * usage ledger, which records every model call the runner makes (every delivery attempt,
 * the reviewer, the tester, the merge resolver, planning for a ticket), and the ticket
 * outcomes from dispatch:
 *
 *   cost_per_accepted_change_usd = spend attributed to ANY ticket, whatever its outcome
 *                                  ÷ tickets that reached `done`
 *   attempts_per_accepted_change = delivery attempts on ANY ticket ÷ tickets that reached done
 *   reviewer time                = for each human/admin decision that took a ticket out of
 *                                  in_review, the time since it entered in_review
 *
 * Limits (also in `limits`, and docs/eval-harness.md): spend with no ticket (onboarding,
 * idle loops, planning before a ticket exists) is reported as `unattributed_usd` and
 * excluded from the ratio; a ticket still in flight adds its spend to the numerator but
 * nothing to the denominator until it lands (so the figure is pessimistic mid-run);
 * reviewer time is wall-clock time in review, not time spent reading (the transition log
 * cannot show attention), and only reviews that ended in a human decision count; there is
 * no baseline (the same changes made with the coding agent directly) to compare against.
 * Pure: the caller supplies the ledger rows, the tickets and the transitions.
 */
import type { HealthRow } from "./healthAggregator.js";

/** One ticket as this report needs it. */
export interface AcceptedChangeTicket {
  readonly id: string;
  readonly number: number;
  readonly status: string;
}

/** A status transition from the event log (`ticket.transitioned`). */
export interface AcceptedChangeTransition {
  readonly ticketId: string;
  readonly actorType: string;
  readonly fromStatus: string | null;
  readonly toStatus: string | null;
  readonly atMs: number;
}

export interface OutcomeSpend {
  readonly tickets: number;
  readonly spend_usd: number;
  readonly delivery_attempts: number;
}

export interface AcceptedChangeReport {
  readonly measure: "all_attempts_over_accepted_changes";
  /** Tickets that reached done (the denominator). */
  readonly accepted_changes: number;
  /** Spend attributed to any ticket, every attempt and every kind (the numerator). */
  readonly attributed_spend_usd: number;
  /** Ledger spend with no ticket: excluded from the ratio, reported so nothing hides. */
  readonly unattributed_usd: number;
  /** attributed_spend_usd ÷ accepted_changes, or null before the first accepted change. */
  readonly cost_per_accepted_change_usd: number | null;
  /** What the accepted tickets alone cost each (the figure that leaves failures out). */
  readonly accepted_only_cost_per_change_usd: number | null;
  /** Delivery attempts on every ticket ÷ accepted changes, or null. */
  readonly attempts_per_accepted_change: number | null;
  /** Spend and attempts split by where the ticket ended up. */
  readonly by_outcome: {
    readonly accepted: OutcomeSpend;
    readonly in_flight: OutcomeSpend;
    readonly parked_or_failed: OutcomeSpend;
    readonly abandoned: OutcomeSpend;
  };
  /** Human review time where the transition log records it. */
  readonly reviewer_time: {
    readonly recorded_reviews: number;
    readonly total_ms: number;
    readonly mean_ms: number | null;
    /** Review time on tickets that reached done ÷ accepted changes, or null. */
    readonly per_accepted_change_ms: number | null;
  };
  readonly limits: readonly string[];
}

const DELIVERY_KIND = "delivery";
const PARKED = new Set(["blocked", "refining", "paused", "failed"]);
const ABANDONED = new Set(["cancelled"]);

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function outcomeOf(status: string | undefined): keyof AcceptedChangeReport["by_outcome"] {
  if (status === "done") return "accepted";
  if (status && ABANDONED.has(status)) return "abandoned";
  if (status && PARKED.has(status)) return "parked_or_failed";
  return "in_flight";
}

/**
 * Human review spans: every time a human or admin took a ticket OUT of in_review
 * (approve, reject, send back), the time since it last entered in_review. Keyed by
 * ticket id; transitions in any order.
 */
export function reviewSpansByTicket(
  transitions: readonly AcceptedChangeTransition[],
): Map<string, number[]> {
  const sorted = [...transitions].sort((a, b) => a.atMs - b.atMs);
  const entered = new Map<string, number>();
  const spans = new Map<string, number[]>();
  for (const t of sorted) {
    if (t.fromStatus === "in_review") {
      const since = entered.get(t.ticketId);
      if (
        since !== undefined &&
        (t.actorType === "human" || t.actorType === "admin") &&
        t.atMs >= since
      ) {
        const list = spans.get(t.ticketId) ?? [];
        list.push(t.atMs - since);
        spans.set(t.ticketId, list);
      }
      entered.delete(t.ticketId);
    }
    if (t.toStatus === "in_review") entered.set(t.ticketId, t.atMs);
  }
  return spans;
}

export const ACCEPTED_CHANGE_LIMITS: readonly string[] = [
  "spend with no ticket (onboarding, idle loops, planning before a ticket exists) is reported as unattributed and left out of the ratio",
  "a ticket still in flight adds its spend but no accepted change until it lands, so mid-run the figure reads high",
  "reviewer time is wall-clock time in review ending in a human decision, not time spent reading",
  "there is no baseline: the same changes made with the coding agent directly are not measured",
];

/** The report (see the module comment). */
export function acceptedChangeCost(
  rows: readonly HealthRow[],
  tickets: readonly AcceptedChangeTicket[],
  transitions: readonly AcceptedChangeTransition[] = [],
): AcceptedChangeReport {
  const statusByNumber = new Map<number, string>();
  const idByNumber = new Map<number, string>();
  for (const t of tickets) {
    statusByNumber.set(t.number, t.status);
    idByNumber.set(t.number, t.id);
  }
  const acc = {
    accepted: { tickets: new Set<number>(), spend: 0, attempts: 0 },
    in_flight: { tickets: new Set<number>(), spend: 0, attempts: 0 },
    parked_or_failed: { tickets: new Set<number>(), spend: 0, attempts: 0 },
    abandoned: { tickets: new Set<number>(), spend: 0, attempts: 0 },
  };
  let attributed = 0;
  let unattributed = 0;
  const seenAttempt = new Set<string>();
  for (const r of rows) {
    const spend = r.total_cost_usd + (r.estimated_cost_usd ?? 0);
    if (r.ticket === null) {
      unattributed += spend;
      continue;
    }
    attributed += spend;
    const bucket = acc[outcomeOf(statusByNumber.get(r.ticket))];
    bucket.tickets.add(r.ticket);
    bucket.spend += spend;
    if (r.kind === DELIVERY_KIND) {
      // One attempt may span several ledger rows (a retry inside the same attempt id).
      const key = r.attempt_id ? `${r.ticket}:${r.attempt_id}` : null;
      if (key === null || !seenAttempt.has(key)) {
        if (key) seenAttempt.add(key);
        bucket.attempts += 1;
      }
    }
  }
  const accepted = tickets.filter((t) => t.status === "done").length;
  const totalAttempts =
    acc.accepted.attempts +
    acc.in_flight.attempts +
    acc.parked_or_failed.attempts +
    acc.abandoned.attempts;

  const spans = reviewSpansByTicket(transitions);
  let recorded = 0;
  let totalMs = 0;
  let acceptedMs = 0;
  const doneIds = new Set(tickets.filter((t) => t.status === "done").map((t) => t.id));
  for (const [id, list] of spans) {
    for (const ms of list) {
      recorded += 1;
      totalMs += ms;
      if (doneIds.has(id)) acceptedMs += ms;
    }
  }
  const out = (b: (typeof acc)["accepted"]): OutcomeSpend => ({
    tickets: b.tickets.size,
    spend_usd: round6(b.spend),
    delivery_attempts: b.attempts,
  });
  return {
    measure: "all_attempts_over_accepted_changes",
    accepted_changes: accepted,
    attributed_spend_usd: round6(attributed),
    unattributed_usd: round6(unattributed),
    cost_per_accepted_change_usd: accepted > 0 ? round6(attributed / accepted) : null,
    accepted_only_cost_per_change_usd: accepted > 0 ? round6(acc.accepted.spend / accepted) : null,
    attempts_per_accepted_change:
      accepted > 0 ? Math.round((totalAttempts / accepted) * 100) / 100 : null,
    by_outcome: {
      accepted: out(acc.accepted),
      in_flight: out(acc.in_flight),
      parked_or_failed: out(acc.parked_or_failed),
      abandoned: out(acc.abandoned),
    },
    reviewer_time: {
      recorded_reviews: recorded,
      total_ms: totalMs,
      mean_ms: recorded > 0 ? Math.round(totalMs / recorded) : null,
      per_accepted_change_ms:
        accepted > 0 && recorded > 0 ? Math.round(acceptedMs / accepted) : null,
    },
    limits: ACCEPTED_CHANGE_LIMITS,
  };
}
