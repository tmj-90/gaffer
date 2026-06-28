import { type Db, inTransaction, openDatabase } from "./db/connection.js";
import { claimTicketInput } from "./domain/schemas.js";
import {
  TICKET_STATUSES,
  parseReviewFeedback,
  type AcceptanceCriterion,
  type Actor,
  type Agent,
  type Decision,
  type DecisionSeverity,
  type Evidence,
  type Repository,
  type ReviewFeedback,
  type RiskLevel,
  type ScopeEdge,
  type ScopeNode,
  type ScopeRepo,
  type PlanMessage,
  type PlanSession,
  type Run,
  type RunKind,
  type TestContract,
  type Ticket,
  type TicketDependencyView,
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
import { RunRepository, type RunListResult } from "./repositories/runRepository.js";
import {
  PlanSessionRepository,
  type PlanSessionListOptions,
} from "./repositories/planSessionRepository.js";
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
import { DecisionService, type ResolveDecisionInput } from "./services/decisionService.js";
import { ScopeService, type ScopeNodeView } from "./services/scopeService.js";
import {
  TicketService,
  type AddDependencyResult,
  type ClaimabilityResult,
  type DeliveryArtifactResult,
  type DeliveryEvidenceInput,
  type RepoDeliveryResult,
} from "./services/ticketService.js";
import {
  RepoService,
  type TicketRepoAccessResult,
  type WorkPacketRepos,
} from "./services/repoService.js";
import { EpicsService, type CreateEpicResult } from "./services/epicsService.js";
import { SuggestionService, type RepoSuggestion } from "./services/suggestionService.js";
import { TransitionService, type TransitionResult } from "./services/transitionService.js";
import { buildNotifierFromEnv } from "./notify/config.js";
import type { NotifyEvent, NotifyKind, Notifier } from "./notify/types.js";
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
export type { WorkPacketRepos } from "./services/repoService.js";

/**
 * Whether a ticket currently passes its policy pack's readiness gate (WG-004).
 */
export type { ClaimabilityResult } from "./services/ticketService.js";

/** Result of setting a ticket↔repo access boundary. */
export type { TicketRepoAccessResult } from "./services/repoService.js";

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

/** Per-repository delivery progress for the Overview "Progress by repository". */
export interface RepoProgress {
  /** Repository name. */
  repo: string;
  /** Tickets linked to this repo (any status). */
  total: number;
  /** Of those, how many are `done`. */
  done: number;
  /** Of those, how many are actively in flight (claimed → ready_for_merge). */
  inFlight: number;
  /** Of those, how many are blocked. */
  blocked: number;
  /** done / total as a 0–100 integer percentage. */
  pct: number;
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
  /** Per-repository delivery progress (mapped repos with ≥1 linked ticket). */
  repoProgress: RepoProgress[];
}

/** Input for resolving a decision via the human surface. */
export type { ResolveDecisionInput } from "./services/decisionService.js";

/**
 * Delivery evidence attached by a SYSTEM/factory actor *without* a claim token.
 */
export type { DeliveryEvidenceInput } from "./services/ticketService.js";

export type { DeliveryArtifactResult } from "./services/ticketService.js";

/** Result of recording a per-repo delivery artifact (WG-005). */
export type { RepoDeliveryResult } from "./services/ticketService.js";

/** A scope node enriched with its linked repos (for the node-detail view). */
export type { ScopeNodeView } from "./services/scopeService.js";

/** Result of {@link Dispatch.createEpic} (EP-001). */
export type { CreateEpicResult } from "./services/epicsService.js";

/** Result of adding a ticket dependency (EP-001). */
export type { AddDependencyResult } from "./services/ticketService.js";

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
  readonly runs: RunRepository;
  readonly planSessions: PlanSessionRepository;
  readonly transitions: TransitionService;
  readonly claims: ClaimService;
  readonly suggestions: SuggestionService;
  readonly scope: ScopeService;
  readonly decisionSvc: DecisionService;
  readonly ticketSvc: TicketService;
  readonly repoSvc: RepoService;
  readonly epicsSvc: EpicsService;
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

  /**
   * H2 human-gate notifier — the opt-in seam that pings the operator when a
   * ticket needs them (enters `in_review`, is parked/`blocked`, or a decision
   * becomes pending). Injectable via the constructor option so tests can pass a
   * fake; defaults to the env-built notifier (a no-op when nothing is
   * configured). Every emit is best-effort and non-blocking — see {@link emitGate}.
   */
  private readonly notifier: Notifier;

  constructor(
    db: Db,
    readonly clock: Clock = systemClock,
    gitRunner?: GitRunner,
    options: { maxAttempts?: number; testingEnabled?: boolean; notifier?: Notifier } = {},
  ) {
    this.db = db;
    this.gitRunner = gitRunner;
    this.maxAttempts = options.maxAttempts ?? resolveMaxAttempts();
    this.testingEnabledOverride = options.testingEnabled;
    this.notifier = options.notifier ?? buildNotifierFromEnv();
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
    this.runs = new RunRepository(db);
    this.planSessions = new PlanSessionRepository(db);
    this.transitions = new TransitionService(db, clock, gitRunner);
    this.claims = new ClaimService(db, clock, this.transitions);
    this.suggestions = new SuggestionService({
      repos: this.repos,
      scopeNodes: this.scopeNodes,
      scopeRepos: this.scopeRepos,
    });
    this.scope = new ScopeService({
      db,
      clock: this.clock,
      scopeNodes: this.scopeNodes,
      scopeEdges: this.scopeEdges,
      scopeRepos: this.scopeRepos,
      ticketScopes: this.ticketScopes,
      tickets: this.tickets,
      repos: this.repos,
    });
    this.decisionSvc = new DecisionService({
      db,
      clock: this.clock,
      decisions: this.decisions,
      notifier: this.notifier,
      onDecisionCreated: (d) => this.emitDecisionGate(d),
    });
    this.ticketSvc = new TicketService({
      db,
      clock: this.clock,
      tickets: this.tickets,
      acs: this.acs,
      decisions: this.decisions,
      evidence: this.evidence,
      repos: this.repos,
      requiredCapabilities: this.requiredCapabilities,
      repoDeliveries: this.repoDeliveries,
      ticketDependencies: this.ticketDependencies,
      transitions: this.transitions,
      claims: this.claims,
    });
    this.repoSvc = new RepoService({
      db,
      clock: this.clock,
      repos: this.repos,
      tickets: this.tickets,
      scopeRepos: this.scopeRepos,
      ticketScopes: this.ticketScopes,
      suggestions: this.suggestions,
      scope: this.scope,
    });
    this.epicsSvc = new EpicsService({
      db,
      clock: this.clock,
      ticketScopes: this.ticketScopes,
      scope: this.scope,
      tickets: this.ticketSvc,
      repos: this.repoSvc,
    });
  }

  /** Open a Dispatch instance against a SQLite file (or ":memory:"). */
  static open(
    path: string,
    clock: Clock = systemClock,
    gitRunner?: GitRunner,
    options: { maxAttempts?: number; testingEnabled?: boolean; notifier?: Notifier } = {},
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
    return this.ticketSvc.createTicket(raw, actor);
  }

  addAcceptanceCriterion(raw: unknown, actor: Actor): { ac: AcceptanceCriterion; eventId: string } {
    return this.ticketSvc.addAcceptanceCriterion(raw, actor);
  }

  // --- Ticket dependencies (EP-001) ----------------------------------------

  addDependency(raw: unknown, actor: Actor): AddDependencyResult {
    return this.ticketSvc.addDependency(raw, actor);
  }

  listDependencies(ticketRef: string): TicketDependencyView[] {
    return this.ticketSvc.listDependencies(ticketRef);
  }

  removeDependency(
    ticketRef: string,
    dependsOnRef: string,
    actor: Actor,
  ): { ticketId: string; dependsOnTicketId: string; eventId: string } {
    return this.ticketSvc.removeDependency(ticketRef, dependsOnRef, actor);
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
    return this.epicsSvc.createEpic(raw, actor);
  }

  // --- Repositories --------------------------------------------------------

  registerRepository(raw: unknown, actor: Actor): Repository {
    return this.repoSvc.registerRepository(raw, actor);
  }

  /** WG-006: hide or un-hide a repo (by id or name). */
  setRepoHidden(repoRef: string, hidden: boolean, actor: Actor): Repository {
    return this.repoSvc.setRepoHidden(repoRef, hidden, actor);
  }

  linkRepository(ticketId: string, repoName: string, role: string, actor: Actor): void {
    return this.repoSvc.linkRepository(ticketId, repoName, role, actor);
  }

  // --- Ticket scope links (WG-001) -----------------------------------------

  linkTicketScope(raw: unknown, actor: Actor): TicketScopeNode {
    return this.scope.linkTicketScope(raw, actor);
  }

  setPrimaryScope(ticketRef: string, scopeNodeId: string, actor: Actor): TicketScopeNode {
    return this.scope.setPrimaryScope(ticketRef, scopeNodeId, actor);
  }

  listTicketScopes(ticketRef: string): TicketScopeWithNode[] {
    return this.scope.listTicketScopes(ticketRef);
  }

  removeTicketScope(
    ticketRef: string,
    scopeNodeId: string,
    actor: Actor,
  ): { ticketId: string; scopeNodeId: string; eventId: string } {
    return this.scope.removeTicketScope(ticketRef, scopeNodeId, actor);
  }

  ticketScopeSummary(ticketRef: string): {
    primary: { id: string; name: string; type: string } | null;
    counts: Record<string, number>;
    total: number;
  } {
    return this.scope.ticketScopeSummary(ticketRef);
  }

  // --- Ticket↔repo access boundaries (WG-002) ------------------------------

  setTicketRepoAccess(raw: unknown, actor: Actor): TicketRepoAccessResult {
    return this.repoSvc.setTicketRepoAccess(raw, actor);
  }

  workPacketRepos(ticketRef: string): WorkPacketRepos {
    return this.repoSvc.workPacketRepos(ticketRef);
  }

  applyMonoFallback(
    ticketRef: string,
    actor: Actor,
  ): { applied: boolean; ticketId: string; repoId?: string; reason?: string } {
    return this.repoSvc.applyMonoFallback(ticketRef, actor);
  }

  // --- Scope→repo suggestions (FG-005) -------------------------------------

  suggestReposForTicket(raw: unknown, actor: Actor): RepoSuggestion[] {
    return this.repoSvc.suggestReposForTicket(raw, actor);
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
    return this.ticketSvc.claimability(ticketRef);
  }

  // --- Factory Map: scope nodes (FG-001) -----------------------------------

  createScopeNode(raw: unknown, actor: Actor): ScopeNode {
    return this.scope.createScopeNode(raw, actor);
  }

  updateScopeNode(nodeId: string, raw: unknown, actor: Actor): ScopeNode {
    return this.scope.updateScopeNode(nodeId, raw, actor);
  }

  listScopeNodes(): ScopeNode[] {
    return this.scope.listScopeNodes();
  }

  getScopeNode(nodeId: string): ScopeNodeView {
    return this.scope.getScopeNode(nodeId);
  }

  deleteScopeNode(nodeId: string, actor: Actor): { nodeId: string; eventId: string } {
    return this.scope.deleteScopeNode(nodeId, actor);
  }

  // --- Factory Map: scope edges (FG-001) -----------------------------------

  createScopeEdge(raw: unknown, actor: Actor): ScopeEdge {
    return this.scope.createScopeEdge(raw, actor);
  }

  listScopeEdges(nodeId?: string): ScopeEdge[] {
    return this.scope.listScopeEdges(nodeId);
  }

  deleteScopeEdge(edgeId: string, actor: Actor): { edgeId: string; eventId: string } {
    return this.scope.deleteScopeEdge(edgeId, actor);
  }

  // --- Factory Map: scope↔repo associations (FG-002) -----------------------

  linkScopeRepo(raw: unknown, actor: Actor): ScopeRepo {
    return this.scope.linkScopeRepo(raw, actor);
  }

  updateScopeRepo(associationId: string, raw: unknown, actor: Actor): ScopeRepo {
    return this.scope.updateScopeRepo(associationId, raw, actor);
  }

  unlinkScopeRepo(associationId: string, actor: Actor): { associationId: string; eventId: string } {
    return this.scope.unlinkScopeRepo(associationId, actor);
  }

  reposForScope(nodeId: string): ScopeRepoWithRepo[] {
    return this.scope.reposForScope(nodeId);
  }

  scopesForRepo(repoId: string): RepoScopeWithNode[] {
    return this.scope.scopesForRepo(repoId);
  }

  listUnmappedRepos(includeHidden = false): Repository[] {
    return this.scope.listUnmappedRepos(includeHidden);
  }

  // --- Decisions -----------------------------------------------------------

  createDecision(
    input: { title: string; question: string; severity?: DecisionSeverity; ticketId?: string },
    actor: Actor,
  ): Decision {
    return this.decisionSvc.createDecision(input, actor);
  }

  listPendingDecisions(): Decision[] {
    return this.decisionSvc.listPendingDecisions();
  }

  resolveDecision(input: ResolveDecisionInput, actor: Actor): Decision {
    return this.decisionSvc.resolveDecision(input, actor);
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
    return this.ticketSvc.setTestable(ticketRef, canBeTested, actor);
  }

  setTestContract(ticketRef: string, raw: unknown, actor: Actor): TestContract {
    return this.ticketSvc.setTestContract(ticketRef, raw, actor);
  }

  getTestContract(ticketRef: string): TestContract | null {
    return this.ticketSvc.getTestContract(ticketRef);
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
    // Capture whether the reject ended up PARKING the ticket (retry cap reached),
    // so we can fire the H2 park notification AFTER the transaction commits.
    let parked: { attempt: number; requestedTarget: string; reason: string } | null = null;
    const result = inTransaction(this.db, () => {
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
        parked = { attempt: nextAttempt, requestedTarget: to, reason: resolvedReason };
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
    // H2: a parked ticket (retry budget exhausted) now needs a human. Emit after
    // the transaction commits, best-effort. A plain reject back into the queue is
    // NOT a human gate, so only the park fires a notification.
    if (parked !== null) {
      const p: { attempt: number; requestedTarget: string; reason: string } = parked;
      this.emitGate("ticket_parked", result.ticket, {
        status: "blocked",
        detail: `retry cap reached (attempt ${p.attempt}/${this.maxAttempts}): ${p.reason}`,
      });
    }
    return result;
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
    return this.ticketSvc.resetAcceptanceCriteria(ref, actor);
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
    return this.ticketSvc.recordDeliveryArtifact(raw, actor);
  }

  // --- Per-repo delivery artifacts (WG-005) --------------------------------

  recordRepoDelivery(raw: unknown, actor: Actor): RepoDeliveryResult {
    return this.ticketSvc.recordRepoDelivery(raw, actor);
  }

  listRepoDeliveries(ticketRef: string): TicketRepoDeliveryWithRepo[] {
    return this.ticketSvc.listRepoDeliveries(ticketRef);
  }

  grantReadyApproval(ref: string, actor: Actor): { ticketId: string; eventId: string } {
    return this.ticketSvc.grantReadyApproval(ref, actor);
  }

  assignReviewer(
    ref: string,
    reviewerId: string,
    actor: Actor,
  ): { ticketId: string; reviewer: string; eventId: string } {
    return this.ticketSvc.assignReviewer(ref, reviewerId, actor);
  }

  setRequiredCapabilities(
    raw: unknown,
    actor: Actor,
  ): { ticketId: string; capabilities: string[]; eventId: string } {
    return this.ticketSvc.setRequiredCapabilities(raw, actor);
  }

  listRequiredCapabilities(ref: string): string[] {
    return this.ticketSvc.listRequiredCapabilities(ref);
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
    const result = this.claims.submitForReview(input, actor);
    // H2: the ticket has reached `in_review` and now needs a human reviewer. Fire
    // AFTER the claim transaction commits so the notification can never roll the
    // transition back; best-effort inside emitGate.
    if (result.status === "in_review") {
      const ticket = this.tickets.findById(input.ticket_id);
      if (ticket) this.emitGate("review_needed", ticket, { detail: input.reason });
    }
    return result;
  }

  markBlocked(input: MarkBlockedInput, actor: Actor): { eventId: string } {
    const result = this.claims.markBlocked(input, actor);
    // H2: the ticket is now `blocked` and needs a human to unblock it. Emit after
    // the block transaction commits, best-effort.
    const ticket = this.tickets.findById(input.ticket_id);
    if (ticket) this.emitGate("ticket_blocked", ticket, { detail: input.reason });
    return result;
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
    return this.ticketSvc.createDraftTicket(input, actor, (ticketId, repoName, a) =>
      this.linkRepository(ticketId, repoName, "primary", a),
    );
  }

  attachDeliveryEvidence(
    ref: string,
    input: DeliveryEvidenceInput,
    actor: Actor,
  ): { evidenceId: string; eventId: string } {
    return this.ticketSvc.attachDeliveryEvidence(ref, input, actor);
  }

  // --- H2 human-gate notifications -----------------------------------------

  /**
   * Fire a human-gate notification, best-effort. Called AFTER the triggering
   * transaction has committed (the transition is already durable), so the emit
   * can never roll the transition back. The {@link Notifier} itself swallows any
   * sink failure with a log, but we also guard the event-building here so a stray
   * read error (e.g. resolving the repo name) can never bubble into the caller.
   *
   * When nothing is configured the notifier is a no-op and `enabled` is false, so
   * we skip building the event entirely (zero overhead on the hot path).
   */
  private emitGate(
    kind: NotifyKind,
    ticket: Ticket,
    extra: { detail?: string | undefined; status?: string | undefined } = {},
  ): void {
    if (!this.notifier.enabled) return;
    try {
      this.notifier.notify(this.buildTicketEvent(kind, ticket, extra));
    } catch {
      // Defence in depth: the notifier is contracted not to throw, but a bug in
      // event-building must never break a transition. Swallow — the gate already
      // committed and the dashboard remains the source of truth.
    }
  }

  /** Fire a decision-pending gate for a raised decision, best-effort. */
  private emitDecisionGate(decision: Decision): void {
    if (!this.notifier.enabled) return;
    try {
      this.notifier.notify({
        kind: "decision_pending",
        title: decision.title,
        status: decision.status,
        at: this.clock.now(),
        ...(decision.question ? { detail: decision.question } : {}),
      });
    } catch {
      // See emitGate — never let a notification break the caller.
    }
  }

  /** Build the structured {@link NotifyEvent} for a ticket-scoped gate. */
  private buildTicketEvent(
    kind: NotifyKind,
    ticket: Ticket,
    extra: { detail?: string | undefined; status?: string | undefined },
  ): NotifyEvent {
    const repo = this.primaryRepoName(ticket.id);
    const url = this.ticketUrl(ticket);
    return {
      kind,
      title: ticket.title,
      status: extra.status ?? ticket.status,
      at: this.clock.now(),
      ...(ticket.number !== null ? { ticket_number: ticket.number } : {}),
      ...(repo !== undefined ? { repo } : {}),
      ...(url !== undefined ? { url } : {}),
      ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
    };
  }

  /** Best-effort primary/first repo name for a ticket, or undefined. */
  private primaryRepoName(ticketId: string): string | undefined {
    const links = this.repos.accessLinksForTicket(ticketId);
    return links[0]?.name;
  }

  /**
   * Build a clickable dashboard link for a ticket when `GAFFER_DASHBOARD_URL` is
   * set, so the operator can jump straight to it. Optional — undefined when the
   * base is unconfigured.
   */
  private ticketUrl(ticket: Ticket): string | undefined {
    const base = (process.env.GAFFER_DASHBOARD_URL ?? "").trim();
    if (base === "" || ticket.number === null) return undefined;
    return `${base.replace(/\/+$/, "")}/tickets/${ticket.number}`;
  }

  // --- Reads ---------------------------------------------------------------

  resolveTicket(ref: string): Ticket {
    return this.ticketSvc.resolveTicket(ref);
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

  // --- Run-activity registry (RUN-ACTIVITY) ---------------------------------

  /** Mint a fresh run id (so a caller can name a per-run log file up front). */
  newRunId(): string {
    return newId();
  }

  /**
   * Record the start of a background run (a detached API-spawned child). Returns
   * the run id so the caller can later {@link markRunEnd} it (and the dashboard
   * can poll its status). The row is created `running`; `pid`/`log_path` are
   * stored as given (null when the platform withheld a pid or no log was opened).
   * The repo (the run's target, when known) is recorded for the panel.
   *
   * `id` may be supplied by the caller (so a per-run log file can be named by the
   * id BEFORE the row is written); when omitted a fresh id is minted.
   */
  recordRunStart(input: {
    id?: string;
    kind: RunKind;
    repo?: string | null;
    pid?: number | null;
    log_path?: string | null;
  }): { id: string } {
    const id = input.id ?? newId();
    this.runs.insertStart({
      id,
      kind: input.kind,
      repo: input.repo ?? null,
      pid: input.pid ?? null,
      log_path: input.log_path ?? null,
      started_at: this.clock.now(),
    });
    return { id };
  }

  /**
   * Mark a tracked run ended. Derives status from the child's exit code: 0 ⇒
   * `succeeded`, any other value (or a null/unknown code) ⇒ `failed`. A no-op if
   * the run was already swept to `unknown` (the first writer wins — see
   * {@link RunRepository.markEnd}), so a late exit listener never resurrects a
   * reconciled row.
   */
  markRunEnd(id: string, input: { exit_code: number | null; detail?: string | null }): void {
    const status: Run["status"] = input.exit_code === 0 ? "succeeded" : "failed";
    this.runs.markEnd({
      id,
      status,
      ended_at: this.clock.now(),
      exit_code: input.exit_code,
      detail: input.detail ?? null,
    });
  }

  /**
   * List tracked runs. `active` ⇒ only the in-flight (`running`) runs; otherwise
   * the most-recent `limit` runs of any status. Powers the dashboard's "Running
   * now" panel.
   */
  listRuns(options: { active?: boolean; limit?: number; activeLimit?: number } = {}): Run[] {
    return this.runs.list(options);
  }

  /**
   * As {@link listRuns}, but also reports whether the (active) list was truncated
   * by its hard cap — so the API can surface "showing N of many" rather than
   * silently dropping in-flight runs.
   */
  listRunsResult(
    options: { active?: boolean; limit?: number; activeLimit?: number } = {},
  ): RunListResult {
    return this.runs.listResult(options);
  }

  /**
   * Reconcile orphaned runs on API startup: any `running` row whose pid is no
   * longer alive is flipped to `unknown` (the API restarted mid-run, so the exit
   * listener that would have marked it died with the previous process). Returns
   * the ids swept. Idempotent — a row already ended is left untouched.
   */
  sweepStaleRuns(): string[] {
    return this.runs.sweepStale(this.clock.now());
  }

  // --- Plan sessions (H9 — durable async plan-build chat) -------------------

  /**
   * Create a fresh active plan session. Any currently active session is
   * archived as 'abandoned' first so only one session is active at a time.
   */
  createPlanSession(): PlanSession {
    const now = this.clock.now();
    this.planSessions.archiveAllActive(now);
    return this.planSessions.create({ id: newId(), created_at: now, updated_at: now });
  }

  /**
   * Fetch a plan session by id. Returns null when not found, so callers can
   * distinguish a missing id from an active-but-empty session.
   */
  getPlanSession(id: string): PlanSession | null {
    return this.planSessions.getById(id);
  }

  /**
   * Return the most-recently-created active session, or null when none exists.
   * Called on panel open so a reload restores the in-progress conversation.
   */
  getActivePlanSession(): PlanSession | null {
    return this.planSessions.getActive();
  }

  /**
   * Append a message to a plan session and optionally update the brief / stored
   * plan. Returns the updated session, or null when the id is not found.
   *
   * `brief` should be supplied only on the first user turn (the opening line).
   * `plan` should be supplied when the decompose helper returns a plan phase, as
   * the raw plan JSON so the panel can restore the full proposal on reload.
   */
  appendPlanMessage(
    id: string,
    message: Omit<PlanMessage, "ts">,
    opts: { brief?: string | null; plan?: unknown } = {},
  ): PlanSession | null {
    return this.planSessions.appendMessage({
      id,
      message: { ...message, ts: this.clock.now() },
      ...(opts.brief !== undefined ? { brief: opts.brief } : {}),
      ...(opts.plan !== undefined ? { plan_json: JSON.stringify(opts.plan) } : {}),
      updated_at: this.clock.now(),
    });
  }

  /**
   * Archive a plan session. `status` must be 'confirmed' (the user approved the
   * plan and tickets are being created) or 'abandoned' (the user started fresh or
   * closed the panel without confirming). A no-op on an already-archived session.
   */
  archivePlanSession(id: string, status: "confirmed" | "abandoned"): void {
    this.planSessions.archive({ id, status, updated_at: this.clock.now() });
  }

  /**
   * List plan sessions, most-recently-created first. Capped at 20 by default.
   * When `status` is given, only sessions with that status are returned.
   */
  listPlanSessions(options: PlanSessionListOptions = {}): PlanSession[] {
    return this.planSessions.list(options);
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
      repoProgress: this.repoProgress(),
    };
  }

  /**
   * Per-repository delivery progress, computed from the ticket↔repo links: for
   * each non-hidden repo with at least one linked ticket, how many are done,
   * in flight or blocked, and the done-share. Drives the Overview repo panel.
   */
  private repoProgress(): RepoProgress[] {
    const rows = this.db
      .prepare(
        `SELECT r.name AS repo,
                COUNT(*) AS total,
                SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done,
                SUM(CASE WHEN t.status IN
                  ('claimed','in_progress','in_review','in_testing','ready_for_merge')
                  THEN 1 ELSE 0 END) AS inflight,
                SUM(CASE WHEN t.status = 'blocked' THEN 1 ELSE 0 END) AS blocked
         FROM repositories r
         JOIN ticket_repos tr ON tr.repo_id = r.id
         JOIN tickets t ON t.id = tr.ticket_id
         WHERE r.hidden = 0
         GROUP BY r.id, r.name
         ORDER BY total DESC, r.name ASC`,
      )
      .all() as Array<{
      repo: string;
      total: number;
      done: number;
      inflight: number;
      blocked: number;
    }>;
    return rows.map((r) => ({
      repo: r.repo,
      total: r.total,
      done: r.done,
      inFlight: r.inflight,
      blocked: r.blocked,
      pct: r.total > 0 ? Math.round((r.done / r.total) * 100) : 0,
    }));
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
