/**
 * Review-gate service (BBT-001, WG-049, security-critical).
 *
 * SECURITY INVARIANTS — must never be weakened:
 *
 *  1. approveReview is HUMAN-ONLY by default. An agent actor is REJECTED unless
 *     the operator has explicitly opted in via `DISPATCH_ALLOW_AGENT_APPROVE=1`.
 *     Do not add any other bypass path.
 *
 *  2. testerVerdict plumbing: transitions that carry `testerVerdict:true` are the
 *     ones the independent black-box tester uses to move tickets through the BBT
 *     lane (`in_review -> in_testing -> ready_for_merge | refining`). Do not
 *     remove or weaken the `testerVerdict` flag on those calls.
 *
 *  3. markMerged is SYSTEM/admin-only. A board-drag or agent can never call it
 *     because the `markMerged:true` guard flag is required by TransitionService.
 *
 *  4. The P1 retry-cap: rejectReview and testerFail bump `attempt_count` on every
 *     re-queue. Once `attempt_count >= maxAttempts` the ticket is parked to
 *     `blocked` (not re-queued forever). `capRetry` is the shared helper.
 */

import { type Db, inTransaction } from "../db/connection.js";
import { type Actor, type ReviewFeedback, type TicketStatus } from "../domain/types.js";
import { writeEvent } from "../events/eventWriter.js";
import { AcRepository } from "../repositories/acRepository.js";
import { EvidenceRepository } from "../repositories/evidenceRepository.js";
import { TicketRepository } from "../repositories/ticketRepository.js";
import type { TransitionResult, TransitionService } from "./transitionService.js";
import type { TicketService } from "./ticketService.js";
import type { Clock } from "../util/clock.js";
import { DispatchError } from "../util/errors.js";
import { newId } from "../util/id.js";
import { isTestingEnabled, testerProvenance } from "../util/testingLane.js";

// Re-export so consumers don't need to reach into core directly.
export { isTestingEnabled, testerProvenance };

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

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface ReviewGateServiceDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly tickets: TicketRepository;
  readonly acs: AcRepository;
  readonly evidence: EvidenceRepository;
  readonly transitions: TransitionService;
  readonly ticketSvc: TicketService;
  readonly maxAttempts: number;
  /** Per-instance override for the GAFFER_TESTING toggle (undefined = read env). */
  readonly testingEnabledOverride?: boolean | undefined;
  /**
   * Called after rejectReview parks a ticket (retry cap reached).
   * Best-effort — errors are swallowed so notifications never break callers.
   */
  readonly onTicketParked?: (ticket: import("../domain/types.js").Ticket, detail: string) => void;
}

export class ReviewGateService {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly tickets: TicketRepository;
  private readonly acs: AcRepository;
  private readonly evidence: EvidenceRepository;
  private readonly transitions: TransitionService;
  private readonly ticketSvc: TicketService;
  private readonly maxAttempts: number;
  private readonly testingEnabledOverride: boolean | undefined;
  private readonly onTicketParked:
    | ((ticket: import("../domain/types.js").Ticket, detail: string) => void)
    | undefined;

  constructor(deps: ReviewGateServiceDeps) {
    this.db = deps.db;
    this.clock = deps.clock;
    this.tickets = deps.tickets;
    this.acs = deps.acs;
    this.evidence = deps.evidence;
    this.transitions = deps.transitions;
    this.ticketSvc = deps.ticketSvc;
    this.maxAttempts = deps.maxAttempts;
    this.testingEnabledOverride = deps.testingEnabledOverride;
    this.onTicketParked = deps.onTicketParked;
  }

  // ---------------------------------------------------------------------------
  // Public methods
  // ---------------------------------------------------------------------------

  /**
   * Human review approval: `in_review -> ready_for_merge` (NOT `done`). The human
   * has approved the diff; the merge runner now does the git merge.
   *
   * SECURITY: By DEFAULT only a human/admin may approve — an `agent`-type actor
   * can never approve its own work. Operator opt-in via `DISPATCH_ALLOW_AGENT_APPROVE=1`
   * removes this gate (their machine, their call).
   */
  approveReview(ticketRef: string, actor: Actor): TransitionResult {
    // P0 authz — do NOT weaken or remove this check.
    const agentApproveAllowed =
      actor.type === "agent" && process.env.DISPATCH_ALLOW_AGENT_APPROVE === "1";
    if (actor.type !== "human" && actor.type !== "admin" && !agentApproveAllowed) {
      throw new DispatchError(
        "ACTOR_NOT_PERMITTED",
        "Only a human or admin may approve a review (set DISPATCH_ALLOW_AGENT_APPROVE=1 to allow autonomous agent approval).",
        { actor_type: actor.type },
      );
    }
    const ticket = this.ticketSvc.resolveTicket(ticketRef);
    // BBT-001: when the testing lane is ON and this ticket is eligible, route
    // through the independent tester (`in_review -> in_testing`) instead of
    // straight to merge. testerVerdict:true guards this transition.
    if (this.testingEnabled() && ticket.can_be_tested === 1) {
      const result = this.transitions.transition({
        ticketId: ticket.id,
        actor,
        toStatus: "in_testing",
        reason: "review_approved_to_testing",
        expectedFromStatus: "in_review",
        testerVerdict: true,
      });
      writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.routed_to_testing",
        payload: { from: "in_review" },
      });
      return result;
    }
    return this.transitions.transition({
      ticketId: ticket.id,
      actor,
      toStatus: "ready_for_merge",
      reason: "review_approved",
      expectedFromStatus: "in_review",
    });
  }

  /**
   * The independent black-box tester PASSED (`in_testing -> ready_for_merge`).
   * testerVerdict:true guards this transition.
   */
  testerPass(
    ticketRef: string,
    input: { summary: string; uri?: string },
    actor: Actor,
  ): TransitionResult {
    const summary = input.summary.trim();
    if (summary.length === 0) {
      throw new DispatchError("VALIDATION_ERROR", "A test-result summary is required.");
    }
    return inTransaction(this.db, () => {
      const ticket = this.ticketSvc.resolveTicket(ticketRef);
      if (ticket.status !== "in_testing") {
        throw new DispatchError(
          "ILLEGAL_TRANSITION",
          "Only a ticket in testing can be passed by the tester.",
          { from: ticket.status, to: "ready_for_merge" },
        );
      }
      // Record the passing test result as evidence so it is visible in review.
      const evidenceId = newId();
      const now = this.clock.now();
      this.evidence.insert({
        id: evidenceId,
        ticket_id: ticket.id,
        ac_id: null,
        repo_id: null,
        decision_id: null,
        evidence_type: "test_output",
        summary,
        uri: input.uri ?? null,
        payload_json: JSON.stringify({ verdict: "pass", provenance: testerProvenance(actor) }),
        created_by: actor.id ?? actor.type,
        created_at: now,
      });
      const result = this.transitions.transition({
        ticketId: ticket.id,
        actor,
        toStatus: "ready_for_merge",
        reason: "tester_passed",
        expectedFromStatus: "in_testing",
        testerVerdict: true,
      });
      writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.tester_passed",
        payload: { evidence_id: evidenceId },
      });
      return result;
    });
  }

  /**
   * The independent black-box tester FAILED (`in_testing -> refining`).
   * Reuses the reject machinery: AC reset, attempt bump, retry-cap park.
   */
  testerFail(
    ticketRef: string,
    input: { summary: string; uri?: string },
    actor: Actor,
  ): TransitionResult {
    const summary = input.summary.trim();
    if (summary.length === 0) {
      throw new DispatchError("VALIDATION_ERROR", "A failing-test summary is required.");
    }
    return inTransaction(this.db, () => {
      const ticket = this.ticketSvc.resolveTicket(ticketRef);
      if (ticket.status !== "in_testing") {
        throw new DispatchError(
          "ILLEGAL_TRANSITION",
          "Only a ticket in testing can be failed by the tester.",
          { from: ticket.status, to: "refining" },
        );
      }
      // Record the failing test as evidence BEFORE the AC reset / transition.
      const evidenceId = newId();
      const now = this.clock.now();
      this.evidence.insert({
        id: evidenceId,
        ticket_id: ticket.id,
        ac_id: null,
        repo_id: null,
        decision_id: null,
        evidence_type: "test_output",
        summary,
        uri: input.uri ?? null,
        payload_json: JSON.stringify({ verdict: "fail", provenance: testerProvenance(actor) }),
        created_by: actor.id ?? actor.type,
        created_at: now,
      });

      const { nextAttempt, capReached } = capRetry(ticket.attempt_count, this.maxAttempts);
      const target: TicketStatus = capReached ? "blocked" : "refining";
      const reason = `tester_failed:${summary}`;
      const result = this.transitions.transition({
        ticketId: ticket.id,
        actor,
        toStatus: target,
        reason: capReached ? `retry_cap_reached:${reason}` : reason,
        expectedFromStatus: "in_testing",
        patch: { attempt_count: nextAttempt },
        ...(capReached ? { park: true } : { testerVerdict: true }),
      });
      if (capReached) {
        writeEvent(this.db, {
          entity_type: "ticket",
          entity_id: ticket.id,
          actor,
          event_type: "ticket.parked_retry_cap",
          payload: { attempt_count: nextAttempt, max_attempts: this.maxAttempts, reason },
        });
      }
      this.ticketSvc.resetAcceptanceCriteria(ticket.id, actor);
      const feedback: ReviewFeedback = {
        reason,
        reviewer: actor.id ?? null,
        at: now,
      };
      this.tickets.setReviewFeedback(ticket.id, JSON.stringify(feedback));
      writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.tester_failed",
        payload: { evidence_id: evidenceId },
      });
      return result;
    });
  }

  /**
   * MERGE-COMPLETE: `ready_for_merge -> done`. SYSTEM/admin only.
   * The markMerged:true flag is required by TransitionService — a board-drag
   * or agent can never trigger this path.
   */
  markMerged(ref: string, actor: Actor): TransitionResult {
    if (actor.type !== "system" && actor.type !== "admin") {
      throw new DispatchError(
        "ACTOR_NOT_PERMITTED",
        "Only a system or admin actor may mark a ticket merged.",
        { actor_type: actor.type },
      );
    }
    const ticket = this.ticketSvc.resolveTicket(ref);
    return this.transitions.transition({
      ticketId: ticket.id,
      actor,
      toStatus: "done",
      reason: "merge_completed",
      expectedFromStatus: "ready_for_merge",
      markMerged: true,
    });
  }

  /**
   * Reopen a merged or merging ticket for review (`done | ready_for_merge -> in_review`).
   * SYSTEM/admin only.
   */
  reopenForReview(
    ref: string,
    input: { reason: string; resolution: string },
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
    return inTransaction(this.db, () => {
      const ticket = this.ticketSvc.resolveTicket(ref);
      if (ticket.status !== "done" && ticket.status !== "ready_for_merge") {
        throw new DispatchError(
          "ILLEGAL_TRANSITION",
          "Only a done or merging ticket can be reopened for review.",
          { from: ticket.status, to: "in_review" },
        );
      }
      const result = this.transitions.transition({
        ticketId: ticket.id,
        actor,
        toStatus: "in_review",
        reason: reason.length > 0 ? reason : "reopened_for_review",
        expectedFromStatus: ticket.status,
        reopenForReview: true,
      });
      const now = this.clock.now();
      const evidenceId = newId();
      this.evidence.insert({
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
        created_at: now,
      });
      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.reopened_for_review",
        payload: {
          reason: reason.length > 0 ? reason : null,
          resolution,
          merge_conflict_resolved: true,
          evidence_id: evidenceId,
        },
      });
      return { ticketId: ticket.id, status: result.ticket.status, eventId };
    });
  }

  /**
   * Human review rejection: `in_review | ready_for_merge -> refining | ready | cancelled`.
   *
   * Abandoning to `cancelled` is terminal and never increments the retry counter.
   * Re-queuing (`ready`/`refining`) bumps `attempt_count`; once >= maxAttempts the
   * ticket is parked to `blocked` (P1 retry-cap).
   */
  rejectReview(
    ticketRef: string,
    to: "ready" | "refining" | "cancelled",
    actor: Actor,
    reason?: string,
  ): TransitionResult {
    let parked: { attempt: number; requestedTarget: string; reason: string } | null = null;
    const result = inTransaction(this.db, () => {
      const ticket = this.ticketSvc.resolveTicket(ticketRef);
      if (ticket.status !== "in_review" && ticket.status !== "ready_for_merge") {
        throw new DispatchError(
          "ILLEGAL_TRANSITION",
          "Only an in-review or merging ticket can be rejected.",
          { from: ticket.status, to },
        );
      }
      const resolvedReason = reason && reason.trim().length > 0 ? reason : "review_rejected";

      const isRequeue = to === "ready" || to === "refining";
      // Abandoning (cancelled) never increments the counter; re-queue does.
      const { nextAttempt, capReached } = isRequeue
        ? capRetry(ticket.attempt_count, this.maxAttempts)
        : { nextAttempt: ticket.attempt_count, capReached: false };
      const target: TicketStatus = capReached ? "blocked" : to;

      const result = this.transitions.transition({
        ticketId: ticket.id,
        actor,
        toStatus: target,
        reason: capReached ? `retry_cap_reached:${resolvedReason}` : resolvedReason,
        expectedFromStatus: ticket.status,
        ...(isRequeue ? { patch: { attempt_count: nextAttempt } } : {}),
        ...(to === "cancelled" ? { wontDo: true } : {}),
        ...(capReached ? { park: true } : {}),
      });
      if (capReached) {
        writeEvent(this.db, {
          entity_type: "ticket",
          entity_id: ticket.id,
          actor,
          event_type: "ticket.parked_retry_cap",
          payload: {
            attempt_count: nextAttempt,
            max_attempts: this.maxAttempts,
            requested_target: to,
            reason: resolvedReason,
          },
        });
        parked = { attempt: nextAttempt, requestedTarget: to, reason: resolvedReason };
      }
      this.ticketSvc.resetAcceptanceCriteria(ticket.id, actor);
      const feedback: ReviewFeedback = {
        reason: resolvedReason,
        reviewer: actor.id ?? null,
        at: this.clock.now(),
      };
      this.tickets.setReviewFeedback(ticket.id, JSON.stringify(feedback));
      return result;
    });
    // H2: notify AFTER the transaction commits, best-effort.
    if (parked !== null) {
      const p: { attempt: number; requestedTarget: string; reason: string } = parked;
      try {
        this.onTicketParked?.(
          result.ticket,
          `retry cap reached (attempt ${p.attempt}/${this.maxAttempts}): ${p.reason}`,
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
  wontDo(ref: string, actor: Actor, reason?: string): TransitionResult {
    return inTransaction(this.db, () => {
      const ticket = this.ticketSvc.resolveTicket(ref);
      const result = this.transitions.transition({
        ticketId: ticket.id,
        actor,
        toStatus: "cancelled",
        reason: reason && reason.trim().length > 0 ? reason : "wont_do",
        expectedFromStatus: ticket.status,
        wontDo: true,
      });
      this.ticketSvc.resetAcceptanceCriteria(ticket.id, actor);
      return result;
    });
  }

  /**
   * Reopen a won't-do (`cancelled`) ticket back into the pipeline.
   */
  reopenFromWontDo(ref: string, to: "refining" | "draft", actor: Actor): TransitionResult {
    const ticket = this.ticketSvc.resolveTicket(ref);
    return this.transitions.transition({
      ticketId: ticket.id,
      actor,
      toStatus: to,
      reason: "reopened_from_wont_do",
      expectedFromStatus: "cancelled",
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * BBT-001 toggle accessor — overridable per-instance for tests. Defaults to the
   * `GAFFER_TESTING` env read via `isTestingEnabled`.
   */
  private testingEnabled(): boolean {
    return this.testingEnabledOverride ?? isTestingEnabled();
  }
}
