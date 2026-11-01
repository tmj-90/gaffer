import { existsSync } from "node:fs";

import { type Db, inTransaction, openDatabase } from "./db/connection.js";
import { claimTicketInput } from "./domain/schemas.js";
import {
  type AcStatus,
  type AcceptanceCriterion,
  type Actor,
  type Agent,
  type BouncingTicket,
  type Decision,
  type DecisionSeverity,
  type Evidence,
  type PausedDelivery,
  type ReworkAttempt,
  type Repository,
  type RiskLevel,
  type ScopeEdge,
  type ScopeNode,
  type ScopeRepo,
  type PlanMessage,
  type PlanSession,
  type Run,
  type RunKind,
  type Spec,
  type SpecCoverage,
  type SpecStatus,
  type TestContract,
  type Ticket,
  type TicketDependencyView,
  type TicketScopeNode,
  type TicketStatus,
  type WorkEvent,
  isActiveTicketRepoRelation,
  parseTestContract,
} from "./domain/types.js";
import {
  backfillEventChain,
  latestEventHash,
  verifyEventChain,
  type ChainVerification,
} from "./events/eventChain.js";
import { listEvents, writeEvent } from "./events/eventWriter.js";
import {
  SquadService,
  type AgentDisplay,
  type AgentDisplayUpdate,
  type ClubUpdate,
  type ClubView,
  type SquadAgentView,
} from "./services/squadService.js";
import { AcRepository } from "./repositories/acRepository.js";
import { AgentRepository } from "./repositories/agentRepository.js";
import { ClaimRepository, type ActiveClaimView } from "./repositories/claimRepository.js";
import { ClubRepository } from "./repositories/clubRepository.js";
import { DecisionRepository } from "./repositories/decisionRepository.js";
import {
  EventRepository,
  type ActivityEvent,
  type ActivityQuery,
} from "./repositories/eventRepository.js";
import { EvidenceRepository } from "./repositories/evidenceRepository.js";
import { PausedDeliveryRepository } from "./repositories/pausedDeliveryRepository.js";
import { RepoRepository, type TicketRepoLink } from "./repositories/repoRepository.js";
import { RequiredCapabilityRepository } from "./repositories/requiredCapabilityRepository.js";
import { ReworkAttemptRepository } from "./repositories/reworkAttemptRepository.js";
import { SpecCoverageRepository } from "./repositories/specCoverageRepository.js";
import { SpecRepository } from "./repositories/specRepository.js";
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
import {
  TicketRepository,
  type TicketListFilter,
  type TicketSummary,
} from "./repositories/ticketRepository.js";
import {
  ClaimService,
  type ClaimNextInput,
  type ClaimResult,
  type MarkBlockedInput,
  type RecordEvidenceInput,
  type RegisterAgentInput,
  type SubmitForReviewInput,
} from "./services/claimService.js";
import {
  computeTicketDiff,
  defaultGitRunner,
  type GitRunner,
  type RepoDiff,
  resolveBranchHead,
  type TicketDiff,
} from "./services/diffService.js";
import { readUsagePause } from "./health/usagePause.js";
import {
  computeLandingStatus,
  REVIEW_PIN_PREFIX,
  type LandingStatus,
} from "./services/landingStatus.js";
import { DecisionService, type ResolveDecisionInput } from "./services/decisionService.js";
import { ScopeService, type ScopeNodeView } from "./services/scopeService.js";
import {
  TicketService,
  type AddDependencyResult,
  type ClaimabilityResult,
  type DeliveryArtifactResult,
  type DeliveryEvidenceInput,
  type EditTicketResult,
  type RepoDeliveryResult,
  type TicketWarning,
} from "./services/ticketService.js";
import {
  RepoService,
  type TicketRepoAccessResult,
  type WorkPacketRepos,
} from "./services/repoService.js";
import { EpicsService, type CreateEpicResult } from "./services/epicsService.js";
import { EPIC_MEMBER_RELATIONS, ownAcceptanceTicketId } from "./services/epicAcceptance.js";
import { DossierService, DOSSIER_EVENT_TYPE, type Dossier } from "./services/dossierService.js";
import {
  ReviewPacketService,
  type CostReader,
  type ReviewPacket,
} from "./services/reviewPacketService.js";
import { SpecsService } from "./services/specsService.js";
import { SpecCoverageService } from "./services/specCoverageService.js";
import { resolveSpecClauseSeeder } from "./services/specClauseSeeder.js";
import { resolveSpecLoreReader } from "./services/specLoreReader.js";
import {
  BoardService,
  resolveMoveTarget,
  type BoardCard,
  type BoardView,
  type BoardWindow,
  type DashboardSummary,
} from "./services/boardService.js";
import { PauseService, type PauseInput } from "./services/pauseService.js";
import { HumanQueueService, type HumanQueue } from "./services/humanQueueService.js";
import {
  type ApprovalShas,
  type ApproveReviewOptions,
  type LandingStarted,
  type ReviewedHead,
  type UnavailableWriteRepo,
  ReviewGateService,
  unavailableRepoRemedy,
} from "./services/reviewGateService.js";
import {
  type ObservedRisk,
  observedRisk,
  runnerIntegrityHolds,
  withRunnerIntegrityHolds,
} from "./services/observedRisk.js";
import {
  AutonomyRecommendationService,
  type AutonomyRecommendation,
} from "./services/autonomyRecommendationService.js";
import {
  AutonomyPolicyRepository,
  type AutonomyPolicyGate,
  type AutonomyPolicyRow,
  type AutonomyPolicyView,
  type AutonomyMode,
} from "./repositories/autonomyPolicyRepository.js";
import {
  AUTO_MERGE_ENV,
  envFlagOn,
  isAutonomyAllowed,
  policyGrantsAuto,
} from "./services/autonomyPolicyService.js";
import {
  decideLandingState,
  type LandingFacts,
  type LandingHold,
  type LandingState,
} from "./services/landingState.js";
import {
  decideApproveOutcome,
  type ApproveOutcome,
  type ApproveOutcomeFacts,
  type ReviewMode,
} from "./services/approveOutcome.js";
import {
  PrincipalRepository,
  type PrincipalActorType,
  type PrincipalCapability,
  type PrincipalView,
} from "./repositories/principalRepository.js";
import {
  hashPrincipalToken,
  mintPrincipalToken,
  PRINCIPAL_NAME_RE,
  principalActor,
} from "./services/principalService.js";
export { BOARD_COLUMNS } from "./services/boardService.js";
export type { BoardColumn } from "./services/boardService.js";
import { SuggestionService, type RepoSuggestion } from "./services/suggestionService.js";
import { TransitionService, type TransitionResult } from "./services/transitionService.js";
import { buildNotifierFromEnv } from "./notify/config.js";
import type { NotifyEvent, NotifyKind, Notifier } from "./notify/types.js";
import { type Clock, systemClock } from "./util/clock.js";
import { DispatchError, notFound } from "./util/errors.js";
import { newId } from "./util/id.js";
import { agreedRequirementsFromTurns } from "./util/planClarifications.js";

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

/** BBT-001 global toggle: is the independent black-box testing lane ON? */
export { isTestingEnabled, testerProvenance } from "./util/testingLane.js";
import { isTestingEnabled } from "./util/testingLane.js";

/**
 * An evidence row enriched with derived provenance for the reviewer surface.
 * `recorded_by_agent` is TRUE iff the row's recording actor type was "agent"
 * (`recorded_by_actor_type === "agent"`) — i.e. evidence SELF-REPORTED by a
 * delivery agent, which the reviewer should weigh with more skepticism than
 * evidence recorded by a trusted principal (a human operator or the factory
 * system). Derived from the real recorded actor type — never fabricated; legacy
 * rows (null type) read as false, so no agent chip and no trust claim is asserted.
 */
export interface EvidenceView extends Evidence {
  recorded_by_agent: boolean;
}

export interface TicketView {
  ticket: Ticket;
  acceptanceCriteria: AcceptanceCriterion[];
  repositories: TicketRepoLink[];
  /** Confirmed (primary/secondary/implicit_repo) + suggested scope links. */
  scopes: TicketScopeWithNode[];
  blockingDecisions: Decision[];
  /**
   * Decisions linked to this ticket that a human has RESOLVED (accepted/rejected),
   * with the relation they were linked by. Carries `resolved_answer` — the answer
   * the agent reads (via get_ticket's `resolved_decisions`).
   */
  resolvedDecisions: Array<Decision & { relation: string }>;
  /**
   * EP-001: tickets this one must wait for, each with the depended-on ticket's
   * number/title/status and a `satisfied` flag (true once it's `done`). An
   * unsatisfied dependency blocks this ticket from being claimed.
   */
  dependencies: TicketDependencyView[];
  /** Recorded evidence rows (oldest first), so reviewers can judge inline. */
  evidence: EvidenceView[];
  events: WorkEvent[];
  /**
   * BBT-001: the parsed test_contract (or null). Surfaced as a structured object
   * so CLI callers and the API never receive a JSON-in-JSON string.
   */
  testContract: TestContract | null;
  /**
   * FAILURE-DIAGNOSIS: the full ordered rework failure trail (attempt 1 → 2 → …),
   * each with the distilled failing test + assertion/stack. Empty for a ticket that
   * never bounced. Powers the ticket-detail "why did #N fail" history.
   */
  reworkTrail: ReworkAttempt[];
  /**
   * PER-REPOSITORY LANDING: the approved commit of each write repo (its current review
   * pin) and whether that commit has landed on the repo's default branch. A ticket is
   * done only when every one has; `partial` marks a held, partly merged ticket.
   */
  landing: LandingStatus;
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
export type {
  ClaimabilityResult,
  EditTicketResult,
  TicketWarning,
} from "./services/ticketService.js";

/** Result of setting a ticket↔repo access boundary. */
export type { TicketRepoAccessResult } from "./services/repoService.js";

export type {
  BoardCard,
  BoardCardClaim,
  BoardArea,
  BoardColumnView,
  BoardView,
  BoardWindow,
  CycleTimeStat,
  StuckTicket,
  RepoProgress,
  DashboardSummary,
} from "./services/boardService.js";
// NOTE: BOARD_COLUMNS and BoardColumn are exported via top-of-file export statements.

/** Input for resolving a decision via the human surface. */
export type { ResolveDecisionInput } from "./services/decisionService.js";

/** The human-owned queue read model (Track 2a — "What I own"). */
export type {
  HumanQueue,
  HumanQueueItem,
  HumanQueueKind,
  HumanQueueCounts,
  HumanQueueTicketRef,
} from "./services/humanQueueService.js";

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
/**
 * USAGE-WINDOW PAUSE as a landing fact: while the runner's pause file holds a pause no
 * tick runs, so the merge lane lands nothing until it ends (health/usagePause.ts reads
 * the file exactly as the runner does). Null when no pause is active.
 */
function usagePauseFact(
  env: NodeJS.ProcessEnv,
): { until: string; kind: "usage_limit" | "rate_limit" } | null {
  const p = readUsagePause(env);
  return p.active ? { until: p.paused_until ?? "its end", kind: p.kind ?? "usage_limit" } : null;
}

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
  readonly reworkAttempts: ReworkAttemptRepository;
  readonly pausedDeliveries: PausedDeliveryRepository;
  readonly specsRepo: SpecRepository;
  readonly specCoverageRepo: SpecCoverageRepository;
  /** GRADUATED-AUTONOMY (Spec 2, Phase 3): the per-(repo × risk × gate) enablement store. */
  readonly autonomyPolicy: AutonomyPolicyRepository;
  readonly principals: PrincipalRepository;
  /** SQUAD (v27): the club identity row. */
  readonly clubRepo: ClubRepository;
  readonly transitions: TransitionService;
  readonly claims: ClaimService;
  readonly suggestions: SuggestionService;
  readonly scope: ScopeService;
  readonly decisionSvc: DecisionService;
  readonly ticketSvc: TicketService;
  readonly repoSvc: RepoService;
  readonly epicsSvc: EpicsService;
  readonly specsSvc: SpecsService;
  readonly specCoverageSvc: SpecCoverageService;
  readonly boardSvc: BoardService;
  readonly dossierSvc: DossierService;
  readonly reviewPacketSvc: ReviewPacketService;
  readonly reviewGateSvc: ReviewGateService;
  readonly autonomyRecommendations: AutonomyRecommendationService;
  readonly pauseSvc: PauseService;
  readonly humanQueueSvc: HumanQueueService;
  /** SQUAD: club identity + agent display names / shirt numbers (presentation only). */
  readonly squadSvc: SquadService;
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
  get maxAttempts(): number {
    // Read per use, not once at startup: DISPATCH_MAX_ATTEMPTS saved from Settings
    // lands in this process's env (writeSettings), and a long-running dashboard must
    // enforce the cap the operator just saved.
    return this.maxAttemptsOverride ?? resolveMaxAttempts();
  }
  private readonly maxAttemptsOverride: number | undefined;

  /**
   * BBT-001: per-instance override for the `GAFFER_TESTING` toggle. `undefined`
   * (the default) means "read the env via {@link isTestingEnabled}"; a boolean
   * pins it for tests so the testing lane can be exercised without touching the
   * process env.
   */
  private readonly testingEnabledOverride: boolean | undefined;
  private readonly requireRegisteredAgentApprover: boolean;

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
    options: {
      maxAttempts?: number;
      testingEnabled?: boolean;
      notifier?: Notifier;
      /**
       * REVIEWER ≠ AUTHOR, strengthened: when true an `agent` actor may approve a review
       * only if its id is a REGISTERED agent (a bare string such as "<agent>/reviewer" is
       * refused), so the not-author rule compares two registered principals. Every
       * production entry point (CLI, REST, MCP) opens with this on; the library default
       * is off so in-memory fixtures can approve with literal actor ids.
       */
      requireRegisteredAgentApprover?: boolean;
    } = {},
  ) {
    this.db = db;
    this.gitRunner = gitRunner;
    this.maxAttemptsOverride = options.maxAttempts;
    this.testingEnabledOverride = options.testingEnabled;
    this.requireRegisteredAgentApprover = options.requireRegisteredAgentApprover ?? false;
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
    this.reworkAttempts = new ReworkAttemptRepository(db);
    this.pausedDeliveries = new PausedDeliveryRepository(db);
    this.specsRepo = new SpecRepository(db);
    this.specCoverageRepo = new SpecCoverageRepository(db);
    this.autonomyPolicy = new AutonomyPolicyRepository(db);
    this.principals = new PrincipalRepository(db);
    this.clubRepo = new ClubRepository(db);
    this.squadSvc = new SquadService({
      db,
      clock: this.clock,
      agents: this.agents,
      club: this.clubRepo,
    });
    this.transitions = new TransitionService(db, clock, gitRunner, this.pausedDeliveries);
    this.claims = new ClaimService(db, clock, this.transitions);
    this.suggestions = new SuggestionService({
      repos: this.repos,
      scopeNodes: this.scopeNodes,
      scopeRepos: this.scopeRepos,
      scopeEdges: this.scopeEdges,
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
    this.specsSvc = new SpecsService({
      db,
      clock: this.clock,
      specs: this.specsRepo,
      // Freeze seeds each clause into Memory as gated draft lore (Phase 2b).
      // Live when MEMORY_CLI_BIN + MEMORY_DB are set; a no-op otherwise, so the
      // standalone/offline path and unit tests are unaffected.
      clauseSeeder: resolveSpecClauseSeeder(),
    });
    this.specCoverageSvc = new SpecCoverageService({
      specs: this.specsRepo,
      coverage: this.specCoverageRepo,
      // Best-effort seeded-lore status via the Memory CLI when wired; a no-op
      // (`unknown` for every clause) otherwise, so the read never blocks.
      loreReader: resolveSpecLoreReader(),
    });
    this.boardSvc = new BoardService({
      db,
      clock: this.clock,
      tickets: this.tickets,
      acs: this.acs,
      decisions: this.decisions,
      claimsRepo: this.claimsRepo,
      events: this.events,
      repos: this.repos,
      agentDisplays: () => this.squadSvc.displayMap(),
    });
    this.dossierSvc = new DossierService({
      db,
      clock: this.clock,
      acs: this.acs,
      evidence: this.evidence,
      repoDeliveries: this.repoDeliveries,
    });
    this.reviewPacketSvc = new ReviewPacketService({
      db,
      acs: this.acs,
      evidence: this.evidence,
      reworkAttempts: this.reworkAttempts,
      maxAttempts: this.maxAttempts,
      // Mirrors approveReview's routing: an acceptance ticket always goes through the
      // tester; a testable one does when the testing lane is on.
      testerExpected: (t) =>
        t.acceptance === 1 ||
        ((this.testingEnabledOverride ?? isTestingEnabled()) && t.can_be_tested === 1),
    });
    this.reviewGateSvc = new ReviewGateService({
      db,
      clock: this.clock,
      tickets: this.tickets,
      acs: this.acs,
      evidence: this.evidence,
      transitions: this.transitions,
      ticketSvc: this.ticketSvc,
      maxAttempts: () => this.maxAttempts,
      testingEnabledOverride: this.testingEnabledOverride,
      // REVIEWER ≠ AUTHOR: the agents table, so an agent approver can be checked to be a
      // registered principal (see requireRegisteredAgentApprover).
      agents: this.agents,
      requireRegisteredAgentApprover: this.requireRegisteredAgentApprover,
      onTicketParked: (ticket, detail) => {
        this.emitGate("ticket_parked", ticket, { status: "blocked", detail });
      },
      // GRADUATED-AUTONOMY (Spec 2, Phase 1): resolve delivery-vs-merge SHAs so the
      // approve path can emit `approved_unchanged`. Pure read; degrades to unknown.
      approvalShaResolver: (ticket) => this.resolveApprovalShas(ticket),
      // REVIEW PIN for a HUMAN approval: the commit the human approved (the primary write
      // repo's delivery-branch head at approve time), recorded as system evidence so every
      // landing path holds a branch that moved past it. Pure read; null when unknown.
      reviewedHeadsResolver: (ticket) => this.resolveApprovedHeads(ticket),
      // APPROVAL COVERS EVERY WRITE REPO: the write repos whose head cannot be read now.
      unavailableWriteReposResolver: (ticket) => this.writeRepoHeads(ticket).unavailable,
      // PER-REPOSITORY LANDING: git ancestry as positive evidence of a landing.
      landedOnDefaultResolver: (repoId, sha) => this.commitOnDefaultBranch(repoId, sha),
      // PR LANDINGS: the approved change carried by the default branch (or its remote copy).
      changeOnRefsResolver: (repoId, sha, refs) => this.changeOnRefs(repoId, sha, refs),
      // GRADUATED-AUTONOMY (Spec 2, Phase 3): the pure-policy predicate the P0 gate
      // ORs with the env flag — true iff a mode='auto' approve policy covers every
      // write repo at this ticket's risk. NO env read here (that stays in the gate).
      policyAllowsAgentApprove: (ticket) =>
        policyGrantsAuto(
          this.autonomyPolicy,
          this.writeRepoIdsForTicket(ticket),
          ticket.risk_level,
          "approve",
        ),
      // OBSERVED-RISK ESCALATION (Trust & Autonomy, security-critical): on the AUTO-SHIP
      // path only, resolve the OBSERVED risk from the REAL server-computed diff (reusing
      // computeTicketDiff + the advisory risk-annotation overlay) so the gate can hold for
      // a human when observed exceeds the DECLARED risk_level. Pure read; a throw degrades
      // to indeterminate (fail toward human). Never grants an approval.
      // GATE INTEGRITY: plus the runner's integrity FLAG from the latest trusted DoD
      // record (what the worktree held that the committed diff cannot show, e.g. a
      // git-ignored .npmrc), unless a human allowed test changes on the ticket.
      observedRiskResolver: (ticket) => this.observedRiskFor(ticket),
    });
    this.autonomyRecommendations = new AutonomyRecommendationService({
      reviewDecisions: () => this.events.reviewDecisions(),
    });
    this.pauseSvc = new PauseService({
      db,
      clock: this.clock,
      tickets: this.tickets,
      paused: this.pausedDeliveries,
      transitions: this.transitions,
      ticketSvc: this.ticketSvc,
      // A pause is a needs-human-review checkpoint — route it through the same
      // ticket_parked gate as the retry-cap park so the existing sinks fire.
      onTicketPaused: (ticket, detail) => {
        this.emitGate("ticket_parked", ticket, { status: "paused", detail });
      },
    });
    this.humanQueueSvc = new HumanQueueService({
      clock: this.clock,
      decisions: this.decisions,
      tickets: this.tickets,
      events: this.events,
      dependencies: this.ticketDependencies,
      landingStatus: (ticketId) => computeLandingStatus(this.db, ticketId),
      pausedDelivery: (ticketId) => this.pausedDeliveries.find(ticketId),
    });
  }

  /** Open a Dispatch instance against a SQLite file (or ":memory:"). */
  static open(
    path: string,
    clock: Clock = systemClock,
    gitRunner?: GitRunner,
    options: {
      maxAttempts?: number;
      testingEnabled?: boolean;
      notifier?: Notifier;
      /**
       * REVIEWER ≠ AUTHOR, strengthened: when true an `agent` actor may approve a review
       * only if its id is a REGISTERED agent (a bare string such as "<agent>/reviewer" is
       * refused), so the not-author rule compares two registered principals. Every
       * production entry point (CLI, REST, MCP) opens with this on; the library default
       * is off so in-memory fixtures can approve with literal actor ids.
       */
      requireRegisteredAgentApprover?: boolean;
    } = {},
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
  /**
   * GATE INTEGRITY: the latest DoD checklist the runner recorded on a ticket (a
   * `test_output` evidence row whose summary starts `DoD: `), ignoring rows an agent
   * recorded (an agent cannot mask the runner's FLAG with a cleaner checklist).
   * Null when there is none. Pure read.
   */
  latestDodSummary(ticketId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT summary FROM evidence
          WHERE ticket_id = ? AND evidence_type = 'test_output' AND summary LIKE 'DoD: %'
            AND (recorded_by_actor_type IS NULL OR recorded_by_actor_type <> 'agent')
          ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(ticketId) as { summary: string } | undefined;
    return row?.summary ?? null;
  }

  /**
   * OBSERVED RISK of a delivery as the auto-ship gate reads it (enforceObservedRiskCeiling):
   * the real diff's risk annotations, plus — unless a human allowed test changes on the
   * ticket — the runner's integrity FLAG from the latest trusted DoD record. Its `holds`
   * are the GATE INTEGRITY hard holds: an agent or auto approval is refused while any is
   * present; a human approval is not. `repos` reuses a diff already read.
   */
  observedRiskFor(ticket: Ticket, repos?: readonly RepoDiff[]): ObservedRisk {
    const observed = observedRisk(repos ?? this.ticketDiff(ticket.id).repos);
    if (ticket.allow_test_changes === 1) return observed;
    return withRunnerIntegrityHolds(
      observed,
      runnerIntegrityHolds(this.latestDodSummary(ticket.id)),
    );
  }

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

  /**
   * GRADUATED-AUTONOMY (Spec 2, Phase 1): resolve the delivery-vs-merge SHAs for a
   * ticket's WRITE repos so {@link ReviewGateService.approveReview} can emit an honest
   * `approved_unchanged` signal. The delivery SHA is the recorded per-repo
   * `commit_sha`; the merge SHA is the current head of the delivery branch
   * (`git rev-parse <branch>`). Returns a representative pair the pure
   * {@link approvalUnchanged} helper maps to unchanged/edited/unknown:
   *   - any write repo edited (both SHAs known and differing) → an unequal pair;
   *   - else every write repo known-and-unchanged → an equal pair;
   *   - any repo indeterminate (no delivery SHA / branch / on-disk repo / git error)
   *     → a null pair (unknown — never overstate agreement).
   * Pure read; a missing git runner or no write repos yields `null` (unknown).
   */
  private resolveApprovalShas(ticket: Ticket): ApprovalShas | null {
    // Fall back to a real `git` spawn when no runner was injected — EVERY production
    // entrypoint (api/bin, cli, mcp/server) opens Dispatch without one, so gating this on
    // an injected runner made `approved_unchanged` ALWAYS null in prod (the merge half of
    // graduated autonomy could never fire). Mirrors computeTicketDiff's defaultGitRunner
    // fallback. Indeterminate repos still yield an unknown pair below (never overstate).
    const runGit = this.gitRunner ?? defaultGitRunner;
    const links = this.repos.accessLinksForTicket(ticket.id);
    const writeRepos = links.filter(
      (l) => isActiveTicketRepoRelation(l.relation) && l.access === "write",
    );
    if (writeRepos.length === 0) return null;

    const pairs: ApprovalShas[] = writeRepos.map((repo) => {
      const delivery = this.repoDeliveries.find(ticket.id, repo.id);
      const deliverySha = delivery?.commit_sha ?? null;
      const branch =
        delivery?.branch_name ??
        this.repos.ticketRepoBranch(ticket.id, repo.id) ??
        ticket.branch_name;
      if (!deliverySha || !branch || !repo.local_path || !existsSync(repo.local_path)) {
        return { deliverySha, mergeSha: null };
      }
      const res = runGit(repo.local_path, ["rev-parse", branch]);
      const mergeSha = res.status === 0 ? res.stdout.trim() || null : null;
      return { deliverySha, mergeSha };
    });

    const known = (p: ApprovalShas): boolean => p.deliverySha !== null && p.mergeSha !== null;
    const edited = pairs.find((p) => known(p) && p.deliverySha !== p.mergeSha);
    if (edited) return edited; // a real edited pair → helper returns false.
    if (pairs.some((p) => !known(p))) return { deliverySha: null, mergeSha: null }; // unknown.
    return pairs[0] ?? null; // all known-and-equal → an unchanged pair.
  }

  /**
   * REVIEW PIN: the current delivery-branch head of EVERY active write repo on the ticket
   * (the same repos, branch resolution and `rev-parse` the review diff uses — see
   * diffService.resolveBranchHead — so the commit the Review view showed and the commit
   * compared here are resolved one way). A repo that is not on disk or whose branch does
   * not resolve yields no entry (nothing to compare, pin or land). Pure read.
   */
  private resolveApprovedHeads(ticket: Ticket): ReviewedHead[] {
    return this.writeRepoHeads(ticket).heads;
  }

  /**
   * Every ACTIVE write repo's delivery head, and the write repos whose head cannot be read
   * now (no checkout on this machine, an unreadable path, no delivery branch, a branch git
   * cannot find). The approval pins the heads and is refused while any repo is unavailable
   * (an approval covers every write repo); the Review button's outcome reads the same list.
   */
  writeRepoHeads(ticket: Ticket): { heads: ReviewedHead[]; unavailable: UnavailableWriteRepo[] } {
    const runGit = this.gitRunner ?? defaultGitRunner;
    const heads: ReviewedHead[] = [];
    const unavailable: UnavailableWriteRepo[] = [];
    for (const repo of this.repos.accessLinksForTicket(ticket.id)) {
      if (!isActiveTicketRepoRelation(repo.relation) || repo.access !== "write") continue;
      const miss = (kind: NonNullable<UnavailableWriteRepo["kind"]>, why: string) =>
        unavailable.push({ repoId: repo.id, repo: repo.name, why, kind });
      if (!repo.local_path) {
        miss("no_checkout", "it has no checkout on this machine");
        continue;
      }
      if (!existsSync(repo.local_path)) {
        miss("unreadable_checkout", `its checkout ${repo.local_path} cannot be read`);
        continue;
      }
      const branch =
        this.repos.ticketRepoBranch(ticket.id, repo.id) ??
        this.repoDeliveries.find(ticket.id, repo.id)?.branch_name ??
        ticket.branch_name;
      if (!branch || branch.trim() === "") {
        miss("no_branch", "it has no delivery branch");
        continue;
      }
      const sha = resolveBranchHead(runGit, repo.local_path, branch);
      if (sha) heads.push({ repoId: repo.id, repo: repo.name, branch, sha });
      else miss("branch_missing", `its delivery branch ${branch} cannot be resolved`);
    }
    return { heads, unavailable };
  }

  /** True when `sha` is contained in the repo's default branch (a verified landing). */
  private commitOnDefaultBranch(repoId: string, sha: string): boolean {
    const repo = this.repos.findById(repoId);
    if (!repo || !repo.local_path || !existsSync(repo.local_path)) return false;
    const runGit = this.gitRunner ?? defaultGitRunner;
    const res = runGit(repo.local_path, [
      "merge-base",
      "--is-ancestor",
      sha,
      `refs/heads/${repo.default_branch || "main"}`,
    ]);
    return res.status === 0;
  }

  /**
   * PR LANDINGS (exploratory finding cli-wg/F-01): does any of `refs` carry the change of
   * `sha`? "default" is the local default branch, "remote-default" every remote-tracking
   * ref of it. A ref carries it when `sha` is its ancestor (a merge commit) or when merging
   * `sha` into it changes nothing (`git merge-tree --write-tree` gives the ref's own tree:
   * a squash or rebase merge of that change already applied). → null when none of the
   * refs exists here (or the checkout is missing), else true/false.
   */
  private changeOnRefs(
    repoId: string,
    sha: string,
    refs: ReadonlyArray<"default" | "remote-default">,
  ): boolean | null {
    const repo = this.repos.findById(repoId);
    if (!repo || !repo.local_path || !existsSync(repo.local_path)) return null;
    const cwd = repo.local_path;
    const runGit = this.gitRunner ?? defaultGitRunner;
    const def = repo.default_branch || "main";
    const names: string[] = [];
    for (const r of refs) {
      if (r === "default") names.push(`refs/heads/${def}`);
      else {
        const listed = runGit(cwd, ["for-each-ref", "--format=%(refname)", "refs/remotes/"]);
        if (listed.status === 0)
          for (const line of listed.stdout.split("\n")) {
            const name = line.trim();
            if (name.endsWith(`/${def}`) && name.split("/").length === 4) names.push(name);
          }
      }
    }
    let anyRef = false;
    for (const ref of names) {
      const tip = runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      if (tip.status !== 0 || tip.stdout.trim() === "") continue;
      anyRef = true;
      if (runGit(cwd, ["merge-base", "--is-ancestor", sha, ref]).status === 0) return true;
      const tree = runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{tree}`]);
      const merged = runGit(cwd, ["merge-tree", "--write-tree", ref, sha]);
      if (
        tree.status === 0 &&
        merged.status === 0 &&
        merged.stdout.split("\n")[0]?.trim() === tree.stdout.trim()
      )
        return true;
    }
    return anyRef ? false : null;
  }

  // --- Graduated Autonomy policy (Spec 2, Phase 3) -------------------------

  /**
   * The repo ids a ticket actually WRITES to (active relation + write access) — the
   * set the autonomy policy must cover for an auto grant. Mirrors the write-repo
   * filter used by {@link resolveApprovalShas}. A ticket with no write repo yields an
   * empty set, which the enforcement treats as "never auto" (fail-closed).
   */
  private writeRepoIdsForTicket(ticket: Ticket): string[] {
    return this.repos
      .accessLinksForTicket(ticket.id)
      .filter((l) => isActiveTicketRepoRelation(l.relation) && l.access === "write")
      .map((l) => l.id);
  }

  /**
   * GRADUATED-AUTONOMY (Spec 2, Phase 3): the READ-ONLY ship-decision surface the AFK
   * runner consults per ticket instead of the raw AUTO_MERGE/MERGE_ON_AGENT_REVIEW flags
   * (`wg ticket auto-decision <N> --gate approve|merge`). Pure — reuses the SAME
   * {@link isAutonomyAllowed} the approve/merge chokepoints use (env floor OR an `auto`
   * policy covering this ticket's risk × EVERY write repo), so the runner adds NO policy
   * logic and can never diverge from the enforced decision. No mutation, no side effects.
   * FAIL-CLOSED by construction: an empty write-repo set ⇒ deny; any uncovered write repo
   * ⇒ deny; risk/gate match exactly. Returns the decision plus the (repo, risk) context it
   * was computed over so the runner can log WHY a ticket held.
   */
  autonomyGateDecision(
    ticket: Ticket,
    gate: AutonomyPolicyGate,
  ): {
    gate: AutonomyPolicyGate;
    decision: "allow" | "deny";
    risk_level: string;
    write_repo_ids: string[];
  } {
    const writeRepoIds = this.writeRepoIdsForTicket(ticket);
    const allowed = isAutonomyAllowed(this.autonomyPolicy, writeRepoIds, ticket.risk_level, gate);
    return {
      gate,
      decision: allowed ? "allow" : "deny",
      risk_level: ticket.risk_level,
      write_repo_ids: writeRepoIds,
    };
  }

  /** Every stored autonomy policy joined to its repo name (Settings surface). */
  listAutonomyPolicies(): AutonomyPolicyView[] {
    return this.autonomyPolicy.list();
  }

  /**
   * GRADUATED-AUTONOMY (Spec 2, Phase 3): enable/disable an autonomy policy for
   * (repo × risk × gate). Enabling (mode !== 'off') is the trust-boundary action and
   * requires an EXPLICIT confirm (LOCKED posture: the operator confirms with the
   * evidence shown) — on enable we SNAPSHOT the current recommendation evidence into
   * `evidence_json` so there is an audit trail of WHY auto was granted. Reversible:
   * mode='off' clears the enablement (and re-gates via the env fallback). Idempotent
   * upsert keyed on (repo, risk, gate).
   */
  setAutonomyPolicy(
    input: {
      repoId: string;
      riskLevel: RiskLevel;
      gate: AutonomyPolicyGate;
      mode: AutonomyMode;
      confirm?: boolean;
    },
    actor: Actor,
  ): AutonomyPolicyRow {
    const repo = this.repos.findById(input.repoId);
    if (!repo) throw notFound("repository", input.repoId);
    // Trust boundary: enabling any non-off mode demands an explicit confirmation that
    // the operator saw the evidence. Disabling (off) is always allowed (fail-safe).
    if (input.mode !== "off" && input.confirm !== true) {
      throw new DispatchError(
        "VALIDATION_ERROR",
        "Enabling an autonomy policy requires an explicit confirmation (confirm: true) that the evidence was reviewed.",
        { gate: input.gate, mode: input.mode },
      );
    }
    const now = this.clock.now();
    const actorRef = actor.id ?? actor.type;
    const enabling = input.mode !== "off";
    // Snapshot the recommendation evidence shown at enable time (audit trail). The
    // recommendation service only speaks to approve/merge; a memory gate (or a repo
    // with no live recommendation) snapshots a null recommendation, which is honest.
    let evidenceJson: string | null = null;
    if (enabling) {
      const rec =
        this.autonomyRecommendationsList().find(
          (r) =>
            r.repoId === input.repoId &&
            r.riskLevel === input.riskLevel &&
            r.gate === (input.gate as typeof r.gate),
        ) ?? null;
      evidenceJson = JSON.stringify({
        snapshot_at: now,
        confirmed_by: actorRef,
        recommendation: rec,
      });
    }
    return this.autonomyPolicy.upsert({
      id: newId(),
      repoId: input.repoId,
      riskLevel: input.riskLevel,
      gate: input.gate,
      mode: input.mode,
      enabledBy: enabling ? actorRef : null,
      enabledAt: enabling ? now : null,
      evidenceJson,
      now,
    });
  }

  // --- Per-principal API credentials -----------------------------------------

  /**
   * Mint a named bearer credential bound to an actor identity and a capability.
   * Returns the token ONCE (it is never stored — only its SHA-256). The creating
   * actor and the new principal's identity are recorded as a `principal.created`
   * event so the credential's provenance is in the tamper-evident log.
   */
  createPrincipal(
    input: {
      name: string;
      capability?: PrincipalCapability | undefined;
      actorType?: PrincipalActorType | undefined;
      actorId?: string | undefined;
    },
    actor: Actor,
  ): { principal: PrincipalView; token: string } {
    const name = String(input.name ?? "").trim();
    if (!PRINCIPAL_NAME_RE.test(name)) {
      throw new DispatchError(
        "VALIDATION_ERROR",
        "Principal name must be 1–64 characters: letters, digits, '.', '_', '@' or '-', starting with a letter or digit.",
        { name },
      );
    }
    if (this.principals.getByName(name)) {
      throw new DispatchError("DUPLICATE", `A principal named '${name}' already exists.`, { name });
    }
    const capability = input.capability ?? "full";
    const actorType = input.actorType ?? "human";
    const actorId = String(input.actorId ?? name).trim() || name;
    // IDENTITY COLLISION (exploratory finding api/F8): a principal (human or admin) may not
    // speak as a registered agent's id. One recorded "human/<agent id>" approval on that agent's
    // own delivery, and the dashboard showed the delivering agent as its own approver.
    // Case-insensitively: an agent id in capitals is the same id to a reader.
    const agentWithId = this.db
      .prepare("SELECT id FROM agents WHERE lower(id) = lower(?) LIMIT 1")
      .get(actorId) as { id: string } | undefined;
    if (agentWithId) {
      throw new DispatchError(
        "DUPLICATE",
        `actor_id '${actorId}' is a registered agent's id; a ${actorType} principal needs its own identity (pick another actor_id). Nothing was created.`,
        { reason: "actor_id_is_agent", actor_id: actorId, actor_type: actorType },
      );
    }
    const token = mintPrincipalToken();
    const now = this.clock.now();
    const principal = inTransaction(this.db, () => {
      const row = this.principals.insert({
        id: newId(),
        name,
        tokenHash: hashPrincipalToken(token),
        capability,
        actorType,
        actorId,
        createdBy: actor.id ?? actor.type,
        now,
      });
      writeEvent(this.db, {
        entity_type: "principal",
        entity_id: row.id,
        actor,
        event_type: "principal.created",
        payload: { name, capability, actor_type: actorType, actor_id: actorId },
      });
      return row;
    });
    return { principal, token };
  }

  /** Every principal, newest first, revoked ones included (never the hash). */
  listPrincipals(): PrincipalView[] {
    return this.principals.list();
  }

  /** One principal by id or name (revoked ones included). Throws NOT_FOUND. */
  getPrincipal(ref: string): PrincipalView {
    const row = this.principals.get(ref) ?? this.principals.getByName(ref);
    if (!row) throw notFound("principal", ref);
    return row;
  }

  /** Revoke by id or name. Idempotent on an already-revoked principal (NO_OP). */
  revokePrincipal(ref: string, actor: Actor): PrincipalView {
    const row = this.principals.get(ref) ?? this.principals.getByName(ref);
    if (!row) throw notFound("principal", ref);
    if (row.revoked_at) {
      throw new DispatchError("NO_OP", `Principal '${row.name}' is already revoked.`, {
        id: row.id,
      });
    }
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      this.principals.revoke(row.id, now);
      writeEvent(this.db, {
        entity_type: "principal",
        entity_id: row.id,
        actor,
        event_type: "principal.revoked",
        payload: { name: row.name },
      });
      const after = this.principals.get(row.id);
      if (!after) throw notFound("principal", ref);
      return after;
    });
  }

  /**
   * Authenticate a bearer credential against the ACTIVE principals. Returns the
   * principal and the actor it speaks for, or null for an unknown/revoked token.
   * Stamps `last_used_at` at most once a minute per principal (best-effort).
   */
  resolvePrincipalToken(token: string): { principal: PrincipalView; actor: Actor } | null {
    const row = this.principals.findActiveByHash(hashPrincipalToken(token));
    if (!row) return null;
    const now = this.clock.now();
    if (!row.last_used_at || Date.parse(now) - Date.parse(row.last_used_at) > 60_000) {
      try {
        this.principals.touch(row.id, now);
      } catch {
        // A usage stamp must never fail authentication.
      }
    }
    return { principal: row, actor: principalActor(row) };
  }

  // --- Tickets -------------------------------------------------------------

  createTicket(raw: unknown, actor: Actor): Ticket {
    return this.ticketSvc.createTicket(raw, actor);
  }

  /**
   * Create a ticket AND its links in ONE transaction: the primary repo, the scope
   * nodes (the first primary, the rest secondary) and the confirmed per-repo access.
   * A bad reference (unknown repo or scope node) rolls the whole create back, so a
   * failed POST /tickets or MCP create_ticket never leaves an orphan draft for a
   * retry to duplicate. (better-sqlite3 nests the services' own transactions as
   * savepoints, as createDraftTicket already relies on.)
   */
  createTicketWithLinks(
    raw: unknown,
    links: {
      repo?: string | undefined;
      scopeNodeIds?: readonly string[] | undefined;
      repoAccess?: ReadonlyArray<{ repo_id: string; access: string }> | undefined;
    },
    actor: Actor,
  ): Ticket {
    return inTransaction(this.db, () => {
      const ticket = this.ticketSvc.createTicket(raw, actor);
      if (links.repo) this.repoSvc.linkRepository(ticket.id, links.repo, "primary", actor);
      (links.scopeNodeIds ?? []).forEach((scopeNodeId, i) => {
        this.linkTicketScope(
          {
            ticket_id: ticket.id,
            scope_node_id: scopeNodeId,
            relation: i === 0 ? "primary" : "secondary",
          },
          actor,
        );
      });
      for (const r of links.repoAccess ?? []) {
        this.repoSvc.setTicketRepoAccess(
          { ticket_id: ticket.id, repo_id: r.repo_id, access: r.access, relation: "confirmed" },
          actor,
        );
      }
      return ticket;
    });
  }

  /** TRACK-3a: set or clear a ticket's per-ticket delivery-budget ceiling (USD). */
  setDeliveryBudget(raw: unknown, actor: Actor): Ticket {
    return this.ticketSvc.setDeliveryBudget(raw, actor);
  }

  addAcceptanceCriterion(raw: unknown, actor: Actor): { ac: AcceptanceCriterion; eventId: string } {
    return this.ticketSvc.addAcceptanceCriterion(raw, actor);
  }

  /** Warnings for a just-created ticket (a pack that will refuse it at ready). */
  ticketCreateWarnings(ticket: Ticket): TicketWarning[] {
    return this.ticketSvc.createWarnings(ticket);
  }

  /** Edit a ticket's title / description / policy / priority (contract-frozen once claimed). */
  editTicket(ref: string, raw: unknown, actor: Actor): EditTicketResult {
    return this.ticketSvc.editTicket(ref, raw, actor);
  }

  /** Edit one acceptance criterion (id, id prefix or 1-based position). */
  editAcceptanceCriterion(
    ticketRef: string,
    acRef: string,
    raw: unknown,
    actor: Actor,
  ): { ac: AcceptanceCriterion; eventId: string } {
    return this.ticketSvc.editAcceptanceCriterion(ticketRef, acRef, raw, actor);
  }

  /** Remove one acceptance criterion (id, id prefix or 1-based position). */
  removeAcceptanceCriterion(
    ticketRef: string,
    acRef: string,
    actor: Actor,
  ): { acId: string; eventId: string } {
    return this.ticketSvc.removeAcceptanceCriterion(ticketRef, acRef, actor);
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
    // PLANNING CLARIFICATIONS: a plan confirmed from a plan session carries the answers
    // the human gave during clarification into the acceptance contract, unless the
    // caller sent its own (reviewed) list. An unknown session id is refused — the
    // caller asked for answers that cannot be found.
    const body = raw as { plan_session_id?: unknown; epic?: { agreed_requirements?: unknown } };
    if (
      body &&
      typeof body === "object" &&
      typeof body.plan_session_id === "string" &&
      body.plan_session_id.trim() !== "" &&
      body.epic &&
      typeof body.epic === "object" &&
      body.epic.agreed_requirements === undefined
    ) {
      const session = this.getPlanSession(body.plan_session_id.trim());
      if (!session) throw notFound("plan_session", body.plan_session_id);
      let turns: Array<{ role: "user" | "assistant"; content: string }> = [];
      try {
        const parsed = JSON.parse(session.messages_json) as unknown;
        if (Array.isArray(parsed)) turns = parsed as typeof turns;
      } catch {
        turns = [];
      }
      raw = {
        ...body,
        epic: { ...body.epic, agreed_requirements: agreedRequirementsFromTurns(turns) },
      };
    }
    return this.epicsSvc.createEpic(raw, actor);
  }

  // --- Specs (Spec-Driven Development, Phase 1a) ---------------------------

  /**
   * Create a spec (always `draft`): a title, brief, and an ordered set of clauses
   * (each a testable requirement / non-goal / decision). Clause ids are minted
   * server-side when absent and preserved thereafter, so a later phase can thread
   * provenance from a clause down to acceptance criteria.
   */
  createSpec(raw: unknown, actor: Actor): Spec {
    return this.specsSvc.createSpec(raw, actor);
  }

  /**
   * cli-wg/F-16: does any spec carry a clause with this (namespaced) id? `ac add
   * --clause` checks it so an AC's spec_clause_id provenance always points at a clause.
   */
  specClauseExists(clauseId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS hit FROM specs s, json_each(s.clauses_json) c
          WHERE json_extract(c.value, '$.clause_id') = ? LIMIT 1`,
      )
      .get(clauseId) as { hit: number } | undefined;
    return row !== undefined;
  }

  /** Fetch a spec by id (throws NOT_FOUND when absent). */
  getSpec(id: string): Spec {
    return this.specsSvc.getSpec(id);
  }

  /** List specs newest-first, optionally filtered by status. */
  listSpecs(status?: SpecStatus): Spec[] {
    return this.specsSvc.listSpecs(status);
  }

  /**
   * Replace a DRAFT spec's clauses. Rejected on a non-draft (frozen/superseded)
   * spec — a frozen spec is immutable.
   */
  updateSpecClauses(id: string, raw: unknown, actor: Actor): Spec {
    return this.specsSvc.updateSpecClauses(id, raw, actor);
  }

  /**
   * Freeze a spec (draft→frozen). INVARIANT: a frozen spec is immutable — only a
   * `draft` spec can be frozen; freezing a non-draft spec is rejected.
   */
  freezeSpec(id: string, actor: Actor): Spec {
    return this.specsSvc.freezeSpec(id, actor);
  }

  /**
   * TRACEABILITY (Phase 3): the coverage read model for a spec — per clause, the
   * covering ACs, whether it is covered / satisfied / an orphan (the gap report),
   * and the bounce count from the rework trail, plus a spec-level rollup. Throws
   * NOT_FOUND when the spec is absent. Pure read — never mutates the board.
   */
  specCoverage(id: string): SpecCoverage {
    return this.specCoverageSvc.specCoverage(id);
  }

  // --- Repositories --------------------------------------------------------

  registerRepository(raw: unknown, actor: Actor): Repository {
    return this.repoSvc.registerRepository(raw, actor);
  }

  /** WG-006: hide or un-hide a repo (by id or name). */
  setRepoHidden(repoRef: string, hidden: boolean, actor: Actor): Repository {
    return this.repoSvc.setRepoHidden(repoRef, hidden, actor);
  }

  /** Set a repo's default branch (the base delivery worktrees branch off). */
  setRepoDefaultBranch(repoRef: string, branch: string, actor: Actor): Repository {
    return this.repoSvc.setRepoDefaultBranch(repoRef, branch, actor);
  }

  /** Set a repo's DoD gate commands (test / lint / coverage); see RepoService.setRepoCommands. */
  setRepoCommands(repoRef: string, input: unknown, actor: Actor): Repository {
    return this.repoSvc.setRepoCommands(repoRef, input, actor);
  }

  linkRepository(ticketId: string, repoName: string, role: string, actor: Actor): void {
    return this.repoSvc.linkRepository(ticketId, repoName, role, actor);
  }

  // --- Ticket scope links (WG-001) -----------------------------------------

  linkTicketScope(raw: unknown, actor: Actor): TicketScopeNode {
    return inTransaction(this.db, () => {
      const link = this.scope.linkTicketScope(raw, actor);
      this.wireEpicAcceptance(link.ticket_id, link.scope_node_id, link.relation, actor);
      this.unwireEpicAcceptance(link.ticket_id, link.scope_node_id, actor);
      return link;
    });
  }

  setPrimaryScope(ticketRef: string, scopeNodeId: string, actor: Actor): TicketScopeNode {
    return inTransaction(this.db, () => {
      const link = this.scope.setPrimaryScope(ticketRef, scopeNodeId, actor);
      this.wireEpicAcceptance(link.ticket_id, link.scope_node_id, link.relation, actor);
      return link;
    });
  }

  /**
   * EPIC MEMBERSHIP (external review #8): a ticket confirmed into an epic after it was
   * planned (a `primary` / `secondary` link) is part of the build the epic's acceptance
   * ticket must test, so that acceptance ticket now DEPENDS on it, exactly like the
   * members createEpic wired: the final cannot be claimed until the new member is done.
   * Before this the final ran (and the epic read accepted) with the new member still
   * ready. Nothing is wired for a suggested / rejected link, an acceptance ticket, a
   * cancelled member, or a final already done or cancelled (`wg stats` then reads the
   * epic pending / stale instead of accepted). Inside the caller's transaction.
   */
  private wireEpicAcceptance(
    ticketId: string,
    scopeNodeId: string,
    relation: string,
    actor: Actor,
  ): void {
    if (!(EPIC_MEMBER_RELATIONS as readonly string[]).includes(relation)) return;
    const node = this.scopeNodes.findById(scopeNodeId);
    if (!node || node.type !== "epic") return;
    const ticket = this.tickets.findById(ticketId);
    if (!ticket || ticket.acceptance === 1 || ticket.status === "cancelled") return;
    const finalId = ownAcceptanceTicketId(this.db, scopeNodeId);
    if (finalId === null || finalId === ticket.id) return;
    const final = this.tickets.findById(finalId);
    if (!final || final.status === "done" || final.status === "cancelled") return;
    if (this.ticketDependencies.exists(final.id, ticket.id)) return;
    try {
      this.ticketSvc.addDependency({ ticket: final.id, depends_on: ticket.id }, actor);
    } catch (err) {
      // A member that itself waits on the final (a follow-up that depends on it) cannot
      // also be a dependency of it. The link stands; `wg stats` reads the epic pending,
      // then stale, until its acceptance ticket is re-run on the finished scope.
      if (err instanceof DispatchError && err.code === "INVALID_DEPENDENCY") return;
      throw err;
    }
    // Marks this edge as the membership's, so withdrawing the membership withdraws it.
    writeEvent(this.db, {
      entity_type: "ticket",
      entity_id: final.id,
      actor,
      event_type: "epic.member_dependency_wired",
      payload: { epic_node_id: scopeNodeId, member_ticket_id: ticket.id },
    });
  }

  /**
   * EPIC MEMBERSHIP: the reverse of wireEpicAcceptance. When a ticket stops being a
   * confirmed member of an epic (its link removed, or changed to suggested / rejected),
   * the dependency of the epic's acceptance ticket on it goes too, but only an edge the
   * membership wired (an explicit dependency someone added stays), and never on a final
   * already done or cancelled. Before this, a ticket taken out of the epic kept its
   * acceptance ticket blocked (DEPENDENCY_BLOCKED) on work that was no longer in scope.
   */
  private unwireEpicAcceptance(ticketId: string, scopeNodeId: string, actor: Actor): void {
    const node = this.scopeNodes.findById(scopeNodeId);
    if (!node || node.type !== "epic") return;
    const finalId = ownAcceptanceTicketId(this.db, scopeNodeId);
    if (finalId === null || finalId === ticketId) return;
    const final = this.tickets.findById(finalId);
    if (!final || final.status === "done" || final.status === "cancelled") return;
    const stillMember = this.db
      .prepare(
        `SELECT 1 AS hit FROM ticket_scope_nodes WHERE ticket_id = ? AND scope_node_id = ?
           AND relation IN (${EPIC_MEMBER_RELATIONS.map((r) => `'${r}'`).join(", ")})`,
      )
      .get(ticketId, scopeNodeId);
    if (stillMember) return;
    if (!this.ticketDependencies.exists(final.id, ticketId)) return;
    const last = (eventType: string, field: string, value: string): number => {
      const row = this.db
        .prepare(
          `SELECT MAX(rowid) AS r FROM work_events
            WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = ?
              AND json_extract(payload_json, '$.' || ?) = ?`,
        )
        .get(final.id, eventType, field, value) as { r: number | null } | undefined;
      return Number(row?.r ?? 0);
    };
    const wired = last("epic.member_dependency_wired", "member_ticket_id", ticketId);
    // The current edge is the membership's only if nobody removed and re-added it since.
    if (wired === 0 || last("ticket.dependency_removed", "depends_on_ticket_id", ticketId) > wired)
      return;
    this.ticketSvc.removeDependency(final.id, ticketId, actor);
  }

  listTicketScopes(ticketRef: string): TicketScopeWithNode[] {
    return this.scope.listTicketScopes(ticketRef);
  }

  removeTicketScope(
    ticketRef: string,
    scopeNodeId: string,
    actor: Actor,
  ): { ticketId: string; scopeNodeId: string; eventId: string } {
    return inTransaction(this.db, () => {
      const res = this.scope.removeTicketScope(ticketRef, scopeNodeId, actor);
      this.unwireEpicAcceptance(res.ticketId, res.scopeNodeId, actor);
      return res;
    });
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

  /**
   * The runner's greenfield inherit (system only): give a sibling write access to the
   * repo a bootstrap ticket in its epic onboarded. See RepoService.inheritBootstrapRepoAccess.
   */
  inheritBootstrapRepoAccess(
    ticketRef: string,
    repoRef: string,
    actor: Actor,
  ): TicketRepoAccessResult {
    return this.repoSvc.inheritBootstrapRepoAccess(ticketRef, repoRef, actor);
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

  /** cli-wg/F-12: ready, not by hand, deps done, no open blocking decision. */
  isClaimableNow(ticket: Ticket): boolean {
    return this.ticketSvc.isClaimableNow(ticket);
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

  getScopeEdge(edgeId: string): ScopeEdge {
    return this.scope.getScopeEdge(edgeId);
  }

  getScopeRepo(associationId: string): ScopeRepo {
    return this.scope.getScopeRepo(associationId);
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
    // Accept any ticket reference (id, 15, #15, T-15) like every other ticket tool; the
    // link table stores the id, so an unresolved number would fail its foreign key.
    const ticketId = input.ticketId ? this.resolveTicket(input.ticketId).id : undefined;
    return this.decisionSvc.createDecision(
      { ...input, ...(ticketId !== undefined ? { ticketId } : {}) },
      actor,
    );
  }

  getDecision(decisionId: string): Decision {
    return this.decisionSvc.getDecision(decisionId);
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
    // Dragging a reviewed ticket back for rework IS a rejection: take the reject path
    // (AC reset, attempt bump, feedback, retry-cap park) instead of a raw move that
    // kept the previous delivery's satisfied ACs for the next done gate.
    if (
      (ticket.status === "in_review" || ticket.status === "ready_for_merge") &&
      (toStatus === "ready" || toStatus === "refining")
    ) {
      // (Through this.rejectReview: a landing already started is reported on the trail.)
      return this.rejectReview(ticket.id, toStatus, actor, "board_move");
    }
    return inTransaction(this.db, () => {
      // Handing in unleased in-progress work (a by-hand delivery, a tokenless resume)
      // by a move stays legal; dragging work an agent still holds a lease on is not.
      const unleasedSubmit =
        ticket.status === "in_progress" &&
        toStatus === "in_review" &&
        !this.claimsRepo.hasActiveForTicket(ticket.id);
      return this.transitions.transition({
        ticketId: ticket.id,
        actor,
        toStatus,
        reason: "board_move",
        // Pin the expected source so a stale board (card moved out from under the
        // drag) fails cleanly with STATE_CONFLICT rather than silently moving a
        // ticket the human is no longer looking at.
        expectedFromStatus: ticket.status,
        ...(unleasedSubmit ? { unleasedSubmit } : {}),
      });
    });
  }

  approveReview(
    ticketRef: string,
    actor: Actor,
    opts: ApproveReviewOptions = {},
  ): TransitionResult {
    return this.reviewGateSvc.approveReview(ticketRef, actor, opts);
  }

  /** PER-REPOSITORY LANDING: which approved revisions have landed. */
  landingStatus(ref: string): LandingStatus {
    return this.reviewGateSvc.landingStatus(ref);
  }

  /** PER-REPOSITORY LANDING: record one repo's approved commit as landed (system/admin). */
  recordLanding(
    ref: string,
    input: { repo: string; commit: string; via?: string | undefined },
    actor: Actor,
  ): ReturnType<ReviewGateService["recordLanding"]> {
    return this.reviewGateSvc.recordLanding(ref, input, actor);
  }

  /**
   * REVOCATION-SAFE LANDING (external review #8): re-check, immediately before a default
   * branch moves, that the ticket is still landable on the same approval and green CI,
   * and record the landing as started (see ReviewGateService.beginLanding).
   */
  beginLanding(
    ref: string,
    input: {
      repo: string;
      commit: string;
      approval?: string | undefined;
      via?: string | undefined;
    },
    actor: Actor,
  ): ReturnType<ReviewGateService["beginLanding"]> {
    return this.reviewGateSvc.beginLanding(ref, input, actor);
  }

  /** The approval a landing acts on (the latest transition into ready_for_merge). */
  landingApproval(ref: string): string | null {
    return this.reviewGateSvc.approvalRef(this.resolveTicket(ref).id);
  }

  /** The landings already started or committed on the ticket's current approval. */
  landingsStarted(ref: string): LandingStarted[] {
    return this.reviewGateSvc.landingsStarted(this.resolveTicket(ref).id);
  }

  /**
   * A revocation (reject, a failed required check) acknowledged AFTER a landing started
   * cannot undo it: say so on the ticket's trail and hand the landings back to the caller,
   * which reports them ("a landing has already happened").
   */
  private revocationAfterLanding(
    ticketId: string,
    actor: Actor,
    revocation: string,
  ): LandingStarted[] {
    const landed = this.reviewGateSvc.landingsStarted(ticketId);
    if (landed.length > 0) {
      writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticketId,
        actor,
        event_type: "ticket.revoked_after_landing",
        payload: { revocation, landings: landed },
      });
    }
    return landed;
  }

  /** TESTER REPLAY: record the tester's tests passed on the landed revision (system only). */
  recordTesterReplay(
    ref: string,
    input: {
      commit: string;
      pin: string;
      files: readonly string[];
      repo?: string | undefined;
      via?: string | undefined;
      note?: string | undefined;
    },
    actor: Actor,
  ): ReturnType<ReviewGateService["recordTesterReplay"]> {
    return this.reviewGateSvc.recordTesterReplay(ref, input, actor);
  }

  /**
   * MACHINE-CHECKABLE AC: the runner records the result of executing an AC's
   * `check_command` (trusted actor only — see ReviewGateService.recordAcCheck).
   */
  recordAcCheck(
    input: unknown,
    actor: Actor,
  ): { status: AcStatus; evidenceId: string; eventId: string } {
    return this.reviewGateSvc.recordAcCheck(input, actor);
  }

  testerPass(
    ticketRef: string,
    input: {
      summary: string;
      uri?: string;
      tested_commit?: string;
      contract_hash?: string;
      replay?: string;
      tests_commit?: string;
    },
    actor: Actor,
  ): TransitionResult {
    return this.reviewGateSvc.testerPass(ticketRef, input, actor);
  }

  testerFail(
    ticketRef: string,
    input: {
      summary: string;
      uri?: string;
      to?: "refining" | "ready";
      tested_commit?: string;
      contract_hash?: string;
      replay?: string;
      tests_commit?: string;
    },
    actor: Actor,
  ): TransitionResult {
    return this.reviewGateSvc.testerFail(ticketRef, input, actor);
  }

  // --- Black-box testing handover (BBT-001) --------------------------------

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

  /** GATE INTEGRITY: a human allows this ticket to change its tests (human/admin only). */
  setAllowTestChanges(
    ticketRef: string,
    allowed: boolean,
    actor: Actor,
    reason?: string,
  ): { ticketId: string; allowTestChanges: boolean; eventId: string } {
    return this.ticketSvc.setAllowTestChanges(ticketRef, allowed, actor, reason);
  }

  getTestContract(ticketRef: string): TestContract | null {
    return this.ticketSvc.getTestContract(ticketRef);
  }

  /**
   * HOLD FOR A HUMAN (`ready_for_merge | in_testing -> blocked`, reason-coded). The
   * runner's merge gate (the combined code failed on the target) and a late red CI
   * result use it; the ticket waits in the human queue with the reason. System/admin.
   */
  holdForHuman(
    ref: string,
    input: { reasonCode: string; reason: string },
    actor: Actor,
  ): TransitionResult {
    const result = this.reviewGateSvc.holdForHuman(ref, input, actor);
    this.emitGate("ticket_parked", result.ticket, { status: "blocked", detail: input.reason });
    return result;
  }

  /** REQUIRED CI: record a CI result for a ticket's candidate commit (system/admin). */
  recordCiResult(
    ref: string,
    input: { commit: string; state: "pending" | "pass" | "fail"; detail?: string },
    actor: Actor,
  ): {
    state: string;
    held: boolean;
    status: string;
    eventId: string;
    landedAlready: LandingStarted[];
  } {
    const res = this.reviewGateSvc.recordCiResult(ref, input, actor);
    const ticket = this.tickets.resolveRef(ref);
    if (res.held) {
      this.emitGate("ticket_parked", ticket, {
        status: "blocked",
        detail: `required CI failed for ${input.commit.slice(0, 12)}`,
      });
    }
    // REVOCATION-SAFE LANDING: a red result after a landing started cannot stop it.
    const landedAlready =
      input.state === "fail" && ticket
        ? this.revocationAfterLanding(ticket.id, actor, `ci_failed:${input.commit.slice(0, 12)}`)
        : [];
    return { ...res, landedAlready };
  }

  /** REQUIRED CI: the latest CI state for a ticket's commit (null commit = latest overall). */
  ciStatus(
    ref: string,
    commit: string | null = null,
  ): { required: boolean; state: string | null; commit: string | null } {
    const ticket = this.resolveTicket(ref);
    return this.reviewGateSvc.ciStatus(ticket.id, commit);
  }

  /**
   * WHAT HAPPENS ON APPROVE: the facts a HUMAN approve of this ticket acts on, read from
   * the same predicates the approve path uses — the tester route and the CI hold come from
   * ReviewGateService (the code approveReview runs), AUTO_MERGE as the approve route reads
   * it, the merge gate as the runner's merge lane asks it (the autonomyGateDecision
   * predicate), and the landing repos as every landing path plans them (the first write
   * repo with a local path lands first, then each other write repo with one; see
   * landingStatus.ts). `mergeCommand` is whether the API's merge runner has a command to
   * start (the caller holds the runner). The gate-integrity holds are the auto-ship
   * gate's own read (observedRiskFor); `approver: "agent"` asks what an agent or auto
   * approval would do. `ci: false` skips the CI and integrity reads (they run git) for an
   * approval that already happened; `repos` reuses a diff the caller already read.
   */
  approveOutcomeFacts(
    ref: string,
    opts: {
      mergeCommand: boolean;
      ci?: boolean;
      env?: NodeJS.ProcessEnv;
      approver?: "human" | "agent";
      repos?: readonly RepoDiff[];
    },
  ): ApproveOutcomeFacts {
    const env = opts.env ?? process.env;
    const ticket = this.resolveTicket(ref);
    // GATE INTEGRITY: the hard holds the auto-ship gate would raise (the same read). A
    // throw is indeterminate: the gate fails toward a human, and so does this fact.
    let testModifiedHolds: string[] = [];
    if (opts.ci !== false) {
      try {
        testModifiedHolds = [...(this.observedRiskFor(ticket, opts.repos).holds ?? [])];
      } catch {
        testModifiedHolds = ["the delivery diff could not be read to check its tests"];
      }
    }
    const writes = this.repos
      .listForTicket(ticket.id)
      .filter((l) => isActiveTicketRepoRelation(l.relation) && l.access === "write");
    const lands = writes.find((l) => l.local_path) ?? null;
    const mode = (env.REVIEW_MODE ?? "human").trim().toLowerCase();
    const method = (env.GAFFER_PR_MERGE_METHOD ?? "").trim().toLowerCase();
    const lane = (env.GAFFER_MERGE_LANE ?? "1").trim().toLowerCase();
    return {
      approver: opts.approver ?? "human",
      testModifiedHolds,
      ciHold: opts.ci === false ? null : this.reviewGateSvc.approveCiHold(ticket),
      // EVERY WRITE REPO: the same read approveReview refuses on (repo_unavailable).
      unavailableRepos:
        opts.ci === false
          ? []
          : this.reviewGateSvc.unavailableWriteRepos(ticket).map((m) => ({
              repo: m.repo,
              why: m.why,
              fix: unavailableRepoRemedy(m, ticket.number),
            })),
      toTester: this.reviewGateSvc.approveRoutesToTesting(ticket),
      acceptance: ticket.acceptance === 1,
      autoMerge: envFlagOn(env[AUTO_MERGE_ENV]),
      mergeCommand: opts.mergeCommand,
      mergeLane: !["0", "false", "no", "off"].includes(lane),
      mergeGateEarned: isAutonomyAllowed(
        this.autonomyPolicy,
        this.writeRepoIdsForTicket(ticket),
        ticket.risk_level,
        "merge",
        env,
      ),
      reviewMode: (["human", "agent", "both"].includes(mode) ? mode : "human") as ReviewMode,
      prMode: envFlagOn(env.GAFFER_CREATE_PR),
      prUrl: lands
        ? this.repos.ticketRepoPrUrl(ticket.id, lands.id) || ticket.pr_url || null
        : ticket.pr_url || null,
      prMergeMethod: ["merge", "squash", "rebase"].includes(method) ? method : "merge",
      landsRepo: lands ? lands.name : null,
      baseBranch: lands ? lands.default_branch || null : null,
      // PER-REPOSITORY LANDING: every other write repo with a checkout lands too (the
      // landing plan is the approved revisions with a local path, primary first).
      alsoLandsRepos: writes.filter((l) => l !== lands && l.local_path).map((l) => l.name),
      noCheckoutRepos: writes.filter((l) => !l.local_path).map((l) => l.name),
      // The same pause read as landing_state, so the line and the status agree.
      pause: usagePauseFact(env),
    };
  }

  /** The first step a human approve of this ticket will certainly take (see approveOutcome.ts). */
  approveOutcome(
    ref: string,
    opts: {
      mergeCommand: boolean;
      env?: NodeJS.ProcessEnv;
      approver?: "human" | "agent";
      repos?: readonly RepoDiff[];
    },
  ): ApproveOutcome {
    return decideApproveOutcome(this.approveOutcomeFacts(ref, opts));
  }

  /**
   * WHERE AN APPROVED CHANGE IS: the facts behind a ready_for_merge (or held) ticket's
   * status label, read from what the landing paths themselves act on — the review pin
   * against the branch head (the landing check's "moved since review"), the merge gate's
   * evidence and the CI result for the head, the hold a parked ticket carries, a merge run
   * the API started that is still running, per-repo landings, and the merge lane's rule
   * (an earned merge gate, or AUTO_MERGE and a human approval; GAFFER_MERGE_LANE).
   * Git runs only for a ready_for_merge ticket; any other status reads no facts.
   */
  landingFacts(ref: string | Ticket, env: NodeJS.ProcessEnv = process.env): LandingFacts | null {
    const ticket = typeof ref === "string" ? this.resolveTicket(ref) : ref;
    if (ticket.status !== "ready_for_merge" && ticket.status !== "blocked") return null;
    const events = listEvents(this.db, "ticket", ticket.id);
    const transitions = events
      .filter((e) => e.event_type === "ticket.transitioned")
      .map((e) => {
        let pl: { to?: string; reason?: string | null } = {};
        try {
          pl = (JSON.parse(e.payload_json || "{}") as typeof pl) || {};
        } catch {
          pl = {};
        }
        return { e, to: pl.to ?? "", reason: pl.reason ?? "" };
      });
    const lastInto = (st: string) => [...transitions].reverse().find((t) => t.to === st);
    const writeLinks = () =>
      this.repos
        .listForTicket(ticket.id)
        .filter((l) => isActiveTicketRepoRelation(l.relation) && l.access === "write");
    const base = {
      mergeRunning: false,
      landedRepos: [] as string[],
      writeRepos: [] as string[],
      autoMerge: false,
      mergeLane: false,
      mergeGateEarned: false,
      approver: "",
    };
    if (ticket.status === "blocked") {
      const m = /^held:(merge_gate_red|ci_red)$/.exec(lastInto("blocked")?.reason ?? "");
      if (!m) return { ...base, status: ticket.status, hold: null };
      // A held multi-repo landing says which repos already landed (they stay landed).
      return {
        ...base,
        ...this.landedAndWriteRepos(computeLandingStatus(this.db, ticket.id), writeLinks()),
        status: ticket.status,
        hold: m[1] as LandingHold,
      };
    }
    // Everything after the ticket's latest entry into ready_for_merge, in log order (the
    // event log's insertion order, never a clock comparison across tables).
    const entry = lastInto("ready_for_merge")?.e;
    const afterEntry = entry ? events.slice(events.indexOf(entry) + 1) : events;
    const recordedSince = new Set(
      afterEntry
        .filter((e) => e.event_type === "evidence.recorded")
        .map((e) => {
          try {
            const pl = JSON.parse(e.payload_json || "{}") as { evidence_id?: string };
            return String(pl.evidence_id ?? "");
          } catch {
            return "";
          }
        }),
    );
    const evidence = this.evidence.listForTicket(ticket.id);
    // The approval on the ticket's current path to merge (the merge lane's own rule).
    let start = 0;
    transitions.forEach((t, i) => {
      if (t.to === "in_review") start = i + 1;
    });
    let approver = "";
    for (const t of transitions.slice(start))
      if (t.reason === "review_approved" || t.reason === "review_approved_to_testing")
        approver = t.e.actor_type;
    let hold: LandingHold | null = null;
    // PER-REPOSITORY LANDING: the approved revision of every write repo (its review pin
    // since the ticket last entered review) and whether a landing of it is on record.
    const landing = computeLandingStatus(this.db, ticket.id);
    const heads = this.resolveApprovedHeads(ticket);
    const head = heads[0] ?? null; // the primary write repo: required CI's candidate
    // MOVED SINCE REVIEW, per repo as the landing check reads it: a repo still to land
    // whose delivery-branch head is no longer its pinned commit. A landed repo is done
    // (its branch may be gone). A legacy approval with no per-repo pin compares its one
    // pin with the primary head, as before.
    const movedRepos = landing.repos
      .filter((r) => !r.landed && r.pinned)
      .filter((r) => {
        const h = heads.find((x) => x.repoId === r.repoId);
        return h !== undefined && h.sha !== r.sha;
      })
      .map((r) => r.repo);
    if (landing.repos.length === 0) {
      const pin = [...evidence]
        .reverse()
        .find(
          (ev) =>
            ev.repo_id === null &&
            ev.recorded_by_actor_type === "system" &&
            (ev.uri ?? "").startsWith(REVIEW_PIN_PREFIX),
        );
      const pinned = pin ? (pin.uri ?? "").slice(REVIEW_PIN_PREFIX.length).toLowerCase() : "";
      if (head && pinned && !head.sha.startsWith(pinned) && !pinned.startsWith(head.sha))
        movedRepos.push(head.repo);
    }
    if (movedRepos.length > 0) hold = "moved_since_review";
    else if (landing.unpinned.length > 0) hold = "unpinned_repo";
    else if (
      evidence.some((ev) => ev.summary.startsWith("MERGE GATE FAILED") && recordedSince.has(ev.id))
    )
      hold = "merge_gate_red";
    else if (head && this.reviewGateSvc.ciStatus(ticket.id, head.sha).state === "fail")
      hold = "ci_red";
    // A merge run the API started for this approval, still running.
    const started = [...afterEntry].reverse().find((e) => e.event_type === "ticket.merge_started");
    let mergeRunning = false;
    if (started) {
      try {
        const runId = (JSON.parse(started.payload_json || "{}") as { run_id?: string }).run_id;
        const row = runId
          ? (this.db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as
              { status: string } | undefined)
          : undefined;
        mergeRunning = row?.status === "running";
      } catch {
        mergeRunning = false;
      }
    }
    const writes = writeLinks();
    const lane = (env.GAFFER_MERGE_LANE ?? "1").trim().toLowerCase();
    return {
      status: ticket.status,
      hold,
      mergeRunning,
      movedRepos,
      unpinnedRepos: [...landing.unpinned],
      ...this.landedAndWriteRepos(landing, writes),
      pause: usagePauseFact(env),
      autoMerge: envFlagOn(env[AUTO_MERGE_ENV]),
      mergeLane: !["0", "false", "no", "off"].includes(lane),
      mergeGateEarned: isAutonomyAllowed(
        this.autonomyPolicy,
        this.writeRepoIdsForTicket(ticket),
        ticket.risk_level,
        "merge",
        env,
      ),
      approver,
    };
  }

  /**
   * The repos a landing state names: with per-repo review pins, the approved revisions
   * and those recorded landed (`gaffer-landed-commit:` system rows, computeLandingStatus);
   * a legacy approval with no per-repo pin names its write repos, none recorded landed.
   */
  private landedAndWriteRepos(
    landing: LandingStatus,
    writes: ReadonlyArray<{ name: string }>,
  ): { landedRepos: string[]; writeRepos: string[] } {
    if (landing.repos.length === 0)
      return { landedRepos: [], writeRepos: writes.map((l) => l.name) };
    return {
      landedRepos: landing.repos.filter((r) => r.landed).map((r) => r.repo),
      writeRepos: landing.repos.map((r) => r.repo),
    };
  }

  /** The truthful status label for an approved or held ticket (see landingState.ts). */
  landingState(ref: string | Ticket, env: NodeJS.ProcessEnv = process.env): LandingState | null {
    try {
      const facts = this.landingFacts(ref, env);
      return facts ? decideLandingState(facts) : null;
    } catch {
      return null; // a status label never fails the read it rides on
    }
  }

  /** Stamp `landing_state` on each approved or held ticket of a list (others untouched). */
  withLandingState<T extends Ticket>(
    tickets: readonly T[],
  ): Array<T & { landing_state?: LandingState }> {
    return tickets.map((t) => {
      if (t.status !== "ready_for_merge" && t.status !== "blocked") return t;
      const ls = this.landingState(t);
      return ls ? { ...t, landing_state: ls } : t;
    });
  }

  /**
   * IN-FLIGHT GUARD (exploratory finding api/F1): true while a merge run the API started
   * for this ticket (its latest `ticket.merge_started` event) is still `running` in the
   * run registry. The merge route refuses a second merge then (409 MERGE_IN_FLIGHT).
   */
  mergeInFlight(ref: string): boolean {
    const ticket = this.resolveTicket(ref);
    const ev = this.db
      .prepare(
        `SELECT payload_json FROM work_events
          WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = 'ticket.merge_started'
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(ticket.id) as { payload_json: string | null } | undefined;
    if (!ev) return false;
    try {
      const runId = (JSON.parse(ev.payload_json || "{}") as { run_id?: string }).run_id;
      if (!runId) return false;
      const row = this.db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as
        { status: string } | undefined;
      return row?.status === "running";
    } catch {
      return false;
    }
  }

  /**
   * Record that the API started a merge run for an approved ticket, so its status can say
   * "landing" while that run is running (the runs table does not carry the ticket).
   */
  noteMergeStarted(ref: string, runId: string | null, actor: Actor): void {
    const ticket = this.resolveTicket(ref);
    writeEvent(this.db, {
      entity_type: "ticket",
      entity_id: ticket.id,
      actor,
      event_type: "ticket.merge_started",
      payload: { run_id: runId },
    });
  }

  markMerged(ref: string, actor: Actor): TransitionResult {
    return this.reviewGateSvc.markMerged(ref, actor);
  }

  reopenForReview(
    ref: string,
    input: { reason: string; resolution: string },
    actor: Actor,
  ): { ticketId: string; status: string; eventId: string } {
    return this.reviewGateSvc.reopenForReview(ref, input, actor);
  }

  rejectReview(
    ticketRef: string,
    to: "ready" | "refining" | "cancelled",
    actor: Actor,
    reason?: string,
  ): TransitionResult & { landedAlready: LandingStarted[] } {
    const res = this.reviewGateSvc.rejectReview(ticketRef, to, actor, reason);
    // REVOCATION-SAFE LANDING: a landing that started before this rejection committed is
    // not undone by it; report it (the merge runner refuses every landing not yet started).
    const landedAlready = this.revocationAfterLanding(res.ticket.id, actor, `rejected_to_${to}`);
    return { ...res, landedAlready };
  }

  resetAcceptanceCriteria(
    ref: string,
    actor: Actor,
  ): { ticketId: string; reset: number; eventId: string } {
    return this.ticketSvc.resetAcceptanceCriteria(ref, actor);
  }

  wontDo(
    ref: string,
    actor: Actor,
    reason?: string,
  ): TransitionResult & { landedAlready: LandingStarted[] } {
    const res = this.reviewGateSvc.wontDo(ref, actor, reason);
    // REVOCATION-SAFE LANDING: the dashboard's Won't do is a cancellation too; a landing
    // that had already started is reported exactly as a rejection reports it.
    const landedAlready = this.revocationAfterLanding(res.ticket.id, actor, "wont_do");
    return { ...res, landedAlready };
  }

  reopenFromWontDo(ref: string, to: "refining" | "draft", actor: Actor): TransitionResult {
    return this.reviewGateSvc.reopenFromWontDo(ref, to, actor);
  }

  // --- Pause-on-cap (PAUSE-ON-CAP) -----------------------------------------

  /**
   * Pause an in-flight delivery that hit a turn/budget cap (`* -> paused`). The
   * runner keeps the worktree + branch alive and records the resume context.
   */
  pauseDelivery(ref: string, input: PauseInput, actor: Actor): TransitionResult {
    return this.pauseSvc.pauseDelivery(ref, input, actor);
  }

  /** The human pressed Continue — mark a paused ticket resume-requested. */
  continuePaused(ref: string, actor: Actor): { ticketId: string; eventId: string } {
    return this.pauseSvc.requestContinue(ref, actor);
  }

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
  beginResume(
    ref: string,
    actor: Actor,
    lease?: { agentId: string; ttlSeconds: number },
  ): { ticketId: string; eventId: string; context: PausedDelivery; claimToken?: string } {
    return inTransaction(this.db, () => {
      const res = this.pauseSvc.beginResume(ref, actor);
      if (!lease) return res;
      const { claimToken } = this.claims.leaseResumedDelivery(
        res.ticketId,
        lease.agentId,
        lease.ttlSeconds,
        actor,
      );
      return { ...res, claimToken };
    });
  }

  /** Stop/abandon a paused delivery (`paused -> cancelled`); drops the resume context. */
  stopPaused(ref: string, actor: Actor, reason?: string): TransitionResult {
    return this.pauseSvc.stop(ref, actor, reason);
  }

  /** Read the resume context for a paused ticket (or null). */
  pausedContext(ref: string): PausedDelivery | null {
    return this.pauseSvc.getContext(ref);
  }

  /** All paused tickets a human has asked to continue (oldest first). */
  listResumeRequested(): PausedDelivery[] {
    return this.pauseSvc.listResumeRequested();
  }

  /** Drop the resume context once a resumed delivery completes (runner cleanup). */
  clearPausedContext(ref: string): void {
    this.pauseSvc.clearContext(ref);
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
   * TRACK-2b: a HUMAN takes a ready ticket "by hand" ("I'll do this myself"). The
   * ticket moves `ready -> in_progress` owned by the human; the agent selection loop
   * structurally skips it thereafter. Resolves a ticket number/id ref, then delegates
   * to {@link ClaimService.humanClaimTicket} (reuses the atomic ready-and-unclaimed
   * invariant). Throws `TICKET_NOT_CLAIMABLE` when the ticket isn't takeable.
   */
  humanClaimTicket(ref: string, actor: Actor): { ticketId: string; number: number } {
    const ticket = this.resolveTicket(ref);
    return this.claims.humanClaimTicket({ ticketId: ticket.id }, actor);
  }

  /**
   * TRACK-2b: a human hands their by-hand ticket back to the queue
   * (`in_progress -> ready`), clearing the ownership marker so agents can pick it up.
   * Only a human-owned in-flight ticket is releasable this way — an agent's live
   * delivery is never touched. See {@link ClaimService.humanReleaseTicket}.
   */
  humanReleaseTicket(
    ref: string,
    actor: Actor,
  ): { ticketId: string; status: string; eventId: string } {
    const ticket = this.resolveTicket(ref);
    return this.claims.humanReleaseTicket({ ticketId: ticket.id }, actor);
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

  /**
   * DELIVERY-DOSSIER: assemble the tamper-evident evidence dossier for a ticket from
   * EXISTING recorded state. Pure read — no write, no lifecycle change. Deterministic:
   * unchanged ticket state always yields the same {@link Dossier.hash}.
   */
  dossier(ref: string): Dossier {
    const ticket = this.resolveTicket(ref);
    return this.dossierSvc.assemble(ticket);
  }

  /**
   * REVIEW PACKET: the runner-verified facts the Review view draws above the agent's
   * words (gates, tester, cost, attempts, risk, the review pin, per-criterion check
   * results, test-count disagreements). Pure read; outside the dossier's hash.
   */
  reviewPacket(ref: string, costFor: CostReader): ReviewPacket {
    return this.reviewPacketSvc.assemble(this.resolveTicket(ref), costFor);
  }

  /**
   * DELIVERY-DOSSIER: assemble the dossier AND record its hash against the control
   * plane as a `ticket.dossier_recorded` work-event, so the dossier can later be
   * verified. This is the ONLY write on the dossier path. Idempotent: when the freshly
   * computed hash equals the most recently recorded one, no new event is written
   * (`eventId` is null). Recording NEVER changes ticket status or any lifecycle state.
   */
  recordDossier(ref: string, actor: Actor): { dossier: Dossier; eventId: string | null } {
    const ticket = this.resolveTicket(ref);
    const dossier = this.dossierSvc.assemble(ticket);
    const previous = this.events.latestDossierHash(ticket.id);
    if (previous === dossier.hash) {
      return { dossier, eventId: null };
    }
    const eventId = writeEvent(this.db, {
      entity_type: "ticket",
      entity_id: ticket.id,
      actor,
      event_type: DOSSIER_EVENT_TYPE,
      payload: {
        dossier_hash: dossier.hash,
        hash_algo: dossier.hash_algo,
        schema: dossier.schema,
      },
    });
    return { dossier, eventId };
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

  /** The ticket id an active claim token is held against (undefined if none). */
  claimTicketIdForToken(claimToken: string): string | undefined {
    return this.claims.ticketIdForToken(claimToken);
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

  submitForReview(
    input: SubmitForReviewInput,
    actor: Actor,
  ): { ticketId: string; status: string; eventId: string } {
    const result = this.claims.submitForReview(input, actor);
    // H2: the ticket has reached `in_review` and now needs a human reviewer. Fire
    // AFTER the claim transaction commits so the notification can never roll the
    // transition back; best-effort inside emitGate.
    if (result.status === "in_review") {
      // The call above already resolved the ref (id or #N), so this cannot throw.
      const ticket = this.tickets.resolveRef(input.ticket_id);
      this.emitGate("review_needed", ticket, { detail: input.reason });
    }
    return result;
  }

  /**
   * cli-wg/F-03: a person blocks a ticket that is not in an agent's hands (draft,
   * refining, ready, or their own by-hand in_progress). See
   * {@link TicketService.humanBlockTicket}; fires the ticket_blocked gate like markBlocked.
   */
  humanBlockTicket(
    ref: string,
    reason: string,
    actor: Actor,
  ): { ticketId: string; from: TicketStatus; eventId: string } {
    const result = this.ticketSvc.humanBlockTicket(ref, reason, actor);
    const ticket = this.tickets.findById(result.ticketId);
    if (ticket) this.emitGate("ticket_blocked", ticket, { detail: reason });
    return result;
  }

  /** cli-wg/F-03: return a blocked ticket to the queue (see {@link TicketService.humanUnblockTicket}). */
  humanUnblockTicket(
    ref: string,
    actor: Actor,
    to?: "ready" | "refining" | "draft",
  ): { ticketId: string; status: TicketStatus; eventId: string } {
    return this.ticketSvc.humanUnblockTicket(ref, actor, to);
  }

  markBlocked(input: MarkBlockedInput, actor: Actor): { ticketId: string; eventId: string } {
    const result = this.claims.markBlocked(input, actor);
    // H2: the ticket is now `blocked` and needs a human to unblock it. Emit after
    // the block transaction commits, best-effort.
    const ticket = this.tickets.resolveRef(input.ticket_id);
    this.emitGate("ticket_blocked", ticket, { detail: input.reason });
    return result;
  }

  /**
   * RUNNER-OWNED-BOOKKEEPING: release/park a runner-held delivery claim. Failure
   * routes the ticket to `ready` (retry); park routes to `refining` (triage,
   * branch preserved). `claimToken` is optional so a tokenless resumed
   * (`in_progress`) delivery can be parked too. See ClaimService.runnerRelease.
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
      pausedUntil?: string;
    },
    actor: Actor,
  ): { status: string; eventId: string } {
    const result = this.claims.runnerRelease(input, actor);
    // Parking to the VISIBLE `blocked` column needs a human to unblock it — fire the
    // gate AFTER the claim transaction commits, best-effort (mirrors markBlocked).
    if (result.status === "blocked") {
      // The call above already resolved the ref (id or #N), so this cannot throw.
      const ticket = this.tickets.resolveRef(input.ticket_id);
      this.emitGate("ticket_blocked", ticket, { detail: input.reason });
    }
    return result;
  }

  /**
   * RUNNER-OWNED-BOOKKEEPING + FAILURE-DIAGNOSIS: record a live rework attempt on an
   * in-flight delivery so the board shows "reworking · attempt N/M" + the latest
   * failure while the runner re-invokes the agent, AND append the full distilled
   * failure to the durable trail. Does NOT change status. See
   * {@link ClaimService.recordReworkAttempt}.
   */
  recordReworkAttempt(
    input: {
      ticket_id: string;
      attempt: number;
      maxAttempts: number;
      reason: string;
      gate?: string;
      distilledFailure?: string;
      acId?: string;
      final?: boolean;
    },
    actor: Actor,
  ): { eventId: string | null } {
    return this.claims.recordReworkAttempt(input, actor);
  }

  /**
   * FAILURE-DIAGNOSIS: the "why did #N fail" read model — the full ordered rework
   * failure trail for one ticket (attempt 1 → 2 → …), each with the distilled
   * failing test + assertion/stack. Resolves by ticket id or number.
   */
  reworkTrail(ref: string): ReworkAttempt[] {
    const ticket = this.resolveTicket(ref);
    return this.reworkAttempts.listForTicket(ticket.id);
  }

  /**
   * FAILURE-DIAGNOSIS: the cross-ticket "these keep bouncing" signal — tickets with
   * a rework trail at or above the floor, ranked worst-first (repeated same-gate
   * failures lead). The operator's key quality signal.
   */
  bouncingTickets(options: { minReworks?: number; limit?: number } = {}): BouncingTicket[] {
    return this.reworkAttempts.bouncing(options);
  }

  releaseClaim(claimToken: string, actor: Actor): void {
    this.claims.releaseClaim(claimToken, actor);
  }

  expireStaleClaims(actor: Actor): { expired: number } {
    const result = this.claims.expireStaleClaims(actor);
    // A claim-expiry that lands a ticket in `blocked` (an unresolved blocking decision)
    // needs a human to unblock it — fire the operator gate per blocked ticket AFTER the
    // sweep commits, best-effort (mirrors markBlocked / runnerRelease). Without this the
    // expiry-block is silent: no Slack/webhook, and queue readers keyed on the gate miss it.
    for (const id of result.blockedTicketIds) {
      const ticket = this.tickets.findById(id);
      if (ticket) {
        this.emitGate("ticket_blocked", ticket, {
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
      const url = this.decisionUrl(decision);
      this.notifier.notify({
        kind: "decision_pending",
        title: decision.title,
        status: decision.status,
        at: this.clock.now(),
        ...(decision.question ? { detail: decision.question } : {}),
        // AFK-LOOP P1: mirror ticketUrl so a decision ping is one-tap actionable.
        ...(url !== undefined ? { url } : {}),
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

  /**
   * Build a clickable dashboard link for a raised decision when
   * `GAFFER_DASHBOARD_URL` is set — the decision-gate analogue of
   * {@link ticketUrl}. Decisions surface on the overview, so the link deep-links
   * to the decision by id there. Optional — undefined when the base is
   * unconfigured (degrades gracefully to a URL-less notification).
   */
  private decisionUrl(decision: Decision): string | undefined {
    const base = (process.env.GAFFER_DASHBOARD_URL ?? "").trim();
    if (base === "") return undefined;
    return `${base.replace(/\/+$/, "")}/decisions/${decision.id}`;
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
      resolvedDecisions: this.decisions.resolvedForTicket(ticket.id),
      dependencies: this.ticketDependencies.listForTicket(ticket.id),
      evidence: this.enrichEvidenceProvenance(this.evidence.listForTicket(ticket.id)),
      events: listEvents(this.db, "ticket", ticket.id),
      // BBT-001: parse the JSON-encoded test_contract to a structured object so
      // consumers (CLI, API) never receive a JSON-in-JSON string.
      testContract: parseTestContract(ticket.test_contract),
      // FAILURE-DIAGNOSIS: the full ordered "why did #N fail" trail.
      reworkTrail: this.reworkAttempts.listForTicket(ticket.id),
      // PER-REPOSITORY LANDING: each write repo's approved commit and whether it landed.
      landing: computeLandingStatus(this.db, ticket.id),
    };
  }

  /**
   * Stamp each evidence row with `recorded_by_agent` for the reviewer's trust
   * surface, derived from the RECORDING ACTOR'S TYPE captured at record time
   * (`recorded_by_actor_type`). A row is agent self-reported iff that type is
   * "agent"; a human operator or the factory/system actor is a trusted principal.
   * This is the dependable signal — `created_by` cannot be used because an agent's
   * `created_by` is a runner-supplied id (e.g. "mcp-agent"), never the registered
   * agent identity. Legacy rows carry a null type (recorded before this column);
   * their flag is left `false` (⇒ no agent chip, no trust claim asserted). Never
   * fabricated — always the real recorded actor type.
   */
  private enrichEvidenceProvenance(rows: Evidence[]): EvidenceView[] {
    return rows.map((e) => ({
      ...e,
      recorded_by_agent: e.recorded_by_actor_type === "agent",
    }));
  }

  list(status?: TicketStatus): Ticket[] {
    return this.tickets.list(status);
  }

  /** Filtered backlog list for the human surface (status / repo / risk). */
  listTickets(filter: TicketListFilter = {}): Ticket[] {
    return this.tickets.listFiltered(filter);
  }

  /** A page of the filtered list + its total (GET /tickets; see TicketRepository.listPage). */
  listTicketPage(
    filter: TicketListFilter,
    page: { limit?: number | undefined; offset?: number | undefined; summary?: boolean },
  ): { tickets: Array<Ticket | TicketSummary>; total: number } {
    return this.tickets.listPage(filter, page);
  }

  /** Events for a ticket (resolved by id or number). */
  listTicketEvents(ref: string): WorkEvent[] {
    const ticket = this.resolveTicket(ref);
    return listEvents(this.db, "ticket", ticket.id);
  }

  /**
   * Active claims joined to their ticket + agent (human "active factory" view).
   * SQUAD: each row also carries the agent's presentation (`agent_display`).
   */
  listActiveClaims(): Array<ActiveClaimView & { agent_display: AgentDisplay | null }> {
    const displays = this.squadSvc.displayMap();
    return this.claimsRepo
      .listActive()
      .map((c) => ({ ...c, agent_display: displays.get(c.agent_id) ?? null }));
  }

  /** All registered agents, newest first, each with its presentation (`agent_display`). */
  listAgents(): Array<Agent & { agent_display: AgentDisplay | null }> {
    const displays = this.squadSvc.displayMap();
    return this.agents.list().map((a) => ({ ...a, agent_display: displays.get(a.id) ?? null }));
  }

  // --- Squad (club identity + agent display names; presentation only) ---------

  /** The club identity (name falls back to "Gaffer" in `name_effective`). */
  getClub(): ClubView {
    return this.squadSvc.getClub();
  }

  /** Update the club identity (validated; recorded as `club.updated` when changed). */
  updateClub(input: ClubUpdate, actor: Actor): { club: ClubView; changed: string[] } {
    return this.squadSvc.updateClub(input, actor);
  }

  /** Every agent with its display name, shirt number, role and derived default. */
  listSquad(): SquadAgentView[] {
    return this.squadSvc.listSquad();
  }

  /**
   * Rename an agent / set its shirt number (validated; shirt numbers unique;
   * recorded as `agent.display_updated`). NEVER changes the agent id.
   */
  updateAgentDisplay(
    ref: string,
    input: AgentDisplayUpdate,
    actor: Actor,
  ): { agent: SquadAgentView; changed: string[] } {
    return this.squadSvc.updateAgentDisplay(ref, input, actor);
  }

  /**
   * The presentation of each REGISTERED agent among `ids`, keyed by id. Ids that
   * are not registered agents (a human actor, "mcp-agent", …) are left out.
   */
  agentDisplayFor(ids: Iterable<string | null | undefined>): Record<string, AgentDisplay> {
    const displays = this.squadSvc.displayMap();
    const out: Record<string, AgentDisplay> = {};
    for (const id of ids) {
      if (!id) continue;
      const d = displays.get(id);
      if (d) out[id] = d;
    }
    return out;
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
   * `succeeded`, any other value (or a null/unknown code) ⇒ `failed`, unless the
   * caller states it (a poll the runner refused exits 0 and is `failed`). A no-op if
   * the run was already swept to `unknown` (the first writer wins — see
   * {@link RunRepository.markEnd}), so a late exit listener never resurrects a
   * reconciled row.
   */
  markRunEnd(
    id: string,
    input: { exit_code: number | null; detail?: string | null; status?: Run["status"] },
  ): void {
    const status: Run["status"] = input.status ?? (input.exit_code === 0 ? "succeeded" : "failed");
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
   * Kanban board: tickets grouped into columns, AC progress enriched. Read-only.
   *
   * @param repo Optional repository name/id — when supplied, only tickets
   *   linked to that repo are included. Omit for the full board.
   */
  board(repo?: string, window?: BoardWindow): BoardView {
    const view = this.boardSvc.board(repo, window);
    // Approved and held cards carry where their landing is (one read per such ticket).
    const states = new Map<string, LandingState>();
    const stamp = (c: BoardCard): BoardCard => {
      if (c.status !== "ready_for_merge" && c.status !== "blocked") return c;
      if (!states.has(c.id)) {
        const ls = this.landingState(c.id);
        if (ls) states.set(c.id, ls);
      }
      const ls = states.get(c.id);
      return ls ? { ...c, landing_state: ls } : c;
    };
    return {
      ...view,
      columns: view.columns.map((col) => ({ ...col, cards: col.cards.map(stamp) })),
      closed: view.closed.map(stamp),
      wontDo: view.wontDo.map(stamp),
      readyForMerge: view.readyForMerge.map(stamp),
    };
  }

  /**
   * GRADUATED-AUTONOMY (Spec 2, Phase 2): read-only, advisory per-repo/per-risk/
   * per-gate autonomy recommendations backed by the review track record. NEVER
   * enables anything — the operator acts on it (Phase 3 adds the enable action).
   */
  autonomyRecommendationsList(): AutonomyRecommendation[] {
    return this.autonomyRecommendations.recommend();
  }

  /**
   * Cross-ticket activity feed. SQUAD: an event whose actor is a registered agent
   * carries that agent's presentation as `agent_display` (null otherwise).
   */
  activity(query: ActivityQuery): {
    events: Array<ActivityEvent & { agent_display: AgentDisplay | null }>;
    total: number;
  } {
    const page = this.boardSvc.activity(query);
    const displays = this.squadSvc.displayMap();
    return {
      total: page.total,
      events: page.events.map((e) => ({
        ...e,
        agent_display: (e.actor_id !== null && displays.get(e.actor_id)) || null,
      })),
    };
  }

  dashboard(): DashboardSummary {
    return this.boardSvc.dashboard();
  }

  /**
   * The HUMAN's queue (Track 2a): everything the operator owns — pending
   * decisions the agent delegated (WITH reasons), tickets awaiting review
   * sign-off, and regulated tickets awaiting ready-approval / reviewer
   * assignment — each with what it is, which ticket, the reason and how long it
   * has waited. A read model only: EXCLUDES agent-owned `blocked`/rework churn,
   * changes no semantics and adds no gate. Read-only.
   */
  humanQueue(): HumanQueue {
    const q = this.humanQueueSvc.build();
    return {
      ...q,
      items: q.items.map((it) => {
        const t = it.ticket;
        if (!t || (t.status !== "ready_for_merge" && t.status !== "blocked")) return it;
        const ls = this.landingState(t.id);
        return ls ? { ...it, ticket: { ...t, landing_state: ls } } : it;
      }),
    };
  }

  /**
   * TAMPER-EVIDENT LOG: re-derive the sha256 hash chain over every work_event in
   * insertion order and report the first row that does not hash to its stored
   * value or does not link to its predecessor. Read-only. `dispatch events verify`
   * and `dispatch doctor` surface it.
   */
  verifyEventChain(): ChainVerification {
    return verifyEventChain(this.db);
  }

  /**
   * The EXPLICIT repair path for unhashed work_events rows (`dispatch events rechain
   * --confirm`). Opening the DB no longer re-chains them: on a chained DB a NULL
   * hash means the row was blanked, and silently re-hashing it is what let an edit
   * plus "blank the hashes after it" verify clean. An operator who has checked the
   * rows can re-anchor the chain here; the re-anchor is itself appended to the log
   * (`events.rechained`, with the old and new head hashes and what was broken), so
   * it never happens without a trace. Rows that already carry a hash are untouched.
   */
  rechainEventLog(actor: Actor): {
    rechained: number;
    oldHead: string;
    newHead: string;
    verification: ChainVerification;
  } {
    return inTransaction(this.db, () => {
      const before = verifyEventChain(this.db);
      const oldHead = latestEventHash(this.db);
      const rechained = backfillEventChain(this.db);
      const newHead = latestEventHash(this.db);
      writeEvent(this.db, {
        entity_type: "event_log",
        entity_id: "work_events",
        actor,
        event_type: "events.rechained",
        payload: {
          rechained,
          old_head: oldHead,
          new_head: newHead,
          was_broken_at_seq: before.brokenAtSeq,
          was_reason: before.reason,
        },
      });
      return { rechained, oldHead, newHead, verification: verifyEventChain(this.db) };
    });
  }
}
