import { type Db, inTransaction } from "../db/connection.js";
import {
  addAcInput,
  addDependencyInput,
  createTicketInput,
  recordDeliveryArtifactInput,
  recordRepoDeliveryInput,
  setRequiredCapabilitiesInput,
  setTestContractInput,
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

/** System delivery evidence input (no claim token). */
export interface DeliveryEvidenceInput {
  evidenceType: EvidenceType;
  summary: string;
  uri?: string | undefined;
}

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
        human_owner: null,
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
        },
      });
      return ticket;
    });
  }

  addAcceptanceCriterion(raw: unknown, actor: Actor): { ac: AcceptanceCriterion; eventId: string } {
    const input = addAcInput.parse(raw);
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      const ticket = this.tickets.findById(input.ticket_id);
      if (!ticket) throw notFound("ticket", input.ticket_id);
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
      return { ac, eventId };
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
    const dependencyBlockers =
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
      this.repoDeliveries.upsert(
        {
          ticketId: ticket.id,
          repoId: repo.id,
          branchName: input.branch_name ?? null,
          commitSha: input.commit_sha ?? null,
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
          title: input.title,
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
        payload_json: null,
        created_by: actor.id ?? actor.type,
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

  resolveTicket(ref: string): Ticket {
    const byId = this.tickets.findById(ref);
    if (byId) return byId;
    // Accept #N and T-N as ticket-number shortcuts.
    const normalised = ref.replace(/^#/, "").replace(/^T-/, "");
    const asNumber = Number(normalised);
    if (Number.isInteger(asNumber) && asNumber > 0) {
      const byNumber = this.tickets.findByNumber(asNumber);
      if (byNumber) return byNumber;
    }
    throw notFound("ticket", ref);
  }
}
