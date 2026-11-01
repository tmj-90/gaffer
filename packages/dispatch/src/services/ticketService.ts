import { type Db, inTransaction } from "../db/connection.js";
import {
  addAcInput,
  addDependencyInput,
  createTicketInput,
  editAcInput,
  editTicketInput,
  toOneLine,
  recordDeliveryArtifactInput,
  recordRepoDeliveryInput,
  setRequiredCapabilitiesInput,
  setTestContractInput,
  setTicketBudgetInput,
} from "../domain/schemas.js";
import {
  parseTestContract,
  validateTestContract,
  type AcceptanceCriterion,
  type Actor,
  type EvidenceType,
  type TestContract,
  type Ticket,
  type TicketDependency,
  type TicketDependencyView,
  type TicketRepoDelivery,
  type TicketStatus,
} from "../domain/types.js";
import { writeEvent } from "../events/eventWriter.js";
import { AcRepository } from "../repositories/acRepository.js";
import { DecisionRepository } from "../repositories/decisionRepository.js";
import { EvidenceRepository } from "../repositories/evidenceRepository.js";
import { RepoRepository } from "../repositories/repoRepository.js";
import { RequiredCapabilityRepository } from "../repositories/requiredCapabilityRepository.js";
import {
  TicketRepoDeliveryRepository,
  type TicketRepoDeliveryWithRepo,
} from "../repositories/ticketRepoDeliveryRepository.js";
import { TicketDependencyRepository } from "../repositories/ticketDependencyRepository.js";
import { TicketRepository } from "../repositories/ticketRepository.js";
import type { TransitionService } from "./transitionService.js";
import type { ClaimService } from "./claimService.js";
import type { Clock } from "../util/clock.js";
import { DispatchError, notFound } from "../util/errors.js";
import { newId } from "../util/id.js";
import { TESTER_REPLAY_PREFIX } from "./testerReplay.js";

/** System delivery evidence input (no claim token). */
export interface DeliveryEvidenceInput {
  evidenceType: EvidenceType;
  summary: string;
  uri?: string | undefined;
  /**
   * Optional structured detail, a JSON OBJECT as text (e.g. the runner's per-attempt
   * agent-run record: attempt, model, CLI version). At most 4 KB; anything that is not
   * a JSON object is refused.
   */
  payloadJson?: string | undefined;
}

/** Cap on a system evidence payload: structured detail, not a log dump. */
export const DELIVERY_EVIDENCE_PAYLOAD_MAX = 4096;

/** Result of recording a delivery artifact. */
export interface DeliveryArtifactResult {
  ticketId: string;
  branchName: string | null;
  prUrl: string | null;
  eventId: string;
}

/** Result of recording a per-repo delivery artifact (WG-005). */
export interface RepoDeliveryResult {
  delivery: TicketRepoDelivery;
  eventId: string;
}

/** Result of adding a ticket dependency (EP-001). */
export interface AddDependencyResult {
  ticketId: string;
  dependsOnTicketId: string;
  eventId: string;
}

/**
 * Whether a ticket currently passes its policy pack's readiness gate (WG-004).
 */
export interface ClaimabilityResult {
  ticketId: string;
  ready: boolean;
  blockers: { code: string; message: string }[];
  warnings: { code: string; message: string }[];
}

/**
 * CONTRACT FREEZE (exploratory findings cli-wg/F-02, api-robustness/F3). A ticket's
 * contract (title, description, policy pack, acceptance criteria and their check
 * commands) may change only while no delivery is bound to it. From `claimed` on, the
 * review, the tester's contract hash and the runner's check commands are bound to
 * the contract as it stood; editing it then would let a criterion (or a check
 * command) appear that the delivery never saw, so every contract write is refused
 * with CONTRACT_FROZEN outside these statuses.
 */
export const CONTRACT_EDITABLE_STATUSES: readonly TicketStatus[] = [
  "draft",
  "refining",
  "ready",
  "blocked",
];

/**
 * The test contract (the testing handover the independent tester reads) is part of the
 * tester's contract hash (util/contractHash). It is written by whoever hands the
 * ticket to the tester: the implementer while it delivers, or the reviewer while it
 * reviews, so it stays editable through `claimed`, `in_progress` and `in_review`. From
 * `in_testing` on the tester is bound to it (its verdict carries the hash, and a PASS
 * reads stale once it changes), so a write there is refused with CONTRACT_FROZEN.
 */
export const TEST_CONTRACT_EDITABLE_STATUSES: readonly TicketStatus[] = [
  ...CONTRACT_EDITABLE_STATUSES,
  "claimed",
  "in_progress",
  "in_review",
];

/** A create-time warning: the ticket was created, but its pack will refuse it at ready. */
export interface TicketWarning {
  code: string;
  message: string;
}

/** Result of a ticket edit (cli-wg/F-02). */
export interface EditTicketResult {
  ticket: Ticket;
  eventId: string;
  changed: string[];
}

function assertHumanOrAdmin(actor: Actor, what: string): void {
  if (actor.type === "human" || actor.type === "admin") return;
  throw new DispatchError(
    "ACTOR_NOT_PERMITTED",
    `Only a human or admin may ${what}; an agent blocks its own claim with its claim token.`,
    { actor_type: actor.type },
  );
}

export interface TicketServiceDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly tickets: TicketRepository;
  readonly acs: AcRepository;
  readonly decisions: DecisionRepository;
  readonly evidence: EvidenceRepository;
  readonly repos: RepoRepository;
  readonly requiredCapabilities: RequiredCapabilityRepository;
  readonly repoDeliveries: TicketRepoDeliveryRepository;
  readonly ticketDependencies: TicketDependencyRepository;
  readonly transitions: TransitionService;
  readonly claims: ClaimService;
}

export class TicketService {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly tickets: TicketRepository;
  private readonly acs: AcRepository;
  private readonly decisions: DecisionRepository;
  private readonly evidence: EvidenceRepository;
  private readonly repos: RepoRepository;
  private readonly requiredCapabilities: RequiredCapabilityRepository;
  private readonly repoDeliveries: TicketRepoDeliveryRepository;
  private readonly ticketDependencies: TicketDependencyRepository;
  private readonly transitions: TransitionService;
  private readonly claims: ClaimService;

  constructor(deps: TicketServiceDeps) {
    this.db = deps.db;
    this.clock = deps.clock;
    this.tickets = deps.tickets;
    this.acs = deps.acs;
    this.decisions = deps.decisions;
    this.evidence = deps.evidence;
    this.repos = deps.repos;
    this.requiredCapabilities = deps.requiredCapabilities;
    this.repoDeliveries = deps.repoDeliveries;
    this.ticketDependencies = deps.ticketDependencies;
    this.transitions = deps.transitions;
    this.claims = deps.claims;
  }

  // --- Tickets -------------------------------------------------------------

  createTicket(raw: unknown, actor: Actor): Ticket {
    const input = createTicketInput.parse(raw);
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      const ticket: Ticket = {
        id: newId(),
        number: this.tickets.nextNumber(),
        title: input.title,
        description: input.description,
        status: "draft",
        priority: input.priority,
        risk_level: input.risk_level,
        policy_pack: input.policy_pack,
        source: input.source ?? null,
        created_by: input.created_by ?? actor.id ?? null,
        reviewer: null,
        branch_name: null,
        pr_url: null,
        attempt_count: 0,
        row_version: 0,
        scheduled_after: null,
        due_at: null,
        bootstrap: input.bootstrap ? 1 : 0,
        last_review_feedback: null,
        can_be_tested: 0,
        test_contract: null,
        acceptance: input.acceptance ? 1 : 0,
        allow_test_changes: 0,
        human_owner: null,
        human_delivered: null,
        delivery_budget_usd: input.delivery_budget_usd ?? null,
        created_at: now,
        updated_at: now,
      };
      this.tickets.insert(ticket);
      writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.created",
        payload: {
          title: ticket.title,
          policy_pack: ticket.policy_pack,
          ...(ticket.bootstrap === 1 ? { bootstrap: true } : {}),
          ...(ticket.acceptance === 1 ? { acceptance: true } : {}),
        },
      });
      return ticket;
    });
  }

  addAcceptanceCriterion(raw: unknown, actor: Actor): { ac: AcceptanceCriterion; eventId: string } {
    const input = addAcInput.parse(raw);
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      const ticket = this.tickets.resolveRef(input.ticket_id);
      this.assertContractEditable(ticket, "add an acceptance criterion");
      const ac: AcceptanceCriterion = {
        id: newId(),
        ticket_id: ticket.id,
        text: input.text,
        sort_order: this.acs.nextSortOrder(ticket.id),
        status: "pending",
        verification_method: input.verification_method ?? null,
        evidence_required: input.evidence_required ? 1 : 0,
        verified_by: null,
        verified_at: null,
        // Spec-Driven Development (Phase 2a): thread the frozen-spec clause id
        // through as provenance; NULL when the AC maps to no clause.
        spec_clause_id: input.spec_clause_id ?? null,
        // MACHINE-CHECKABLE AC: the runner-executed verification command (NULL ⇒ prose).
        check_command: input.check_command ?? null,
        created_at: now,
        updated_at: now,
      };
      this.acs.insert(ac);
      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ac.added",
        payload: { ac_id: ac.id, text: ac.text },
      });
      this.recheckReadyGate(ticket);
      return { ac, eventId };
    });
  }

  // --- Contract edits (cli-wg/F-02, api-robustness/F3) ---------------------

  /**
   * Refuse a contract write outside {@link CONTRACT_EDITABLE_STATUSES} with
   * CONTRACT_FROZEN (409 over REST).
   */
  assertContractEditable(ticket: Ticket, what: string): void {
    if (CONTRACT_EDITABLE_STATUSES.includes(ticket.status)) return;
    throw new DispatchError(
      "CONTRACT_FROZEN",
      `Cannot ${what}: ticket #${ticket.number ?? ticket.id} is '${ticket.status}', and its ` +
        "contract (title, description, policy, criteria, check commands) is frozen once " +
        "delivery starts, because the review and the tester are bound to it. Send it back for " +
        `rework first, or change it while it is ${CONTRACT_EDITABLE_STATUSES.join(", ")}.`,
      {
        ticket_id: ticket.id,
        status: ticket.status,
        editable_statuses: CONTRACT_EDITABLE_STATUSES,
      },
    );
  }

  /**
   * A READY ticket must keep passing its own ready gate: an edit that would fail it
   * (a blanked description under team_light, the last criterion removed, a stricter
   * pack) is refused with POLICY_DENIED, and the caller's transaction rolls back.
   * Other statuses are checked when they next go ready.
   */
  private recheckReadyGate(before: Ticket): void {
    if (before.status !== "ready") return;
    const policy = this.transitions.preview(before.id, "ready");
    if (policy && !policy.allowed) {
      throw new DispatchError(
        "POLICY_DENIED",
        `This edit would make ready ticket #${before.number ?? before.id} fail its ` +
          `'${policy.policy_pack}' ready gate; move it back to draft first, or fix what the ` +
          "gate names in the same change.",
        { policy },
      );
    }
  }

  /**
   * Warnings for a just-created ticket (cli-wg/F-02): a team_light-or-stricter ticket
   * with no description can never pass its ready gate until one is set.
   */
  createWarnings(ticket: Ticket): TicketWarning[] {
    if (ticket.policy_pack === "solo_loose" || ticket.description.trim().length > 0) return [];
    return [
      {
        code: "DESCRIPTION_REQUIRED",
        message:
          `The '${ticket.policy_pack}' pack needs a description before ticket ` +
          `#${ticket.number} can be ready. Set one with: wg ticket edit ${ticket.number} -d "<what + why>"`,
      },
    ];
  }

  /**
   * Edit a ticket's title, description, policy pack and/or priority. Writes one
   * `ticket.edited` event naming what changed (old and new value; a description by
   * its length). The contract fields are guarded by {@link assertContractEditable};
   * a priority-only change is refused only on a done or cancelled ticket.
   */
  editTicket(ref: string, raw: unknown, actor: Actor): EditTicketResult {
    const input = editTicketInput.parse(raw);
    return inTransaction(this.db, () => {
      const ticket = this.resolveTicket(ref);
      const contract =
        input.title !== undefined ||
        input.description !== undefined ||
        input.policy_pack !== undefined;
      if (contract) this.assertContractEditable(ticket, "edit the ticket");
      else if (ticket.status === "done" || ticket.status === "cancelled") {
        throw new DispatchError(
          "STATE_CONFLICT",
          `Ticket #${ticket.number ?? ticket.id} is '${ticket.status}'; its priority is final.`,
          { status: ticket.status },
        );
      }
      const changes: Record<string, unknown> = {};
      if (input.title !== undefined && input.title !== ticket.title) {
        changes.title = { from: ticket.title, to: input.title };
      }
      if (input.description !== undefined && input.description !== ticket.description) {
        changes.description = {
          from_length: ticket.description.length,
          to_length: input.description.length,
        };
      }
      if (input.policy_pack !== undefined && input.policy_pack !== ticket.policy_pack) {
        changes.policy_pack = { from: ticket.policy_pack, to: input.policy_pack };
      }
      if (input.priority !== undefined && input.priority !== ticket.priority) {
        changes.priority = { from: ticket.priority, to: input.priority };
      }
      const changed = Object.keys(changes);
      if (changed.length === 0) {
        throw new DispatchError(
          "NO_OP",
          `Ticket #${ticket.number ?? ticket.id} already has those values.`,
        );
      }
      const now = this.clock.now();
      const ok = this.tickets.updateFields(
        ticket.id,
        ticket.row_version,
        {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.policy_pack !== undefined ? { policy_pack: input.policy_pack } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
        },
        now,
      );
      if (!ok) {
        throw new DispatchError("CONCURRENCY_CONFLICT", "Ticket changed concurrently; retry.");
      }
      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.edited",
        payload: { changed, changes },
      });
      this.recheckReadyGate(ticket);
      const updated = this.tickets.findById(ticket.id);
      if (!updated) throw notFound("ticket", ticket.id);
      return { ticket: updated, eventId, changed };
    });
  }

  /**
   * One of a ticket's criteria by its id, a unique id prefix (4+ characters) or its
   * 1-based position in the ticket's list (`1` = the first, as `ticket show` orders them).
   */
  resolveAcceptanceCriterion(ticket: Ticket, acRef: string): AcceptanceCriterion {
    const ref = acRef.trim();
    const acs = this.acs.listForTicket(ticket.id);
    if (/^\d{1,3}$/.test(ref)) {
      const ac = acs[Number(ref) - 1];
      if (ac) return ac;
      throw new DispatchError(
        "NOT_FOUND",
        `Ticket #${ticket.number ?? ticket.id} has ${acs.length} criteria; there is no criterion ${ref}.`,
        { entity: "acceptance_criterion", id: ref, count: acs.length },
      );
    }
    const exact = acs.find((a) => a.id === ref);
    if (exact) return exact;
    const hits = ref.length >= 4 ? acs.filter((a) => a.id.startsWith(ref)) : [];
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) {
      throw new DispatchError("AMBIGUOUS_REF", `Criterion ref "${ref}" matches ${hits.length}.`, {
        ref,
        matches: hits.map((a) => a.id),
      });
    }
    throw notFound("acceptance_criterion", ref);
  }

  /**
   * Edit one criterion's text, verification method and/or check command. The
   * criterion goes back to `pending` (what verified the old wording does not verify
   * the new). Writes `ac.edited` naming what changed.
   */
  editAcceptanceCriterion(
    ticketRef: string,
    acRef: string,
    raw: unknown,
    actor: Actor,
  ): { ac: AcceptanceCriterion; eventId: string } {
    const input = editAcInput.parse(raw);
    return inTransaction(this.db, () => {
      const ticket = this.resolveTicket(ticketRef);
      this.assertContractEditable(ticket, "edit an acceptance criterion");
      const ac = this.resolveAcceptanceCriterion(ticket, acRef);
      const next = {
        text: input.text ?? ac.text,
        verification_method:
          input.verification_method === undefined
            ? ac.verification_method
            : input.verification_method === null || input.verification_method.trim() === ""
              ? null
              : input.verification_method,
        check_command: input.check_command === undefined ? ac.check_command : input.check_command,
      };
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const k of ["text", "verification_method", "check_command"] as const) {
        if (next[k] !== ac[k]) changes[k] = { from: ac[k], to: next[k] };
      }
      const changed = Object.keys(changes);
      if (changed.length === 0) {
        throw new DispatchError("NO_OP", "The criterion already has those values.");
      }
      const now = this.clock.now();
      this.acs.update(ac.id, next, now);
      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ac.edited",
        payload: { ac_id: ac.id, changed, changes },
      });
      this.recheckReadyGate(ticket);
      const updated = this.acs.findById(ac.id);
      if (!updated) throw notFound("acceptance_criterion", ac.id);
      return { ac: updated, eventId };
    });
  }

  /** Remove one criterion (its evidence goes with it). Writes `ac.removed`. */
  removeAcceptanceCriterion(
    ticketRef: string,
    acRef: string,
    actor: Actor,
  ): { acId: string; eventId: string } {
    return inTransaction(this.db, () => {
      const ticket = this.resolveTicket(ticketRef);
      this.assertContractEditable(ticket, "remove an acceptance criterion");
      const ac = this.resolveAcceptanceCriterion(ticket, acRef);
      this.acs.delete(ac.id);
      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ac.removed",
        payload: { ac_id: ac.id, text: ac.text },
      });
      this.recheckReadyGate(ticket);
      return { acId: ac.id, eventId };
    });
  }

  // --- Human block / unblock (cli-wg/F-03) ---------------------------------

  /**
   * A person parks a ticket that is not in an agent's hands: draft, refining, ready,
   * or in_progress when a human took it by hand. The state-machine edges this takes
   * are legal only with the `humanBlock` flag, which transition() accepts from a
   * human or admin alone. An agent-claimed ticket is refused here: the agent blocks
   * its own claim with its token (Dispatch.markBlocked, unchanged). Writes
   * `ticket.blocked` with the status it left, which {@link humanUnblockTicket} returns to.
   */
  humanBlockTicket(
    ref: string,
    reason: string,
    actor: Actor,
  ): { ticketId: string; from: TicketStatus; eventId: string } {
    assertHumanOrAdmin(actor, "block a ticket without a claim token");
    const why = reason.trim();
    if (why.length === 0) throw new DispatchError("VALIDATION_ERROR", "A reason is required.");
    return inTransaction(this.db, () => {
      const ticket = this.resolveTicket(ref);
      const from = ticket.status;
      const humanOwned = from === "in_progress" && ticket.human_owner !== null;
      if (from !== "draft" && from !== "refining" && from !== "ready" && !humanOwned) {
        throw new DispatchError(
          "STATE_CONFLICT",
          from === "claimed" || from === "in_progress"
            ? `Ticket #${ticket.number ?? ticket.id} is '${from}' under an agent's claim: the agent ` +
                "blocks it with its claim token (--token), or release the claim first."
            : `Ticket #${ticket.number ?? ticket.id} is '${from}'; a person can block a draft, ` +
                "refining, ready or by-hand ticket.",
          { status: from, ticket_id: ticket.id },
        );
      }
      this.transitions.transition({
        ticketId: ticket.id,
        actor,
        toStatus: "blocked",
        reason: why,
        humanBlock: true,
      });
      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.blocked",
        payload: { reason: why, from },
      });
      return { ticketId: ticket.id, from, eventId };
    });
  }

  /**
   * Return a blocked ticket to the queue: to `to` when given, else to draft or
   * refining when that is where a person blocked it from, else to ready (the ready
   * gate applies, so a ticket that no longer passes it is refused with POLICY_DENIED;
   * `to: "refining"` then parks it for triage). Writes `ticket.unblocked`.
   */
  humanUnblockTicket(
    ref: string,
    actor: Actor,
    to?: "ready" | "refining" | "draft",
  ): { ticketId: string; status: TicketStatus; eventId: string } {
    assertHumanOrAdmin(actor, "unblock a ticket");
    return inTransaction(this.db, () => {
      const ticket = this.resolveTicket(ref);
      if (ticket.status !== "blocked") {
        throw new DispatchError(
          "STATE_CONFLICT",
          `Ticket #${ticket.number ?? ticket.id} is '${ticket.status}', not blocked.`,
          { status: ticket.status, ticket_id: ticket.id },
        );
      }
      const row = this.db
        .prepare(
          `SELECT payload_json FROM work_events
            WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = 'ticket.blocked'
            ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(ticket.id) as { payload_json: string | null } | undefined;
      let blockedFrom: unknown;
      try {
        blockedFrom = (JSON.parse(row?.payload_json ?? "{}") as { from?: unknown }).from;
      } catch {
        blockedFrom = undefined;
      }
      const target: TicketStatus =
        to ?? (blockedFrom === "draft" || blockedFrom === "refining" ? blockedFrom : "ready");
      this.transitions.transition({
        ticketId: ticket.id,
        actor,
        toStatus: target,
        reason: "unblock",
        humanBlock: true,
      });
      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.unblocked",
        payload: { to: target },
      });
      return { ticketId: ticket.id, status: target, eventId };
    });
  }

  // --- Ticket dependencies (EP-001) ----------------------------------------

  /**
   * Declare that `ticket` must wait for `depends_on` (both id or #number) to be
   * `done` before it can be claimed.
   */
  addDependency(raw: unknown, actor: Actor): AddDependencyResult {
    const input = addDependencyInput.parse(raw);
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      const ticket = this.resolveTicket(input.ticket);
      const dependsOn = this.resolveTicket(input.depends_on);
      if (ticket.id === dependsOn.id) {
        throw new DispatchError("INVALID_DEPENDENCY", "A ticket cannot depend on itself.", {
          ticket_id: ticket.id,
        });
      }
      if (this.ticketDependencies.exists(ticket.id, dependsOn.id)) {
        throw new DispatchError("DUPLICATE", "That dependency already exists.", {
          ticket_id: ticket.id,
          depends_on_ticket_id: dependsOn.id,
        });
      }
      if (this.dependencyCycleWouldForm(dependsOn.id, ticket.id)) {
        throw new DispatchError("INVALID_DEPENDENCY", "This dependency would create a cycle.", {
          ticket_id: ticket.id,
          depends_on_ticket_id: dependsOn.id,
        });
      }
      const dep: TicketDependency = {
        ticket_id: ticket.id,
        depends_on_ticket_id: dependsOn.id,
        created_at: now,
      };
      this.ticketDependencies.insert(dep);
      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.dependency_added",
        payload: { depends_on_ticket_id: dependsOn.id, depends_on_number: dependsOn.number },
      });
      return { ticketId: ticket.id, dependsOnTicketId: dependsOn.id, eventId };
    });
  }

  /**
   * Walk depends-on edges from `startTicketId`; true if `targetTicketId` is
   * reachable (so adding target -> start would close a loop).
   */
  private dependencyCycleWouldForm(startTicketId: string, targetTicketId: string): boolean {
    const seen = new Set<string>();
    const stack = [startTicketId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === targetTicketId) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const next of this.ticketDependencies.dependsOn(current)) stack.push(next);
    }
    return false;
  }

  listDependencies(ticketRef: string): TicketDependencyView[] {
    const ticket = this.resolveTicket(ticketRef);
    return this.ticketDependencies.listForTicket(ticket.id);
  }

  removeDependency(
    ticketRef: string,
    dependsOnRef: string,
    actor: Actor,
  ): { ticketId: string; dependsOnTicketId: string; eventId: string } {
    return inTransaction(this.db, () => {
      const ticket = this.resolveTicket(ticketRef);
      const dependsOn = this.resolveTicket(dependsOnRef);
      const removed = this.ticketDependencies.delete(ticket.id, dependsOn.id);
      if (!removed) {
        throw notFound("ticket_dependency", `${ticket.id}->${dependsOn.id}`);
      }
      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.dependency_removed",
        payload: { depends_on_ticket_id: dependsOn.id },
      });
      return { ticketId: ticket.id, dependsOnTicketId: dependsOn.id, eventId };
    });
  }

  // --- Claimability --------------------------------------------------------

  /**
   * Report whether a ticket passes its policy pack's readiness gate (WG-004) AND
   * is dependency-clear (EP-001), WITHOUT mutating it.
   */
  claimability(ticketRef: string): ClaimabilityResult {
    const ticket = this.resolveTicket(ticketRef);

    const unsatisfied = this.ticketDependencies.unsatisfiedDependencies(ticket.id);
    const dependencyBlockers: { code: string; message: string }[] =
      unsatisfied.length > 0
        ? [
            {
              code: "DEPENDENCY_BLOCKED",
              message: `Blocked by ${unsatisfied
                .map((d) => (d.number !== null ? `#${d.number}` : d.depends_on_ticket_id))
                .join(", ")} (must be done first).`,
            },
          ]
        : [];

    // cli-wg/F-12: an open blocking decision keeps a ticket out of every claim (the
    // candidate scan skips it whatever its pack), so it is a blocker here too.
    const decisions = this.decisions.blockingForTicket(ticket.id);
    if (decisions.length > 0) {
      dependencyBlockers.push({
        code: "DECISION_BLOCKED",
        message: `Waiting on ${decisions.length === 1 ? "a decision" : `${decisions.length} decisions`}: ${decisions
          .map((d) => d.title)
          .join("; ")} (answer it: gaffer wg decisions resolve <id>).`,
      });
    }

    const beforeReady = ticket.status === "draft" || ticket.status === "refining";
    if (!beforeReady) {
      return {
        ticketId: ticket.id,
        ready: dependencyBlockers.length === 0,
        blockers: dependencyBlockers,
        warnings: [],
      };
    }
    const policy = this.transitions.preview(ticket.id, "ready");
    if (!policy) {
      return {
        ticketId: ticket.id,
        ready: dependencyBlockers.length === 0,
        blockers: dependencyBlockers,
        warnings: [],
      };
    }
    const policyBlockers = policy.failures.map((f) => ({ code: f.code, message: f.message }));
    return {
      ticketId: ticket.id,
      ready: policy.allowed && dependencyBlockers.length === 0,
      blockers: [...policyBlockers, ...dependencyBlockers],
      warnings: policy.warnings.map((w) => ({ code: w.code, message: w.message })),
    };
  }

  /**
   * cli-wg/F-12: could a claim take this ticket now? Ready, not taken by hand, and
   * {@link claimability} reports no blocker (every dependency done, no open blocking
   * decision). What `wg ticket list --claimable` lists.
   */
  isClaimableNow(ticket: Ticket): boolean {
    if (ticket.status !== "ready" || ticket.human_owner !== null) return false;
    return this.claimability(ticket.id).ready;
  }

  // --- AC management -------------------------------------------------------

  /**
   * Reset every acceptance criterion on a ticket back to `pending` (NOT satisfied).
   */
  resetAcceptanceCriteria(
    ref: string,
    actor: Actor,
  ): { ticketId: string; reset: number; eventId: string } {
    return inTransaction(this.db, () => {
      const ticket = this.resolveTicket(ref);
      const now = this.clock.now();
      const reset = this.acs.resetForTicket(ticket.id, now);
      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.acceptance_criteria_reset",
        payload: { reset },
      });
      return { ticketId: ticket.id, reset, eventId };
    });
  }

  // --- Testing lane (BBT-001) ----------------------------------------------

  setTestable(
    ticketRef: string,
    canBeTested: boolean,
    actor: Actor,
  ): { ticketId: string; canBeTested: boolean; eventId: string } {
    return inTransaction(this.db, () => {
      const ticket = this.resolveTicket(ticketRef);
      const now = this.clock.now();
      this.tickets.setCanBeTested(ticket.id, canBeTested, now);
      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.testable_set",
        payload: { can_be_tested: canBeTested },
      });
      return { ticketId: ticket.id, canBeTested, eventId };
    });
  }

  // --- Gate integrity -------------------------------------------------------

  /**
   * GATE INTEGRITY: a HUMAN allows (or withdraws the allowance for) this ticket to
   * change its tests. With it set, the runner's integrity gate row reads PASS-with-note
   * instead of FLAG and the `test-modified` risk annotation no longer holds an
   * auto-approve. Only a human or admin may set it — an agent cannot excuse its own
   * test edits, and the runner (system) has no business deciding it either — so both
   * are refused here, server-side, whatever surface they came through. Every change is
   * a `ticket.test_changes_allowed` event naming who set it and the optional reason.
   */
  setAllowTestChanges(
    ticketRef: string,
    allowed: boolean,
    actor: Actor,
    reason?: string,
  ): { ticketId: string; allowTestChanges: boolean; eventId: string } {
    if (actor.type !== "human" && actor.type !== "admin") {
      throw new DispatchError(
        "ACTOR_NOT_PERMITTED",
        "Only a human or admin may allow test changes on a ticket; an agent cannot excuse its own test edits.",
        { actor_type: actor.type },
      );
    }
    const note = (reason ?? "").trim();
    return inTransaction(this.db, () => {
      const ticket = this.resolveTicket(ticketRef);
      const now = this.clock.now();
      this.tickets.setAllowTestChanges(ticket.id, allowed, now);
      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.test_changes_allowed",
        payload: {
          allow_test_changes: allowed,
          previous: ticket.allow_test_changes === 1,
          ...(note ? { reason: note.slice(0, 500) } : {}),
        },
      });
      return { ticketId: ticket.id, allowTestChanges: allowed, eventId };
    });
  }

  setTestContract(ticketRef: string, raw: unknown, actor: Actor): TestContract {
    const input = setTestContractInput.parse(raw);
    const contract = validateTestContract({
      changed_surfaces: input.changed_surfaces,
      runtime_deps: input.runtime_deps,
      env_vars: input.env_vars,
      run_command: input.run_command,
      harness_ready: input.harness_ready,
    });
    return inTransaction(this.db, () => {
      const ticket = this.resolveTicket(ticketRef);
      const now = this.clock.now();
      this.tickets.setTestContract(ticket.id, JSON.stringify(contract), now);
      writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
      if (!TEST_CONTRACT_EDITABLE_STATUSES.includes(ticket.status)) {
        throw new DispatchError(
          "CONTRACT_FROZEN",
          `Cannot set the test contract: ticket #${ticket.number ?? ticket.id} is ` +
            `'${ticket.status}', and the tester is bound to the contract from in_testing ` +
            "on. Send it back for rework first, or set it while it is " +
            `${TEST_CONTRACT_EDITABLE_STATUSES.join(", ")}.`,
          {
            ticket_id: ticket.id,
            status: ticket.status,
            editable_statuses: TEST_CONTRACT_EDITABLE_STATUSES,
          },
        );
      }
        actor,
        event_type: "ticket.test_contract_set",
        payload: {
          changed_surfaces: contract.changed_surfaces.length,
          harness_ready: contract.harness_ready,
        },
      });
      return contract;
    });
  }

  getTestContract(ticketRef: string): TestContract | null {
    const ticket = this.resolveTicket(ticketRef);
    return parseTestContract(ticket.test_contract);
  }

  // --- Human gate operations -----------------------------------------------

  grantReadyApproval(ref: string, actor: Actor): { ticketId: string; eventId: string } {
    if (actor.type !== "human" && actor.type !== "admin") {
      throw new DispatchError(
        "ACTOR_NOT_PERMITTED",
        "Only a human or admin may grant a ready-approval.",
        { actor_type: actor.type },
      );
    }
    return inTransaction(this.db, () => {
      const ticket = this.resolveTicket(ref);
      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.ready_approved",
        payload: { granted_by: actor.id ?? actor.type },
      });
      return { ticketId: ticket.id, eventId };
    });
  }

  assignReviewer(
    ref: string,
    reviewerId: string,
    actor: Actor,
  ): { ticketId: string; reviewer: string; eventId: string } {
    if (actor.type !== "human" && actor.type !== "admin") {
      throw new DispatchError(
        "ACTOR_NOT_PERMITTED",
        "Only a human or admin may assign a reviewer.",
        { actor_type: actor.type },
      );
    }
    const reviewer = reviewerId.trim();
    if (reviewer.length === 0) {
      throw new DispatchError("VALIDATION_ERROR", "A reviewer id is required.");
    }
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      const ticket = this.resolveTicket(ref);
      const ok = this.tickets.updateStatus(
        ticket.id,
        ticket.status,
        ticket.row_version,
        { reviewer },
        now,
      );
      if (!ok) {
        throw new DispatchError("CONCURRENCY_CONFLICT", "Ticket changed concurrently; retry.");
      }
      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.reviewer_assigned",
        payload: { reviewer },
      });
      return { ticketId: ticket.id, reviewer, eventId };
    });
  }

  setRequiredCapabilities(
    raw: unknown,
    actor: Actor,
  ): { ticketId: string; capabilities: string[]; eventId: string } {
    const input = setRequiredCapabilitiesInput.parse(raw);
    const capabilities = [...new Set(input.capabilities)];
    return inTransaction(this.db, () => {
      const ticket = this.resolveTicket(input.ticket_id);
      this.requiredCapabilities.setForTicket(ticket.id, capabilities);
      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.required_capabilities_set",
        payload: { capabilities },
      });
      return { ticketId: ticket.id, capabilities, eventId };
    });
  }

  listRequiredCapabilities(ref: string): string[] {
    const ticket = this.resolveTicket(ref);
    return this.requiredCapabilities.listForTicket(ticket.id);
  }

  // --- Delivery artifacts --------------------------------------------------

  recordDeliveryArtifact(raw: unknown, actor: Actor): DeliveryArtifactResult {
    const input = recordDeliveryArtifactInput.parse(raw);
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      const ticket = this.resolveTicket(input.ticket_id);

      if (input.claim_token) {
        this.claims.assertClaimOnTicket(input.claim_token, ticket.id);
      } else if (actor.type === "agent") {
        throw new DispatchError(
          "CLAIM_REQUIRED",
          "An agent must present a valid claim token to record a delivery artifact.",
          { actor_type: actor.type, ticket_id: ticket.id },
        );
      }

      const ok = this.tickets.updateStatus(
        ticket.id,
        ticket.status,
        ticket.row_version,
        {
          ...(input.branch_name !== undefined ? { branch_name: input.branch_name } : {}),
          ...(input.pr_url !== undefined ? { pr_url: input.pr_url } : {}),
        },
        now,
      );
      if (!ok) {
        throw new DispatchError("CONCURRENCY_CONFLICT", "Ticket changed concurrently; retry.");
      }

      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.delivery_recorded",
        payload: {
          branch_name: input.branch_name ?? null,
          pr_url: input.pr_url ?? null,
          commit: input.commit ?? null,
          diff_summary: input.diff_summary ?? null,
        },
      });
      const updated = this.tickets.findById(ticket.id)!;
      return {
        ticketId: updated.id,
        branchName: updated.branch_name,
        prUrl: updated.pr_url,
        eventId,
      };
    });
  }

  recordRepoDelivery(raw: unknown, actor: Actor): RepoDeliveryResult {
    const input = recordRepoDeliveryInput.parse(raw);
    // GATE INTEGRITY: the base commit is the runner's record of where the delivery was
    // cut; the delivering agent never sets it (its MCP tool does not pass it either).
    if (
      (input.base_sha !== undefined || input.base_recut !== undefined) &&
      actor.type === "agent"
    ) {
      throw new DispatchError(
        "ACTOR_NOT_PERMITTED",
        "An agent cannot record a delivery's base commit; the runner records it.",
        { ticket_id: input.ticket_id, actor_type: actor.type },
      );
    }
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      const ticket = this.resolveTicket(input.ticket_id);
      const repo = this.repos.findById(input.repo_id) ?? this.repos.findByName(input.repo_id);
      if (!repo) throw notFound("repository", input.repo_id);
      if (!this.repoDeliveries.isRepoLinkedToTicket(ticket.id, repo.id)) {
        throw new DispatchError(
          "REPO_NOT_LINKED",
          `Cannot record delivery for repo '${repo.name}': it is not linked to this ticket. ` +
            "Link it via ticket_repos (linkRepository / setTicketRepoAccess) first.",
          { ticket_id: ticket.id, repo_id: repo.id },
        );
      }
      const existing = this.repoDeliveries.find(ticket.id, repo.id);
      // GATE INTEGRITY: the base commit is write-once. Replacing a stored one needs the
      // runner's word that it cut the branch again (`base_recut`); anything else (a retry
      // re-recording after the agent ran, whose branch tip holds the agent's commits)
      // is refused, so the scan and the gates keep diffing from where the work started.
      const replaceBase =
        input.base_sha !== undefined &&
        existing?.base_sha != null &&
        existing.base_sha !== input.base_sha;
      if (replaceBase && input.base_recut !== true) {
        throw new DispatchError(
          "STATE_CONFLICT",
          `Delivery for repo '${repo.name}' already records base ${existing.base_sha!.slice(0, 12)}; ` +
            "a different base commit replaces it only when the runner cut the branch again (base_recut).",
          { ticket_id: ticket.id, repo_id: repo.id },
        );
      }
      this.repoDeliveries.upsert(
        {
          ticketId: ticket.id,
          repoId: repo.id,
          branchName: input.branch_name ?? null,
          commitSha: input.commit_sha ?? null,
          baseSha: input.base_sha ?? null,
          replaceBaseSha: replaceBase,
          prUrl: input.pr_url ?? null,
          status: input.status ?? existing?.status ?? "not_started",
          evidenceRef: input.evidence_ref ?? null,
        },
        now,
      );
      const delivery = this.repoDeliveries.find(ticket.id, repo.id)!;
      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.repo_delivery_recorded",
        payload: {
          repo_id: repo.id,
          status: delivery.status,
          has_branch: delivery.branch_name !== null,
          has_pr: delivery.pr_url !== null,
        },
      });
      return { delivery, eventId };
    });
  }

  listRepoDeliveries(ticketRef: string): TicketRepoDeliveryWithRepo[] {
    const ticket = this.resolveTicket(ticketRef);
    return this.repoDeliveries.listForTicket(ticket.id);
  }

  // --- Convenience helpers -------------------------------------------------

  /**
   * Convenience for the idle loop: create a draft ticket, optionally link a repo,
   * and attach a manual-note evidence row capturing the supplied summary.
   * NOTE: linkRepository must be called on the Dispatch facade (which also
   * handles scope auto-link), so this method accepts an optional callback for it.
   */
  createDraftTicket(
    input: {
      title: string;
      description?: string;
      repoName?: string;
      evidenceSummary?: string;
      policyPack?: string;
    },
    actor: Actor,
    linkRepo?: (ticketId: string, repoName: string, actor: Actor) => void,
  ): { ticketId: string; number: number } {
    return inTransaction(this.db, () => {
      const ticket = this.createTicket(
        {
          // Machine-made (idle loops): collapse control characters rather than fail.
          title: toOneLine(input.title),
          description: input.description ?? "",
          ...(input.policyPack ? { policy_pack: input.policyPack } : {}),
        },
        actor,
      );
      if (input.repoName && linkRepo) {
        linkRepo(ticket.id, input.repoName, actor);
      }
      if (input.evidenceSummary) {
        const evidenceId = newId();
        const now = this.clock.now();
        this.evidence.insert({
          id: evidenceId,
          ticket_id: ticket.id,
          ac_id: null,
          repo_id: null,
          decision_id: null,
          evidence_type: "manual_note",
          summary: input.evidenceSummary,
          uri: null,
          payload_json: null,
          created_by: actor.id ?? actor.type,
          recorded_by_actor_type: actor.type,
          created_at: now,
        });
        writeEvent(this.db, {
          entity_type: "ticket",
          entity_id: ticket.id,
          actor,
          event_type: "evidence.recorded",
          payload: { evidence_id: evidenceId, evidence_type: "manual_note" },
        });
      }
      return { ticketId: ticket.id, number: ticket.number ?? 0 };
    });
  }

  /**
   * System delivery evidence (no claim token). Records an evidence row on a
   * ticket on behalf of a SYSTEM/factory actor so the `done` gate's PR/diff
   * requirement can be satisfied after the implementer's claim has completed.
   */
  attachDeliveryEvidence(
    ref: string,
    input: DeliveryEvidenceInput,
    actor: Actor,
  ): { evidenceId: string; eventId: string } {
    if (actor.type !== "system") {
      throw new DispatchError(
        "ACTOR_NOT_PERMITTED",
        "Delivery evidence may only be attached by a system actor; agents must record claim-scoped evidence.",
        { actor_type: actor.type },
      );
    }
    if (input.summary.trim().length === 0) {
      throw new DispatchError("VALIDATION_ERROR", "Delivery evidence summary is required.");
    }
    // TESTER REPLAY: the landed-revision record is written only by recordTesterReplay (the
    // landing path, with its checks); a generic system row must never look like one.
    if (String(input.uri ?? "").startsWith(TESTER_REPLAY_PREFIX)) {
      throw new DispatchError(
        "VALIDATION_ERROR",
        `The ${TESTER_REPLAY_PREFIX} uri is reserved for the landing path's tester-replay record.`,
      );
    }
    let payloadJson: string | null = null;
    if (input.payloadJson !== undefined && input.payloadJson.trim() !== "") {
      if (input.payloadJson.length > DELIVERY_EVIDENCE_PAYLOAD_MAX) {
        throw new DispatchError(
          "VALIDATION_ERROR",
          `Delivery evidence payload is over ${DELIVERY_EVIDENCE_PAYLOAD_MAX} characters.`,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(input.payloadJson);
      } catch {
        parsed = null;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new DispatchError(
          "VALIDATION_ERROR",
          "Delivery evidence payload must be a JSON object.",
        );
      }
      payloadJson = JSON.stringify(parsed);
    }
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      const ticket = this.resolveTicket(ref);
      const evidenceId = newId();
      this.evidence.insert({
        id: evidenceId,
        ticket_id: ticket.id,
        ac_id: null,
        repo_id: null,
        decision_id: null,
        evidence_type: input.evidenceType,
        summary: input.summary,
        uri: input.uri ?? null,
        payload_json: payloadJson,
        created_by: actor.id ?? actor.type,
        recorded_by_actor_type: actor.type,
        created_at: now,
      });
      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "evidence.recorded",
        payload: {
          evidence_id: evidenceId,
          ac_id: null,
          evidence_type: input.evidenceType,
          source: "system_delivery",
        },
      });
      return { evidenceId, eventId };
    });
  }

  // --- Internal helpers ----------------------------------------------------

  /**
   * TRACK-3a: set (or clear) a ticket's per-ticket delivery-budget ceiling in USD.
   * A positive figure caps the ticket's cumulative measured delivery spend; `null`
   * clears it (the factory-wide env budget then applies). Returns the updated ticket.
   */
  setDeliveryBudget(raw: unknown, actor: Actor): Ticket {
    const input = setTicketBudgetInput.parse(raw);
    return inTransaction(this.db, () => {
      const ticket = this.resolveTicket(String(input.ticket));
      const now = this.clock.now();
      this.tickets.setDeliveryBudget(ticket.id, input.delivery_budget_usd, now);
      writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.budget_set",
        payload: { delivery_budget_usd: input.delivery_budget_usd },
      });
      const updated = this.tickets.findById(ticket.id);
      if (!updated) throw notFound("ticket", ticket.id);
      return updated;
    });
  }

  resolveTicket(ref: string): Ticket {
    // The id, or #N / T-N / N (see TicketRepository.resolveRef).
    return this.tickets.resolveRef(ref);
  }
}
