/**
 * Send-backs — every time a ticket was sent back for another delivery attempt.
 *
 * There are two kinds, recorded in two places:
 *   - a REVIEW send-back: a reviewer or tester rejected the delivery — a
 *     `ticket.transitioned` event out of in_review / in_testing / ready_for_merge back
 *     to refining / ready / in_progress (or parked to blocked by the retry cap);
 *   - a RUNNER RETRY: the runner re-invoked the agent after a failed gate inside one
 *     delivery — a row in `rework_attempts` (the ticket never left in_progress).
 * The Health report used to count only the second, so a ticket a reviewer bounced
 * read as never reworked (third external review). Both feed the rework rate and the
 * rework spend.
 */
import type { SendBack } from "./healthAggregator.js";

/** One `ticket.transitioned` event, projected. */
export interface SendBackTransition {
  readonly ticketId: string;
  readonly fromStatus: string | null;
  readonly toStatus: string | null;
  readonly reason: string | null;
  readonly at: string;
}

/** One `rework_attempts` row, projected. */
export interface RunnerRetry {
  readonly ticketId: string;
  readonly at: string;
}

const REVIEW_STATES = new Set(["in_review", "in_testing", "ready_for_merge"]);
const BACK_TO_WORK = new Set(["refining", "ready", "in_progress", "claimed"]);

/** True when a transition is a reviewer's or tester's rejection back to work. */
export function isReviewSendBack(t: SendBackTransition): boolean {
  if (!REVIEW_STATES.has(t.fromStatus ?? "")) return false;
  const to = t.toStatus ?? "";
  if (BACK_TO_WORK.has(to)) return true;
  // The retry cap parks a rejected ticket to blocked instead of re-queuing it.
  return to === "blocked" && (t.reason ?? "").startsWith("retry_cap_reached:");
}

/** Every send-back per ticket id, oldest first. */
export function sendBacksByTicket(
  transitions: readonly SendBackTransition[],
  retries: readonly RunnerRetry[],
): Map<string, SendBack[]> {
  const out = new Map<string, SendBack[]>();
  const add = (ticketId: string, back: SendBack): void => {
    const list = out.get(ticketId);
    if (list) list.push(back);
    else out.set(ticketId, [back]);
  };
  for (const t of transitions) {
    if (isReviewSendBack(t)) add(t.ticketId, { at: t.at, source: "review" });
  }
  for (const r of retries) add(r.ticketId, { at: r.at, source: "retry" });
  for (const list of out.values()) list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return out;
}
