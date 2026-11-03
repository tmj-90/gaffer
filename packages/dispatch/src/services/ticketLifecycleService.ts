/**
 * Claims and the delivery lifecycle around them as the facade composes it over
 * ClaimService, TicketService and PauseService: claiming a chosen ticket, by-hand work,
 * blocking, the runner's release, claim expiry and revocation, resuming a paused delivery,
 * and the human-gate pings those fire after their transaction commits.
 */
import { inTransaction } from "../db/connection.js";
import { claimTicketInput } from "../domain/schemas.js";
import { type Actor, type PausedDelivery, type TicketStatus } from "../domain/types.js";
import { writeEvent } from "../events/eventWriter.js";
import {
  type ClaimResult,
  type MarkBlockedInput,
  type SubmitForReviewInput,
} from "./claimService.js";
import { DispatchError, notFound } from "../util/errors.js";
import type { DispatchInternals } from "./dispatchInternals.js";
import type { Dispatch } from "../core.js";
import { emitGate } from "./gateNotifications.js";

/** What these functions read from the {@link Dispatch} facade they are handed. */
export type TicketLifecycleHost = Pick<
  Dispatch,
  | "claims"
  | "claimsRepo"
  | "clock"
  | "db"
  | "linkRepository"
  | "pauseSvc"
  | "repos"
  | "resolveTicket"
  | "reviewGateSvc"
  | "ticketSvc"
  | "tickets"
  | "transitions"
>;
/** The facade's private state these functions read. */
export type TicketLifecycleInternals = Pick<DispatchInternals, "notifier">;

/**
 * The factory loop re-entered delivery in the existing worktree (`paused ->
 * in_progress`). Returns the resume context the runner re-invokes the agent with.
 *
 * With `lease`, the resume is LEASED to that runner agent in the same transaction
 * and the claim token is returned: the runner heartbeats it and submits/releases
 * through the normal token-gated paths, and if it dies the lease lapses and the
 * expiry sweep returns the ticket to `paused`. Without a lease (older callers) a
 * resumed ticket is in_progress with no claim, which nothing can recover
 * automatically — the runner always passes one.
 */
export function beginResume(
  host: TicketLifecycleHost,
  ref: string,
  actor: Actor,
  lease?: { agentId: string; ttlSeconds: number },
): { ticketId: string; eventId: string; context: PausedDelivery; claimToken?: string } {
  return inTransaction(host.db, () => {
    const res = host.pauseSvc.beginResume(ref, actor);
    if (!lease) return res;
    const { claimToken } = host.claims.leaseResumedDelivery(
      res.ticketId,
      lease.agentId,
      lease.ttlSeconds,
      actor,
    );
    return { ...res, claimToken };
  });
}

/**
 * Claim a CHOSEN ticket (by id or number) rather than the next ready one.
 * Applies the same eligibility rules as `claimNextTicket` and the atomic claim;
 * throws a structured `TICKET_NOT_CLAIMABLE`/`NOT_FOUND` rather than silently
 * claiming a different ticket. Mirrors the runner's preselect-then-claim flow.
 */
export function claimTicket(host: TicketLifecycleHost, raw: unknown, actor: Actor): ClaimResult {
  const input = claimTicketInput.parse(raw);
  const ticket = host.resolveTicket(input.ticket_id);
  return host.claims.claimTicket(
    {
      ticketId: ticket.id,
      agentId: input.agent_id,
      ttlSeconds: input.ttl_seconds,
      capabilities: input.capabilities,
    },
    actor,
  );
}

/**
 * TRACK-2b: a HUMAN takes a ready ticket "by hand" ("I'll do this myself"). The
 * ticket moves `ready -> in_progress` owned by the human; the agent selection loop
 * structurally skips it thereafter. Resolves a ticket number/id ref, then delegates
 * to {@link ClaimService.humanClaimTicket} (reuses the atomic ready-and-unclaimed
 * invariant). Throws `TICKET_NOT_CLAIMABLE` when the ticket isn't takeable.
 */
export function humanClaimTicket(
  host: TicketLifecycleHost,
  ref: string,
  actor: Actor,
): { ticketId: string; number: number } {
  const ticket = host.resolveTicket(ref);
  return host.claims.humanClaimTicket({ ticketId: ticket.id }, actor);
}

/**
 * TRACK-2b: a human hands their by-hand ticket back to the queue
 * (`in_progress -> ready`), clearing the ownership marker so agents can pick it up.
 * Only a human-owned in-flight ticket is releasable this way — an agent's live
 * delivery is never touched. See {@link ClaimService.humanReleaseTicket}.
 */
export function humanReleaseTicket(
  host: TicketLifecycleHost,
  ref: string,
  actor: Actor,
): { ticketId: string; status: string; eventId: string } {
  const ticket = host.resolveTicket(ref);
  return host.claims.humanReleaseTicket({ ticketId: ticket.id }, actor);
}

export function submitForReview(
  host: TicketLifecycleHost,
  internals: TicketLifecycleInternals,
  input: SubmitForReviewInput,
  actor: Actor,
): { ticketId: string; status: string; eventId: string } {
  const result = host.claims.submitForReview(input, actor);
  // H2: the ticket has reached `in_review` and now needs a human reviewer. Fire
  // AFTER the claim transaction commits so the notification can never roll the
  // transition back; best-effort inside emitGate. TESTER FIRST: a ticket the tester
  // gates goes to the tester before a person looks, so the ping waits for its PASS
  // (testerPass below); a FAIL or a hold costs no human attention.
  if (result.status === "in_review") {
    // The call above already resolved the ref (id or #N), so this cannot throw.
    const ticket = host.tickets.resolveRef(input.ticket_id);
    if (!host.reviewGateSvc.laneApplies(ticket)) {
      emitGate(host, internals, "review_needed", ticket, { detail: input.reason });
    }
  }
  return result;
}

/**
 * cli-wg/F-03: a person blocks a ticket that is not in an agent's hands (draft,
 * refining, ready, or their own by-hand in_progress). See
 * {@link TicketService.humanBlockTicket}; fires the ticket_blocked gate like markBlocked.
 */
export function humanBlockTicket(
  host: TicketLifecycleHost,
  internals: TicketLifecycleInternals,
  ref: string,
  reason: string,
  actor: Actor,
): { ticketId: string; from: TicketStatus; eventId: string } {
  const result = host.ticketSvc.humanBlockTicket(ref, reason, actor);
  const ticket = host.tickets.findById(result.ticketId);
  if (ticket) emitGate(host, internals, "ticket_blocked", ticket, { detail: reason });
  return result;
}

export function markBlocked(
  host: TicketLifecycleHost,
  internals: TicketLifecycleInternals,
  input: MarkBlockedInput,
  actor: Actor,
): { ticketId: string; eventId: string } {
  const result = host.claims.markBlocked(input, actor);
  // H2: the ticket is now `blocked` and needs a human to unblock it. Emit after
  // the block transaction commits, best-effort.
  const ticket = host.tickets.resolveRef(input.ticket_id);
  emitGate(host, internals, "ticket_blocked", ticket, { detail: input.reason });
  return result;
}

/**
 * RUNNER-OWNED-BOOKKEEPING: release/park a runner-held delivery claim. Failure
 * routes the ticket to `ready` (retry); park routes to `refining` (triage,
 * branch preserved). `claimToken` is optional so a tokenless resumed
 * (`in_progress`) delivery can be parked too. See ClaimService.runnerRelease.
 */
export function runnerRelease(
  host: TicketLifecycleHost,
  internals: TicketLifecycleInternals,
  input: {
    ticket_id: string;
    to: "ready" | "refining" | "blocked";
    claimToken?: string;
    reason?: string;
    reasonCode?: string;
    attempt?: number;
    maxAttempts?: number;
    pausedUntil?: string;
  },
  actor: Actor,
): { status: string; eventId: string } {
  const result = host.claims.runnerRelease(input, actor);
  // Parking to the VISIBLE `blocked` column needs a human to unblock it — fire the
  // gate AFTER the claim transaction commits, best-effort (mirrors markBlocked).
  if (result.status === "blocked") {
    // The call above already resolved the ref (id or #N), so this cannot throw.
    const ticket = host.tickets.resolveRef(input.ticket_id);
    emitGate(host, internals, "ticket_blocked", ticket, { detail: input.reason });
  }
  return result;
}

export function expireStaleClaims(
  host: TicketLifecycleHost,
  internals: TicketLifecycleInternals,
  actor: Actor,
): { expired: number } {
  const result = host.claims.expireStaleClaims(actor);
  // A claim-expiry that lands a ticket in `blocked` (an unresolved blocking decision)
  // needs a human to unblock it — fire the operator gate per blocked ticket AFTER the
  // sweep commits, best-effort (mirrors markBlocked / runnerRelease). Without this the
  // expiry-block is silent: no Slack/webhook, and queue readers keyed on the gate miss it.
  for (const id of result.blockedTicketIds) {
    const ticket = host.tickets.findById(id);
    if (ticket) {
      emitGate(host, internals, "ticket_blocked", ticket, {
        detail: "claim expired with an unresolved blocking decision",
      });
    }
  }
  return { expired: result.expired };
}

/**
 * Human override: revoke a claim by its id, mark it revoked and return its
 * ticket to `ready` (systemOverride, bypassing policy gates). Idempotent calls
 * on an already-terminal claim raise STATE_CONFLICT.
 */
export function revokeClaim(
  host: TicketLifecycleHost,
  claimId: string,
  actor: Actor,
): { claimId: string; ticketId: string } {
  const now = host.clock.now();
  return inTransaction(host.db, () => {
    const claim = host.claimsRepo.findById(claimId);
    if (!claim) throw notFound("claim", claimId);
    if (claim.status !== "active") {
      throw new DispatchError(
        "STATE_CONFLICT",
        `Claim is '${claim.status}' and cannot be revoked.`,
        { status: claim.status },
      );
    }
    host.claimsRepo.setStatus(claim.id, "revoked", now);
    const ticket = host.tickets.findById(claim.ticket_id);
    if (ticket && (ticket.status === "claimed" || ticket.status === "in_progress")) {
      host.transitions.transition({
        ticketId: ticket.id,
        actor,
        toStatus: "ready",
        reason: "claim_revoked",
        systemOverride: true,
      });
    }
    writeEvent(host.db, {
      entity_type: "ticket",
      entity_id: claim.ticket_id,
      actor,
      event_type: "claim.revoked",
      payload: { claim_id: claim.id, agent_id: claim.agent_id },
    });
    return { claimId: claim.id, ticketId: claim.ticket_id };
  });
}

/**
 * Convenience for the idle loop: create a draft ticket, optionally link a repo,
 * and attach a manual-note evidence row capturing the supplied summary.
 */
export function createDraftTicket(
  host: TicketLifecycleHost,
  input: {
    title: string;
    description?: string;
    repoName?: string;
    evidenceSummary?: string;
    policyPack?: string;
  },
  actor: Actor,
): { ticketId: string; number: number } {
  return host.ticketSvc.createDraftTicket(input, actor, (ticketId, repoName, a) =>
    host.linkRepository(ticketId, repoName, "primary", a),
  );
}
