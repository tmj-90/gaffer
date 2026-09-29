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
import {
  type AcStatus,
  type Actor,
  type ReviewFeedback,
  type Ticket,
  type TicketStatus,
} from "../domain/types.js";
import { type ObservedRisk, shouldEscalate } from "./observedRisk.js";
import { envFlagOn } from "./autonomyPolicyService.js";
import { writeEvent } from "../events/eventWriter.js";
import { AcRepository } from "../repositories/acRepository.js";
import { EvidenceRepository } from "../repositories/evidenceRepository.js";
import { TicketRepository } from "../repositories/ticketRepository.js";
import type { AgentRepository } from "../repositories/agentRepository.js";
import type { TransitionResult, TransitionService } from "./transitionService.js";
import type { TicketService } from "./ticketService.js";
import type { Clock } from "../util/clock.js";
import { recordAcCheckInput } from "../domain/schemas.js";
import { AC_CHECK_VERIFIER } from "../policy/policy.js";
import { DispatchError, notFound } from "../util/errors.js";
import { newId } from "../util/id.js";
import { isTestingEnabled, testerProvenance } from "../util/testingLane.js";
import {
  contractHash,
  REPLAY_STATES,
  type ReplayState,
  type VerdictBinding,
} from "../util/contractHash.js";

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
// GRADUATED-AUTONOMY (Spec 2, Phase 1): "approved unchanged vs edited" signal
// ---------------------------------------------------------------------------

/** The delivery SHA (what the agent shipped) vs the merge SHA (current branch head). */
export interface ApprovalShas {
  /** The recorded delivery commit SHA — what the reviewer was shown. */
  deliverySha: string | null;
  /** The SHA that would actually merge (current head of the delivery branch). */
  mergeSha: string | null;
}

/** Resolves the delivery-vs-merge SHAs for a ticket at approve time (git + DB read). */
export type ApprovalShaResolver = (ticket: Ticket) => ApprovalShas | null;

/**
 * Decide whether an approval was UNCHANGED (`true`), edited (`false`), or
 * indeterminate (`null`). When either SHA is missing we return `null` — the signal
 * is unknown, and the recommendation must NOT count an unknown as agreement (doing
 * so would overstate how often the operator approves an agent's work verbatim).
 */
export function approvalUnchanged(
  deliverySha: string | null | undefined,
  mergeSha: string | null | undefined,
): boolean | null {
  if (!deliverySha || !mergeSha) return null;
  return deliverySha === mergeSha;
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
  /** The agents table — lets the approve path verify an agent approver is REGISTERED. */
  readonly agents?: AgentRepository | undefined;
  /**
   * When true, an `agent` actor may approve only if `agents.findById(actor.id)` exists:
   * the reviewer-not-author rule then compares two registered principals rather than a
   * free string. Production entry points turn this on; fixtures leave it off.
   */
  readonly requireRegisteredAgentApprover?: boolean | undefined;
  /**
   * Called after rejectReview parks a ticket (retry cap reached).
   * Best-effort — errors are swallowed so notifications never break callers.
   */
  readonly onTicketParked?: (ticket: import("../domain/types.js").Ticket, detail: string) => void;
  /**
   * GRADUATED-AUTONOMY (Spec 2, Phase 1): resolves the delivery-vs-merge SHAs so
   * `approveReview` can emit `approved_unchanged`. Injectable (the real one reads the
   * per-repo delivery SHA + `git rev-parse` of the branch); `undefined` (the default)
   * means the signal is emitted as `null` (unknown). Best-effort — a throw here never
   * blocks an approval.
   */
  readonly approvalShaResolver?: ApprovalShaResolver;
  /**
   * GRADUATED-AUTONOMY (Spec 2, Phase 3): the pure-policy predicate that answers
   * "does an explicit mode='auto' approve policy cover this ticket (its risk × ALL
   * its write repos)?" NO env read here — the P0 check below ORs it with the env
   * flag, so the policy is only ever an ADDITIONAL allow-path. `undefined` (the
   * default) means "no policy layer wired" ⇒ the gate is exactly the pre-Phase-3
   * pure env-flag check. See services/autonomyPolicyService.ts.
   */
  readonly policyAllowsAgentApprove?: (ticket: Ticket) => boolean;
  /**
   * OBSERVED-RISK ESCALATION (Trust & Autonomy, security-critical): resolves the OBSERVED
   * risk of a ticket from its REAL server-computed diff (the advisory risk-annotation
   * overlay + diff size). Used ONLY on the AUTO-SHIP path (an agent approving because an
   * autonomy flag/policy is on) to hold-for-human when observed risk exceeds the DECLARED
   * `risk_level`. `undefined` (the default) means the escalation is INERT — behaviour is
   * byte-identical to today. A resolver throw degrades to "indeterminate" (fail toward
   * human). It can only ever DENY an auto-ship; it never grants one. See observedRisk.ts.
   */
  readonly observedRiskResolver?: (ticket: Ticket) => ObservedRisk | null;
}

/**
 * ACCEPTANCE GATE: validate the structured binding a tester verdict carries — the exact
 * commit the tester ran against, the hash of the contract it tested (see
 * util/contractHash) and the runner's clean-replay outcome. A binding that is PRESENT but
 * malformed is refused (never silently dropped: a verdict must not look bound when it is
 * not). For an epic's ACCEPTANCE ticket, a non-human PASS must carry all three, the hash
 * must be the contract on record, and the replay must have passed — anything less could be
 * reported as a verified build. A human verdict is a waiver: allowed without a binding and
 * reported as `waived`, never as verified.
 */
function validatedBinding(
  input: { tested_commit?: string; contract_hash?: string; replay?: string },
  opts: { strict: boolean; currentHash: string | null; verdict: "pass" | "fail" },
): VerdictBinding {
  const out: VerdictBinding = {};
  if (input.tested_commit !== undefined) {
    const sha = input.tested_commit.trim();
    if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(sha)) {
      throw new DispatchError(
        "VALIDATION_ERROR",
        "tested_commit must be a full git commit id (40 or 64 hex characters).",
      );
    }
    out.tested_commit = sha.toLowerCase();
  }
  if (input.contract_hash !== undefined) {
    const h = input.contract_hash.trim();
    if (!/^[0-9a-f]{64}$/i.test(h)) {
      throw new DispatchError("VALIDATION_ERROR", "contract_hash must be a sha256 hex digest.");
    }
    out.contract_hash = h.toLowerCase();
  }
  if (input.replay !== undefined) {
    if (!(REPLAY_STATES as readonly string[]).includes(input.replay)) {
      throw new DispatchError(
        "VALIDATION_ERROR",
        `replay must be one of ${REPLAY_STATES.join(", ")}.`,
      );
    }
    out.replay = input.replay as ReplayState;
  }
  if (out.contract_hash && opts.currentHash && out.contract_hash !== opts.currentHash) {
    throw new DispatchError(
      "CONTRACT_MISMATCH",
      "The verdict was recorded against a different contract than the one on record (the ticket's title, description, criteria or test contract changed since the tester started). Re-test.",
      { recorded: out.contract_hash, current: opts.currentHash },
    );
  }
  if (opts.strict && opts.verdict === "pass") {
    const missing = [
      ...(out.tested_commit ? [] : ["tested_commit"]),
      ...(out.contract_hash ? [] : ["contract_hash"]),
      ...(out.replay === "passed" ? [] : ["replay=passed"]),
    ];
    if (missing.length > 0) {
      throw new DispatchError(
        "BINDING_REQUIRED",
        `An automated PASS on an acceptance ticket must be bound to what was tested; missing: ${missing.join(", ")}. A human can waive instead (tester-pass --as human), which is reported as waived, not verified.`,
        { missing },
      );
    }
  }
  return out;
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
  private readonly agents: AgentRepository | undefined;
  private readonly requireRegisteredAgentApprover: boolean;
  private readonly onTicketParked:
    ((ticket: import("../domain/types.js").Ticket, detail: string) => void) | undefined;
  private readonly approvalShaResolver: ApprovalShaResolver | undefined;
  private readonly policyAllowsAgentApprove: ((ticket: Ticket) => boolean) | undefined;
  private readonly observedRiskResolver: ((ticket: Ticket) => ObservedRisk | null) | undefined;

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
    this.agents = deps.agents;
    this.requireRegisteredAgentApprover = deps.requireRegisteredAgentApprover ?? false;
    this.onTicketParked = deps.onTicketParked;
    this.approvalShaResolver = deps.approvalShaResolver;
    this.policyAllowsAgentApprove = deps.policyAllowsAgentApprove;
    this.observedRiskResolver = deps.observedRiskResolver;
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
    // P0 authz — do NOT weaken or remove this check. An agent may approve ONLY when
    // the operator opted in via DISPATCH_ALLOW_AGENT_APPROVE=1 (the pre-Phase-3 flag,
    // FIRST and unchanged) OR — Graduated Autonomy (Spec 2, Phase 3) — an EXPLICIT
    // mode='auto' approve policy covers this ticket's risk × every write repo. The
    // policy is only ever an ADDITIONAL allow-path: with no policy row this reduces to
    // exactly the pure env-flag gate (byte-identical to today). system is never permitted.
    const agentApproveAllowed =
      actor.type === "agent" &&
      (envFlagOn(process.env.DISPATCH_ALLOW_AGENT_APPROVE) ||
        this.policyGrantsAgentApprove(ticketRef));
    if (actor.type !== "human" && actor.type !== "admin" && !agentApproveAllowed) {
      throw new DispatchError(
        "ACTOR_NOT_PERMITTED",
        "Only a human or admin may approve a review (set DISPATCH_ALLOW_AGENT_APPROVE=1 to allow autonomous agent approval).",
        { actor_type: actor.type },
      );
    }
    // OBSERVED-RISK ESCALATION (Trust & Autonomy, security-critical): this runs ONLY on
    // the AUTO-SHIP path — an agent whose approve+merge was permitted WITHOUT a human
    // because an autonomy flag (DISPATCH_ALLOW_AGENT_APPROVE) or a mode='auto' approve
    // policy is on (`agentApproveAllowed === true`). Human/admin never reach here (their
    // approve is byte-identical to today), and an agent already denied by the P0 throw
    // above never reaches here either. When the ticket's OBSERVED risk (from the real
    // diff) exceeds its DECLARED `risk_level` (or a configured ceiling), we HOLD for a
    // human: throw before any transition runs, so the ticket stays `in_review` — the
    // identical mechanism as the P0 deny above. This can ONLY convert an auto-ship into a
    // human-hold; it never grants an approval and never weakens the manual gate.
    if (agentApproveAllowed) {
      this.enforceObservedRiskCeiling(ticketRef, actor);
    }
    const ticket = this.ticketSvc.resolveTicket(ticketRef);
    // REVIEWER ≠ AUTHOR (server-side, not by convention). Even on an autonomy-permitted
    // agent approve, the approving principal must not be the agent that DELIVERED the
    // ticket: the id on the ticket's most recent claim. Before this the "agent cannot
    // approve its own work" guarantee rested on the runner's bash hook denying the CLI;
    // any process that could open the DB (or a runner passing its own agent id as the
    // reviewer) could self-approve. The runner's reviewer pass now presents a distinct
    // reviewer principal (`<agent>/reviewer`), so the autonomous path is unaffected.
    if (actor.type === "agent") {
      // The approving agent must be a REGISTERED principal (production entry points): a
      // bare string like "<agent>/reviewer" trivially differs from the author id and
      // would otherwise pass the not-author rule below on string inequality alone.
      if (
        this.requireRegisteredAgentApprover &&
        (actor.id === undefined || !this.agents || !this.agents.findById(actor.id))
      ) {
        throw new DispatchError(
          "ACTOR_NOT_PERMITTED",
          "An agent may approve only as a REGISTERED agent principal: the approving actor id is not a registered agent (register a distinct reviewer agent and approve as its id, or approve as a human).",
          { actor_type: actor.type, actor_id: actor.id ?? null },
        );
      }
      const author = this.deliveringAgentId(ticket.id);
      if (author !== null && actor.id !== undefined && actor.id === author) {
        throw new DispatchError(
          "ACTOR_NOT_PERMITTED",
          "An agent may not approve its own delivery: the approving actor id matches the agent that claimed and delivered this ticket. Approve as a distinct reviewer principal (or a human).",
          { actor_type: actor.type, actor_id: actor.id, delivering_agent_id: author },
        );
      }
    }
    // GRADUATED-AUTONOMY (Spec 2, Phase 1): capture whether this delivery is being
    // approved UNCHANGED vs edited, emitted on the transition below. Best-effort — a
    // resolver throw or absence yields `null` (unknown) and never blocks the approve.
    const approvedUnchanged = this.computeApprovedUnchanged(ticket);
    // BBT-001: when the testing lane is ON and this ticket is eligible, route
    // through the independent tester (`in_review -> in_testing`) instead of
    // straight to merge. testerVerdict:true guards this transition.
    // ACCEPTANCE GATE: an epic's acceptance ticket ALWAYS takes this route — the
    // GAFFER_TESTING toggle does not apply. Acceptance is a gate, not an option: the
    // only ways out of in_testing are a recorded tester verdict or a human's
    // tester-pass / tester-fail (auditable evidence), never a plain approve.
    if (ticket.acceptance === 1 || (this.testingEnabled() && ticket.can_be_tested === 1)) {
      const result = this.transitions.transition({
        ticketId: ticket.id,
        actor,
        toStatus: "in_testing",
        reason: "review_approved_to_testing",
        expectedFromStatus: "in_review",
        testerVerdict: true,
        approvedUnchanged,
      });
      writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.routed_to_testing",
        payload: { from: "in_review", ...(ticket.acceptance === 1 ? { acceptance: true } : {}) },
      });
      return result;
    }
    return this.transitions.transition({
      ticketId: ticket.id,
      actor,
      toStatus: "ready_for_merge",
      reason: "review_approved",
      expectedFromStatus: "in_review",
      approvedUnchanged,
      reviewApprove: true, // reached the merge-ready state through the guarded approve path
    });
  }

  /**
   * MACHINE-CHECKABLE AC — record the RUNNER's execution of an AC's `check_command`.
   *
   * Trusted-actor only: the runner (`system`) or a human/admin. An `agent` actor is
   * refused — this is the verification the done gate TRUSTS precisely because the
   * agent cannot author it (the agent's own `record_ac_evidence` still marks an AC
   * satisfied, but with `verified_by = <agent>`, which the gate does not accept for
   * a checked AC). Exit 0 ⇒ `satisfied`, else `failed`; either way a `test_output`
   * evidence row carries the command, exit code and bounded output tail so the
   * reviewer (and the next rework attempt) sees exactly what ran.
   */
  recordAcCheck(
    raw: unknown,
    actor: Actor,
  ): { status: AcStatus; evidenceId: string; eventId: string } {
    const input = recordAcCheckInput.parse(raw);
    if (actor.type === "agent") {
      throw new DispatchError(
        "ACTOR_NOT_PERMITTED",
        "An agent may not record an acceptance-criterion check result; the runner (system) executes and records checks.",
        { actor_type: actor.type },
      );
    }
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      const ticket = this.tickets.findById(input.ticket_id);
      if (!ticket) throw notFound("ticket", input.ticket_id);
      const ac = this.acs.findById(input.ac_id);
      if (!ac || ac.ticket_id !== ticket.id) throw notFound("acceptance_criterion", input.ac_id);
      if (!ac.check_command) {
        throw new DispatchError(
          "VALIDATION_ERROR",
          "This acceptance criterion has no check_command; a check result can only be recorded for a machine-checkable AC.",
          { ac_id: ac.id },
        );
      }
      const passed = input.exit_code === 0;
      const status: AcStatus = passed ? "satisfied" : "failed";
      this.acs.setStatus(ac.id, status, AC_CHECK_VERIFIER, now);
      const evidenceId = newId();
      this.evidence.insert({
        id: evidenceId,
        ticket_id: ticket.id,
        ac_id: ac.id,
        repo_id: null,
        decision_id: null,
        evidence_type: "test_output",
        summary: `AC check ${passed ? "PASSED" : "FAILED"} (exit ${input.exit_code}): ${input.command}`,
        uri: null,
        payload_json: JSON.stringify({
          kind: "ac_check",
          passed,
          exit_code: input.exit_code,
          command: input.command,
          ...(input.output_tail !== undefined ? { output_tail: input.output_tail } : {}),
          ...(input.duration_s !== undefined ? { duration_s: input.duration_s } : {}),
        }),
        created_by: actor.id ?? actor.type,
        recorded_by_actor_type: actor.type,
        created_at: now,
      });
      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ac.checked",
        payload: { ac_id: ac.id, passed, exit_code: input.exit_code, evidence_id: evidenceId },
      });
      return { status, evidenceId, eventId };
    });
  }

  /**
   * The agent id on the ticket's MOST RECENT claim (active or released) — the principal
   * that delivered the work now under review. `null` when the ticket was never claimed
   * (e.g. a human-driven delivery), in which case the reviewer≠author rule is inert.
   */
  private deliveringAgentId(ticketId: string): string | null {
    const row = this.db
      .prepare(
        "SELECT agent_id FROM ticket_claims WHERE ticket_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(ticketId) as { agent_id: string } | undefined;
    return row?.agent_id ?? null;
  }

  /**
   * GRADUATED-AUTONOMY (Spec 2, Phase 1): resolve the delivery-vs-merge SHAs and
   * decide whether the approval is UNCHANGED (`true`), edited (`false`) or unknown
   * (`null`). Wrapped so a resolver failure degrades to `null` — an approval must
   * never fail because the (advisory) telemetry probe threw.
   */
  private computeApprovedUnchanged(ticket: Ticket): boolean | null {
    if (!this.approvalShaResolver) return null;
    try {
      const shas = this.approvalShaResolver(ticket);
      if (!shas) return null;
      return approvalUnchanged(shas.deliverySha, shas.mergeSha);
    } catch {
      return null;
    }
  }

  /**
   * GRADUATED-AUTONOMY (Spec 2, Phase 3): does an explicit mode='auto' approve policy
   * cover this ticket (its risk × ALL its write repos)? Pure policy check — NO env
   * read (the P0 gate ORs this with the env flag). FAIL-CLOSED: an absent predicate,
   * an unresolvable ticket, or ANY throw yields false, so a policy-probe failure can
   * never grant an approval it shouldn't.
   */
  private policyGrantsAgentApprove(ticketRef: string): boolean {
    if (!this.policyAllowsAgentApprove) return false;
    try {
      const ticket = this.ticketSvc.resolveTicket(ticketRef);
      return this.policyAllowsAgentApprove(ticket);
    } catch {
      return false;
    }
  }

  /**
   * OBSERVED-RISK ESCALATION (Trust & Autonomy, security-critical). Called ONLY on the
   * AUTO-SHIP path (see approveReview). Compares the OBSERVED risk derived from the real
   * server-computed diff against the ticket's DECLARED `risk_level`. When observed exceeds
   * declared (or crosses a configured ceiling), or the diff cannot be observed
   * (indeterminate ⇒ fail toward human), it records an `autoship_escalated` event and
   * throws `OBSERVED_RISK_ESCALATED` — held BEFORE any transition, so the ticket stays
   * `in_review` for a human, exactly like the P0 deny above.
   *
   * FAIL-SAFE by construction:
   *  - No resolver wired ⇒ returns immediately (inert; autonomy-off parity unaffected).
   *  - Resolver throws ⇒ treated as indeterminate ⇒ HOLD (never silently auto-ships).
   *  - Observed ≤ declared and no ceiling ⇒ returns; the ticket auto-ships exactly as
   *    before (no false-escalation of a genuinely-low-risk change).
   * It can only ever THROW (deny) — it never calls `transition`, so it can never turn a
   * hold into a ship, never newly-allow, and never weakens the manual human gate.
   */
  private enforceObservedRiskCeiling(ticketRef: string, actor: Actor): void {
    if (!this.observedRiskResolver) return;
    const ticket = this.ticketSvc.resolveTicket(ticketRef);
    let observed: ObservedRisk | null;
    try {
      observed = this.observedRiskResolver(ticket);
    } catch {
      observed = null; // a probe failure must fail toward a human, never silently ship.
    }
    // A missing observation is indeterminate ⇒ escalate (hold for a human).
    const escalate = !observed || shouldEscalate(observed, ticket.risk_level);
    if (!escalate) return;
    const observedLevel = observed?.level ?? "unknown";
    const reasons = observed?.reasons.length ? observed.reasons : ["diff unavailable to observe"];
    // Record the reason on the EXISTING append-only event log (no new mutation surface).
    writeEvent(this.db, {
      entity_type: "ticket",
      entity_id: ticket.id,
      actor,
      event_type: "ticket.autoship_escalated",
      payload: {
        declared: ticket.risk_level,
        observed: observedLevel,
        determinate: observed?.determinate ?? false,
        reasons,
        files: observed?.files ?? null,
        lines: observed?.lines ?? null,
      },
    });
    throw new DispatchError(
      "OBSERVED_RISK_ESCALATED",
      `Auto-approve held for human review: observed risk '${observedLevel}' exceeds declared '${ticket.risk_level}'.`,
      { declared: ticket.risk_level, observed: observedLevel, reasons },
    );
  }

  /**
   * The independent black-box tester PASSED (`in_testing -> ready_for_merge`).
   * testerVerdict:true guards this transition.
   */
  testerPass(
    ticketRef: string,
    input: {
      summary: string;
      uri?: string;
      tested_commit?: string;
      contract_hash?: string;
      replay?: string;
    },
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
      const binding = validatedBinding(input, {
        strict: ticket.acceptance === 1 && testerProvenance(actor) !== "human",
        currentHash: contractHash(this.db, ticket.id),
        verdict: "pass",
      });
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
        // ACCEPTANCE GATE: a verdict is evidence about ONE commit and ONE contract. The
        // runner's tester records both; the merge lane refuses to land a branch whose head
        // is not the tested commit, and stats flag an acceptance whose contract changed.
        payload_json: JSON.stringify({
          verdict: "pass",
          provenance: testerProvenance(actor),
          ...binding,
        }),
        created_by: actor.id ?? actor.type,
        recorded_by_actor_type: actor.type,
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
    input: {
      summary: string;
      uri?: string;
      to?: "refining" | "ready";
      tested_commit?: string;
      contract_hash?: string;
      replay?: string;
    },
    actor: Actor,
  ): TransitionResult {
    const summary = input.summary.trim();
    if (summary.length === 0) {
      throw new DispatchError("VALIDATION_ERROR", "A failing-test summary is required.");
    }
    // Where a FAIL lands (below the retry cap): `refining` holds the ticket for a human
    // (the default, unchanged); `ready` re-queues it for REWORK with the failing
    // observation as feedback — the autonomous runner's choice, mirroring
    // `review reject --to ready`, so a tester FAIL is a bounded retry, not a stall.
    const failTo: TicketStatus = input.to === "ready" ? "ready" : "refining";
    return inTransaction(this.db, () => {
      const ticket = this.ticketSvc.resolveTicket(ticketRef);
      if (ticket.status !== "in_testing") {
        throw new DispatchError(
          "ILLEGAL_TRANSITION",
          "Only a ticket in testing can be failed by the tester.",
          { from: ticket.status, to: failTo },
        );
      }
      const binding = validatedBinding(input, {
        strict: false, // a FAIL never certifies anything; a present binding is still validated
        currentHash: contractHash(this.db, ticket.id),
        verdict: "fail",
      });
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
        payload_json: JSON.stringify({
          verdict: "fail",
          provenance: testerProvenance(actor),
          ...binding,
        }),
        created_by: actor.id ?? actor.type,
        recorded_by_actor_type: actor.type,
        created_at: now,
      });

      const { nextAttempt, capReached } = capRetry(ticket.attempt_count, this.maxAttempts);
      const target: TicketStatus = capReached ? "blocked" : failTo;
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
   *
   * GRADUATED-AUTONOMY (Spec 2, Phase 1, merge-time correction): `approved_unchanged`
   * is first stamped at APPROVE time, but with the testing lane on a tester can amend
   * the branch AFTER approval — so the approve-time value can overstate what actually
   * landed. We RE-RESOLVE the delivery-vs-merged-head signal here (the resolver reads
   * the branch head fresh, which is now the merged head) and emit the CORRECTED value
   * on this transition, so the signal reaching `autonomyRecommendationService` (via
   * {@link EventRepository.reviewDecisions}, which prefers this merge-time value)
   * reflects the merged state. Behaviour is preserved when there was no post-approval
   * amend: the merged head still equals the delivery SHA, so the value is identical to
   * approve time. The key is only emitted when the signal is DEFINITE (`true`/`false`);
   * an unknown (`null`) resolution is omitted, leaving the merge payload byte-for-byte
   * as before so it never clobbers a known approve-time value downstream.
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
    const approvedUnchanged = this.computeApprovedUnchanged(ticket);
    return this.transitions.transition({
      ticketId: ticket.id,
      actor,
      toStatus: "done",
      reason: "merge_completed",
      expectedFromStatus: "ready_for_merge",
      markMerged: true,
      // Only carry a DEFINITE merge-time signal; omit an unknown so the payload stays
      // byte-for-byte identical to today and never overrides a known approve-time value.
      ...(approvedUnchanged !== null ? { approvedUnchanged } : {}),
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
        recorded_by_actor_type: actor.type,
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
