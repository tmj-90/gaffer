import type { AcceptanceProfile } from "./domain/acceptanceProfile.js";
import type { VerdictPrincipal } from "./services/reviewGate/waiver.js";
import { type Db, openDatabase } from "./db/connection.js";
import {
  type AcStatus,
  type AcceptanceCriterion,
  type Actor,
  type Agent,
  type BouncingTicket,
  type Decision,
  type DecisionSeverity,
  type PausedDelivery,
  type ReopenForReviewCause,
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
} from "./domain/types.js";
import { verifyEventChain, type ChainVerification } from "./events/eventChain.js";
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
import { RepoRepository } from "./repositories/repoRepository.js";
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
  type TicketDiffOptions,
  defaultGitRunner,
  type GitRunner,
  type RepoDiff,
  type TicketDiff,
} from "./services/diffService.js";
import { readRunnerTesterLane, type RunnerTesterLane } from "./health/runnerTesterLane.js";
import { computeLandingStatus, type LandingStatus } from "./services/landingStatus.js";
import {
  type CommentRepoContext,
  type CreateCommentInput,
  ReviewCommentService,
  type ReviewCommentView,
} from "./services/reviewCommentService.js";
import { type RejectOutcome } from "./services/rejectOutcome.js";
import { type SinceDiff } from "./services/sinceReview.js";
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
import { DossierService, type Dossier } from "./services/dossierService.js";
import { type EvalJudgment } from "./services/evalJudgment.js";
import { type RegressionLink } from "./services/escapedDefects.js";
import { type ScoutRecord } from "./services/scoutRecord.js";
import { type LaneVerdict, type RawOpenKind } from "./services/reviewTelemetry.js";
import {
  ReviewPacketService,
  type CostReader,
  type ReviewPacket,
} from "./services/reviewPacketService.js";
import { SpecsService } from "./services/specsService.js";
import { SpecCoverageService } from "./services/specCoverageService.js";
import { resolveSpecClauseSeeder } from "./services/specClauseSeeder.js";
import { resolveSpecLoreReader } from "./services/specLoreReader.js";
import { resolveCodeIndexReader, type CodeIndexReader } from "./services/codeIndexReader.js";
import {
  BoardService,
  type BoardView,
  type BoardWindow,
  type DashboardSummary,
} from "./services/boardService.js";
import { PauseService, type PauseInput } from "./services/pauseService.js";
import { HumanQueueService, type HumanQueue } from "./services/humanQueueService.js";
import {
  type ApproveReviewOptions,
  type LandingStarted,
  type ReviewedHead,
  type TesterRoute,
  type UnavailableWriteRepo,
  ReviewGateService,
} from "./services/reviewGateService.js";
import { type ObservedRisk } from "./services/observedRisk.js";
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
import { policyGrantsAuto } from "./services/autonomyPolicyService.js";
import { type LandingFacts, type LandingState } from "./services/landingState.js";
import { type ApproveOutcome, type ApproveOutcomeFacts } from "./services/approveOutcome.js";
import {
  PrincipalRepository,
  type PrincipalActorType,
  type PrincipalCapability,
  type PrincipalView,
} from "./repositories/principalRepository.js";
import { type Access, type AccessAction, type ScopeTicket } from "./services/accessScope.js";
import { SuggestionService, type RepoSuggestion } from "./services/suggestionService.js";
import { TransitionService, type TransitionResult } from "./services/transitionService.js";
import { buildNotifierFromEnv } from "./notify/config.js";
import type { Notifier } from "./notify/types.js";
import { type Clock, systemClock } from "./util/clock.js";
import { newId } from "./util/id.js";
import type { DispatchInternals } from "./services/dispatchInternals.js";
import { type TesterLaneDecision, type TestingLaneMode } from "./util/testingLane.js";
import type {
  TicketDetailPart,
  TicketDetailBatchItem,
  TicketView,
} from "./services/ticketReadService.js";
import type { JudgeRevealResult, ReviewOpenResult } from "./services/ticketRecordsService.js";

// The services whose functions hold the method bodies this facade delegates to.
import * as gate from "./services/gateNotifications.js";
import * as ticketGit from "./services/ticketGitService.js";
import * as autonomyGate from "./services/autonomyGateService.js";
import * as principalAdmin from "./services/principalAdminService.js";
import * as landing from "./services/landingFactsService.js";
import * as reviewLifecycle from "./services/reviewLifecycleService.js";
import * as ticketLifecycle from "./services/ticketLifecycleService.js";
import * as testerLane from "./services/testerLaneService.js";
import * as ticketRecords from "./services/ticketRecordsService.js";
import * as regressions from "./services/regressionService.js";
import * as ticketLinks from "./services/ticketLinksService.js";
import * as planning from "./services/planningService.js";
import * as runRegistry from "./services/runRegistryService.js";
import * as eventLog from "./services/eventLogService.js";
import * as ticketReads from "./services/ticketReadService.js";
import { ephemeralGateKeyring, type GateKeyring } from "./events/gateSeal.js";
import { setEventAnchor } from "./events/eventWriter.js";

export { BOARD_COLUMNS } from "./services/boardService.js";
export type { BoardColumn } from "./services/boardService.js";

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
export {
  isTestingEnabled,
  testerProvenance,
  testingLaneMode,
  testerOffNotice,
} from "./util/testingLane.js";

/** The ticket view, the batched details and their parts (see services/ticketReadService.ts). */
export { TICKET_DETAIL_PARTS } from "./services/ticketReadService.js";
export type {
  EvidenceView,
  TicketDetailBatchItem,
  TicketDetailPart,
  TicketView,
} from "./services/ticketReadService.js";
export type { RegressionLinkView } from "./services/regressionService.js";

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

/** What recording a review open did (see services/ticketRecordsService.ts). */
export type { JudgeRevealResult, ReviewOpenResult } from "./services/ticketRecordsService.js";

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
  readonly reviewCommentSvc: ReviewCommentService;
  readonly autonomyRecommendations: AutonomyRecommendationService;
  readonly pauseSvc: PauseService;
  readonly humanQueueSvc: HumanQueueService;
  /** SQUAD: club identity + agent display names / shirt numbers (presentation only). */
  readonly squadSvc: SquadService;
  /** The private state the core services read (see services/dispatchInternals.ts). */
  private readonly internals: DispatchInternals;

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

  private readonly requireRegisteredAgentApprover: boolean;
  /** SIGNED GATE EVENTS: the keyring gate events are sealed and verified with. */
  readonly gateKeyring: GateKeyring;

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
      /**
       * CHANGE IMPACT: the code index reader for the Behavioural surface's callers row.
       * Defaults to the memory CLI when MEMORY_CLI_BIN + MEMORY_DB are set; null: none.
       */
      codeIndex?: CodeIndexReader | null;
      /**
       * A PERSON'S WAIVER records the factory's isolation: "none" or the OS sandbox
       * provider. Defaults to the runner's own probe (reviewGate/waiver.ts).
       */
      isolation?: () => string;
      /**
       * SIGNED GATE EVENTS: the key approvals and tester verdicts are sealed with, and
       * every landing verifies them under (events/gateSeal.ts). The trusted host entry
       * points (the CLI and the REST server) pass the factory key; the agent-facing MCP
       * server passes a keyring that refuses. The library default is a process-local
       * random key, whose seals no landing path in another process ever accepts.
       */
      gateKeyring?: GateKeyring;
    } = {},
  ) {
    this.db = db;
    this.internals = {
      codeIndex: options.codeIndex === undefined ? resolveCodeIndexReader() : options.codeIndex,
      gitRunner,
      lastCallersRow: new Map(),
      testingEnabledOverride: options.testingEnabled,
      notifier: options.notifier ?? buildNotifierFromEnv(),
    };
    this.maxAttemptsOverride = options.maxAttempts;
    this.requireRegisteredAgentApprover = options.requireRegisteredAgentApprover ?? false;
    this.gateKeyring = options.gateKeyring ?? ephemeralGateKeyring();
    // SIGNED GATE EVENTS: a keyring that may write it records the event log's head outside
    // the database after every committed write (a truncated revocation is then detected).
    const keyring = this.gateKeyring;
    setEventAnchor(db, keyring.anchor ? () => keyring.anchor!(db) : null);
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
      notifier: this.internals.notifier,
      onDecisionCreated: (d) => gate.emitDecisionGate(this, this.internals, d),
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
      // A planned build marks its tickets testable unless the lane is switched OFF: under
      // the `auto` default the tester then runs for each ticket whose repos have a
      // registered test command (decided when it is routed, not when it is planned).
      testingEnabled: () => this.testerLaneMode() !== "off",
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
      maxAttempts: () => this.maxAttempts,
      // Mirrors approveReview's routing: an acceptance ticket always goes through the
      // tester; a testable one does when the testing lane is on.
      testerExpected: (t) => this.reviewGateSvc.laneApplies(t),
      testerLane: (t) => this.testerLane(t),
      runnerTesterLane: (t) => this.runnerTesterLaneFor(t),
      // SAME CANDIDATE: the runner's gated commit per repo, and each write repo's head as
      // the approval reads it (role order), so the packet compares the commit Approve binds.
      repoDeliveries: this.repoDeliveries,
      writeRepoHeads: (t) => ticketGit.orderedWriteRepoHeads(this, t),
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
      testerLaneApplies: (t) => this.testerLane(t).on,
      runnerTesterLane: (t) => this.runnerTesterLaneFor(t),
      // REVIEWER ≠ AUTHOR: the agents table, so an agent approver can be checked to be a
      // registered principal (see requireRegisteredAgentApprover).
      agents: this.agents,
      requireRegisteredAgentApprover: this.requireRegisteredAgentApprover,
      gateKeyring: this.gateKeyring,
      onTicketParked: (ticket, detail) => {
        gate.emitGate(this, this.internals, "ticket_parked", ticket, { status: "blocked", detail });
      },
      // GRADUATED-AUTONOMY (Spec 2, Phase 1): resolve delivery-vs-merge SHAs so the
      // approve path can emit `approved_unchanged`. Pure read; degrades to unknown.
      approvalShaResolver: (ticket) => ticketGit.resolveApprovalShas(this, this.internals, ticket),
      // REVIEW PIN for a HUMAN approval: the commit the human approved (the primary write
      // repo's delivery-branch head at approve time), recorded as system evidence so every
      // landing path holds a branch that moved past it. Pure read; null when unknown.
      reviewedHeadsResolver: (ticket) => ticketGit.resolveApprovedHeads(this, ticket),
      // APPROVAL COVERS EVERY WRITE REPO: the write repos whose head cannot be read now.
      unavailableWriteReposResolver: (ticket) => this.writeRepoHeads(ticket).unavailable,
      // PER-REPOSITORY LANDING: git ancestry as positive evidence of a landing.
      landedOnDefaultResolver: (repoId, sha) =>
        ticketGit.commitOnDefaultBranch(this, this.internals, repoId, sha),
      // PR LANDINGS: the approved change carried by the default branch (or its remote copy).
      changeOnRefsResolver: (repoId, sha, refs) =>
        ticketGit.changeOnRefs(this, this.internals, repoId, sha, refs),
      // GRADUATED-AUTONOMY (Spec 2, Phase 3): the pure-policy predicate the P0 gate
      // ORs with the env flag — true iff a mode='auto' approve policy covers every
      // write repo at this ticket's risk. NO env read here (that stays in the gate).
      policyAllowsAgentApprove: (ticket) =>
        policyGrantsAuto(
          this.autonomyPolicy,
          ticketGit.writeRepoIdsForTicket(this, ticket),
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
      ...(options.isolation ? { isolation: options.isolation } : {}),
    });
    this.reviewCommentSvc = new ReviewCommentService({
      db,
      clock: this.clock,
      runGit: this.internals.gitRunner ?? defaultGitRunner,
      resolveTicket: (ref) => this.resolveTicket(ref),
      repoContexts: (ticket) => this.commentRepoContexts(ticket),
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
        gate.emitGate(this, this.internals, "ticket_parked", ticket, { status: "paused", detail });
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
      codeIndex?: CodeIndexReader | null;
      /** A person's waiver records the factory's isolation (see the constructor). */
      isolation?: () => string;
      gateKeyring?: GateKeyring;
    } = {},
  ): Dispatch {
    return new Dispatch(openDatabase(path), clock, gitRunner, options);
  }

  latestDodSummary(ticketId: string): string | null {
    return ticketGit.latestDodSummary(this, ticketId);
  }

  observedRiskFor(ticket: Ticket, repos?: readonly RepoDiff[]): ObservedRisk {
    return ticketGit.observedRiskFor(this, ticket, repos);
  }

  ticketDiff(ref: string, opts?: TicketDiffOptions): TicketDiff {
    return ticketGit.ticketDiff(this, this.internals, ref, opts);
  }

  downstreamRepos(repoId: string): Array<{ repo: string; via: string }> {
    return ticketGit.downstreamRepos(this, repoId);
  }

  writeRepoHeads(ticket: Ticket): { heads: ReviewedHead[]; unavailable: UnavailableWriteRepo[] } {
    return ticketGit.writeRepoHeads(this, this.internals, ticket);
  }

  commentRepoContexts(ticket: Ticket): CommentRepoContext[] {
    return ticketGit.commentRepoContexts(this, this.internals, ticket);
  }

  ticketHeads(ref: string): {
    ticketId: string;
    heads: Array<{ repo: string; repo_id: string; sha: string }>;
    unavailable: Array<{ repo: string; repo_id: string; why: string }>;
  } {
    return ticketGit.ticketHeads(this, ref);
  }

  ticketDiffSince(ref: string): SinceDiff {
    return ticketGit.ticketDiffSince(this, this.internals, ref);
  }

  // --- Graduated Autonomy policy (Spec 2, Phase 3) -------------------------

  autonomyGateDecision(
    ticket: Ticket,
    gate: AutonomyPolicyGate,
  ): {
    gate: AutonomyPolicyGate;
    decision: "allow" | "deny";
    risk_level: string;
    write_repo_ids: string[];
  } {
    return autonomyGate.autonomyGateDecision(this, ticket, gate);
  }

  /** Every stored autonomy policy joined to its repo name (Settings surface). */
  listAutonomyPolicies(): AutonomyPolicyView[] {
    return this.autonomyPolicy.list();
  }

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
    return autonomyGate.setAutonomyPolicy(this, input, actor);
  }

  // --- Per-principal API credentials -----------------------------------------

  createPrincipal(
    input: {
      name: string;
      capability?: PrincipalCapability | undefined;
      actorType?: PrincipalActorType | undefined;
      actorId?: string | undefined;
      /** Repo names or ids: the principal may reach only tickets on these repos. */
      repos?: readonly string[] | undefined;
      /** Ticket numbers or ids: the principal may reach these tickets. */
      tickets?: ReadonlyArray<string | number> | undefined;
    },
    actor: Actor,
  ): { principal: PrincipalView; token: string } {
    return principalAdmin.createPrincipal(this, input, actor);
  }

  /** Every principal, newest first, revoked ones included (never the hash). */
  listPrincipals(): PrincipalView[] {
    return this.principals.list();
  }

  getPrincipal(ref: string): PrincipalView {
    return principalAdmin.getPrincipal(this, ref);
  }

  revokePrincipal(ref: string, actor: Actor): PrincipalView {
    return principalAdmin.revokePrincipal(this, ref, actor);
  }

  scopeTicket(ref: string): ScopeTicket {
    return principalAdmin.scopeTicket(this, ref);
  }

  ticketVisibility(principal: PrincipalView): ((ticketId: string) => boolean) | null {
    return principalAdmin.ticketVisibility(this, principal);
  }

  decisionTicketIds(decisionId: string): string[] {
    return principalAdmin.decisionTicketIds(this, decisionId);
  }

  /**
   * DECISION VISIBILITY: may a holder with this ticket filter read a decision? Null when
   * unscoped. The one rule every decision-bearing response applies.
   */
  decisionVisibility(
    ticketVisible: ((ticketId: string) => boolean) | null,
  ): ((decisionId: string) => boolean) | null {
    return principalAdmin.decisionVisibility(this, ticketVisible);
  }

  assertPrincipalAccess(principal: PrincipalView, action: AccessAction, access?: Access): void {
    return principalAdmin.assertPrincipalAccess(this, principal, action, access);
  }

  resolvePrincipalToken(token: string): { principal: PrincipalView; actor: Actor } | null {
    return principalAdmin.resolvePrincipalToken(this, token);
  }

  // --- Tickets -------------------------------------------------------------

  createTicket(raw: unknown, actor: Actor): Ticket {
    return this.ticketSvc.createTicket(raw, actor);
  }

  createTicketWithLinks(
    raw: unknown,
    links: {
      repo?: string | undefined;
      scopeNodeIds?: readonly string[] | undefined;
      repoAccess?: ReadonlyArray<{ repo_id: string; access: string }> | undefined;
    },
    actor: Actor,
  ): Ticket {
    return ticketLinks.createTicketWithLinks(this, raw, links, actor);
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

  createEpic(raw: unknown, actor: Actor): CreateEpicResult {
    return planning.createEpic(this, raw, actor);
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

  specClauseExists(clauseId: string): boolean {
    return planning.specClauseExists(this, clauseId);
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
    return ticketLinks.linkTicketScope(this, raw, actor);
  }

  setPrimaryScope(ticketRef: string, scopeNodeId: string, actor: Actor): TicketScopeNode {
    return ticketLinks.setPrimaryScope(this, ticketRef, scopeNodeId, actor);
  }

  listTicketScopes(ticketRef: string): TicketScopeWithNode[] {
    return this.scope.listTicketScopes(ticketRef);
  }

  removeTicketScope(
    ticketRef: string,
    scopeNodeId: string,
    actor: Actor,
  ): { ticketId: string; scopeNodeId: string; eventId: string } {
    return ticketLinks.removeTicketScope(this, ticketRef, scopeNodeId, actor);
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
  /**
   * `decisionVisible`: the reader's decision filter (null or omitted: unscoped). A
   * blocking decision it may not read is still a blocker, named generically.
   */
  claimability(
    ticketRef: string,
    decisionVisible?: ((decisionId: string) => boolean) | null,
  ): ClaimabilityResult {
    return this.ticketSvc.claimability(ticketRef, decisionVisible);
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
    input: {
      title: string;
      question: string;
      severity?: DecisionSeverity;
      ticketId?: string;
      ticketIds?: readonly string[];
    },
    actor: Actor,
  ): Decision {
    return ticketLinks.createDecision(this, input, actor);
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

  moveTicket(ticketRef: string, target: string, actor: Actor): TransitionResult {
    return reviewLifecycle.moveTicket(this, ticketRef, target, actor);
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

  landingApproval(ref: string): string | null {
    return reviewLifecycle.landingApproval(this, ref);
  }

  landingsStarted(ref: string): LandingStarted[] {
    return reviewLifecycle.landingsStarted(this, ref);
  }

  /** TESTER REPLAY: record the tester's tests passed on the landed revision (system only). */
  recordTesterReplay(
    ref: string,
    input: {
      commit: string;
      pin: string;
      files: readonly string[];
      tests?: unknown;
      evidence?: string | undefined;
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
      acceptance_evidence?: string;
      /** The test identities the PASS binds (system only; see services/testerReplay.ts). */
      tests?: unknown;
      /** The tester agent (and run) whose verdict the runner records (system only). */
      tester_agent?: unknown;
      /** The testing round the verdict was made in (a stale one is refused). */
      round?: string;
      /** A person's waiver: the criteria it waives, by position or id (default: all). */
      criteria?: readonly string[];
    },
    actor: Actor,
    /**
     * A PERSON'S VERDICT (package H1): the principal it is recorded for. A human or admin
     * actor without an active human or admin principal is refused (ACTOR_NOT_PERMITTED).
     */
    authority: { principal?: VerdictPrincipal | null } = {},
  ): TransitionResult {
    return reviewLifecycle.testerPass(this, this.internals, ticketRef, input, actor, authority);
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
      /** The testing round the verdict was made in (a stale one is refused). */
      round?: string;
    },
    actor: Actor,
    /** A PERSON'S VERDICT (package H1): see testerPass. */
    authority: { principal?: VerdictPrincipal | null } = {},
  ): TransitionResult {
    return this.reviewGateSvc.testerFail(ticketRef, input, actor, authority);
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

  /** ACCEPTANCE PROFILE: a person sets the profile and the commands the runner runs. */
  setAcceptanceProfile(
    ticketRef: string,
    input: { profile: unknown; spec?: unknown },
    actor: Actor,
  ): { ticketId: string; profile: AcceptanceProfile; contract: TestContract; eventId: string } {
    return this.ticketSvc.setAcceptanceProfile(ticketRef, input, actor);
  }

  /** ACCEPTANCE EVIDENCE: the runner's record of a profile run (system only). */
  recordAcceptanceEvidence(
    ticketRef: string,
    payloadJson: string,
    actor: Actor,
  ): { evidenceId: string; eventId: string; passed: boolean } {
    return this.ticketSvc.recordAcceptanceEvidence(ticketRef, payloadJson, actor);
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

  holdForHuman(
    ref: string,
    input: { reasonCode: string; reason: string },
    actor: Actor,
  ): TransitionResult {
    return reviewLifecycle.holdForHuman(this, this.internals, ref, input, actor);
  }

  /** REQUIRED CI: record that a ticket needs CI before review exposes it (system/admin). */
  recordCiRequired(
    ref: string,
    input: { detail?: string },
    actor: Actor,
  ): { required: true; eventId: string | null } {
    return this.reviewGateSvc.recordCiRequired(ref, input, actor);
  }

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
    return reviewLifecycle.recordCiResult(this, this.internals, ref, input, actor);
  }

  recordEvalJudgment(
    ref: string,
    input: unknown,
    actor: Actor,
  ): { ticketId: string; eventId: string; judgment: EvalJudgment } {
    return ticketRecords.recordEvalJudgment(this, ref, input, actor);
  }

  recordReviewOpened(ref: string, actor: Actor, seenRound?: string | null): ReviewOpenResult {
    return ticketRecords.recordReviewOpened(this, this.internals, ref, actor, seenRound);
  }

  recordReviewRawOpened(
    ref: string,
    what: RawOpenKind,
    actor: Actor,
    seenRound?: string | null,
  ): ReviewOpenResult {
    return ticketRecords.recordReviewRawOpened(this, this.internals, ref, what, actor, seenRound);
  }

  /** BLINDING: a person opened the eval judge's collapsed view of a ticket in review. */
  recordJudgeRevealed(ref: string, actor: Actor, seenRound?: string | null): ReviewOpenResult {
    return ticketRecords.recordJudgeRevealed(this, this.internals, ref, actor, seenRound);
  }

  /**
   * BLINDING: record the reveal, then return the grade (one step; no grade when the
   * reveal could not be recorded). See ticketRecordsService.revealJudge.
   */
  revealJudge(ref: string, actor: Actor, seenRound?: string | null): JudgeRevealResult {
    return ticketRecords.revealJudge(this, this.internals, ref, actor, seenRound ?? null);
  }

  recordLaneVerdict(
    ref: string,
    input: Record<string, unknown>,
    actor: Actor,
  ): { ticketId: string; eventId: string; verdict: LaneVerdict } {
    return ticketRecords.recordLaneVerdict(this, ref, input, actor);
  }

  recordScout(
    ref: string,
    input: unknown,
    actor: Actor,
  ): { ticketId: string; eventId: string; scout: ScoutRecord } {
    return ticketRecords.recordScout(this, ref, input, actor);
  }

  fileRegression(
    ref: string,
    of: string,
    actor: Actor,
    note?: string | null,
  ): { ticketId: string; regressionOf: string; recorded: boolean; eventId: string | null } {
    return regressions.fileRegression(this, ref, of, actor, note);
  }

  withdrawRegression(
    ref: string,
    of: string,
    actor: Actor,
  ): { ticketId: string; regressionOf: string; recorded: boolean; eventId: string | null } {
    return regressions.withdrawRegression(this, ref, of, actor);
  }

  regressionLinkRows(): RegressionLink[] {
    return regressions.regressionLinkRows(this);
  }

  ciStatus(
    ref: string,
    commit?: string | null,
  ): { required: boolean; state: string | null; commit: string | null } {
    return reviewLifecycle.ciStatus(this, ref, commit);
  }

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
    return landing.approveOutcomeFacts(this, ref, opts);
  }

  approveOutcome(
    ref: string,
    opts: {
      mergeCommand: boolean;
      env?: NodeJS.ProcessEnv;
      approver?: "human" | "agent";
      repos?: readonly RepoDiff[];
    },
  ): ApproveOutcome {
    return landing.approveOutcome(this, ref, opts);
  }

  landingFacts(ref: string | Ticket, env?: NodeJS.ProcessEnv): LandingFacts | null {
    return landing.landingFacts(this, ref, env);
  }

  landingState(ref: string | Ticket, env?: NodeJS.ProcessEnv): LandingState | null {
    return landing.landingState(this, ref, env);
  }

  withLandingState<T extends Ticket>(
    tickets: readonly T[],
  ): Array<T & { landing_state?: LandingState }> {
    return landing.withLandingState(this, tickets);
  }

  mergeInFlight(ref: string): boolean {
    return landing.mergeInFlight(this, ref);
  }

  noteMergeStarted(ref: string, runId: string | null, actor: Actor): void {
    return landing.noteMergeStarted(this, ref, runId, actor);
  }

  markMerged(ref: string, actor: Actor): TransitionResult {
    return this.reviewGateSvc.markMerged(ref, actor);
  }

  reopenForReview(
    ref: string,
    input: { reason: string; resolution: string; cause?: ReopenForReviewCause },
    actor: Actor,
  ): { ticketId: string; status: string; eventId: string } {
    return reviewLifecycle.reopenForReview(this, ref, input, actor);
  }

  rejectReview(
    ticketRef: string,
    to: "ready" | "refining" | "cancelled",
    actor: Actor,
    reason?: string,
  ): TransitionResult & { landedAlready: LandingStarted[] } {
    return reviewLifecycle.rejectReview(this, ticketRef, to, actor, reason);
  }

  // --- Review comments (A1) + Fix these (A2) --------------------------------

  /** Write a review comment (human/admin only; see ReviewCommentService.create). */
  createReviewComment(ref: string, input: CreateCommentInput, actor: Actor): ReviewCommentView {
    return this.reviewCommentSvc.create(ref, input, actor);
  }

  listReviewComments(
    ref: string,
    opts?: { open?: boolean; anchors?: boolean },
  ): ReviewCommentView[] {
    return reviewLifecycle.listReviewComments(this, ref, opts);
  }

  /** Resolve / reopen / withdraw a review comment (a human act). */
  setReviewCommentState(
    commentRef: string,
    action: "resolve" | "reopen" | "withdraw",
    actor: Actor,
    ticketRef?: string,
  ): ReviewCommentView {
    return this.reviewCommentSvc.setState(commentRef, action, actor, ticketRef);
  }

  rejectOutcome(ref: string, to?: "refining" | "ready", requirements?: number): RejectOutcome {
    return reviewLifecycle.rejectOutcome(this, ref, to, requirements);
  }

  fixThese(
    ref: string,
    opts: { commentIds?: readonly string[]; to?: "refining" | "ready" },
    actor: Actor,
  ): TransitionResult & {
    landedAlready: LandingStarted[];
    requirements: ReviewCommentView[];
    rejectOutcome: RejectOutcome;
  } {
    return reviewLifecycle.fixThese(this, ref, opts, actor);
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
    return reviewLifecycle.wontDo(this, ref, actor, reason);
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

  beginResume(
    ref: string,
    actor: Actor,
    lease?: { agentId: string; ttlSeconds: number },
  ): { ticketId: string; eventId: string; context: PausedDelivery; claimToken?: string } {
    return ticketLifecycle.beginResume(this, ref, actor, lease);
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

  claimTicket(raw: unknown, actor: Actor): ClaimResult {
    return ticketLifecycle.claimTicket(this, raw, actor);
  }

  humanClaimTicket(ref: string, actor: Actor): { ticketId: string; number: number } {
    return ticketLifecycle.humanClaimTicket(this, ref, actor);
  }

  humanReleaseTicket(
    ref: string,
    actor: Actor,
  ): { ticketId: string; status: string; eventId: string } {
    return ticketLifecycle.humanReleaseTicket(this, ref, actor);
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

  dossier(ref: string): Dossier {
    return ticketRecords.dossier(this, ref);
  }

  reviewPacket(ref: string, costFor: CostReader): ReviewPacket {
    return ticketRecords.reviewPacket(this, ref, costFor);
  }

  recordDossier(ref: string, actor: Actor): { dossier: Dossier; eventId: string | null } {
    return ticketRecords.recordDossier(this, ref, actor);
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
    return ticketLifecycle.submitForReview(this, this.internals, input, actor);
  }

  testerLaneMode(): TestingLaneMode {
    return testerLane.testerLaneMode(this.internals);
  }

  testerLane(ref: string | Ticket, mode?: TestingLaneMode): TesterLaneDecision {
    return testerLane.testerLane(this, ref, mode);
  }

  recordRunnerTesterLane(): boolean {
    return testerLane.recordRunnerTesterLane(this);
  }

  /** The tester lane the runner last recorded, or null. */
  runnerTesterLane(): RunnerTesterLane | null {
    return readRunnerTesterLane(this.db);
  }

  runnerTesterLaneFor(
    ref: string | Ticket,
  ): (RunnerTesterLane & { on: boolean; gates: boolean }) | null {
    return testerLane.runnerTesterLaneFor(this, ref);
  }

  testerLaneHealth(): {
    mode: TestingLaneMode;
    repos_without_test_command: string[];
    notices: string[];
    runner: RunnerTesterLane | null;
    runner_differs: boolean;
  } {
    return testerLane.testerLaneHealth(this);
  }

  pendingTesterRoutes(): number {
    return testerLane.pendingTesterRoutes(this);
  }

  routeToTester(ref: string | null, actor: Actor): TesterRoute[] {
    return testerLane.routeToTester(this, ref, actor);
  }

  humanBlockTicket(
    ref: string,
    reason: string,
    actor: Actor,
  ): { ticketId: string; from: TicketStatus; eventId: string } {
    return ticketLifecycle.humanBlockTicket(this, this.internals, ref, reason, actor);
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
    return ticketLifecycle.markBlocked(this, this.internals, input, actor);
  }

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
    return ticketLifecycle.runnerRelease(this, this.internals, input, actor);
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

  reworkTrail(ref: string): ReworkAttempt[] {
    return ticketReads.reworkTrail(this, ref);
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
    return ticketLifecycle.expireStaleClaims(this, this.internals, actor);
  }

  revokeClaim(claimId: string, actor: Actor): { claimId: string; ticketId: string } {
    return ticketLifecycle.revokeClaim(this, claimId, actor);
  }

  createDraftTicket(
    input: {
      title: string;
      description?: string;
      repoName?: string;
      evidenceSummary?: string;
      policyPack?: string;
      sourceUrl?: string;
    },
    actor: Actor,
  ): { ticketId: string; number: number; deduped?: boolean } {
    return ticketLifecycle.createDraftTicket(this, input, actor);
  }

  /** The ticket recording exactly this source (ingest dedup; see util/ticketMarkers.ts). */
  findTicketBySource(sourceUrl: string): { ticketId: string; number: number } | undefined {
    return this.ticketSvc.findTicketBySource(sourceUrl);
  }

  attachDeliveryEvidence(
    ref: string,
    input: DeliveryEvidenceInput,
    actor: Actor,
  ): { evidenceId: string; eventId: string } {
    return this.ticketSvc.attachDeliveryEvidence(ref, input, actor);
  }

  // --- H2 human-gate notifications -----------------------------------------

  // --- Reads ---------------------------------------------------------------

  resolveTicket(ref: string): Ticket {
    return this.ticketSvc.resolveTicket(ref);
  }

  view(ref: string): TicketView {
    return ticketReads.view(this, ref);
  }

  /**
   * BLINDING: the ticket view as a reader sees it before the decision. While the ticket is
   * in review and nobody has opened the judge's view this round, the eval judge's grade is
   * hidden: `evalJudgment` is null, `judgeHidden` true, and the judge's events carry
   * `{ hidden: true }` in place of the grade (ticketReadService.hideJudgeInReview).
   * GET /tickets/:id and `wg ticket show` read this; `view` keeps the grade.
   */
  readerView(ref: string): TicketView & { judgeHidden: boolean } {
    const v = ticketReads.view(this, ref);
    const h = ticketReads.hideJudgeInReview(v.ticket, v.events);
    return h.hidden
      ? { ...v, events: h.events, evalJudgment: null, judgeHidden: true }
      : { ...v, judgeHidden: false };
  }

  ticketDetailsBatch(
    select: { ids: readonly string[] } | { limit: number; offset: number },
    include: ReadonlySet<TicketDetailPart>,
    visible?: ((ticketId: string) => boolean) | null,
  ): { details: TicketDetailBatchItem[]; missing: string[]; total: number } {
    return ticketReads.ticketDetailsBatch(this, select, include, visible);
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

  listTicketEvents(ref: string): WorkEvent[] {
    return ticketReads.listTicketEvents(this, ref);
  }

  listActiveClaims(): Array<ActiveClaimView & { agent_display: AgentDisplay | null }> {
    return ticketReads.listActiveClaims(this);
  }

  listAgents(): Array<Agent & { agent_display: AgentDisplay | null }> {
    return ticketReads.listAgents(this);
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

  agentDisplayFor(ids: Iterable<string | null | undefined>): Record<string, AgentDisplay> {
    return ticketReads.agentDisplayFor(this, ids);
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

  recordRunStart(input: {
    id?: string;
    kind: RunKind;
    repo?: string | null;
    pid?: number | null;
    log_path?: string | null;
  }): { id: string } {
    return runRegistry.recordRunStart(this, input);
  }

  markRunEnd(
    id: string,
    input: { exit_code: number | null; detail?: string | null; status?: Run["status"] },
  ): void {
    return runRegistry.markRunEnd(this, id, input);
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

  createPlanSession(): PlanSession {
    return planning.createPlanSession(this);
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

  appendPlanMessage(
    id: string,
    message: Omit<PlanMessage, "ts">,
    opts?: { brief?: string | null; plan?: unknown },
  ): PlanSession | null {
    return planning.appendPlanMessage(this, id, message, opts);
  }

  archivePlanSession(id: string, status: "confirmed" | "abandoned"): void {
    return planning.archivePlanSession(this, id, status);
  }

  recordPlanSession(input: {
    brief: string;
    messages: ReadonlyArray<Omit<PlanMessage, "ts">>;
    plan: unknown;
    status: "confirmed" | "abandoned";
  }): PlanSession {
    return planning.recordPlanSession(this, input);
  }

  /**
   * List plan sessions, most-recently-created first. Capped at 20 by default.
   * When `status` is given, only sessions with that status are returned.
   */
  listPlanSessions(options: PlanSessionListOptions = {}): PlanSession[] {
    return this.planSessions.list(options);
  }

  // --- Board + dashboard reads (read-only showcase surfaces) ----------------

  board(repo?: string, window?: BoardWindow, visible?: (ticketId: string) => boolean): BoardView {
    return ticketReads.board(this, repo, window, visible);
  }

  /**
   * GRADUATED-AUTONOMY (Spec 2, Phase 2): read-only, advisory per-repo/per-risk/
   * per-gate autonomy recommendations backed by the review track record. NEVER
   * enables anything — the operator acts on it (Phase 3 adds the enable action).
   */
  autonomyRecommendationsList(): AutonomyRecommendation[] {
    return this.autonomyRecommendations.recommend();
  }

  activity(query: ActivityQuery): {
    events: Array<ActivityEvent & { agent_display: AgentDisplay | null }>;
    total: number;
  } {
    return ticketReads.activity(this, query);
  }

  dashboard(): DashboardSummary {
    return this.boardSvc.dashboard();
  }

  humanQueue(): HumanQueue {
    return ticketReads.humanQueue(this);
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

  rechainEventLog(actor: Actor): {
    rechained: number;
    oldHead: string;
    newHead: string;
    verification: ChainVerification;
  } {
    return eventLog.rechainEventLog(this, actor);
  }
}
