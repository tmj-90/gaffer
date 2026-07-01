import { type Db, inTransaction } from "../db/connection.js";
import { recordEvidenceInput, registerAgentInput } from "../domain/schemas.js";
import {
  riskRank,
  type Actor,
  parseReviewFeedback,
  type Agent,
  type EvidenceType,
  type ReviewFeedback,
  type TicketClaim,
  type TicketDependencyView,
} from "../domain/types.js";
import { writeEvent } from "../events/eventWriter.js";
import { AcRepository } from "../repositories/acRepository.js";
import { AgentRepository } from "../repositories/agentRepository.js";
import { ClaimRepository } from "../repositories/claimRepository.js";
import { DecisionRepository } from "../repositories/decisionRepository.js";
import { EvidenceRepository } from "../repositories/evidenceRepository.js";
import { ReworkAttemptRepository } from "../repositories/reworkAttemptRepository.js";
import { TicketDependencyRepository } from "../repositories/ticketDependencyRepository.js";
import { TicketRepository } from "../repositories/ticketRepository.js";
import type { TransitionService } from "./transitionService.js";
import { type Clock, isoPlusSeconds } from "../util/clock.js";
import { DispatchError, notFound } from "../util/errors.js";
import { hashClaimToken, newClaimToken, newId } from "../util/id.js";

/** SQLite error shape for a partial-unique-index violation (one active claim). */
function isUniqueConstraint(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

/**
 * Build the EP-001 `DEPENDENCY_BLOCKED` error for a ticket gated by one or more
 * not-yet-`done` dependencies. The message + `blocked_by` detail name the
 * specific tickets ("blocked by #3, #5") so the runner/UI can show exactly what
 * must finish first. Shared by the claim path and the core facade so both report
 * dependency gating identically.
 */
export function dependencyBlockedError(
  ticketLabel: string | number,
  ticketId: string,
  unsatisfied: readonly TicketDependencyView[],
): DispatchError {
  const refs = unsatisfied.map((d) =>
    d.number !== null ? `#${d.number}` : d.depends_on_ticket_id,
  );
  return new DispatchError(
    "DEPENDENCY_BLOCKED",
    `Ticket '${ticketLabel}' is blocked by ${refs.join(", ")} (must be done first).`,
    {
      ticket_id: ticketId,
      blocked_by: unsatisfied.map((d) => ({
        ticket_id: d.depends_on_ticket_id,
        number: d.number,
        status: d.status,
      })),
    },
  );
}

export interface RegisterAgentInput {
  display_name?: string;
  agent_type?: string;
  model?: string;
  runtime?: string;
  host?: string;
  max_risk?: string;
  capabilities?: string[];
  created_by?: string;
}

export interface ClaimNextInput {
  agentId: string;
  ttlSeconds: number;
  capabilities?: string[] | undefined;
}

/** Claim a chosen ticket (by id) rather than the next ready one. */
export interface ClaimTicketInput {
  ticketId: string;
  agentId: string;
  ttlSeconds: number;
  capabilities?: string[] | undefined;
}

export interface ClaimResult {
  ticketId: string;
  number: number;
  claimToken: string;
  /**
   * WG-049: the reviewer's latest rejection feedback when the claimed ticket was
   * bounced back for rework, so the re-claiming agent sees WHY without a second
   * call. `null` for a clean ticket (never rejected, or already re-reviewed).
   */
  lastReviewFeedback: ReviewFeedback | null;
}

export interface RecordEvidenceInput {
  claimToken?: string | undefined;
  ticket_id: string;
  ac_id?: string | undefined;
  repo_id?: string | undefined;
  evidence_type: EvidenceType;
  summary: string;
  uri?: string | undefined;
  payload?: unknown;
}

export interface SubmitForReviewInput {
  claimToken: string;
  ticket_id: string;
  reason?: string | undefined;
}

export interface MarkBlockedInput {
  claimToken?: string | undefined;
  ticket_id: string;
  reason: string;
}

/**
 * Claim + evidence lifecycle. Owns the atomic queue-claim, heartbeat, evidence,
 * review submission, blocking, release and stale-claim recovery. All ticket
 * status changes are delegated to the TransitionService — this service never
 * writes `tickets.status` directly.
 */
export class ClaimService {
  private readonly agents: AgentRepository;
  private readonly claims: ClaimRepository;
  private readonly tickets: TicketRepository;
  private readonly acs: AcRepository;
  private readonly evidence: EvidenceRepository;
  private readonly decisions: DecisionRepository;
  private readonly dependencies: TicketDependencyRepository;
  private readonly reworkAttempts: ReworkAttemptRepository;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly transitions: TransitionService,
  ) {
    this.agents = new AgentRepository(db);
    this.claims = new ClaimRepository(db);
    this.tickets = new TicketRepository(db);
    this.acs = new AcRepository(db);
    this.evidence = new EvidenceRepository(db);
    this.decisions = new DecisionRepository(db);
    this.dependencies = new TicketDependencyRepository(db);
    this.reworkAttempts = new ReworkAttemptRepository(db);
  }

  // --- Agents --------------------------------------------------------------

  registerAgent(raw: RegisterAgentInput, actor: Actor): Agent {
    const input = registerAgentInput.parse(raw);
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      const agent: Agent = {
        id: newId(),
        display_name: input.display_name ?? null,
        agent_type: input.agent_type,
        model: input.model ?? null,
        runtime: input.runtime ?? null,
        host: input.host ?? null,
        max_risk: input.max_risk,
        status: "active",
        created_by: input.created_by ?? actor.id ?? null,
        last_seen_at: null,
        created_at: now,
        updated_at: now,
      };
      this.agents.insert(agent);
      for (const capability of input.capabilities) {
        this.agents.addCapability(agent.id, capability);
      }
      writeEvent(this.db, {
        entity_type: "agent",
        entity_id: agent.id,
        actor,
        event_type: "agent.registered",
        payload: { agent_type: agent.agent_type, capabilities: input.capabilities },
      });
      return agent;
    });
  }

  // --- Claiming ------------------------------------------------------------

  /**
   * Atomically claim the highest-priority `ready` ticket with no active claim and
   * no unresolved blocking decision. The whole operation runs in one transaction;
   * if a concurrent writer wins the partial unique index we catch the constraint
   * error and move to the next candidate. Returns null when nothing is claimable.
   */
  claimNextTicket(input: ClaimNextInput, actor: Actor): ClaimResult | null {
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      const agent = this.agents.findById(input.agentId);
      if (!agent) throw notFound("agent", input.agentId);

      // Only an ACTIVE agent may claim (P0-1). A paused/disabled agent gets
      // nothing — never the next ticket — rather than silently grabbing work.
      if (agent.status !== "active") {
        throw new DispatchError("AGENT_NOT_ELIGIBLE", `Agent is '${agent.status}', not active.`, {
          agent_id: agent.id,
          status: agent.status,
        });
      }
      this.agents.touchLastSeen(agent.id, now);

      // Candidate selection enforces eligibility (P0-1): the query only returns
      // tickets at or below the agent's risk ceiling whose required capabilities
      // the agent holds. Ineligible tickets are simply skipped, so the agent gets
      // the next ELIGIBLE ready ticket (or none).
      const capabilities = this.agents.capabilities(agent.id);
      const candidates = this.claims.candidateTickets(now, {
        maxRiskRank: riskRank(agent.max_risk),
        capabilities,
      });
      for (const candidate of candidates) {
        const result = this.attemptClaim(candidate, agent, input.ttlSeconds, actor, now);
        if (result === "skip") continue;
        return result;
      }
      return null;
    });
  }

  /**
   * Claim a SPECIFIC chosen ticket (by id) for an agent. Applies the same
   * eligibility rules as claimNextTicket (active agent, risk ceiling, required
   * capabilities, no blocking decision, ready-or-reclaimable-expired) plus the
   * atomic claim — but never silently claims a different ticket. Throws a
   * structured error when the chosen ticket is not claimable for this agent.
   */
  claimTicket(input: ClaimTicketInput, actor: Actor): ClaimResult {
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      const ticket = this.tickets.findById(input.ticketId);
      if (!ticket) throw notFound("ticket", input.ticketId);

      const agent = this.agents.findById(input.agentId);
      if (!agent) throw notFound("agent", input.agentId);
      if (agent.status !== "active") {
        throw new DispatchError("AGENT_NOT_ELIGIBLE", `Agent is '${agent.status}', not active.`, {
          agent_id: agent.id,
          status: agent.status,
        });
      }
      this.agents.touchLastSeen(agent.id, now);

      const capabilities = this.agents.capabilities(agent.id);
      const candidate = this.claims.candidateForTicket(ticket.id, now, {
        maxRiskRank: riskRank(agent.max_risk),
        capabilities,
      });
      if (!candidate) {
        // EP-001: when the ONLY reason the chosen ticket failed eligibility is an
        // unsatisfied dependency, surface the clearer DEPENDENCY_BLOCKED code with
        // a "blocked by #N" reason rather than the generic not-claimable error so
        // the runner/UI can show exactly what's gating it.
        const unsatisfied = this.dependencies.unsatisfiedDependencies(ticket.id);
        if (unsatisfied.length > 0) {
          throw dependencyBlockedError(ticket.number ?? ticket.id, ticket.id, unsatisfied);
        }
        throw new DispatchError(
          "TICKET_NOT_CLAIMABLE",
          `Ticket '${ticket.number ?? ticket.id}' is not claimable by this agent.`,
          { ticket_id: ticket.id, status: ticket.status, agent_id: agent.id },
        );
      }

      const result = this.attemptClaim(candidate, agent, input.ttlSeconds, actor, now);
      if (result === "skip") {
        // A concurrent claim won the race or policy declined the chosen ticket —
        // surface that as a structured failure rather than claiming something else.
        throw new DispatchError(
          "TICKET_NOT_CLAIMABLE",
          `Ticket '${ticket.number ?? ticket.id}' could not be claimed (raced or policy-denied).`,
          { ticket_id: ticket.id, agent_id: agent.id },
        );
      }
      return result;
    });
  }

  /**
   * Attempt to claim one already-eligible candidate inside the caller's
   * transaction: reap any expired claim (P0-2), insert the atomic claim, gate +
   * flip ready->claimed, and emit `claim.created`. Returns the ClaimResult on
   * success, or the sentinel "skip" when a concurrent claim won the partial
   * unique index or policy declined the transition.
   */
  private attemptClaim(
    candidate: { id: string; expired_claim_id: string | null },
    agent: Agent,
    ttlSeconds: number,
    actor: Actor,
    now: string,
  ): ClaimResult | "skip" {
    if (candidate.expired_claim_id) {
      this.claims.setStatus(candidate.expired_claim_id, "expired", now);
      const stuck = this.tickets.findById(candidate.id);
      if (stuck && (stuck.status === "claimed" || stuck.status === "in_progress")) {
        this.transitions.transition({
          ticketId: candidate.id,
          actor,
          toStatus: "ready",
          reason: "claim_expired_reclaim",
          systemOverride: true,
        });
      }
      writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: candidate.id,
        actor,
        event_type: "claim.expired",
        payload: { claim_id: candidate.expired_claim_id, returned_to: "reclaimed" },
      });
    }

    const claimToken = newClaimToken();
    const claim: TicketClaim = {
      id: newId(),
      ticket_id: candidate.id,
      agent_id: agent.id,
      claim_token_hash: hashClaimToken(claimToken),
      status: "active",
      expires_at: isoPlusSeconds(ttlSeconds, now),
      heartbeat_at: now,
      created_at: now,
      released_at: null,
    };
    try {
      this.claims.insert(claim);
    } catch (err) {
      if (isUniqueConstraint(err)) return "skip";
      throw err;
    }

    try {
      this.transitions.transition({
        ticketId: candidate.id,
        actor,
        toStatus: "claimed",
        reason: "claim_next",
        expectedFromStatus: "ready",
      });
    } catch (err) {
      this.claims.setStatus(claim.id, "released", now);
      if (
        err instanceof DispatchError &&
        (err.code === "POLICY_DENIED" || err.code === "STATE_CONFLICT")
      ) {
        return "skip";
      }
      throw err;
    }

    const ticket = this.tickets.findById(candidate.id)!;
    writeEvent(this.db, {
      entity_type: "ticket",
      entity_id: ticket.id,
      actor,
      event_type: "claim.created",
      payload: { claim_id: claim.id, agent_id: agent.id, expires_at: claim.expires_at },
    });
    return {
      ticketId: ticket.id,
      number: ticket.number ?? 0,
      claimToken,
      lastReviewFeedback: parseReviewFeedback(ticket.last_review_feedback),
    };
  }

  heartbeat(claimToken: string): { expiresAt: string } {
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      const claim = this.activeClaimForToken(claimToken, now);
      const expiresAt = isoPlusSeconds(this.ttlForClaim(claim, now), now);
      const ok = this.claims.extend(claim.id, expiresAt, now);
      if (!ok) {
        throw new DispatchError("CLAIM_INVALID", "Claim is no longer active.");
      }
      return { expiresAt };
    });
  }

  recordEvidence(raw: RecordEvidenceInput, actor: Actor): { evidenceId: string; eventId: string } {
    const input = recordEvidenceInput.parse(raw);
    const claimToken = raw.claimToken;
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      const ticket = this.tickets.findById(input.ticket_id);
      if (!ticket) throw notFound("ticket", input.ticket_id);

      // A human actor may record manual evidence with no claim token; everyone
      // else must present a token matching an active claim on this ticket.
      if (claimToken) {
        const claim = this.activeClaimForToken(claimToken, now);
        if (claim.ticket_id !== ticket.id) {
          throw new DispatchError(
            "CLAIM_INVALID",
            "Claim token does not match an active claim on this ticket.",
          );
        }
      } else if (actor.type !== "human") {
        throw new DispatchError("CLAIM_INVALID", "A claim token is required to record evidence.");
      }

      if (input.ac_id) {
        const ac = this.acs.findById(input.ac_id);
        if (!ac || ac.ticket_id !== ticket.id) {
          throw notFound("acceptance_criterion", input.ac_id);
        }
      }

      const evidenceId = newId();
      this.evidence.insert({
        id: evidenceId,
        ticket_id: ticket.id,
        ac_id: input.ac_id ?? null,
        repo_id: input.repo_id ?? null,
        decision_id: null,
        evidence_type: input.evidence_type,
        summary: input.summary,
        uri: input.uri ?? null,
        payload_json: input.payload === undefined ? null : JSON.stringify(input.payload),
        created_by: actor.id ?? actor.type,
        created_at: now,
      });

      if (input.ac_id) {
        this.acs.setStatus(input.ac_id, "satisfied", actor.id ?? actor.type, now);
      }

      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "evidence.recorded",
        payload: {
          evidence_id: evidenceId,
          ac_id: input.ac_id ?? null,
          evidence_type: input.evidence_type,
        },
      });
      return { evidenceId, eventId };
    });
  }

  submitForReview(input: SubmitForReviewInput, actor: Actor): { status: string; eventId: string } {
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      const claim = this.activeClaimForToken(input.claimToken, now);
      const ticket = this.tickets.findById(input.ticket_id);
      if (!ticket) throw notFound("ticket", input.ticket_id);
      if (claim.ticket_id !== ticket.id) {
        throw new DispatchError(
          "CLAIM_INVALID",
          "Claim token does not match an active claim on this ticket.",
        );
      }

      // Step through the allowed table: claimed -> in_progress -> in_review.
      if (ticket.status === "claimed") {
        this.transitions.transition({
          ticketId: ticket.id,
          actor,
          toStatus: "in_progress",
          reason: "submit_for_review",
          expectedFromStatus: "claimed",
        });
      }
      const result = this.transitions.transition({
        ticketId: ticket.id,
        actor,
        toStatus: "in_review",
        reason: input.reason ?? "submit_for_review",
        expectedFromStatus: "in_progress",
      });

      this.claims.setStatus(claim.id, "completed", now);
      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "claim.completed",
        payload: { claim_id: claim.id },
      });
      return { status: result.ticket.status, eventId };
    });
  }

  markBlocked(input: MarkBlockedInput, actor: Actor): { eventId: string } {
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      const ticket = this.tickets.findById(input.ticket_id);
      if (!ticket) throw notFound("ticket", input.ticket_id);

      // P0-3: an agent may only mutate a ticket it holds a valid, matching claim
      // for. A missing or mismatched token from an agent is rejected — agents can
      // never block tokenlessly. Human/admin/system actors may block without a
      // token (operator override); the actor is recorded on the event trail.
      if (input.claimToken) {
        const claim = this.activeClaimForToken(input.claimToken, now);
        if (claim.ticket_id !== ticket.id) {
          throw new DispatchError(
            "CLAIM_INVALID",
            "Claim token does not match an active claim on this ticket.",
          );
        }
      } else if (actor.type === "agent") {
        throw new DispatchError(
          "CLAIM_REQUIRED",
          "An agent must present a valid claim token to block a ticket.",
          { actor_type: actor.type, ticket_id: ticket.id },
        );
      }
      this.transitions.transition({
        ticketId: ticket.id,
        actor,
        toStatus: "blocked",
        reason: input.reason,
      });
      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.blocked",
        payload: { reason: input.reason },
      });
      return { eventId };
    });
  }

  releaseClaim(claimToken: string, actor: Actor): void {
    const now = this.clock.now();
    inTransaction(this.db, () => {
      const claim = this.activeClaimForToken(claimToken, now);
      this.claims.setStatus(claim.id, "released", now);
      const ticket = this.tickets.findById(claim.ticket_id);
      if (ticket && (ticket.status === "claimed" || ticket.status === "in_progress")) {
        this.transitions.transition({
          ticketId: ticket.id,
          actor,
          toStatus: "ready",
          reason: "release_claim",
          systemOverride: true,
        });
      }
      writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: claim.ticket_id,
        actor,
        event_type: "claim.released",
        payload: { claim_id: claim.id },
      });
    });
  }

  /**
   * RUNNER-OWNED-BOOKKEEPING: the factory runner holds the delivery claim and is
   * the authority that releases/parks it when a delivery fails or exhausts its
   * retries. On FAILURE the ticket returns to `ready` (blind-requeue safe); on
   * PARK it routes to `refining` (legacy triage) or, when the rework loop exhausts
   * its attempt/cost budget, to the VISIBLE `blocked` column with a structured
   * `rework_exhausted` reason so a human never wonders where the ticket went. A
   * resumed delivery is `in_progress` and carries no runner-held token, so
   * `claimToken` is OPTIONAL — when present the matching active claim is released so
   * the ticket carries no dangling claim; when absent (resume) the ticket is simply
   * transitioned. The guarded `runnerRelease` transitions make the otherwise
   * board-unreachable `claimed->{refining,blocked}` / `in_progress->{ready,refining,
   * blocked}` routes legal for exactly this path.
   *
   * When parking (`refining`/`blocked`) the latest failure feedback is written to
   * `last_review_feedback` (with the optional `reasonCode`/`attempt`/`maxAttempts`)
   * so the board card surfaces WHY the ticket bounced and, for `blocked`, a
   * `ticket.blocked` event is appended for the activity trail + the human-unblock gate.
   */
  runnerRelease(
    input: {
      ticket_id: string;
      to: "ready" | "refining" | "blocked";
      claimToken?: string;
      reason?: string;
      reasonCode?: string;
      attempt?: number;
      maxAttempts?: number;
    },
    actor: Actor,
  ): { status: string; eventId: string } {
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      const ticket = this.tickets.findById(input.ticket_id);
      if (!ticket) throw notFound("ticket", input.ticket_id);
      if (input.claimToken) {
        const claim = this.activeClaimForToken(input.claimToken, now);
        if (claim.ticket_id !== ticket.id) {
          throw new DispatchError(
            "CLAIM_INVALID",
            "Claim token does not match an active claim on this ticket.",
          );
        }
        this.claims.setStatus(claim.id, "released", now);
        writeEvent(this.db, {
          entity_type: "ticket",
          entity_id: ticket.id,
          actor,
          event_type: "claim.released",
          payload: { claim_id: claim.id },
        });
      }
      const reason = input.reason ?? `runner_release_${input.to}`;
      const result = this.transitions.transition({
        ticketId: ticket.id,
        actor,
        toStatus: input.to,
        reason,
        systemOverride: true,
        runnerRelease: true,
      });
      // Parking (not a blind requeue to `ready`) preserves salvageable work and
      // needs a human eye — surface the failure on the card via last_review_feedback.
      if (input.to === "refining" || input.to === "blocked") {
        const feedback: ReviewFeedback = { reason, reviewer: actor.id ?? null, at: now };
        if (input.reasonCode) feedback.code = input.reasonCode;
        if (typeof input.attempt === "number") feedback.attempt = input.attempt;
        if (typeof input.maxAttempts === "number") feedback.maxAttempts = input.maxAttempts;
        this.tickets.setReviewFeedback(ticket.id, JSON.stringify(feedback));
      }
      if (input.to === "blocked") {
        writeEvent(this.db, {
          entity_type: "ticket",
          entity_id: ticket.id,
          actor,
          event_type: "ticket.blocked",
          payload: { reason, reason_code: input.reasonCode ?? null },
        });
      }
      return { status: result.ticket.status, eventId: result.eventId };
    });
  }

  /**
   * RUNNER-OWNED-BOOKKEEPING + FAILURE-DIAGNOSIS: record a live rework attempt
   * WITHOUT changing status. While the runner re-invokes the agent between failed
   * delivery attempts the ticket stays visibly `in_progress` (it IS being worked,
   * not gone). This does two things:
   *  - overwrites `last_review_feedback` with the latest failure + attempt counter
   *    so the board card renders "reworking · attempt N/M" (the LATEST, as before);
   *  - APPENDS a row to the `rework_attempts` failure trail so the FULL ordered
   *    history survives, not just the latest — the surface an operator returns to
   *    when triaging. The trail row keeps the full DISTILLED failure (`distilledFailure`,
   *    the real failing test + assertion/stack) rather than the truncated board
   *    summary in `reason`; when the runner omits it, `reason` is used as a fallback.
   *
   * It NEVER transitions the ticket and is a no-op-safe read on any status.
   * Best-effort from the runner's perspective; a failure here never aborts a
   * delivery (the runner wraps the call fail-soft).
   */
  recordReworkAttempt(
    input: {
      ticket_id: string;
      attempt: number;
      maxAttempts: number;
      reason: string;
      /** The gate that failed (e.g. `tests`, `definition-of-done`). Persisted on the trail. */
      gate?: string;
      /** The full distilled failing test + assertion/stack. Falls back to `reason`. */
      distilledFailure?: string;
      /** The AC being worked toward when known. */
      acId?: string;
    },
    actor: Actor,
  ): { eventId: string } {
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      const ticket = this.tickets.findById(input.ticket_id);
      if (!ticket) throw notFound("ticket", input.ticket_id);
      const feedback: ReviewFeedback = {
        reason: input.reason,
        reviewer: actor.id ?? null,
        at: now,
        code: "reworking",
        attempt: input.attempt,
        maxAttempts: input.maxAttempts,
      };
      this.tickets.setReviewFeedback(ticket.id, JSON.stringify(feedback));
      // APPEND the full distilled failure to the durable trail (never overwrites a
      // prior attempt). Keep the full block — the operator needs the real assertion,
      // not the one-line board summary.
      this.reworkAttempts.insert({
        id: newId(),
        ticket_id: ticket.id,
        attempt: input.attempt,
        max_attempts: input.maxAttempts,
        gate: input.gate ?? null,
        distilled_failure: input.distilledFailure ?? input.reason,
        ac_id: input.acId ?? null,
        created_at: now,
      });
      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.reworking",
        payload: {
          attempt: input.attempt,
          max_attempts: input.maxAttempts,
          reason: input.reason,
          gate: input.gate ?? null,
        },
      });
      return { eventId };
    });
  }

  /**
   * System recovery: expire every active claim past its TTL and return its ticket
   * to `ready` — or to `blocked` if the ticket has an unresolved blocking decision.
   * Transitions use systemOverride so policy gates never stall recovery.
   */
  expireStaleClaims(actor: Actor): { expired: number } {
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      const stale = this.claims.listExpired(now);
      let expired = 0;
      for (const claim of stale) {
        this.claims.setStatus(claim.id, "expired", now);
        const ticket = this.tickets.findById(claim.ticket_id);
        if (!ticket || (ticket.status !== "claimed" && ticket.status !== "in_progress")) {
          expired += 1;
          continue;
        }
        const blocked = this.decisions.blockingForTicket(ticket.id).length > 0;
        this.transitions.transition({
          ticketId: ticket.id,
          actor,
          toStatus: blocked ? "blocked" : "ready",
          reason: "claim_expired",
          systemOverride: true,
        });
        writeEvent(this.db, {
          entity_type: "ticket",
          entity_id: ticket.id,
          actor,
          event_type: "claim.expired",
          payload: { claim_id: claim.id, returned_to: blocked ? "blocked" : "ready" },
        });
        expired += 1;
      }
      return { expired };
    });
  }

  /**
   * Resolve and validate that `claimToken` names an active claim on `ticketId`.
   * Throws CLAIM_INVALID for an unknown/expired token or one held against a
   * different ticket. Exposed for claim-scoped facade methods (e.g. recording a
   * delivery artifact) that must reuse the same resolver agents already use.
   */
  assertClaimOnTicket(claimToken: string, ticketId: string): TicketClaim {
    const now = this.clock.now();
    const claim = this.activeClaimForToken(claimToken, now);
    if (claim.ticket_id !== ticketId) {
      throw new DispatchError(
        "CLAIM_INVALID",
        "Claim token does not match an active claim on this ticket.",
      );
    }
    return claim;
  }

  // --- Helpers -------------------------------------------------------------

  /** Resolve an active, unexpired claim for a token or throw CLAIM_INVALID. */
  private activeClaimForToken(claimToken: string, nowIso: string): TicketClaim {
    const claim = this.claims.findActiveByTokenHash(hashClaimToken(claimToken), nowIso);
    if (!claim) {
      throw new DispatchError("CLAIM_INVALID", "Unknown or expired claim token.");
    }
    return claim;
  }

  /** Preserve the original lease length when extending on heartbeat. */
  private ttlForClaim(claim: TicketClaim, nowIso: string): number {
    const originalTtlMs =
      new Date(claim.expires_at).getTime() - new Date(claim.created_at).getTime();
    const seconds = Math.max(1, Math.round(originalTtlMs / 1000));
    void nowIso;
    return seconds;
  }
}
