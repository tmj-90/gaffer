import { type Db, inTransaction, openDatabase } from "./db/connection.js";
import {
  addAcInput,
  addDependencyInput,
  claimTicketInput,
  createEpicInput,
  createScopeEdgeInput,
  createScopeNodeInput,
  createTicketInput,
  linkScopeRepoInput,
  linkTicketScopeInput,
  recordDeliveryArtifactInput,
  recordRepoDeliveryInput,
  registerRepoInput,
  setRequiredCapabilitiesInput,
  setTestContractInput,
  setTicketRepoAccessInput,
  suggestReposInput,
  updateScopeNodeInput,
  updateScopeRepoInput,
} from "./domain/schemas.js";
import {
  SCOPE_EDGE_RELATIONS_V1,
  TICKET_STATUSES,
  isActiveTicketRepoRelation,
  parseReviewFeedback,
  parseTestContract,
  validateTestContract,
  type AcceptanceCriterion,
  type Actor,
  type Agent,
  type Decision,
  type DecisionSeverity,
  type Evidence,
  type EvidenceType,
  type Repository,
  type ReviewFeedback,
  type RiskLevel,
  type ScopeEdge,
  type ScopeNode,
  type ScopeRepo,
  type TestContract,
  type Ticket,
  type TicketDependency,
  type TicketDependencyView,
  type TicketRepoDelivery,
  type TicketScopeNode,
  type TicketStatus,
  type WorkEvent,
} from "./domain/types.js";
import { listEvents, writeEvent } from "./events/eventWriter.js";
import { AcRepository } from "./repositories/acRepository.js";
import { AgentRepository } from "./repositories/agentRepository.js";
import { ClaimRepository, type ActiveClaimView } from "./repositories/claimRepository.js";
import { DecisionRepository } from "./repositories/decisionRepository.js";
import {
  EventRepository,
  type ActivityEvent,
  type ActivityQuery,
  type TransitionRow,
} from "./repositories/eventRepository.js";
import { EvidenceRepository } from "./repositories/evidenceRepository.js";
import { RepoRepository, type TicketRepoLink } from "./repositories/repoRepository.js";
import { RequiredCapabilityRepository } from "./repositories/requiredCapabilityRepository.js";
import {
  TicketRepoDeliveryRepository,
  type TicketRepoDeliveryWithRepo,
} from "./repositories/ticketRepoDeliveryRepository.js";
import { ScopeEdgeRepository } from "./repositories/scopeEdgeRepository.js";
import { ScopeNodeRepository } from "./repositories/scopeNodeRepository.js";
import { TicketDependencyRepository } from "./repositories/ticketDependencyRepository.js";
import {
  ScopeRepoRepository,
  type RepoScopeWithNode,
  type ScopeRepoWithRepo,
} from "./repositories/scopeRepoRepository.js";
import {
  TicketScopeNodeRepository,
  type TicketScopeWithNode,
} from "./repositories/ticketScopeNodeRepository.js";
import { TicketRepository, type TicketListFilter } from "./repositories/ticketRepository.js";
import {
  ClaimService,
  type ClaimNextInput,
  type ClaimResult,
  type MarkBlockedInput,
  type RecordEvidenceInput,
  type RegisterAgentInput,
  type SubmitForReviewInput,
} from "./services/claimService.js";
import { computeTicketDiff, type GitRunner, type TicketDiff } from "./services/diffService.js";
import {
  SuggestionService,
  type RepoSuggestion,
  type SuggestByFields,
} from "./services/suggestionService.js";
import { TransitionService, type TransitionResult } from "./services/transitionService.js";
import { type Clock, systemClock } from "./util/clock.js";
import { DispatchError, notFound } from "./util/errors.js";
import { newId } from "./util/id.js";

/**
 * Default cap on how many times a delivery may be rejected back into the queue
 * before it is PARKED for a human (P1 unbounded reject-loop / wallet guard).
 * Overridable via `DISPATCH_MAX_ATTEMPTS` (a positive integer).
 */
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Resolve the effective max-attempts cap: `DISPATCH_MAX_ATTEMPTS` when it parses
 * to a positive integer, else {@link DEFAULT_MAX_ATTEMPTS}. A non-positive or
 * unparseable value falls back to the default (fail-safe — never an unbounded cap).
 */
export function resolveMaxAttempts(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DISPATCH_MAX_ATTEMPTS;
  if (raw === undefined) return DEFAULT_MAX_ATTEMPTS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_ATTEMPTS;
}

/**
 * BBT-001 global toggle: is the independent black-box testing lane ON? Read from
 * `GAFFER_TESTING` (same env-driven path as the other autonomy/idle flags), OFF by
 * default so the lane is fully opt-in. Truthy values are "1"/"true"/"yes"/"on"
 * (case-insensitive); anything else (incl. unset) is OFF. When off, review approval
 * keeps today's behaviour (`in_review -> ready_for_merge`) and the lane is skipped
 * entirely.
 */
export function isTestingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.GAFFER_TESTING ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * BBT-001: derive the PROVENANCE of a tester verdict from the recording actor's
 * type, so the dashboard can attribute a pass/fail ("by agent | human | system")
 * instead of surfacing an unattributed verdict. `admin` collapses to `human` (a
 * person), `agent` is the factory tester, `system` is an automated/seam recording.
 */
export function testerProvenance(actor: Actor): "agent" | "human" | "system" {
  switch (actor.type) {
    case "agent":
      return "agent";
    case "system":
      return "system";
    case "human":
    case "admin":
      return "human";
  }
}

export interface TicketView {
  ticket: Ticket;
  acceptanceCriteria: AcceptanceCriterion[];
  repositories: TicketRepoLink[];
  /** Confirmed (primary/secondary/implicit_repo) + suggested scope links. */
  scopes: TicketScopeWithNode[];
  blockingDecisions: Decision[];
  /**
   * EP-001: tickets this one must wait for, each with the depended-on ticket's
   * number/title/status and a `satisfied` flag (true once it's `done`). An
   * unsatisfied dependency blocks this ticket from being claimed.
   */
  dependencies: TicketDependencyView[];
  /** Recorded evidence rows (oldest first), so reviewers can judge inline. */
  evidence: Evidence[];
  events: WorkEvent[];
}

/**
 * The execution boundary for a ticket, partitioned by access (WG-002). Only
 * relations that count as ACTIVE (confirmed / implicit_single_repo) appear in
 * `writeRepos`/`readOnlyRepos`/`testRepos`; `deniedRepos` carries access='none'
 * active links. `suggested`/`rejected` links are NOT a boundary and are surfaced
 * separately so a UI/agent can see what still needs confirming. An agent may
 * only write where a repo appears in `writeRepos`.
 */
export interface WorkPacketRepos {
  writeRepos: TicketRepoLink[];
  readOnlyRepos: TicketRepoLink[];
  testRepos: TicketRepoLink[];
  deniedRepos: TicketRepoLink[];
  /** Active links pending human confirmation (relation='suggested'). */
  suggestedRepos: TicketRepoLink[];
  /** Retained-for-audit rejected links (relation='rejected'). */
  rejectedRepos: TicketRepoLink[];
}

/**
 * Whether a ticket currently passes its policy pack's readiness gate (WG-004).
 * `ready` is the boolean verdict; `blockers` are the policy failure codes/messages
 * the PO must clear first (empty when ready); `warnings` are non-blocking hints.
 * Derived from the same TransitionService.preview the real mark-ready uses, so the
 * answer can never drift from the actual gate.
 */
export interface ClaimabilityResult {
  ticketId: string;
  ready: boolean;
  blockers: { code: string; message: string }[];
  warnings: { code: string; message: string }[];
}

/** Result of setting a ticket↔repo access boundary. */
export interface TicketRepoAccessResult {
  ticketId: string;
  repoId: string;
  access: string;
  relation: string;
  eventId: string;
}

/** Column keys for the kanban board (claimed+in_progress collapse to one). */
export const BOARD_COLUMNS = [
  "draft",
  "ready",
  "in_progress",
  "blocked",
  "in_review",
  // BBT-001: the independent black-box testing lane, between review and merge.
  "in_testing",
  "ready_for_merge",
  "done",
] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/** Claim summary surfaced on a board card. Never carries a token. */
export interface BoardCardClaim {
  agentId: string;
  agentDisplayName: string | null;
  expiresAt: string;
  /** True when the claim's lease has passed its expiry (stale/recoverable). */
  stale: boolean;
}

/** A single kanban card: the ticket plus the at-a-glance rollups. */
export interface BoardCard {
  id: string;
  number: number | null;
  title: string;
  status: TicketStatus;
  priority: number;
  risk_level: RiskLevel;
  updated_at: string;
  /** Total acceptance criteria. */
  acTotal: number;
  /** Acceptance criteria in a satisfied state. */
  acSatisfied: number;
  /** Acceptance criteria that require evidence AND are satisfied. */
  acEvidenced: number;
  /** Acceptance criteria that require evidence (the denominator for evidenced). */
  acEvidenceRequired: number;
  /** Count of open blocking decisions. */
  blockingCount: number;
  /** Active claim holder, when the ticket is claimed/in_progress. */
  claim: BoardCardClaim | null;
  /**
   * Latest review-rejection feedback (WG-049), so a human triaging the board sees
   * WHY a ticket in `refining`/rework was sent back. `null` when there is none.
   */
  lastReviewFeedback: ReviewFeedback | null;
}

/** A board column: the column key and its ordered cards. */
export interface BoardColumnView {
  column: BoardColumn;
  cards: BoardCard[];
}

/**
 * The full kanban board: ordered live columns, a closed (failed) area, and a
 * terminal won't-do bucket (cancelled tickets — work that will NOT be built,
 * distinct from rework). Won't-do tickets are reopenable, so they get their own
 * visible bucket rather than being hidden in the closed area.
 */
export interface BoardView {
  columns: BoardColumnView[];
  closed: BoardCard[];
  wontDo: BoardCard[];
  /**
   * Approved-and-merging tickets (`ready_for_merge`): approved by a human, the
   * merge runner is doing the git merge. Surfaced as a dedicated array (mirroring
   * the `ready_for_merge` column in `columns`) so a caller can render the
   * "Approved · merging" column without re-scanning the column list.
   */
  readyForMerge: BoardCard[];
}

/** Median time (ms) tickets spent in a state, over completed intervals. */
export interface CycleTimeStat {
  /** The state held between two transitions. */
  status: TicketStatus;
  /** Median duration in the state, in milliseconds. */
  medianMs: number;
  /** Number of completed intervals the median is computed over. */
  samples: number;
}

/** A ticket flagged as stuck: sitting in a non-terminal state too long. */
export interface StuckTicket {
  id: string;
  number: number | null;
  title: string;
  status: TicketStatus;
  /** How long the ticket has held its current state, in milliseconds. */
  stuckForMs: number;
  /** When the ticket entered its current state (ISO instant). */
  since: string;
}

/** Dashboard summary tiles — counts plus cycle-time/stuck analytics. */
export interface DashboardSummary {
  /** Ticket counts keyed by status (every status present, zero-filled). */
  ticketsByStatus: Record<TicketStatus, number>;
  /** Tickets delivered (→in_review/done) since the start of today (UTC). */
  deliveredToday: number;
  /** Tickets currently blocked. */
  blocked: number;
  /** Open (unresolved) decisions awaiting a human. */
  openDecisions: number;
  /** Active claims right now. */
  activeClaims: number;
  /** Active claims whose lease has passed expiry (stale). */
  staleClaims: number;
  /** Median cycle time per state, in TICKET_STATUSES order (states with data). */
  cycleTimeByState: CycleTimeStat[];
  /** Tickets stuck in a non-terminal state beyond the threshold, longest first. */
  stuckTickets: StuckTicket[];
  /** The age (hours) past which a non-terminal ticket is flagged as stuck. */
  stuckThresholdHours: number;
}

/** Input for resolving a decision via the human surface. */
export interface ResolveDecisionInput {
  decisionId: string;
  status: "accepted" | "rejected";
  answer?: string | undefined;
  rationale?: string | undefined;
}

/**
 * Delivery evidence attached by a SYSTEM/factory actor *without* a claim token.
 * This is the post-implementation path: by the time a ticket is `in_review` the
 * implementer's claim is completed, so the factory/tick attaches the delivery
 * `diff_summary` (or PR) to satisfy the `done` gate's PR/diff requirement. It is
 * NOT a substitute for claim-scoped AC evidence — see `attachDeliveryEvidence`.
 */
export interface DeliveryEvidenceInput {
  evidenceType: EvidenceType;
  summary: string;
  uri?: string | undefined;
}

/**
 * Where a ticket's work was delivered. Claim-scoped for agents (a valid token
 * matching the ticket's active claim); human/admin/system actors may record
 * tokenlessly. `branch_name`/`pr_url` persist onto the ticket; `commit` and
 * `diff_summary` ride on the emitted event payload.
 */
export interface RecordDeliveryArtifactInputView {
  ticketId?: string | undefined;
  ref?: string | undefined;
  claimToken?: string | undefined;
  branchName?: string | undefined;
  prUrl?: string | undefined;
  commit?: string | undefined;
  diffSummary?: string | undefined;
}

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

/** A scope node enriched with its linked repos (for the node-detail view). */
export interface ScopeNodeView {
  node: ScopeNode;
  repos: ScopeRepoWithRepo[];
}

/**
 * Result of {@link Dispatch.createEpic} (EP-001): the id of the created `epic`
 * scope node and the numbers of the created tickets, in plan (input array) order.
 * The runner/skill resolves a ticket number back to a ticket via the usual reads.
 */
export interface CreateEpicResult {
  epicNodeId: string;
  ticketNumbers: number[];
}

/** Result of adding a ticket dependency (EP-001). */
export interface AddDependencyResult {
  ticketId: string;
  dependsOnTicketId: string;
  eventId: string;
}

/**
 * Dispatch core API. The single entry point used by the CLI and MCP server.
 * Owns the DB handle, repositories and the transition service; validates input
 * with the Zod schemas before mutating.
 */
export class Dispatch {
  readonly db: Db;
  readonly tickets: TicketRepository;
  readonly acs: AcRepository;
  readonly repos: RepoRepository;
  readonly decisions: DecisionRepository;
  readonly evidence: EvidenceRepository;
  readonly agents: AgentRepository;
  readonly claimsRepo: ClaimRepository;
  readonly requiredCapabilities: RequiredCapabilityRepository;
  readonly repoDeliveries: TicketRepoDeliveryRepository;
  readonly events: EventRepository;
  readonly scopeNodes: ScopeNodeRepository;
  readonly scopeEdges: ScopeEdgeRepository;
  readonly scopeRepos: ScopeRepoRepository;
  readonly ticketScopes: TicketScopeNodeRepository;
  readonly ticketDependencies: TicketDependencyRepository;
  readonly transitions: TransitionService;
  readonly claims: ClaimService;
  readonly suggestions: SuggestionService;
  /**
   * Git runner used to compute diff-in-review. Injectable so tests can drive the
   * diff endpoint without a real repo on disk; defaults to the real `git` spawn.
   */
  private readonly gitRunner: GitRunner | undefined;

  /**
   * Retry cap (P1): a delivery rejected back into the queue this many times is
   * PARKED for a human instead of re-delivered forever. Resolved from
   * `DISPATCH_MAX_ATTEMPTS` (default {@link DEFAULT_MAX_ATTEMPTS}); overridable
   * per-instance for tests via the constructor option.
   */
  readonly maxAttempts: number;

  /**
   * BBT-001: per-instance override for the `GAFFER_TESTING` toggle. `undefined`
   * (the default) means "read the env via {@link isTestingEnabled}"; a boolean
   * pins it for tests so the testing lane can be exercised without touching the
   * process env.
   */
  private readonly testingEnabledOverride: boolean | undefined;

  constructor(
    db: Db,
    readonly clock: Clock = systemClock,
    gitRunner?: GitRunner,
    options: { maxAttempts?: number; testingEnabled?: boolean } = {},
  ) {
    this.db = db;
    this.gitRunner = gitRunner;
    this.maxAttempts = options.maxAttempts ?? resolveMaxAttempts();
    this.testingEnabledOverride = options.testingEnabled;
    this.tickets = new TicketRepository(db);
    this.acs = new AcRepository(db);
    this.repos = new RepoRepository(db);
    this.decisions = new DecisionRepository(db);
    this.evidence = new EvidenceRepository(db);
    this.agents = new AgentRepository(db);
    this.claimsRepo = new ClaimRepository(db);
    this.requiredCapabilities = new RequiredCapabilityRepository(db);
    this.repoDeliveries = new TicketRepoDeliveryRepository(db);
    this.events = new EventRepository(db);
    this.scopeNodes = new ScopeNodeRepository(db);
    this.scopeEdges = new ScopeEdgeRepository(db);
    this.scopeRepos = new ScopeRepoRepository(db);
    this.ticketScopes = new TicketScopeNodeRepository(db);
    this.ticketDependencies = new TicketDependencyRepository(db);
    this.transitions = new TransitionService(db, clock, gitRunner);
    this.claims = new ClaimService(db, clock, this.transitions);
    this.suggestions = new SuggestionService({
      repos: this.repos,
      scopeNodes: this.scopeNodes,
      scopeRepos: this.scopeRepos,
    });
  }

  /** Open a Dispatch instance against a SQLite file (or ":memory:"). */
  static open(
    path: string,
    clock: Clock = systemClock,
    gitRunner?: GitRunner,
    options: { maxAttempts?: number; testingEnabled?: boolean } = {},
  ): Dispatch {
    return new Dispatch(openDatabase(path), clock, gitRunner, options);
  }

  /**
   * Diff-in-review: the real `git diff <default-branch>...<delivery-branch>` for
   * each WRITE repo on the ticket, so a reviewer reads the change inline before
   * approving (and re-reads the resolved diff after a reopen-for-review). Pure
   * read; every failure mode (no branch, repo not on disk, empty, git error) is
   * reported per-repo rather than thrown. See {@link computeTicketDiff}.
   */
  ticketDiff(ref: string): TicketDiff {
    const ticket = this.resolveTicket(ref);
    return computeTicketDiff(
      {
        repos: this.repos,
        tickets: this.tickets,
        repoDeliveries: this.repoDeliveries,
        ...(this.gitRunner ? { runGit: this.gitRunner } : {}),
      },
      ticket.id,
    );
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
   * `done` before it can be claimed. Rejects a self-dependency, a duplicate edge,
   * and any edge that would create a cycle (so the dependency graph stays a DAG —
   * mirroring the scope-edge `contains` guard). The edge is recorded immediately;
   * the claim-eligibility query enforces the gate.
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
      // Cycle guard: adding ticket -> dependsOn would close a loop iff `ticket`
      // is already reachable from `dependsOn` along existing depends-on edges.
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
   * reachable (so adding target -> start would close a loop). A visited set
   * guards against any pre-existing cycle in the data. Mirrors
   * {@link containsCycleWouldForm} for scope edges.
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

  /** This ticket's dependencies (depended-on number/title/status + satisfied flag). */
  listDependencies(ticketRef: string): TicketDependencyView[] {
    const ticket = this.resolveTicket(ticketRef);
    return this.ticketDependencies.listForTicket(ticket.id);
  }

  /** Remove one dependency edge. NOT_FOUND when the edge doesn't exist. */
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

  // --- Epics (EP-001) ------------------------------------------------------

  /**
   * Create an epic atomically (all-or-nothing): a scope node of type `epic` that
   * `contains` every created ticket, the N tickets themselves (each `draft`, with
   * ACs, per-ticket priority/risk/policy, an optional repo link + access boundary
   * and an optional bootstrap marker), and the dependency edges declared by index
   * within the plan. `tickets[i].dependsOn` lists OTHER ticket indexes in the same
   * array; they're resolved to the created ticket ids after all tickets exist, so
   * a self-contained dependency-ordered plan is created in one call. Returns the
   * epic node id and the created ticket numbers in plan order.
   *
   * Validation (besides the Zod schema): every dependsOn index must be in range
   * and not self-referential; the dependency edges must form a DAG (a cycle is
   * rejected). The whole thing runs in one transaction — any failure rolls back
   * the node, the tickets and the edges.
   */
  createEpic(raw: unknown, actor: Actor): CreateEpicResult {
    const input = createEpicInput.parse(raw);

    // Pre-flight the dependency indexes BEFORE any write so a bad plan fails
    // cleanly (and cheaply) rather than part-way through the transaction.
    const n = input.tickets.length;
    for (let i = 0; i < n; i++) {
      for (const dep of input.tickets[i]!.dependsOn) {
        if (dep === i) {
          throw new DispatchError("INVALID_DEPENDENCY", `Ticket #${i} cannot depend on itself.`, {
            index: i,
          });
        }
        if (dep < 0 || dep >= n) {
          throw new DispatchError(
            "INVALID_DEPENDENCY",
            `Ticket #${i} depends on out-of-range index ${dep} (plan has ${n} tickets).`,
            { index: i, depends_on_index: dep },
          );
        }
      }
    }
    // Reject a cyclic plan up front via a DFS over the declared index edges.
    this.assertEpicPlanIsAcyclic(input.tickets.map((t) => t.dependsOn));

    return inTransaction(this.db, () => {
      const node = this.createScopeNode(
        {
          name: input.epic.name,
          type: "epic",
          ...(input.epic.description !== undefined ? { description: input.epic.description } : {}),
        },
        actor,
      );

      // Create every ticket first so the index→id map is complete before edges
      // are wired. Each ticket is created via the normal createTicket path (draft,
      // policy/scope validation), then ACs, repo link + access, and contained by
      // the epic node.
      const createdIds: string[] = [];
      const createdNumbers: number[] = [];
      for (const spec of input.tickets) {
        const ticket = this.createTicket(
          {
            title: spec.title,
            description: spec.description,
            ...(spec.priority !== undefined ? { priority: spec.priority } : {}),
            ...(spec.risk_level !== undefined ? { risk_level: spec.risk_level } : {}),
            ...(spec.policy_pack !== undefined ? { policy_pack: spec.policy_pack } : {}),
            ...(spec.bootstrap !== undefined ? { bootstrap: spec.bootstrap } : {}),
          },
          actor,
        );
        createdIds.push(ticket.id);
        createdNumbers.push(ticket.number ?? 0);

        for (const text of spec.acceptanceCriteria) {
          this.addAcceptanceCriterion({ ticket_id: ticket.id, text }, actor);
        }

        if (spec.repo) {
          // Internal seed of the epic ticket's repo link — uses the unguarded core
          // so an agent-driven epic-create (the factory flow) still links its repo.
          // The PUBLIC setTicketRepoAccess stays human/admin-only (P0 authz).
          this.applyTicketRepoAccess(
            {
              ticket_id: ticket.id,
              repo_id: spec.repo,
              ...(spec.access !== undefined ? { access: spec.access } : {}),
            },
            actor,
          );
        }

        // The epic node `contains` the ticket — a ticket↔scope link, so the epic
        // groups its tickets the same way a product scope groups its work.
        this.ticketScopes.upsert({
          ticket_id: ticket.id,
          scope_node_id: node.id,
          relation: "secondary",
          confidence: null,
          reasons_json: JSON.stringify([`contained by epic '${input.epic.name}'`]),
          created_at: this.clock.now(),
          updated_at: this.clock.now(),
        });
      }

      // Now wire the dependency edges by resolving each plan index to its id.
      for (let i = 0; i < n; i++) {
        for (const depIndex of input.tickets[i]!.dependsOn) {
          this.addDependency({ ticket: createdIds[i]!, depends_on: createdIds[depIndex]! }, actor);
        }
      }

      writeEvent(this.db, {
        entity_type: "scope_node",
        entity_id: node.id,
        actor,
        event_type: "epic.created",
        payload: { name: input.epic.name, ticket_count: n, ticket_numbers: createdNumbers },
      });

      return { epicNodeId: node.id, ticketNumbers: createdNumbers };
    });
  }

  /**
   * Reject a cyclic epic plan: a DFS over the index→dependsOn adjacency. Throws
   * INVALID_DEPENDENCY on the first back-edge. (createEpic also relies on
   * addDependency's per-edge guard, but checking the whole plan up front gives a
   * single clean failure before any row is written.)
   */
  private assertEpicPlanIsAcyclic(adjacency: ReadonlyArray<readonly number[]>): void {
    const WHITE = 0;
    const GREY = 1;
    const BLACK = 2;
    const color = new Array<number>(adjacency.length).fill(WHITE);
    const visit = (node: number): void => {
      color[node] = GREY;
      for (const next of adjacency[node]!) {
        if (color[next] === GREY) {
          throw new DispatchError(
            "INVALID_DEPENDENCY",
            "The epic plan's dependencies form a cycle.",
            { from_index: node, to_index: next },
          );
        }
        if (color[next] === WHITE) visit(next);
      }
      color[node] = BLACK;
    };
    for (let i = 0; i < adjacency.length; i++) {
      if (color[i] === WHITE) visit(i);
    }
  }

  // --- Repositories --------------------------------------------------------

  registerRepository(raw: unknown, actor: Actor): Repository {
    const input = registerRepoInput.parse(raw);
    const now = this.clock.now();
    if (this.repos.findByName(input.name)) {
      throw new DispatchError("DUPLICATE", `Repository '${input.name}' already exists.`);
    }
    const repo: Repository = {
      id: newId(),
      name: input.name,
      local_path: input.local_path ?? null,
      remote_url: input.remote_url ?? null,
      default_branch: input.default_branch,
      stack: input.stack ?? null,
      risk_level: input.risk_level,
      test_command: input.test_command ?? null,
      lint_command: input.lint_command ?? null,
      coverage_command: input.coverage_command ?? null,
      hidden: 0,
      created_at: now,
      updated_at: now,
    };
    this.repos.insert(repo);
    writeEvent(this.db, {
      entity_type: "repository",
      entity_id: repo.id,
      actor,
      event_type: "repository.registered",
      payload: { name: repo.name },
    });
    return repo;
  }

  /**
   * WG-006: hide or un-hide a repo (by id or name). A hidden repo stays
   * registered and keeps all its links/scope mappings, but is excluded by default
   * from the dashboard surfaces (repo list, Factory Map unmapped repos, repo
   * pickers) — it reappears once un-hidden via the "Hidden repos" page or CLI.
   * Validates the repo exists; idempotent (setting the flag to its current value
   * is a no-op write that still returns the repo and emits no spurious error).
   */
  setRepoHidden(repoRef: string, hidden: boolean, actor: Actor): Repository {
    return inTransaction(this.db, () => {
      const repo = this.repos.findById(repoRef) ?? this.repos.findByName(repoRef);
      if (!repo) throw notFound("repository", repoRef);
      const already = repo.hidden === 1;
      if (already === hidden) {
        // Idempotent: nothing to change. Return the repo unchanged, no event.
        return repo;
      }
      const now = this.clock.now();
      this.repos.setHidden(repo.id, hidden, now);
      writeEvent(this.db, {
        entity_type: "repository",
        entity_id: repo.id,
        actor,
        event_type: hidden ? "repository.hidden" : "repository.unhidden",
        payload: { name: repo.name },
      });
      return { ...repo, hidden: hidden ? 1 : 0, updated_at: now };
    });
  }

  linkRepository(ticketId: string, repoName: string, role: string, actor: Actor): void {
    return inTransaction(this.db, () => {
      const ticket = this.tickets.findById(ticketId);
      if (!ticket) throw notFound("ticket", ticketId);
      const repo = this.repos.findByName(repoName) ?? this.repos.findById(repoName);
      if (!repo) throw notFound("repository", repoName);
      this.repos.linkTicket(ticket.id, repo.id, role, this.clock.now());
      writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.repo_linked",
        payload: { repo_id: repo.id, role },
      });
      // WG-001: if the repo is unmapped (no scope_repos rows), record an
      // implicit_repo scope so the ticket's product/system scope is never empty
      // just because the work targets a standalone single-repo. Mapped repos
      // surface their scope via the graph and don't need this.
      this.recordImplicitRepoScopes(ticket.id, repo.id, actor);
    });
  }

  /**
   * For each scope node a repo belongs to, do nothing — those scopes are mapped.
   * If the repo is UNMAPPED, ensure the ticket carries an `implicit_repo` scope
   * synthesised from the repo itself, modelled as a scope node of type
   * `external_dependency` named after the repo. Idempotent: re-linking the same
   * unmapped repo reuses the synthetic node (matched by name + type) rather than
   * creating a duplicate. Never overrides a human-set primary scope.
   */
  private recordImplicitRepoScopes(ticketId: string, repoId: string, actor: Actor): void {
    const scopes = this.scopeRepos.scopesForRepo(repoId);
    if (scopes.length > 0) return; // mapped — graph carries the scope.

    const repo = this.repos.findById(repoId);
    if (!repo) return;
    const syntheticName = `repo:${repo.name}`;
    const existing = this.scopeNodes
      .list()
      .find((n) => n.name === syntheticName && n.type === "external_dependency");
    const node =
      existing ??
      this.createScopeNode(
        {
          name: syntheticName,
          type: "external_dependency",
          description: `Implicit single-repo scope for unmapped repo '${repo.name}'.`,
        },
        actor,
      );
    if (this.ticketScopes.find(ticketId, node.id)) return;
    const now = this.clock.now();
    this.ticketScopes.upsert({
      ticket_id: ticketId,
      scope_node_id: node.id,
      relation: "implicit_repo",
      confidence: null,
      reasons_json: JSON.stringify([`unmapped repo '${repo.name}' targeted by ticket`]),
      created_at: now,
      updated_at: now,
    });
    writeEvent(this.db, {
      entity_type: "ticket",
      entity_id: ticketId,
      actor,
      event_type: "ticket.scope_linked",
      payload: { scope_node_id: node.id, relation: "implicit_repo" },
    });
  }

  // --- Ticket scope links (WG-001) -----------------------------------------

  /**
   * Link a ticket to a scope node with a relation. Upsert: re-linking the same
   * node updates its relation/confidence/reasons. Marking a link `primary` here
   * delegates to {@link setPrimaryScope} so the "at most one primary" invariant
   * holds. `implicit_repo` is reserved for the auto-link path and rejected here.
   */
  linkTicketScope(raw: unknown, actor: Actor): TicketScopeNode {
    const input = linkTicketScopeInput.parse(raw);
    if (input.relation === "implicit_repo") {
      throw new DispatchError(
        "VALIDATION_ERROR",
        "The 'implicit_repo' relation is recorded automatically and cannot be set manually.",
      );
    }
    if (input.relation === "primary") {
      this.setPrimaryScope(input.ticket_id, input.scope_node_id, actor);
      return this.ticketScopes.find(input.ticket_id, input.scope_node_id)!;
    }
    return inTransaction(this.db, () => {
      const ticket = this.resolveTicket(input.ticket_id);
      const node = this.scopeNodes.findById(input.scope_node_id);
      if (!node) throw notFound("scope_node", input.scope_node_id);
      const now = this.clock.now();
      const link: TicketScopeNode = {
        ticket_id: ticket.id,
        scope_node_id: node.id,
        relation: input.relation,
        confidence: input.confidence ?? null,
        reasons_json: input.reasons ? JSON.stringify(input.reasons) : null,
        created_at: now,
        updated_at: now,
      };
      this.ticketScopes.upsert(link);
      writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.scope_linked",
        payload: { scope_node_id: node.id, relation: link.relation },
      });
      return link;
    });
  }

  /**
   * Mark a scope node as the ticket's PRIMARY scope, demoting any existing
   * primary to 'secondary' first so at most one primary exists per ticket.
   * Creates the link if absent. Returns the resulting primary link.
   */
  setPrimaryScope(ticketRef: string, scopeNodeId: string, actor: Actor): TicketScopeNode {
    return inTransaction(this.db, () => {
      const ticket = this.resolveTicket(ticketRef);
      const node = this.scopeNodes.findById(scopeNodeId);
      if (!node) throw notFound("scope_node", scopeNodeId);
      const now = this.clock.now();
      this.ticketScopes.demotePrimaries(ticket.id, now);
      const existing = this.ticketScopes.find(ticket.id, node.id);
      const link: TicketScopeNode = {
        ticket_id: ticket.id,
        scope_node_id: node.id,
        relation: "primary",
        confidence: existing?.confidence ?? null,
        reasons_json: existing?.reasons_json ?? null,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      this.ticketScopes.upsert(link);
      writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.scope_primary_set",
        payload: { scope_node_id: node.id },
      });
      return link;
    });
  }

  /** All scope links for a ticket (primary first), joined to the node. */
  listTicketScopes(ticketRef: string): TicketScopeWithNode[] {
    const ticket = this.resolveTicket(ticketRef);
    return this.ticketScopes.listForTicket(ticket.id);
  }

  /** Remove a ticket↔scope link. */
  removeTicketScope(
    ticketRef: string,
    scopeNodeId: string,
    actor: Actor,
  ): { ticketId: string; scopeNodeId: string; eventId: string } {
    return inTransaction(this.db, () => {
      const ticket = this.resolveTicket(ticketRef);
      if (!this.ticketScopes.find(ticket.id, scopeNodeId)) {
        throw notFound("ticket_scope", `${ticket.id}/${scopeNodeId}`);
      }
      this.ticketScopes.delete(ticket.id, scopeNodeId);
      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.scope_unlinked",
        payload: { scope_node_id: scopeNodeId },
      });
      return { ticketId: ticket.id, scopeNodeId, eventId };
    });
  }

  /**
   * Compact scope summary for the MCP get_ticket payload: the primary scope (id +
   * name + type only) plus counts by relation. Deliberately omits confidence,
   * reasons and the full graph — the agent gets "what is the primary product area
   * and how many scopes are in play", not the internals. Mirrors the
   * eventProjection redaction discipline.
   */
  ticketScopeSummary(ticketRef: string): {
    primary: { id: string; name: string; type: string } | null;
    counts: Record<string, number>;
    total: number;
  } {
    const links = this.listTicketScopes(ticketRef);
    const counts: Record<string, number> = {};
    let primary: { id: string; name: string; type: string } | null = null;
    for (const l of links) {
      counts[l.relation] = (counts[l.relation] ?? 0) + 1;
      if (l.relation === "primary") primary = { id: l.id, name: l.name, type: l.type };
    }
    return { primary, counts, total: links.length };
  }

  // --- Ticket↔repo access boundaries (WG-002) ------------------------------

  /**
   * Set (upsert) the explicit access boundary for a ticket↔repo link. Creates the
   * link if absent. The `implicit_single_repo` relation is reserved for the
   * mono_fallback path; callers must use {@link applyMonoFallback} for it.
   */
  setTicketRepoAccess(raw: unknown, actor: Actor): TicketRepoAccessResult {
    // P0 authz: setting a repo access boundary on the PUBLIC surface GRANTS write
    // access on a ticket — a privilege escalation if an agent could grant itself
    // write. Only a human/admin may set the boundary directly (the dashboard's
    // API_ACTOR is human, the operator CLI runs as human; only an `agent`-type
    // actor is refused). The trusted INTERNAL caller (createEpic, which seeds the
    // initial repo link during agent-driven epic creation) goes through the
    // unguarded {@link applyTicketRepoAccess} instead, so that legitimate factory
    // flow is unaffected.
    if (actor.type !== "human" && actor.type !== "admin") {
      throw new DispatchError(
        "ACTOR_NOT_PERMITTED",
        "Only a human or admin may set a ticket's repo access boundary.",
        { actor_type: actor.type },
      );
    }
    return this.applyTicketRepoAccess(raw, actor);
  }

  /**
   * Unguarded core of {@link setTicketRepoAccess}. Trusted internal callers (epic
   * creation) use this to seed a repo link; the public method adds the human/admin
   * actor-type guard before delegating here.
   */
  private applyTicketRepoAccess(raw: unknown, actor: Actor): TicketRepoAccessResult {
    const input = setTicketRepoAccessInput.parse(raw);
    if (input.relation === "implicit_single_repo") {
      throw new DispatchError(
        "VALIDATION_ERROR",
        "The 'implicit_single_repo' relation is set via mono_fallback, not manually.",
        { relation: input.relation },
      );
    }
    return inTransaction(this.db, () => {
      const ticket = this.resolveTicket(input.ticket_id);
      const repo = this.repos.findById(input.repo_id) ?? this.repos.findByName(input.repo_id);
      if (!repo) throw notFound("repository", input.repo_id);
      const now = this.clock.now();
      this.repos.upsertAccess(
        {
          ticketId: ticket.id,
          repoId: repo.id,
          access: input.access,
          relation: input.relation,
          source: input.source,
          confidence: input.confidence ?? null,
          reasons: input.reasons ? JSON.stringify(input.reasons) : null,
        },
        now,
      );
      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.repo_access_set",
        payload: {
          repo_id: repo.id,
          access: input.access,
          relation: input.relation,
          source: input.source,
        },
      });
      return {
        ticketId: ticket.id,
        repoId: repo.id,
        access: input.access,
        relation: input.relation,
        eventId,
      };
    });
  }

  /**
   * The ticket's execution boundary, partitioned by access (WG-002). Only ACTIVE
   * relations (confirmed / implicit_single_repo) contribute to the write/read/test/
   * denied buckets; `suggested` and `rejected` links are surfaced separately and
   * never count as a write target. This is the accessor the runner/agent reads to
   * learn where it may write.
   */
  workPacketRepos(ticketRef: string): WorkPacketRepos {
    const ticket = this.resolveTicket(ticketRef);
    const links = this.repos.accessLinksForTicket(ticket.id);
    const out: WorkPacketRepos = {
      writeRepos: [],
      readOnlyRepos: [],
      testRepos: [],
      deniedRepos: [],
      suggestedRepos: [],
      rejectedRepos: [],
    };
    for (const link of links) {
      if (link.relation === "rejected") {
        out.rejectedRepos.push(link);
        continue;
      }
      if (link.relation === "suggested") {
        out.suggestedRepos.push(link);
        continue;
      }
      if (!isActiveTicketRepoRelation(link.relation)) {
        // context_only or any non-active relation: treat as read-only context.
        out.readOnlyRepos.push(link);
        continue;
      }
      switch (link.access) {
        case "write":
          out.writeRepos.push(link);
          break;
        case "read":
          out.readOnlyRepos.push(link);
          break;
        case "test":
          out.testRepos.push(link);
          break;
        case "none":
          out.deniedRepos.push(link);
          break;
      }
    }
    return out;
  }

  /**
   * Mono-fallback (WG-002): when a ticket's ONLY repo is unmapped (no scope-graph
   * mapping), promote that single repo to a confirmed write boundary with
   * source='mono_fallback' and relation='implicit_single_repo'. No-op (returns
   * `applied:false`) when the ticket has zero or multiple repos, or its single
   * repo is mapped into the graph. Idempotent.
   */
  applyMonoFallback(
    ticketRef: string,
    actor: Actor,
  ): { applied: boolean; ticketId: string; repoId?: string; reason?: string } {
    return inTransaction(this.db, () => {
      const ticket = this.resolveTicket(ticketRef);
      const links = this.repos.accessLinksForTicket(ticket.id);
      if (links.length !== 1) {
        return {
          applied: false,
          ticketId: ticket.id,
          reason: `mono_fallback requires exactly one repo (found ${links.length}).`,
        };
      }
      const only = links[0]!;
      if (this.scopeRepos.scopesForRepo(only.id).length > 0) {
        return {
          applied: false,
          ticketId: ticket.id,
          reason: "the single repo is mapped into the scope graph; mono_fallback does not apply.",
        };
      }
      const now = this.clock.now();
      this.repos.upsertAccess(
        {
          ticketId: ticket.id,
          repoId: only.id,
          access: "write",
          relation: "implicit_single_repo",
          source: "mono_fallback",
          confidence: null,
          reasons: JSON.stringify(["single unmapped repo promoted to write via mono_fallback"]),
        },
        now,
      );
      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.repo_access_set",
        payload: {
          repo_id: only.id,
          access: "write",
          relation: "implicit_single_repo",
          source: "mono_fallback",
        },
      });
      return { applied: true, ticketId: ticket.id, repoId: only.id, eventId } as {
        applied: boolean;
        ticketId: string;
        repoId?: string;
      };
    });
  }

  // --- Scope→repo suggestions (FG-005) -------------------------------------

  /**
   * Suggest likely repos for a ticket or a pre-create draft (FG-005). Advisory:
   * the result carries access/confidence/reasons but NEVER writes ticket_repos —
   * the caller confirms via setTicketRepoAccess (or applyMonoFallback for the
   * single-unmapped-repo `monoFallback` suggestion).
   *
   * Two input shapes:
   *  - `{ ticketId }` — resolves the ticket, derives its scope-node ids from the
   *    confirmed/primary/secondary/implicit_repo scope links, uses its
   *    title/description, and treats its existing ticket_repos as the selected
   *    repos (so a lone unmapped repo yields the mono-fallback suggestion).
   *  - `{ title?, description?, scopeNodeIds?, repoIds? }` — a pre-create draft.
   */
  suggestReposForTicket(raw: unknown, _actor: Actor): RepoSuggestion[] {
    const input = suggestReposInput.parse(raw);

    // Ticket form: a body carrying a ticket_id (id or number) is resolved into
    // the by-fields form. We accept it through the same schema so the REST/MCP
    // surface can pass `{ ticketId }`-style requests too.
    const ticketRef =
      (raw as { ticketId?: unknown; ticket_id?: unknown })?.ticketId ??
      (raw as { ticket_id?: unknown })?.ticket_id;
    if (typeof ticketRef === "string" && ticketRef.length > 0) {
      return this.suggestForExistingTicket(ticketRef);
    }

    const fields: SuggestByFields = {
      title: input.title,
      description: input.description,
      scopeNodeIds: input.scopeNodeIds,
    };
    return this.suggestions.suggest(fields, input.repoIds ?? []);
  }

  /** Derive the suggestion inputs from a live ticket and run the engine. */
  private suggestForExistingTicket(ticketRef: string): RepoSuggestion[] {
    const ticket = this.resolveTicket(ticketRef);
    // Scope nodes the ticket is actually anchored to. We exclude 'rejected' and
    // the synthetic 'implicit_repo' external_dependency nodes from the graph walk
    // (the latter has no scope_repos), but keep primary/secondary/suggested.
    const scopeNodeIds = this.ticketScopes
      .listForTicket(ticket.id)
      .filter((s) => s.relation !== "rejected" && s.relation !== "implicit_repo")
      .map((s) => s.id);
    // Repos already on the ticket — used for the mono-fallback detection.
    const selectedRepoIds = this.repos.listForTicket(ticket.id).map((r) => r.id);
    return this.suggestions.suggest(
      {
        title: ticket.title,
        description: ticket.description,
        scopeNodeIds,
      },
      selectedRepoIds,
    );
  }

  /**
   * Report whether a ticket passes its policy pack's readiness gate (WG-004) AND
   * is dependency-clear (EP-001), WITHOUT mutating it. Runs the same
   * TransitionService.preview the real mark-ready uses, so the policy verdict
   * matches the gate exactly. Layered on top of that, an unsatisfied dependency
   * (a depended-on ticket not yet `done`) adds a `DEPENDENCY_BLOCKED` blocker and
   * forces `ready:false` — even for a ticket already in `ready` status — so the
   * runner/UI sees the hard gate that stops a claim.
   */
  claimability(ticketRef: string): ClaimabilityResult {
    const ticket = this.resolveTicket(ticketRef);

    // EP-001 dependency gate — independent of (and ANDed with) the policy gate.
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
      // No readiness gate for this transition (shouldn't happen for 'ready').
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

  // --- Factory Map: scope nodes (FG-001) -----------------------------------

  /**
   * Create a scope node (product/system area). Name is NOT unique — the same
   * name may exist under different types — so this only enforces the type enum
   * (via the Zod schema) before inserting.
   */
  createScopeNode(raw: unknown, actor: Actor): ScopeNode {
    const input = createScopeNodeInput.parse(raw);
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      const node: ScopeNode = {
        id: newId(),
        name: input.name,
        type: input.type,
        description: input.description ?? null,
        risk_level: input.risk_level,
        owner: input.owner ?? null,
        tags_json: input.tags ? JSON.stringify(input.tags) : null,
        lore_tags_json: input.lore_tags ? JSON.stringify(input.lore_tags) : null,
        created_at: now,
        updated_at: now,
      };
      this.scopeNodes.insert(node);
      writeEvent(this.db, {
        entity_type: "scope_node",
        entity_id: node.id,
        actor,
        event_type: "scope_node.created",
        payload: { name: node.name, type: node.type },
      });
      return node;
    });
  }

  /** Patch a scope node by id. Only the supplied fields are written. */
  updateScopeNode(nodeId: string, raw: unknown, actor: Actor): ScopeNode {
    const input = updateScopeNodeInput.parse(raw);
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      const existing = this.scopeNodes.findById(nodeId);
      if (!existing) throw notFound("scope_node", nodeId);
      const fields: Partial<ScopeNode> = {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.risk_level !== undefined ? { risk_level: input.risk_level } : {}),
        ...(input.owner !== undefined ? { owner: input.owner } : {}),
        ...(input.tags !== undefined ? { tags_json: JSON.stringify(input.tags) } : {}),
        ...(input.lore_tags !== undefined
          ? { lore_tags_json: JSON.stringify(input.lore_tags) }
          : {}),
      };
      this.scopeNodes.update(nodeId, fields, now);
      writeEvent(this.db, {
        entity_type: "scope_node",
        entity_id: nodeId,
        actor,
        event_type: "scope_node.updated",
        payload: { fields: Object.keys(fields) },
      });
      return this.scopeNodes.findById(nodeId)!;
    });
  }

  /** All scope nodes, ordered by type then name. Empty when none exist. */
  listScopeNodes(): ScopeNode[] {
    return this.scopeNodes.list();
  }

  /** A scope node plus its linked repos (with relation + default access). */
  getScopeNode(nodeId: string): ScopeNodeView {
    const node = this.scopeNodes.findById(nodeId);
    if (!node) throw notFound("scope_node", nodeId);
    return { node, repos: this.scopeRepos.reposForScope(nodeId) };
  }

  /**
   * Delete a scope node. Blocked (SCOPE_NODE_IN_USE) while it has any scope_repos
   * rows — and any ticket_scope_nodes rows, guarded defensively in case that
   * table (WG-001) exists. Edges referencing the node CASCADE away.
   */
  deleteScopeNode(nodeId: string, actor: Actor): { nodeId: string; eventId: string } {
    return inTransaction(this.db, () => {
      const node = this.scopeNodes.findById(nodeId);
      if (!node) throw notFound("scope_node", nodeId);
      const repoLinks = this.scopeRepos.countForNode(nodeId);
      if (repoLinks > 0) {
        throw new DispatchError(
          "SCOPE_NODE_IN_USE",
          `Scope node '${node.name}' has ${repoLinks} linked repo(s); unlink them before deleting.`,
          { node_id: nodeId, repo_links: repoLinks },
        );
      }
      const ticketLinks = this.countTicketScopeLinks(nodeId);
      if (ticketLinks > 0) {
        throw new DispatchError(
          "SCOPE_NODE_IN_USE",
          `Scope node '${node.name}' is linked to ${ticketLinks} ticket(s); unlink them before deleting.`,
          { node_id: nodeId, ticket_links: ticketLinks },
        );
      }
      this.scopeNodes.delete(nodeId);
      const eventId = writeEvent(this.db, {
        entity_type: "scope_node",
        entity_id: nodeId,
        actor,
        event_type: "scope_node.deleted",
        payload: { name: node.name },
      });
      return { nodeId, eventId };
    });
  }

  /** Count of ticket↔scope links referencing a node — blocks node deletion. */
  private countTicketScopeLinks(nodeId: string): number {
    return this.ticketScopes.countForNode(nodeId);
  }

  // --- Factory Map: scope edges (FG-001) -----------------------------------

  /**
   * Create a graph edge between two scope nodes. Rejects self-edges and (for the
   * `contains` relation) cycles, so containment stays a DAG. Relations beyond the
   * v1 set (contains / depends_on) require `advanced: true`.
   */
  createScopeEdge(raw: unknown, actor: Actor): ScopeEdge {
    const input = createScopeEdgeInput.parse(raw);
    if (input.from_node_id === input.to_node_id) {
      throw new DispatchError("INVALID_EDGE", "A scope edge cannot point a node at itself.", {
        node_id: input.from_node_id,
      });
    }
    if (
      !input.advanced &&
      !(SCOPE_EDGE_RELATIONS_V1 as readonly string[]).includes(input.relation)
    ) {
      throw new DispatchError(
        "ADVANCED_RELATION_REQUIRED",
        `Relation '${input.relation}' is advanced; pass advanced:true to use it (v1 exposes ${SCOPE_EDGE_RELATIONS_V1.join(", ")}).`,
        { relation: input.relation },
      );
    }
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      const from = this.scopeNodes.findById(input.from_node_id);
      if (!from) throw notFound("scope_node", input.from_node_id);
      const to = this.scopeNodes.findById(input.to_node_id);
      if (!to) throw notFound("scope_node", input.to_node_id);
      if (this.scopeEdges.exists(input.from_node_id, input.to_node_id, input.relation)) {
        throw new DispatchError("DUPLICATE", "That scope edge already exists.", {
          from_node_id: input.from_node_id,
          to_node_id: input.to_node_id,
          relation: input.relation,
        });
      }
      if (
        input.relation === "contains" &&
        this.containsCycleWouldForm(input.to_node_id, input.from_node_id)
      ) {
        throw new DispatchError(
          "INVALID_EDGE",
          "This 'contains' edge would create a containment cycle.",
          { from_node_id: input.from_node_id, to_node_id: input.to_node_id },
        );
      }
      const edge: ScopeEdge = {
        id: newId(),
        from_node_id: input.from_node_id,
        to_node_id: input.to_node_id,
        relation: input.relation,
        confidence: input.confidence ?? null,
        reasons_json: input.reasons ? JSON.stringify(input.reasons) : null,
        created_at: now,
      };
      this.scopeEdges.insert(edge);
      writeEvent(this.db, {
        entity_type: "scope_node",
        entity_id: input.from_node_id,
        actor,
        event_type: "scope_edge.created",
        payload: { edge_id: edge.id, to_node_id: input.to_node_id, relation: input.relation },
      });
      return edge;
    });
  }

  /**
   * Walk `contains` edges from `startNodeId`; true if `targetNodeId` is reachable
   * (so adding target -contains-> start would close a loop). Guards against the
   * graph itself containing a pre-existing cycle via a visited set.
   */
  private containsCycleWouldForm(startNodeId: string, targetNodeId: string): boolean {
    const seen = new Set<string>();
    const stack = [startNodeId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === targetNodeId) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      const children = this.db
        .prepare(
          `SELECT to_node_id FROM scope_edges WHERE relation = 'contains' AND from_node_id = ?`,
        )
        .all(current) as Array<{ to_node_id: string }>;
      for (const child of children) stack.push(child.to_node_id);
    }
    return false;
  }

  /** Graph edges, optionally filtered to those touching `nodeId` (either end). */
  listScopeEdges(nodeId?: string): ScopeEdge[] {
    return this.scopeEdges.list(nodeId);
  }

  deleteScopeEdge(edgeId: string, actor: Actor): { edgeId: string; eventId: string } {
    return inTransaction(this.db, () => {
      const edge = this.scopeEdges.findById(edgeId);
      if (!edge) throw notFound("scope_edge", edgeId);
      this.scopeEdges.delete(edgeId);
      const eventId = writeEvent(this.db, {
        entity_type: "scope_node",
        entity_id: edge.from_node_id,
        actor,
        event_type: "scope_edge.deleted",
        payload: { edge_id: edgeId, relation: edge.relation },
      });
      return { edgeId, eventId };
    });
  }

  // --- Factory Map: scope↔repo associations (FG-002) -----------------------

  /**
   * Link a repo into a scope node with a relation + default access. A repo may
   * be linked to many scope nodes; the (scope, repo, relation) triple is unique.
   */
  linkScopeRepo(raw: unknown, actor: Actor): ScopeRepo {
    const input = linkScopeRepoInput.parse(raw);
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      const node = this.scopeNodes.findById(input.scope_node_id);
      if (!node) throw notFound("scope_node", input.scope_node_id);
      const repo = this.repos.findById(input.repo_id) ?? this.repos.findByName(input.repo_id);
      if (!repo) throw notFound("repository", input.repo_id);
      if (this.scopeRepos.exists(node.id, repo.id, input.relation)) {
        throw new DispatchError(
          "DUPLICATE",
          "That repo is already linked to this scope node with that relation.",
          { scope_node_id: node.id, repo_id: repo.id, relation: input.relation },
        );
      }
      const link: ScopeRepo = {
        id: newId(),
        scope_node_id: node.id,
        repo_id: repo.id,
        relation: input.relation,
        default_access: input.default_access,
        confidence: input.confidence ?? null,
        role_description: input.role_description ?? null,
        reasons_json: input.reasons ? JSON.stringify(input.reasons) : null,
        created_at: now,
        updated_at: now,
      };
      this.scopeRepos.insert(link);
      writeEvent(this.db, {
        entity_type: "scope_node",
        entity_id: node.id,
        actor,
        event_type: "scope_repo.linked",
        payload: {
          association_id: link.id,
          repo_id: repo.id,
          relation: link.relation,
          default_access: link.default_access,
        },
      });
      return link;
    });
  }

  /** Patch a scope↔repo association (access / confidence / role / reasons). */
  updateScopeRepo(associationId: string, raw: unknown, actor: Actor): ScopeRepo {
    const input = updateScopeRepoInput.parse(raw);
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      const existing = this.scopeRepos.findById(associationId);
      if (!existing) throw notFound("scope_repo", associationId);
      const fields: Partial<ScopeRepo> = {
        ...(input.default_access !== undefined ? { default_access: input.default_access } : {}),
        ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
        ...(input.role_description !== undefined
          ? { role_description: input.role_description }
          : {}),
        ...(input.reasons !== undefined ? { reasons_json: JSON.stringify(input.reasons) } : {}),
      };
      this.scopeRepos.update(associationId, fields, now);
      writeEvent(this.db, {
        entity_type: "scope_node",
        entity_id: existing.scope_node_id,
        actor,
        event_type: "scope_repo.updated",
        payload: { association_id: associationId, fields: Object.keys(fields) },
      });
      return this.scopeRepos.findById(associationId)!;
    });
  }

  /** Remove a scope↔repo association by its id. */
  unlinkScopeRepo(associationId: string, actor: Actor): { associationId: string; eventId: string } {
    return inTransaction(this.db, () => {
      const existing = this.scopeRepos.findById(associationId);
      if (!existing) throw notFound("scope_repo", associationId);
      this.scopeRepos.delete(associationId);
      const eventId = writeEvent(this.db, {
        entity_type: "scope_node",
        entity_id: existing.scope_node_id,
        actor,
        event_type: "scope_repo.unlinked",
        payload: { association_id: associationId, repo_id: existing.repo_id },
      });
      return { associationId, eventId };
    });
  }

  /** Repos linked to a scope node, with relation + default access. */
  reposForScope(nodeId: string): ScopeRepoWithRepo[] {
    if (!this.scopeNodes.findById(nodeId)) throw notFound("scope_node", nodeId);
    return this.scopeRepos.reposForScope(nodeId);
  }

  /** Scope nodes a repo belongs to, with relation + default access. */
  scopesForRepo(repoId: string): RepoScopeWithNode[] {
    const repo = this.repos.findById(repoId) ?? this.repos.findByName(repoId);
    if (!repo) throw notFound("repository", repoId);
    return this.scopeRepos.scopesForRepo(repo.id);
  }

  /**
   * Repositories with NO scope association — implicit single-repo scopes. WG-006:
   * hidden repos are excluded by default (so a hidden repo drops off the Factory
   * Map's unmapped list); pass `includeHidden` for the full set.
   */
  listUnmappedRepos(includeHidden = false): Repository[] {
    return this.scopeRepos.listUnmappedRepos(includeHidden);
  }

  // --- Decisions -----------------------------------------------------------

  createDecision(
    input: { title: string; question: string; severity?: DecisionSeverity; ticketId?: string },
    actor: Actor,
  ): Decision {
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      const decision: Decision = {
        id: newId(),
        title: input.title,
        question: input.question,
        rationale: null,
        status: input.severity === "human_required" ? "human_required" : "requested",
        decision_type: "product",
        severity: input.severity ?? "human_preferred",
        proposed_answer: null,
        proposed_by: null,
        confidence: null,
        resolved_answer: null,
        resolved_by: null,
        resolved_at: null,
        memory_record_id: null,
        created_at: now,
        updated_at: now,
      };
      this.decisions.insert(decision);
      if (input.ticketId) {
        this.decisions.link(input.ticketId, decision.id, "blocks", now);
      }
      writeEvent(this.db, {
        entity_type: "decision",
        entity_id: decision.id,
        actor,
        event_type: "decision.created",
        payload: { title: decision.title, severity: decision.severity },
      });
      return decision;
    });
  }

  listPendingDecisions(): Decision[] {
    return this.decisions.listPending();
  }

  /**
   * Resolve a decision (human surface): set its terminal status + resolved_*,
   * record the answer/rationale and append an event. Refuses to re-resolve an
   * already-terminal decision.
   */
  resolveDecision(input: ResolveDecisionInput, actor: Actor): Decision {
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      const decision = this.decisions.findById(input.decisionId);
      if (!decision) throw notFound("decision", input.decisionId);
      if (
        decision.status === "accepted" ||
        decision.status === "rejected" ||
        decision.status === "superseded"
      ) {
        throw new DispatchError(
          "STATE_CONFLICT",
          `Decision is already '${decision.status}' and cannot be resolved again.`,
          { status: decision.status },
        );
      }
      const ok = this.decisions.resolve(
        decision.id,
        input.status,
        input.answer ?? null,
        input.rationale ?? null,
        actor.id ?? actor.type,
        now,
      );
      if (!ok) {
        throw new DispatchError("CONCURRENCY_CONFLICT", "Decision changed concurrently; retry.");
      }
      writeEvent(this.db, {
        entity_type: "decision",
        entity_id: decision.id,
        actor,
        event_type: "decision.resolved",
        payload: { status: input.status, answer: input.answer ?? null },
      });
      return this.decisions.findById(decision.id)!;
    });
  }

  // --- Convenience transitions --------------------------------------------

  markReady(ticketId: string, actor: Actor): TransitionResult {
    return this.transitions.transition({
      ticketId,
      actor,
      toStatus: "ready",
      reason: "mark ready",
    });
  }

  /**
   * Human/admin board move: drag a ticket card into another status column (or
   * pick a target from the card's status menu). The headline case is un-readying
   * a ticket — `ready -> draft` — which has no other path on the board.
   *
   * `target` is either a concrete {@link TicketStatus} or a {@link BoardColumn}
   * key (the column the card was dropped into); a column key is resolved to its
   * canonical status (e.g. column "in_progress" -> status "in_progress").
   *
   * This is a thin, intentful wrapper over {@link TransitionService.transition},
   * NOT a bypass: the move is validated against the same ALLOWED state machine
   * and policy gates as every other transition. An illegal board move (e.g.
   * dropping a `done` card on Draft, or any move that would touch a claim) is
   * REJECTED with `ILLEGAL_TRANSITION`; a no-op drop (same column) with `NO_OP`.
   * The `claimed`/`in_progress` collapse means the "in_progress" column maps to
   * `in_progress`, which is only reachable from `claimed` — so a human can never
   * conjure a claim by dragging, the move is simply rejected as illegal.
   */
  moveTicket(ticketRef: string, target: string, actor: Actor): TransitionResult {
    const ticket = this.resolveTicket(ticketRef);
    const toStatus = resolveMoveTarget(target);
    return this.transitions.transition({
      ticketId: ticket.id,
      actor,
      toStatus,
      reason: "board_move",
      // Pin the expected source so a stale board (card moved out from under the
      // drag) fails cleanly with STATE_CONFLICT rather than silently moving a
      // ticket the human is no longer looking at.
      expectedFromStatus: ticket.status,
    });
  }

  /**
   * Human review approval: `in_review -> ready_for_merge` (NOT `done`). The human
   * has approved the diff; the merge runner now does the git merge and, once it
   * lands, calls {@link markMerged} (`ready_for_merge -> done`). So `done` means
   * the work is ACTUALLY merged, never "approved but the merge was partial/failed".
   * The done-gate policy (AC satisfied, PR/diff present) is evaluated on THIS
   * transition — it is the human sign-off.
   */
  approveReview(ticketRef: string, actor: Actor): TransitionResult {
    // P0 authz: review approval is the human sign-off that releases a delivery to
    // merge. By DEFAULT only a human/admin may approve — an `agent`-type actor can
    // never approve its own work, so the human gate is a real boundary. The
    // dashboard's API_ACTOR is `{type:"human"}` and the operator CLI runs as human,
    // so both always pass.
    //
    // OPT-IN "yolo" autonomy: an operator who wants a fully hands-off factory can
    // set DISPATCH_ALLOW_AGENT_APPROVE=1, which also lets an `agent` actor approve.
    // That deliberately removes the human gate — their machine, their call (see
    // SECURITY.md; pairs with the runner's MERGE_ON_AGENT_REVIEW). Default-off keeps
    // the gate intact.
    const agentApproveAllowed =
      actor.type === "agent" && process.env.DISPATCH_ALLOW_AGENT_APPROVE === "1";
    if (actor.type !== "human" && actor.type !== "admin" && !agentApproveAllowed) {
      throw new DispatchError(
        "ACTOR_NOT_PERMITTED",
        "Only a human or admin may approve a review (set DISPATCH_ALLOW_AGENT_APPROVE=1 to allow autonomous agent approval).",
        { actor_type: actor.type },
      );
    }
    const ticket = this.resolveTicket(ticketRef);
    // BBT-001: when the independent-testing lane is ON (GAFFER_TESTING) AND this
    // ticket is eligible (`can_be_tested`), review approval routes through the
    // INDEPENDENT tester (`in_review -> in_testing`) instead of straight to merge.
    // Otherwise — toggle off OR not testable — keep today's behaviour exactly
    // (`in_review -> ready_for_merge`). The done-gate policy still fires later, when
    // the lane exits to `ready_for_merge` (tester pass) or directly here.
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
   * BBT-001 toggle accessor — overridable per-instance for tests. Defaults to the
   * `GAFFER_TESTING` env read via {@link isTestingEnabled}.
   */
  private testingEnabled(): boolean {
    return this.testingEnabledOverride ?? isTestingEnabled();
  }

  /**
   * The independent black-box tester PASSED: the tests it wrote from the
   * test_contract + acceptance criteria all pass, so the delivery may proceed to
   * merge (`in_testing -> ready_for_merge`). The done-gate policy fires on THIS
   * transition (AC satisfied, PR/diff present) exactly as it would have on a direct
   * approval, so testing never weakens the merge gate.
   *
   * A `tester`-role agent (or any non-merging actor) records this; like the
   * reviewer it CANNOT approve or merge — it can only report the test verdict. The
   * actual merge stays the guarded `mark-merged` system path. `summary` is recorded
   * as a `test_output` evidence row so the passing result is visible in review.
   */
  testerPass(
    ticketRef: string,
    input: { summary: string; uri?: string },
    actor: Actor,
  ): TransitionResult {
    // No actor-type gate beyond the structural one: a tester (agent), or a
    // human/admin/system recording on its behalf, may report the verdict — but the
    // ACTUAL merge stays the guarded system/admin-only `mark-merged` path, so a
    // tester can never approve+merge its own verdict. That structural gate is the
    // boundary, mirroring how an agent reviewer cannot approve.
    const summary = input.summary.trim();
    if (summary.length === 0) {
      throw new DispatchError("VALIDATION_ERROR", "A test-result summary is required.");
    }
    return inTransaction(this.db, () => {
      const ticket = this.resolveTicket(ticketRef);
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
        // Provenance: capture WHO produced the verdict (derived from the actor type)
        // so a later reviewer sees "tests passed — by <agent|human|system|stub>" on
        // the dashboard instead of an unattributed pass.
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
   * The independent black-box tester FAILED: a test it wrote from the contract +
   * acceptance criteria does NOT pass — the implementation satisfies its own tests
   * but not the AC. The ticket goes back to `refining` with the failing test as
   * rejection evidence, REUSING the reject path (AC reset, attempt bump + retry-cap
   * park, review feedback) so a tester failure is handled exactly like a review
   * rejection. The `summary` (the failing test / why) becomes the rejection reason
   * and is recorded as a `test_output` evidence row.
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
      const ticket = this.resolveTicket(ticketRef);
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
        // Provenance: see testerPass — record who produced the FAIL verdict.
        payload_json: JSON.stringify({ verdict: "fail", provenance: testerProvenance(actor) }),
        created_by: actor.id ?? actor.type,
        created_at: now,
      });

      // Reuse the reject machinery: attempt bump + retry-cap park, AC reset, review
      // feedback. A cap-reached failure parks to `blocked` instead of re-queuing.
      const nextAttempt = ticket.attempt_count + 1;
      const capReached = nextAttempt >= this.maxAttempts;
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
      this.resetAcceptanceCriteria(ticket.id, actor);
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

  // --- Black-box testing handover (BBT-001) --------------------------------

  /**
   * Set (or clear) a ticket's `can_be_tested` eligibility flag — the gate that lets
   * review approval route through the independent testing lane. Set by the PO /
   * clarify / reviewer once an observable boundary may have changed.
   *
   * NO actor gate, by design and fail-safe: marking a ticket testable only ADDS a
   * scrutiny step (it routes a future review approval through the independent tester
   * BEFORE merge) — it can never bypass a gate or grant any access. The worst an
   * agent can do by setting it is cause MORE testing, never less. Contrast
   * {@link setTicketRepoAccess}, which GRANTS write access and so is human/admin-only.
   */
  setTestable(
    ticketRef: string,
    canBeTested: boolean,
    actor: Actor,
  ): { ticketId: string; canBeTested: boolean; eventId: string } {
    // No actor-type gate: marking a ticket testable only ADDS scrutiny (it routes a
    // future approval through the independent tester) — it can never bypass a gate
    // or grant access, so it is fail-safe for any actor (PO / clarify / reviewer,
    // human or agent) to set. Contrast setTicketRepoAccess, which GRANTS write and
    // so is human/admin-only.
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

  /**
   * Record (replace) a ticket's test_contract — the testing handover artifact the
   * tester reads to stand the system up and probe the changed boundaries WITHOUT
   * the diff. Validated by {@link setTestContractInput} (a zod schema). Stored as
   * JSON on the ticket. Returns the parsed contract.
   */
  setTestContract(ticketRef: string, raw: unknown, actor: Actor): TestContract {
    const input = setTestContractInput.parse(raw);
    // Single choke point for the CLI, MCP, and REST write paths: reject a contract
    // that leaks an implementation pointer (branch name, PR/commit URL, bare commit
    // hash, a `diff`/`branch_name` leakage token, or "changed X to Y" narration)
    // BEFORE it is persisted. The lane's invariant is "the tester never sees the
    // diff"; this guards the prose path the runner can't (the runner already omits
    // the diff — but a sloppy contract could smuggle breadcrumbs in its text).
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

  /** Read a ticket's parsed test_contract, or null when none is recorded. */
  getTestContract(ticketRef: string): TestContract | null {
    const ticket = this.resolveTicket(ticketRef);
    return parseTestContract(ticket.test_contract);
  }

  /**
   * MERGE-COMPLETE: mark an approved-and-merging ticket actually merged
   * (`ready_for_merge -> done`). This is the merge runner's callback after the git
   * merge of the delivery branch landed cleanly. SYSTEM/admin only — a normal user
   * or a board-drag can never fake "merged" (the guarded `markMerged` flag is
   * required and the board-move path never sets it). The matching CLI is
   * `wg ticket mark-merged <number> --as system`.
   */
  markMerged(ref: string, actor: Actor): TransitionResult {
    if (actor.type !== "system" && actor.type !== "admin") {
      throw new DispatchError(
        "ACTOR_NOT_PERMITTED",
        "Only a system or admin actor may mark a ticket merged.",
        { actor_type: actor.type },
      );
    }
    const ticket = this.resolveTicket(ref);
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
   * Re-open a `done` ticket for review (`done -> in_review`) after the auto-merge
   * loop hit a CONFLICT and a resolver agent committed a resolution ON the delivery
   * branch. This is the runner's re-approval callback: a human re-reviews the
   * RESOLVED diff (the same Review surface, now showing the resolved branch) and
   * re-approves, after which a later merge lands cleanly.
   *
   * SYSTEM/admin only — a normal user can never reopen a closed ticket this way
   * (the board-move path rejects `done -> in_review`). Records the `resolution`
   * summary as a `manual_note` delivery-artifact evidence row so it's visible in
   * review, and emits a `ticket.reopened_for_review` event carrying a
   * `merge_conflict_resolved` flag the UI surfaces as a "re-approve" banner.
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
      const ticket = this.resolveTicket(ref);
      // Reopen-for-review is reachable from a merged `done` ticket OR from a
      // still-merging `ready_for_merge` ticket (the conflict the resolver fixed was
      // hit during the merge). Anything else is not a reopenable state.
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
      // Persist the resolver's summary as a visible delivery-artifact note so the
      // reviewer reads WHAT was resolved alongside the resolved diff.
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
   * Human review rejection. A delivery rejected at review can be:
   *
   *  - sent back for rework (`refining` — the default): a human triages the
   *    rejection reason before the ticket re-enters the delivery queue, so there
   *    is no blind retry. `ready` is still accepted for callers that want the old
   *    skip-triage behaviour.
   *  - abandoned (`cancelled` — the won't-do bucket): the ticket will NOT be
   *    built. This is the one-step "reject → won't do" reviewer affordance.
   *
   * In every case the ticket's acceptance criteria are reset to NOT satisfied:
   * the ACs the now-rejected delivery marked satisfied are stale and misleading,
   * so a rejected ticket shows 0/N satisfied again. An optional `reason` is
   * recorded on the transition event so the rationale is auditable. Runs in one
   * transaction so the status move and the AC reset commit together.
   *
   * Reachable from `in_review` AND from `ready_for_merge` (a human can change
   * their mind PRE-merge: send the approved-and-merging ticket back for rework or
   * abandon it). Note `ready_for_merge -> ready` is NOT a legal transition, so
   * rework from a merging ticket must target `refining` (or `cancelled`).
   */
  rejectReview(
    ticketRef: string,
    to: "ready" | "refining" | "cancelled",
    actor: Actor,
    reason?: string,
  ): TransitionResult {
    return inTransaction(this.db, () => {
      const ticket = this.resolveTicket(ticketRef);
      if (ticket.status !== "in_review" && ticket.status !== "ready_for_merge") {
        throw new DispatchError(
          "ILLEGAL_TRANSITION",
          "Only an in-review or merging ticket can be rejected.",
          { from: ticket.status, to },
        );
      }
      const resolvedReason = reason && reason.trim().length > 0 ? reason : "review_rejected";

      // P1 retry-cap: abandoning to `cancelled` (won't-do) is terminal — it never
      // re-enters the queue, so it neither increments the attempt counter nor is
      // capped. A reject back into the queue (`ready`/`refining`) IS a retry: bump
      // attempt_count and, once it reaches the cap, PARK to `blocked` (needs-human)
      // instead of re-queuing the ticket to be re-delivered forever.
      const isRequeue = to === "ready" || to === "refining";
      const nextAttempt = isRequeue ? ticket.attempt_count + 1 : ticket.attempt_count;
      const capReached = isRequeue && nextAttempt >= this.maxAttempts;
      const target: TicketStatus = capReached ? "blocked" : to;

      const result = this.transitions.transition({
        ticketId: ticket.id,
        actor,
        toStatus: target,
        reason: capReached ? `retry_cap_reached:${resolvedReason}` : resolvedReason,
        expectedFromStatus: ticket.status,
        // Carry the incremented attempt counter through the same guarded update.
        ...(isRequeue ? { patch: { attempt_count: nextAttempt } } : {}),
        // Abandoning at review is the guarded won't-do path.
        ...(to === "cancelled" ? { wontDo: true } : {}),
        // Parking past the cap is the guarded retry-cap path.
        ...(capReached ? { park: true } : {}),
      });
      if (capReached) {
        // Make the park auditable + visible: why the ticket needs a human now.
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
      }
      this.resetAcceptanceCriteria(ticket.id, actor);
      // WG-049: persist the rejection feedback on the ticket so the re-claiming
      // agent (and the board) sees WHY it bounced. Cleared when it re-enters
      // `in_review` (see TransitionService) so stale feedback never shows current.
      const feedback: ReviewFeedback = {
        reason: resolvedReason,
        reviewer: actor.id ?? null,
        at: this.clock.now(),
      };
      this.tickets.setReviewFeedback(ticket.id, JSON.stringify(feedback));
      return result;
    });
  }

  /**
   * Reset every acceptance criterion on a ticket back to `pending` (NOT satisfied)
   * and record an auditable `ticket.acceptance_criteria_reset` event. Wired into
   * the reject/won't-do paths so a rejected ticket no longer carries the satisfied
   * stamps from the delivery that was just thrown away. Safe to call when the
   * ticket has no ACs (no-op event still recorded for the audit trail).
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

  /**
   * Mark a ticket "won't do" (terminal `cancelled` bucket): the work will NOT be
   * built. A deliberate, guarded move — it is rejected for in-flight/claimed
   * tickets (only `draft`/`refining`/`ready`/`blocked`/`in_review`/`failed` can be
   * abandoned, never `claimed`/`in_progress`/`done`) and never triggered by a
   * stray board-drag (the won't-do flag is required). Resets the ticket's ACs to
   * not-satisfied so a reopened ticket starts clean. Reversible via
   * {@link reopenFromWontDo}.
   */
  wontDo(ref: string, actor: Actor, reason?: string): TransitionResult {
    return inTransaction(this.db, () => {
      const ticket = this.resolveTicket(ref);
      const result = this.transitions.transition({
        ticketId: ticket.id,
        actor,
        toStatus: "cancelled",
        reason: reason && reason.trim().length > 0 ? reason : "wont_do",
        expectedFromStatus: ticket.status,
        wontDo: true,
      });
      this.resetAcceptanceCriteria(ticket.id, actor);
      return result;
    });
  }

  /**
   * Reopen a won't-do (`cancelled`) ticket back into the pipeline. Defaults to
   * `refining` (triage the abandonment first), but `draft` is allowed for a clean
   * restart. Neither target holds a claim, so reopening can never resurrect stale
   * in-flight work. The reverse of {@link wontDo}.
   */
  reopenFromWontDo(ref: string, to: "refining" | "draft", actor: Actor): TransitionResult {
    const ticket = this.resolveTicket(ref);
    return this.transitions.transition({
      ticketId: ticket.id,
      actor,
      toStatus: to,
      reason: "reopened_from_wont_do",
      expectedFromStatus: "cancelled",
    });
  }

  // --- Agents + claims (M2) ------------------------------------------------

  registerAgent(input: RegisterAgentInput, actor: Actor): Agent {
    return this.claims.registerAgent(input, actor);
  }

  claimNextTicket(input: ClaimNextInput, actor: Actor): ClaimResult | null {
    return this.claims.claimNextTicket(input, actor);
  }

  /**
   * Claim a CHOSEN ticket (by id or number) rather than the next ready one.
   * Applies the same eligibility rules as `claimNextTicket` and the atomic claim;
   * throws a structured `TICKET_NOT_CLAIMABLE`/`NOT_FOUND` rather than silently
   * claiming a different ticket. Mirrors the runner's preselect-then-claim flow.
   */
  claimTicket(raw: unknown, actor: Actor): ClaimResult {
    const input = claimTicketInput.parse(raw);
    const ticket = this.resolveTicket(input.ticket_id);
    return this.claims.claimTicket(
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
   * Record where a ticket was delivered: persist `branch_name`/`pr_url` onto the
   * ticket and emit a `ticket.delivery_recorded` event carrying optional
   * `commit`/`diff_summary`. Claim-scoped for agents — a token matching the
   * ticket's active claim is required; human/admin/system may record tokenlessly.
   * Lets reviewers read the branch/PR from Dispatch rather than grepping.
   */
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

  // --- Per-repo delivery artifacts (WG-005) --------------------------------

  /**
   * Record (upsert) WHERE a single repo's slice of a ticket was delivered: its
   * branch, commit, PR, a delivery status and an optional evidence pointer. One
   * row per (ticket, repo) — a single-repo ticket yields one row; a multi-repo
   * ticket records one per write repo.
   *
   * REJECTS (DispatchError REPO_NOT_LINKED) when the repo is NOT linked to the
   * ticket via ticket_repos: a delivery can only be recorded against a repo that
   * is part of the ticket's execution boundary. `repo_id` accepts an id or name.
   *
   * The ticket's top-level branch_name/pr_url (the WG summary pointer) is left
   * untouched — this table is the per-repo detail, not a replacement.
   */
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
          // Default a brand-new row to 'not_started'; an existing row keeps its
          // status unless the caller explicitly supplies a new one.
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

  /** All per-repo delivery rows for a ticket (joined to the repo name). */
  listRepoDeliveries(ticketRef: string): TicketRepoDeliveryWithRepo[] {
    const ticket = this.resolveTicket(ticketRef);
    return this.repoDeliveries.listForTicket(ticket.id);
  }

  /**
   * Grant a persisted human ready-approval for a ticket (the `regulated` pack's
   * HUMAN_APPROVAL_REQUIRED gate). Recorded as a `ticket.ready_approved` event;
   * TransitionService reads this to set `humanApprovedReady`. Restricted to
   * human/admin actors — an agent may not approve its own readiness.
   */
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

  /**
   * Assign (or replace) the reviewer recorded on a ticket. `factory_strict` and
   * `regulated` packs gate readiness on a reviewer being set (REVIEWER_REQUIRED);
   * without this path such tickets can never reach `ready`. Persists
   * `ticket.reviewer` and emits a `ticket.reviewer_assigned` event for the audit
   * trail. Restricted to human/admin actors — an agent may not assign a reviewer.
   */
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

  /**
   * Replace the set of capabilities a ticket requires of a claiming agent. The
   * write is enforced by claim eligibility (see ClaimRepository.candidateTickets).
   * Emits a `ticket.required_capabilities_set` event for the audit trail.
   */
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

  /** Capabilities a ticket currently requires of a claiming agent. */
  listRequiredCapabilities(ref: string): string[] {
    const ticket = this.resolveTicket(ref);
    return this.requiredCapabilities.listForTicket(ticket.id);
  }

  heartbeat(claimToken: string): { expiresAt: string } {
    return this.claims.heartbeat(claimToken);
  }

  recordEvidence(
    input: RecordEvidenceInput,
    actor: Actor,
  ): { evidenceId: string; eventId: string } {
    return this.claims.recordEvidence(input, actor);
  }

  submitForReview(input: SubmitForReviewInput, actor: Actor): { status: string; eventId: string } {
    return this.claims.submitForReview(input, actor);
  }

  markBlocked(input: MarkBlockedInput, actor: Actor): { eventId: string } {
    return this.claims.markBlocked(input, actor);
  }

  releaseClaim(claimToken: string, actor: Actor): void {
    this.claims.releaseClaim(claimToken, actor);
  }

  expireStaleClaims(actor: Actor): { expired: number } {
    return this.claims.expireStaleClaims(actor);
  }

  /**
   * Human override: revoke a claim by its id, mark it revoked and return its
   * ticket to `ready` (systemOverride, bypassing policy gates). Idempotent calls
   * on an already-terminal claim raise STATE_CONFLICT.
   */
  revokeClaim(claimId: string, actor: Actor): { claimId: string; ticketId: string } {
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      const claim = this.claimsRepo.findById(claimId);
      if (!claim) throw notFound("claim", claimId);
      if (claim.status !== "active") {
        throw new DispatchError(
          "STATE_CONFLICT",
          `Claim is '${claim.status}' and cannot be revoked.`,
          { status: claim.status },
        );
      }
      this.claimsRepo.setStatus(claim.id, "revoked", now);
      const ticket = this.tickets.findById(claim.ticket_id);
      if (ticket && (ticket.status === "claimed" || ticket.status === "in_progress")) {
        this.transitions.transition({
          ticketId: ticket.id,
          actor,
          toStatus: "ready",
          reason: "claim_revoked",
          systemOverride: true,
        });
      }
      writeEvent(this.db, {
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
  createDraftTicket(
    input: {
      title: string;
      description?: string;
      repoName?: string;
      evidenceSummary?: string;
      policyPack?: string;
    },
    actor: Actor,
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
      if (input.repoName) {
        this.linkRepository(ticket.id, input.repoName, "primary", actor);
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
   * requirement (`hasPrOrDiff`) can be satisfied after the implementer's claim
   * has completed. Writes an auditable `evidence.recorded` work-event tagged
   * `system_delivery` so this distinct path is traceable.
   *
   * Deliberately constrained to keep claim-scoping intact:
   *  - SYSTEM actors only. A non-system actor (agent/human/admin) is refused —
   *    agents must continue to use the claim-scoped `recordEvidence` path.
   *  - It cannot satisfy an acceptance criterion: the evidence row carries no
   *    `ac_id`, so AC satisfaction stays claim-scoped. This only unblocks the
   *    PR/diff done-gate requirement.
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

  // --- Reads ---------------------------------------------------------------

  resolveTicket(ref: string): Ticket {
    const byId = this.tickets.findById(ref);
    if (byId) return byId;
    const asNumber = Number(ref.replace(/^#/, ""));
    if (Number.isInteger(asNumber)) {
      const byNumber = this.tickets.findByNumber(asNumber);
      if (byNumber) return byNumber;
    }
    throw notFound("ticket", ref);
  }

  view(ref: string): TicketView {
    const ticket = this.resolveTicket(ref);
    return {
      ticket,
      acceptanceCriteria: this.acs.listForTicket(ticket.id),
      repositories: this.repos.listForTicket(ticket.id),
      // WG-001: ticket detail includes confirmed + suggested scopes. The repo
      // listForTicket already excludes nothing, so 'rejected' scopes are retained
      // and visible too (audit), but the listForTicket ordering puts the useful
      // ones (primary/secondary/suggested/implicit) first.
      scopes: this.ticketScopes.listForTicket(ticket.id),
      blockingDecisions: this.decisions.blockingForTicket(ticket.id),
      dependencies: this.ticketDependencies.listForTicket(ticket.id),
      evidence: this.evidence.listForTicket(ticket.id),
      events: listEvents(this.db, "ticket", ticket.id),
    };
  }

  list(status?: TicketStatus): Ticket[] {
    return this.tickets.list(status);
  }

  /** Filtered backlog list for the human surface (status / repo / risk). */
  listTickets(filter: TicketListFilter = {}): Ticket[] {
    return this.tickets.listFiltered(filter);
  }

  /** Events for a ticket (resolved by id or number). */
  listTicketEvents(ref: string): WorkEvent[] {
    const ticket = this.resolveTicket(ref);
    return listEvents(this.db, "ticket", ticket.id);
  }

  /** Active claims joined to their ticket + agent (human "active factory" view). */
  listActiveClaims(): ActiveClaimView[] {
    return this.claimsRepo.listActive();
  }

  /** All registered agents, newest first. */
  listAgents(): Agent[] {
    return this.agents.list();
  }

  /**
   * Registered repositories, ordered by name. WG-006: hidden repos are excluded
   * by default; pass `includeHidden` for the full set (the "Hidden repos" page).
   */
  listRepositories(includeHidden = false): Repository[] {
    return this.repos.list(includeHidden);
  }

  /** WG-006: only the hidden repositories (the "Hidden repos" page's source). */
  listHiddenRepos(): Repository[] {
    return this.repos.listHidden();
  }

  // --- Board + dashboard reads (read-only showcase surfaces) ----------------

  /**
   * Kanban board: every ticket grouped into a fixed set of columns
   * (claimed+in_progress collapse into "in_progress"), each card enriched with
   * AC progress, blocking-decision count and active-claim/lease state.
   * cancelled/failed tickets are returned separately as a "closed" area so the
   * live columns stay focused. Read-only — no mutation.
   */
  board(): BoardView {
    const now = this.clock.now();
    const tickets = this.tickets.listFiltered({});

    // Index active claims by ticket so each card resolves its holder in O(1).
    const claimsByTicket = new Map<string, ActiveClaimView>();
    for (const claim of this.claimsRepo.listActive()) {
      claimsByTicket.set(claim.ticket_id, claim);
    }

    const empty = (): BoardColumnView[] =>
      BOARD_COLUMNS.map((column) => ({ column, cards: [] as BoardCard[] }));
    const columns = empty();
    const byColumn = new Map<BoardColumn, BoardCard[]>(columns.map((c) => [c.column, c.cards]));
    const closed: BoardCard[] = [];
    const wontDo: BoardCard[] = [];

    for (const ticket of tickets) {
      const card = this.toBoardCard(ticket, claimsByTicket.get(ticket.id), now);
      // `cancelled` is the terminal won't-do bucket (reopenable); `failed` stays in
      // the closed area; everything else maps to a live column.
      if (ticket.status === "cancelled") {
        wontDo.push(card);
        continue;
      }
      const column = columnFor(ticket.status);
      if (column === null) {
        closed.push(card);
        continue;
      }
      byColumn.get(column)!.push(card);
    }

    // The `ready_for_merge` column's cards, surfaced as a dedicated array too.
    const readyForMerge = byColumn.get("ready_for_merge") ?? [];

    return { columns, closed, wontDo, readyForMerge };
  }

  /** Build a single board card, computing AC progress + claim/lease state. */
  private toBoardCard(
    ticket: Ticket,
    claim: ActiveClaimView | undefined,
    nowIso: string,
  ): BoardCard {
    const acs = this.acs.listForTicket(ticket.id);
    const acSatisfied = acs.filter((a) => a.status === "satisfied").length;
    const evidenceRequired = acs.filter((a) => a.evidence_required === 1);
    const acEvidenced = evidenceRequired.filter((a) => a.status === "satisfied").length;
    const blockingCount = this.decisions.blockingForTicket(ticket.id).length;

    const claimCard: BoardCardClaim | null = claim
      ? {
          agentId: claim.agent_id,
          agentDisplayName: claim.agent_display_name,
          expiresAt: claim.expires_at,
          stale: claim.expires_at < nowIso,
        }
      : null;

    return {
      id: ticket.id,
      number: ticket.number,
      title: ticket.title,
      status: ticket.status,
      priority: ticket.priority,
      risk_level: ticket.risk_level,
      updated_at: ticket.updated_at,
      acTotal: acs.length,
      acSatisfied,
      acEvidenced,
      acEvidenceRequired: evidenceRequired.length,
      blockingCount,
      claim: claimCard,
      lastReviewFeedback: parseReviewFeedback(ticket.last_review_feedback),
    };
  }

  /**
   * Cross-ticket activity feed: newest-first page of work_events across all
   * entities, enriched with the ticket number/title where applicable. Carries
   * metadata only — never payload bodies (see EventRepository). Returns the page
   * plus the total for simple pagination.
   */
  activity(query: ActivityQuery): { events: ActivityEvent[]; total: number } {
    return {
      events: this.events.listActivity(query),
      total: this.events.countActivity(),
    };
  }

  /** Dashboard summary tiles — counts only, safe to render wholesale. */
  dashboard(): DashboardSummary {
    const now = this.clock.now();
    const startOfToday = startOfUtcDay(now);

    const ticketsByStatus = Object.fromEntries(TICKET_STATUSES.map((s) => [s, 0])) as Record<
      TicketStatus,
      number
    >;
    for (const { status, count } of this.events.ticketCountsByStatus()) {
      if (isTicketStatus(status)) ticketsByStatus[status] = count;
    }

    const activeClaims = this.claimsRepo.listActive();
    const staleClaims = activeClaims.filter((c) => c.expires_at < now).length;

    const transitions = this.events.stateTransitions();

    return {
      ticketsByStatus,
      deliveredToday: this.events.deliveredSince(startOfToday),
      blocked: ticketsByStatus.blocked,
      openDecisions: this.decisions.listPending().length,
      activeClaims: activeClaims.length,
      staleClaims,
      cycleTimeByState: cycleTimeByState(transitions),
      stuckTickets: this.stuckTickets(transitions, now),
      stuckThresholdHours: STUCK_THRESHOLD_HOURS,
    };
  }

  /**
   * Tickets sitting in a non-terminal state longer than {@link STUCK_THRESHOLD_HOURS}.
   * A ticket entered its current state at its most recent transition (or, if it
   * never transitioned, at creation); the gap to `now` is how long it has held it.
   * Terminal states (done/failed/cancelled) are never stuck. Longest-stuck first.
   */
  private stuckTickets(transitions: TransitionRow[], nowIso: string): StuckTicket[] {
    // Last transition per ticket = when it entered its current state (rows are
    // ordered oldest-first, so the last write for a ticket wins).
    const enteredAt = new Map<string, string>();
    for (const tr of transitions) enteredAt.set(tr.ticket_id, tr.created_at);

    const nowMs = Date.parse(nowIso);
    const thresholdMs = STUCK_THRESHOLD_HOURS * 3_600_000;
    const stuck: StuckTicket[] = [];
    for (const t of this.tickets.listFiltered({})) {
      if (TERMINAL_STATUSES.has(t.status)) continue;
      const since = enteredAt.get(t.id) ?? t.created_at;
      const stuckForMs = nowMs - Date.parse(since);
      if (stuckForMs <= thresholdMs) continue;
      stuck.push({
        id: t.id,
        number: t.number,
        title: t.title,
        status: t.status,
        stuckForMs,
        since,
      });
    }
    return stuck.sort((a, b) => b.stuckForMs - a.stuckForMs);
  }
}

/** Hours a ticket may hold a non-terminal state before it is flagged as stuck. */
const STUCK_THRESHOLD_HOURS = 24;

/** Statuses that close a ticket — work in them is done, never "stuck". */
const TERMINAL_STATUSES: ReadonlySet<TicketStatus> = new Set(["done", "failed", "cancelled"]);

/**
 * Median time spent in each state, computed from consecutive transition pairs:
 * the gap between a ticket entering a state and leaving it is one completed
 * interval. Returns one stat per state that has ≥1 completed interval, ordered
 * by TICKET_STATUSES so the dashboard renders states in lifecycle order.
 */
function cycleTimeByState(transitions: TransitionRow[]): CycleTimeStat[] {
  const durations = new Map<TicketStatus, number[]>();
  let prev: TransitionRow | undefined;
  for (const tr of transitions) {
    if (prev && prev.ticket_id === tr.ticket_id && isTicketStatus(prev.to_status ?? "")) {
      const state = prev.to_status as TicketStatus;
      const ms = Date.parse(tr.created_at) - Date.parse(prev.created_at);
      if (ms >= 0) {
        const ds = durations.get(state) ?? [];
        ds.push(ms);
        durations.set(state, ds);
      }
    }
    prev = tr;
  }
  return TICKET_STATUSES.filter((s) => durations.has(s)).map((status) => {
    const ds = durations.get(status)!;
    return { status, medianMs: median(ds), samples: ds.length };
  });
}

/** Median of a non-empty number array (mean of the two middles when even). */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Map a ticket status to its board column, or null for the closed area. */
function columnFor(status: TicketStatus): BoardColumn | null {
  switch (status) {
    case "draft":
    case "refining":
      return "draft";
    case "ready":
      return "ready";
    case "claimed":
    case "in_progress":
      return "in_progress";
    case "blocked":
      return "blocked";
    case "in_review":
      return "in_review";
    case "in_testing":
      return "in_testing";
    case "ready_for_merge":
      return "ready_for_merge";
    case "done":
      return "done";
    case "cancelled":
    case "failed":
      return null;
  }
}

function isTicketStatus(value: string): value is TicketStatus {
  return (TICKET_STATUSES as readonly string[]).includes(value);
}

function isBoardColumn(value: string): value is BoardColumn {
  return (BOARD_COLUMNS as readonly string[]).includes(value);
}

/**
 * Resolve a board-move target into the canonical {@link TicketStatus} to
 * transition to. Accepts either a real status or a {@link BoardColumn} key. The
 * board's "in_progress" column collapses claimed+in_progress, so dropping into
 * it targets `in_progress` (a status only legally reached from `claimed` — so a
 * board drop can never invent a claim; the transition is simply rejected).
 * Throws VALIDATION_ERROR for anything that is neither a status nor a column.
 */
function resolveMoveTarget(target: string): TicketStatus {
  if (isTicketStatus(target)) return target;
  if (isBoardColumn(target)) {
    // Every BoardColumn key except (none) is itself a valid TicketStatus, so the
    // status check above already handled them; this branch is defensive.
    return target as TicketStatus;
  }
  throw new DispatchError(
    "VALIDATION_ERROR",
    `'${target}' is not a valid status or board column.`,
    { target },
  );
}

/** Start-of-day (UTC) ISO instant for the day containing `nowIso`. */
function startOfUtcDay(nowIso: string): string {
  const d = new Date(nowIso);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
  return start.toISOString();
}
