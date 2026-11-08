/**
 * Send-backs and holds: rejecting a review (with the P1 retry cap, security invariant 4),
 * Won't do and its reopen, reopening a reviewed ticket for review, and holding a ticket for
 * a human.
 */
import { inTransaction } from "../../db/connection.js";
import {
  type Actor,
  type ReopenForReviewCause,
  type ReviewFeedback,
  type TicketStatus,
} from "../../domain/types.js";
import { writeEvent } from "../../events/eventWriter.js";
import type { TransitionResult } from "../transitionService.js";
import { DispatchError } from "../../util/errors.js";
import { newId } from "../../util/id.js";
import { recordedLandingRepos } from "../landingStatus.js";
import type { ReviewGateInternals } from "./internals.js";
import { capRetry, reviewerPatch } from "./shared.js";
import type { ReviewGateService } from "../reviewGateService.js";
import { resolveReviewedHeads, recordRejectPins } from "./staleness.js";
import { refuseCancelOfLanded, partlyLandedHold } from "./landing.js";

/** What these functions read from the {@link ReviewGateService} facade they are handed. */
export type SendBackHost = Pick<ReviewGateService, "landingsStarted">;
/** The facade's private state these functions read. */
export type SendBackInternals = Pick<
  ReviewGateInternals,
  | "clock"
  | "db"
  | "evidence"
  | "maxAttempts"
  | "onTicketParked"
  | "reviewedHeadsResolver"
  | "ticketSvc"
  | "tickets"
  | "transitions"
>;

/**
 * Human review rejection: `in_review | ready_for_merge -> refining | ready | cancelled`.
 *
 * Abandoning to `cancelled` is terminal and never increments the retry counter.
 * Re-queuing (`ready`/`refining`) bumps `attempt_count`; once >= maxAttempts the
 * ticket is parked to `blocked` (P1 retry-cap).
 */
export function rejectReview(
  host: SendBackHost,
  internals: SendBackInternals,
  ticketRef: string,
  to: "ready" | "refining" | "cancelled",
  actor: Actor,
  reason?: string,
): TransitionResult {
  let parked: { attempt: number; requestedTarget: string; reason: string } | null = null;
  // REJECT PINS: the heads the reviewer sent back, read before the write lock is taken
  // (git never runs under it). Only a re-queue records them; abandoning has no next round.
  const pinHeads =
    to === "cancelled"
      ? []
      : resolveReviewedHeads(internals, internals.ticketSvc.resolveTicket(ticketRef));
  const result = inTransaction(internals.db, () => {
    const ticket = internals.ticketSvc.resolveTicket(ticketRef);
    if (ticket.status !== "in_review" && ticket.status !== "ready_for_merge") {
      throw new DispatchError(
        "ILLEGAL_TRANSITION",
        "Only an in-review or merging ticket can be rejected.",
        { from: ticket.status, to },
      );
    }
    if (to === "cancelled") refuseCancelOfLanded(host, internals, ticket);
    const resolvedReason = reason && reason.trim().length > 0 ? reason : "review_rejected";

    // PARTLY LANDED (cli-runner/F-02): a send-back of a ticket whose change already
    // reached a default branch is held for a person (blocked, reason code
    // partly_landed) instead of re-queued: re-queued, it read as ordinary rework while
    // half the change sat on main, and nothing then stopped it being cancelled.
    const landedRepos =
      to === "ready" || to === "refining" ? recordedLandingRepos(internals.db, ticket.id) : [];
    const holdLanded = landedRepos.length > 0;
    const isRequeue = (to === "ready" || to === "refining") && !holdLanded;
    // Abandoning (cancelled) never increments the counter; re-queue does.
    const { nextAttempt, capReached } = isRequeue
      ? capRetry(ticket.attempt_count, internals.maxAttempts)
      : { nextAttempt: ticket.attempt_count, capReached: false };
    const target: TicketStatus = capReached || holdLanded ? "blocked" : to;

    const result = internals.transitions.transition({
      ticketId: ticket.id,
      actor,
      toStatus: target,
      reason: holdLanded
        ? `partly_landed:${resolvedReason}`
        : capReached
          ? `retry_cap_reached:${resolvedReason}`
          : resolvedReason,
      expectedFromStatus: ticket.status,
      ...(isRequeue
        ? {
            patch: { attempt_count: nextAttempt, ...reviewerPatch(ticket, actor).patch },
            reviewReject: true,
          }
        : reviewerPatch(ticket, actor)),
      ...(to === "cancelled" ? { wontDo: true } : {}),
      ...(capReached || holdLanded ? { park: true } : {}),
    });
    if (holdLanded) {
      const why = partlyLandedHold(internals, ticket, landedRepos, to, resolvedReason, actor);
      parked = { attempt: ticket.attempt_count, requestedTarget: to, reason: why };
    }
    if (capReached) {
      writeEvent(internals.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.parked_retry_cap",
        payload: {
          attempt_count: nextAttempt,
          max_attempts: internals.maxAttempts,
          requested_target: to,
          reason: resolvedReason,
        },
      });
      parked = { attempt: nextAttempt, requestedTarget: to, reason: resolvedReason };
    }
    recordRejectPins(internals, ticket, actor, pinHeads, nextAttempt);
    internals.ticketSvc.resetAcceptanceCriteria(ticket.id, actor);
    const feedback: ReviewFeedback = {
      reason: resolvedReason,
      reviewer: actor.id ?? null,
      at: internals.clock.now(),
    };
    internals.tickets.setReviewFeedback(ticket.id, JSON.stringify(feedback));
    return result;
  });
  // H2: notify AFTER the transaction commits, best-effort.
  if (parked !== null) {
    const p: { attempt: number; requestedTarget: string; reason: string } = parked;
    try {
      internals.onTicketParked?.(
        result.ticket,
        p.reason.startsWith("partly landed")
          ? p.reason
          : `retry cap reached (attempt ${p.attempt}/${internals.maxAttempts}): ${p.reason}`,
      );
    } catch {
      // Notifications are never allowed to break the caller.
    }
  }
  return result;
}

/**
 * Mark a ticket "won't do" (`-> cancelled`). Resets ACs and records the
 * wontDo:true guard flag so TransitionService validates the path.
 */
export function wontDo(
  host: SendBackHost,
  internals: SendBackInternals,
  ref: string,
  actor: Actor,
  reason?: string,
): TransitionResult {
  return inTransaction(internals.db, () => {
    const ticket = internals.ticketSvc.resolveTicket(ref);
    refuseCancelOfLanded(host, internals, ticket);
    const result = internals.transitions.transition({
      ticketId: ticket.id,
      actor,
      toStatus: "cancelled",
      reason: reason && reason.trim().length > 0 ? reason : "wont_do",
      expectedFromStatus: ticket.status,
      wontDo: true,
    });
    internals.ticketSvc.resetAcceptanceCriteria(ticket.id, actor);
    return result;
  });
}

/**
 * Reopen a won't-do (`cancelled`) ticket back into the pipeline.
 */
export function reopenFromWontDo(
  internals: SendBackInternals,
  ref: string,
  to: "refining" | "draft",
  actor: Actor,
): TransitionResult {
  const ticket = internals.ticketSvc.resolveTicket(ref);
  return internals.transitions.transition({
    ticketId: ticket.id,
    actor,
    toStatus: to,
    reason: "reopened_from_wont_do",
    expectedFromStatus: "cancelled",
  });
}

/**
 * Reopen a merged or merging ticket for review (`done | ready_for_merge -> in_review`).
 * SYSTEM/admin only.
 */
export function reopenForReview(
  internals: SendBackInternals,
  ref: string,
  input: { reason: string; resolution: string; cause?: ReopenForReviewCause },
  actor: Actor,
): { ticketId: string; status: string; eventId: string } {
  if (actor.type !== "system" && actor.type !== "admin") {
    throw new DispatchError(
      "ACTOR_NOT_PERMITTED",
      "Only a system or admin actor may reopen a done ticket for review.",
      { actor_type: actor.type },
    );
  }
  const reason = input.reason.trim();
  const resolution = input.resolution.trim();
  if (resolution.length === 0) {
    throw new DispatchError("VALIDATION_ERROR", "A resolution summary is required.");
  }
  return inTransaction(internals.db, () => {
    const ticket = internals.ticketSvc.resolveTicket(ref);
    if (ticket.status !== "done" && ticket.status !== "ready_for_merge") {
      throw new DispatchError(
        "ILLEGAL_TRANSITION",
        "Only a done or merging ticket can be reopened for review.",
        { from: ticket.status, to: "in_review" },
      );
    }
    const result = internals.transitions.transition({
      ticketId: ticket.id,
      actor,
      toStatus: "in_review",
      reason: reason.length > 0 ? reason : "reopened_for_review",
      expectedFromStatus: ticket.status,
      reopenForReview: true,
    });
    const now = internals.clock.now();
    const evidenceId = newId();
    internals.evidence.insert({
      id: evidenceId,
      ticket_id: ticket.id,
      ac_id: null,
      repo_id: null,
      decision_id: null,
      evidence_type: "manual_note",
      summary: resolution,
      uri: null,
      payload_json: null,
      created_by: actor.id ?? actor.type,
      recorded_by_actor_type: actor.type,
      created_at: now,
    });
    const eventId = writeEvent(internals.db, {
      entity_type: "ticket",
      entity_id: ticket.id,
      actor,
      event_type: "ticket.reopened_for_review",
      payload: {
        reason: reason.length > 0 ? reason : null,
        resolution,
        // What sent it back (the caller's cause; Dispatch.reopenForReview infers one
        // from the ticket's hold). Only the resolver's conflict reopen says a merge
        // conflict was resolved.
        cause: input.cause ?? "merge_conflict",
        merge_conflict_resolved: (input.cause ?? "merge_conflict") === "merge_conflict",
        evidence_id: evidenceId,
      },
    });
    return { ticketId: ticket.id, status: result.ticket.status, eventId };
  });
}

/**
 * HOLD FOR A HUMAN: park an approved ticket (`ready_for_merge | in_testing -> blocked`)
 * with a structured reason code, so it leaves the merge lane and waits in the human
 * queue (the `parked` kind) with the reason. SYSTEM/admin only — the runner's merge
 * gate (the combined code failed the gates on the target) and a late red CI result
 * use it; a board drag cannot (the `park` guard).
 */
export function holdForHuman(
  internals: SendBackInternals,
  ticketRef: string,
  input: { reasonCode: string; reason: string },
  actor: Actor,
): TransitionResult {
  if (actor.type !== "system" && actor.type !== "admin") {
    throw new DispatchError(
      "ACTOR_NOT_PERMITTED",
      "Only the runner (system) or an admin may hold an approved ticket for a human.",
      { actor_type: actor.type },
    );
  }
  const code = input.reasonCode.trim();
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(code)) {
    throw new DispatchError("VALIDATION_ERROR", "reason code must be a snake_case word.", {
      reason_code: input.reasonCode,
    });
  }
  const reason = input.reason.trim().slice(0, 4_000) || code;
  return inTransaction(internals.db, () => {
    const ticket = internals.ticketSvc.resolveTicket(ticketRef);
    if (ticket.status !== "ready_for_merge" && ticket.status !== "in_testing") {
      throw new DispatchError(
        "ILLEGAL_TRANSITION",
        "Only an approved ticket (ready_for_merge or in_testing) can be held for a human.",
        { from: ticket.status, to: "blocked" },
      );
    }
    const result = internals.transitions.transition({
      ticketId: ticket.id,
      actor,
      toStatus: "blocked",
      reason: `held:${code}`,
      expectedFromStatus: ticket.status,
      park: true,
    });
    writeEvent(internals.db, {
      entity_type: "ticket",
      entity_id: ticket.id,
      actor,
      event_type: "ticket.blocked",
      payload: { reason, reason_code: code },
    });
    return result;
  });
}
