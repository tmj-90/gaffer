/**
 * Small helpers the review gate's modules share: the P1 retry cap (capRetry, security
 * invariant 4 in reviewGateService.ts) and the reviewer patch an approve or reject records.
 */
import { type Actor, type Ticket } from "../../domain/types.js";

// ---------------------------------------------------------------------------
// Shared helper: P1 retry-cap logic
// ---------------------------------------------------------------------------

/**
 * Compute the retry-cap state for a reject or tester-fail:
 * - bumps `attempt_count` by 1 on every call.
 * - when `nextAttempt >= maxAttempts` sets `capReached:true` so the caller
 *   parks the ticket to `blocked` instead of re-queuing it.
 */
export function capRetry(
  currentAttemptCount: number,
  maxAttempts: number,
): { nextAttempt: number; capReached: boolean } {
  const nextAttempt = currentAttemptCount + 1;
  return { nextAttempt, capReached: nextAttempt >= maxAttempts };
}

/**
 * cli-wg/F-04: the person who approves or rejects a review is its reviewer. A ticket
 * with no reviewer assigned (the loose packs never need one before ready) records the
 * human/admin who decided it, so `ticket.reviewer` names who looked; an assigned
 * reviewer is never overwritten, and an agent or runner decision sets nothing.
 */
export function reviewerPatch(ticket: Ticket, actor: Actor): { patch?: { reviewer: string } } {
  if (ticket.reviewer !== null) return {};
  if (actor.type !== "human" && actor.type !== "admin") return {};
  return actor.id ? { patch: { reviewer: actor.id } } : {};
}
