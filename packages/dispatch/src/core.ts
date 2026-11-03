import type { AcceptanceProfile } from "./domain/acceptanceProfile.js";

import { type Db, inTransaction, openDatabase } from "./db/connection.js";
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
  TICKET_SUMMARY_COLUMNS,
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
import {
  readRunnerTesterLane,
  recordRunnerTesterLane,
  runnerLaneNotice,
  type RunnerTesterLane,
} from "./health/runnerTesterLane.js";
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
import { EPIC_MEMBER_RELATIONS, ownAcceptanceTicketId } from "./services/epicAcceptance.js";
import { DossierService, DOSSIER_EVENT_TYPE, type Dossier } from "./services/dossierService.js";
import {
  assertMayRecordJudgment,
  currentJudgment,
  EVAL_JUDGED_EVENT,
  normalizeJudgment,
  type EvalJudgment,
  type RecordedEvalJudgment,
} from "./services/evalJudgment.js";
import {
  assertMayFileRegression,
  currentRegressionLinks,
  DEFECT_ESCAPED_EVENT,
  DEFECT_ESCAPED_WITHDRAWN_EVENT,
  regressionNote,
  type RegressionEventRow,
  type RegressionLink,
} from "./services/escapedDefects.js";
import {
  assertMayRecordScout,
  normalizeScoutRecord,
  SCOUT_RECORDED_EVENT,
  type ScoutRecord,
} from "./services/scoutRecord.js";
import {
  assertMayRecordLaneVerdict,
  assertMayRecordReviewOpen,
  LANE_VERDICT_EVENT,
  normalizeLaneVerdict,
  REVIEW_OPENED_EVENT,
  REVIEW_RAW_OPENED_EVENT,
  type LaneVerdict,
  type RawOpenKind,
} from "./services/reviewTelemetry.js";
import {
  enteredReviewAt,
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
  type BoardCard,
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
export { BOARD_COLUMNS } from "./services/boardService.js";
export type { BoardColumn } from "./services/boardService.js";
import { SuggestionService, type RepoSuggestion } from "./services/suggestionService.js";
import { TransitionService, type TransitionResult } from "./services/transitionService.js";
import { buildNotifierFromEnv } from "./notify/config.js";
import type { Notifier } from "./notify/types.js";
import { type Clock, systemClock } from "./util/clock.js";
import { DispatchError, notFound } from "./util/errors.js";
import { newId } from "./util/id.js";
import { agreedRequirementsFromTurns } from "./util/planClarifications.js";
import type { DispatchInternals } from "./services/dispatchInternals.js";

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
import {
  testerLaneFor,
  testerOffNotice,
  testingLaneMode,
  type TesterLaneDecision,
  type TestingLaneMode,
} from "./util/testingLane.js";
import * as gate from "./services/gateNotifications.js";
import * as ticketGit from "./services/ticketGitService.js";
import * as autonomyGate from "./services/autonomyGateService.js";
import * as principalAdmin from "./services/principalAdminService.js";
import * as landing from "./services/landingFactsService.js";
import * as reviewLifecycle from "./services/reviewLifecycleService.js";
import * as ticketLifecycle from "./services/ticketLifecycleService.js";

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

/** The parts GET /tickets/details can return per ticket (the ticket row always comes). */
export const TICKET_DETAIL_PARTS = [
  "repositories",
  "scopes",
  "dependencies",
  "rework_trail",
  "events",
  "evidence",
] as const;
export type TicketDetailPart = (typeof TICKET_DETAIL_PARTS)[number];

/** One ticket of a {@link Dispatch.ticketDetailsBatch} read: the summary row + the asked parts. */
export interface TicketDetailBatchItem {
  ticket: TicketSummary;
  repositories?: TicketRepoLink[];
  scopes?: TicketScopeWithNode[];
  dependencies?: TicketDependencyView[];
  rework_trail?: ReturnType<ReworkAttemptRepository["listForTicket"]>;
  events?: WorkEvent[];
  evidence?: EvidenceView[];
}

/** One side of a regression link as the ticket view shows it. */
export interface RegressionLinkView {
  ticket_id: string;
  number: number | null;
  title: string;
  status: string;
  filed_by: { type: string; id: string | null };
  filed_at: string;
  note: string | null;
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
   * REVIEW COMMENTS (A1): the reviewer's comments on this ticket, oldest first, with the
   * delivery agent's replies (claims). No git here: the anchor state is computed by
   * {@link Dispatch.listReviewComments} with `anchors`. Outside the hashed dossier subject.
   */
  reviewComments: ReviewCommentView[];
  /**
   * PER-REPOSITORY LANDING: the approved commit of each write repo (its current review
   * pin) and whether that commit has landed on the repo's default branch. A ticket is
   * done only when every one has; `partial` marks a held, partly merged ticket.
   */
  landing: LandingStatus;
  /**
   * EVAL JUDGE: the delivery-quality judge's verdict on the current delivery (the latest
   * `ticket.eval_judged` event since the ticket last entered review), or null when the
   * judge is off (the runner default), failed, or graded only an earlier attempt.
   * Advisory: no gate reads it.
   */
  evalJudgment: RecordedEvalJudgment | null;
  /**
   * ESCAPED DEFECTS (MF5): the accepted changes a person said this ticket regresses, and
   * the later tickets a person linked to this one as its regressions. Current links only.
   */
  regression: { regression_of: RegressionLinkView[]; regressed_by: RegressionLinkView[] };
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

/** What recording a review open did (recorded, or why not). */
export interface ReviewOpenResult {
  ticketId: string;
  recorded: boolean;
  /** Why nothing was written: not_in_review | no_review_round | stale_round | already_recorded. */
  reason: string | null;
  eventId: string | null;
  roundEnteredAt: string | null;
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
      maxAttempts: this.maxAttempts,
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
    input: {
      title: string;
      question: string;
      severity?: DecisionSeverity;
      ticketId?: string;
      ticketIds?: readonly string[];
    },
    actor: Actor,
  ): Decision {
    // Accept any ticket reference (id, 15, #15, T-15) like every other ticket tool; the
    // link table stores the id, so an unresolved number would fail its foreign key.
    const ticketId = input.ticketId ? this.resolveTicket(input.ticketId).id : undefined;
    const ticketIds = input.ticketIds?.map((ref) => this.resolveTicket(ref).id);
    return this.decisionSvc.createDecision(
      {
        ...input,
        ...(ticketId !== undefined ? { ticketId } : {}),
        ...(ticketIds !== undefined ? { ticketIds } : {}),
      },
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
    },
    actor: Actor,
  ): TransitionResult {
    return reviewLifecycle.testerPass(this, this.internals, ticketRef, input, actor);
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

  /**
   * EVAL JUDGE: record the delivery-quality judge's verdict on a ticket (runner/lib/
   * eval-judge.sh after a submit). System/admin only. Telemetry: nothing reads it to
   * gate, approve or land; it is shown to the reviewer and paired with the review outcome
   * by `wg judge-agreement`.
   */
  recordEvalJudgment(
    ref: string,
    input: unknown,
    actor: Actor,
  ): { ticketId: string; eventId: string; judgment: EvalJudgment } {
    assertMayRecordJudgment(actor);
    const ticket = this.resolveTicket(ref);
    const judgment = normalizeJudgment(input, ticket.attempt_count);
    const eventId = inTransaction(this.db, () => {
      const id = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: EVAL_JUDGED_EVENT,
        payload: judgment,
      });
      // The Review view shows the grade, and it (and its packet cache) re-reads a ticket
      // only when its updated_at moves: bump it so an open page shows the grade. Nothing
      // else changes: no status, no row_version, no gate input.
      this.tickets.touch(ticket.id, this.clock.now());
      return id;
    });
    return { ticketId: ticket.id, eventId, judgment };
  }

  /**
   * REVIEW TELEMETRY: a person rendered this ticket in the Review view. Recorded once per
   * review round (the round is the ticket's last entry into in_review, computed here, not
   * taken from the caller), with the delivery commits recorded for each repo. Only while
   * the ticket is in review, and only for a human or admin actor. Never bumps updated_at:
   * the Review queue re-renders on it. A measurement only; nothing gates on it.
   */
  recordReviewOpened(ref: string, actor: Actor, seenRound: string | null = null): ReviewOpenResult {
    assertMayRecordReviewOpen(actor);
    const ticket = this.resolveTicket(ref);
    return this.recordReviewOpen(ticket, actor, seenRound, REVIEW_OPENED_EVENT, null);
  }

  /**
   * REVIEW TELEMETRY: a person opened a raw log, the evidence in full or the full diff of
   * a ticket in review. Once per round and kind; the same rules as recordReviewOpened.
   */
  recordReviewRawOpened(
    ref: string,
    what: RawOpenKind,
    actor: Actor,
    seenRound: string | null = null,
  ): ReviewOpenResult {
    assertMayRecordReviewOpen(actor);
    const ticket = this.resolveTicket(ref);
    return this.recordReviewOpen(ticket, actor, seenRound, REVIEW_RAW_OPENED_EVENT, what);
  }

  private recordReviewOpen(
    ticket: Ticket,
    actor: Actor,
    seenRound: string | null,
    eventType: typeof REVIEW_OPENED_EVENT | typeof REVIEW_RAW_OPENED_EVENT,
    what: RawOpenKind | null,
  ): ReviewOpenResult {
    return inTransaction(this.db, () => {
      const current = this.resolveTicket(ticket.id);
      if (current.status !== "in_review")
        return {
          ticketId: ticket.id,
          recorded: false,
          reason: "not_in_review",
          eventId: null,
          roundEnteredAt: null,
        };
      const round = this.events.enteredStatusAt(ticket.id, "in_review")?.at ?? null;
      if (round === null)
        return {
          ticketId: ticket.id,
          recorded: false,
          reason: "no_review_round",
          eventId: null,
          roundEnteredAt: null,
        };
      if (seenRound !== null && seenRound !== round)
        return {
          ticketId: ticket.id,
          recorded: false,
          reason: "stale_round",
          eventId: null,
          roundEnteredAt: round,
        };
      const seen = this.db
        .prepare(
          `SELECT 1 FROM work_events
            WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = ?
              AND json_extract(payload_json, '$.round_entered_at') = ?
              AND (? IS NULL OR json_extract(payload_json, '$.what') = ?)
            LIMIT 1`,
        )
        .get(ticket.id, eventType, round, what, what);
      if (seen)
        return {
          ticketId: ticket.id,
          recorded: false,
          reason: "already_recorded",
          eventId: null,
          roundEnteredAt: round,
        };
      const payload =
        what === null
          ? {
              round_entered_at: round,
              head_shas: this.repoDeliveries
                .listForTicket(ticket.id)
                .filter((d) => d.commit_sha)
                .map((d) => ({ repo: d.repo_name, sha: d.commit_sha })),
              // What the Behavioural surface's callers row showed for this ticket when the
              // server last computed it IN THIS ROUND (listed / none_changed / not_analysed);
              // absent when it has not (Health counts only known rows).
              ...(this.internals.lastCallersRow.get(ticket.id)?.round === round
                ? { impact_callers: this.internals.lastCallersRow.get(ticket.id)!.status }
                : {}),
            }
          : { what, round_entered_at: round };
      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: eventType,
        payload,
      });
      return { ticketId: ticket.id, recorded: true, reason: null, eventId, roundEnteredAt: round };
    });
  }

  /**
   * LANE VERDICT: what a judging lane (the reviewer agent, the security reviewer, the
   * tester, the eval judge) concluded about one candidate, recorded by the runner as a
   * system event so whether a lane changed the decision can be computed. System/admin
   * only; an agent is refused. Nothing gates on it, and it never bumps updated_at.
   */
  recordLaneVerdict(
    ref: string,
    input: Record<string, unknown>,
    actor: Actor,
  ): { ticketId: string; eventId: string; verdict: LaneVerdict } {
    assertMayRecordLaneVerdict(actor);
    const ticket = this.resolveTicket(ref);
    const verdict = normalizeLaneVerdict(input, actor);
    const eventId = writeEvent(this.db, {
      entity_type: "ticket",
      entity_id: ticket.id,
      actor,
      event_type: LANE_VERDICT_EVENT,
      payload: verdict,
    });
    return { ticketId: ticket.id, eventId, verdict };
  }

  /**
   * PRE-WORK SCOUT: the runner's scout packet summary for one delivery attempt (the risk
   * it classified, the signals that raised it, its coverage), recorded as a system event
   * for the Review backing rows and Health's scout read model. System/admin only; an
   * agent is refused. Nothing gates on it, and it never bumps updated_at.
   */
  recordScout(
    ref: string,
    input: unknown,
    actor: Actor,
  ): { ticketId: string; eventId: string; scout: ScoutRecord } {
    assertMayRecordScout(actor);
    const ticket = this.resolveTicket(ref);
    const packet =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    // The declared level is the ticket's own, not the packet's copy of it.
    const scout = normalizeScoutRecord(packet, actor, ticket.risk_level);
    const eventId = writeEvent(this.db, {
      entity_type: "ticket",
      entity_id: ticket.id,
      actor,
      event_type: SCOUT_RECORDED_EVENT,
      payload: scout,
    });
    return { ticketId: ticket.id, eventId, scout };
  }

  /**
   * ESCAPED DEFECT (MF5): a person says `ref` (a defect report or its fix) is a regression
   * of the accepted change `of` (a ticket id or number). Recorded as `ticket.defect_escaped`
   * on `ref`, the actor columns saying who filed it. Human or admin only; the target must be
   * another ticket that is done (an accepted change). Filing the same standing link again
   * records nothing. A measurement: nothing gates on it, and it never bumps updated_at.
   */
  fileRegression(
    ref: string,
    of: string,
    actor: Actor,
    note: string | null = null,
  ): { ticketId: string; regressionOf: string; recorded: boolean; eventId: string | null } {
    assertMayFileRegression(actor);
    const ticket = this.resolveTicket(ref);
    const target = this.resolveTicket(of);
    if (target.id === ticket.id)
      throw new DispatchError("VALIDATION_ERROR", "A ticket cannot be a regression of itself.", {
        ticket_id: ticket.id,
      });
    if (target.status !== "done")
      throw new DispatchError(
        "STATE_CONFLICT",
        `#${target.number ?? "?"} is not an accepted change (it is ${target.status}); a regression links to a change that reached done.`,
        { regression_of: target.id, status: target.status },
      );
    return inTransaction(this.db, () => {
      const standing = this.regressionLinkRows().some(
        (l) => l.ticketId === ticket.id && l.regressionOf === target.id,
      );
      if (standing)
        return { ticketId: ticket.id, regressionOf: target.id, recorded: false, eventId: null };
      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: DEFECT_ESCAPED_EVENT,
        payload: {
          regression_of: target.id,
          regression_of_number: target.number ?? null,
          note: regressionNote(note),
        },
      });
      return { ticketId: ticket.id, regressionOf: target.id, recorded: true, eventId };
    });
  }

  /** Take back a regression link filed in error (human or admin; nothing standing: no-op). */
  withdrawRegression(
    ref: string,
    of: string,
    actor: Actor,
  ): { ticketId: string; regressionOf: string; recorded: boolean; eventId: string | null } {
    assertMayFileRegression(actor);
    const ticket = this.resolveTicket(ref);
    const target = this.resolveTicket(of);
    return inTransaction(this.db, () => {
      const standing = this.regressionLinkRows().some(
        (l) => l.ticketId === ticket.id && l.regressionOf === target.id,
      );
      if (!standing)
        return { ticketId: ticket.id, regressionOf: target.id, recorded: false, eventId: null };
      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: DEFECT_ESCAPED_WITHDRAWN_EVENT,
        payload: { regression_of: target.id, regression_of_number: target.number ?? null },
      });
      return { ticketId: ticket.id, regressionOf: target.id, recorded: true, eventId };
    });
  }

  /** Every standing regression link (the event log folded, see services/escapedDefects.ts). */
  regressionLinkRows(): RegressionLink[] {
    const rows = this.db
      .prepare(
        `SELECT entity_id AS ticketId, event_type AS eventType, actor_type AS actorType,
                actor_id AS actorId, created_at AS at,
                json_extract(payload_json, '$.regression_of') AS regressionOf,
                json_extract(payload_json, '$.note') AS note
           FROM work_events
          WHERE entity_type = 'ticket' AND event_type IN (?, ?)
          ORDER BY rowid`,
      )
      .all(DEFECT_ESCAPED_EVENT, DEFECT_ESCAPED_WITHDRAWN_EVENT) as RegressionEventRow[];
    return currentRegressionLinks(rows);
  }

  private regressionLinksOf(ticketId: string): TicketView["regression"] {
    const links = this.regressionLinkRows();
    const side = (otherId: string, l: RegressionLink): RegressionLinkView[] => {
      const row = this.db
        .prepare(`SELECT number, title, status FROM tickets WHERE id = ?`)
        .get(otherId) as { number: number | null; title: string; status: string } | undefined;
      if (!row) return [];
      return [
        {
          ticket_id: otherId,
          number: row.number,
          title: row.title,
          status: row.status,
          filed_by: l.filedBy,
          filed_at: l.filedAt,
          note: l.note,
        },
      ];
    };
    return {
      regression_of: links
        .filter((l) => l.ticketId === ticketId)
        .flatMap((l) => side(l.regressionOf, l)),
      regressed_by: links
        .filter((l) => l.regressionOf === ticketId)
        .flatMap((l) => side(l.ticketId, l)),
    };
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
    return ticketLifecycle.submitForReview(this, this.internals, input, actor);
  }

  /**
   * The GAFFER_TESTING setting this instance acts on: the constructor's `testingEnabled`
   * pins it on or off (tests); otherwise the env (`auto` when unset).
   */
  testerLaneMode(): TestingLaneMode {
    if (this.internals.testingEnabledOverride !== undefined) {
      return this.internals.testingEnabledOverride ? "on" : "off";
    }
    return testingLaneMode();
  }

  /**
   * ADAPTIVE TESTER LANE: is the independent tester lane on for this ticket's
   * repositories, and which write repos have no registered test command? An explicit
   * GAFFER_TESTING wins; the `auto` default is on when every write repo has one.
   */
  testerLane(
    ref: string | Ticket,
    mode: TestingLaneMode = this.testerLaneMode(),
  ): TesterLaneDecision {
    const ticket = typeof ref === "string" ? this.resolveTicket(ref) : ref;
    const writes = this.repos
      .accessLinksForTicket(ticket.id)
      .filter((l) => isActiveTicketRepoRelation(l.relation) && l.access === "write")
      .map((l) => ({ name: l.name, test_command: l.test_command }));
    return testerLaneFor(mode, writes);
  }

  /**
   * LANE-SETTING CONSISTENCY: record the GAFFER_TESTING mode this process decides under as
   * the runner's (its CLI's tester-route calls, see health/runnerTesterLane.ts). Fail-soft.
   */
  recordRunnerTesterLane(): boolean {
    return recordRunnerTesterLane(this.db, this.testerLaneMode());
  }

  /** The tester lane the runner last recorded, or null. */
  runnerTesterLane(): RunnerTesterLane | null {
    return readRunnerTesterLane(this.db);
  }

  /**
   * The runner's recorded lane for one ticket, when it differs from this process's mode:
   * the mode, when it was recorded, and whether the tester gates the ticket under it (the
   * same rule as laneApplies: acceptance always, a testable ticket when its lane is on).
   * Null when the runner recorded nothing or reads the same mode.
   */
  runnerTesterLaneFor(
    ref: string | Ticket,
  ): (RunnerTesterLane & { on: boolean; gates: boolean }) | null {
    const runner = this.runnerTesterLane();
    if (!runner || runner.mode === this.testerLaneMode()) return null;
    const ticket = typeof ref === "string" ? this.resolveTicket(ref) : ref;
    const on = this.testerLane(ticket, runner.mode).on;
    const gates = ticket.acceptance === 1 || (ticket.can_be_tested === 1 && on);
    return { ...runner, on, gates };
  }

  /**
   * ADAPTIVE TESTER LANE on Health: the setting, and under the `auto` default each
   * registered (visible) repository with no test command, with the one-line notice
   * that says the tester is off there and why.
   */
  testerLaneHealth(): {
    mode: TestingLaneMode;
    repos_without_test_command: string[];
    notices: string[];
    runner: RunnerTesterLane | null;
    runner_differs: boolean;
  } {
    const mode = this.testerLaneMode();
    const missing =
      mode === "auto"
        ? this.repos
            .list(false)
            .filter((r) => !(r.test_command ?? "").trim())
            .map((r) => r.name)
        : [];
    // LANE-SETTING CONSISTENCY: the runner's recorded mode, and a notice when it differs.
    const runner = this.runnerTesterLane();
    const differs = runner !== null && runner.mode !== mode;
    return {
      mode,
      repos_without_test_command: missing,
      notices: [
        ...(differs && runner ? [runnerLaneNotice(mode, runner)] : []),
        ...missing.map(testerOffNotice),
      ],
      runner,
      runner_differs: differs,
    };
  }

  /**
   * TESTER FIRST: how many in_review tickets the runner's tester pass would send to the
   * tester now (the same decision as routeToTester: the tester gates them, no PASS covers
   * their head, their heads read and any required CI passed): a push after a PASS, a
   * conflict reopen, a delivery the runner could not route. Poll for work counts them so
   * a tick runs the sweep, and never counts one the sweep would leave. Reads git per
   * ticket the tester gates.
   */
  pendingTesterRoutes(): number {
    let n = 0;
    for (const t of this.tickets.list("in_review")) {
      try {
        if (this.reviewGateSvc.laneApplies(t) && this.reviewGateSvc.testerRoutePlan(t).route) n++;
      } catch {
        /* a ticket that cannot be read is not counted */
      }
    }
    return n;
  }

  /**
   * TESTER FIRST: send in_review tickets the tester gates (and has not passed on their
   * head) to it before a person reviews them: one ticket, or every in_review ticket. The
   * runner's call (system) or an admin's.
   */
  routeToTester(ref: string | null, actor: Actor): TesterRoute[] {
    return ref === null
      ? this.reviewGateSvc.routeAllToTester(actor)
      : [this.reviewGateSvc.routeToTester(ref, actor)];
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
    },
    actor: Actor,
  ): { ticketId: string; number: number } {
    return ticketLifecycle.createDraftTicket(this, input, actor);
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
    const ticket = this.resolveTicket(ref);
    const events = listEvents(this.db, "ticket", ticket.id);
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
      events,
      // BBT-001: parse the JSON-encoded test_contract to a structured object so
      // consumers (CLI, API) never receive a JSON-in-JSON string.
      testContract: parseTestContract(ticket.test_contract),
      // FAILURE-DIAGNOSIS: the full ordered "why did #N fail" trail.
      reworkTrail: this.reworkAttempts.listForTicket(ticket.id),
      reviewComments: this.reviewCommentSvc.listViews(ticket.id),
      // PER-REPOSITORY LANDING: each write repo's approved commit and whether it landed.
      landing: computeLandingStatus(this.db, ticket.id),
      evalJudgment: currentJudgment(events, enteredReviewAt(ticket.id, events)),
      regression: this.regressionLinksOf(ticket.id),
    };
  }

  /**
   * The parts of many tickets' detail in one read (GET /tickets/details): what the
   * dashboard's Map, Overview and Epics need from each ticket, without one
   * GET /tickets/:id per ticket. `ids` names the tickets (unknown ones are listed in
   * `missing`); without it a page of every ticket is read (`limit`/`offset`). Each
   * ticket row is the summary row (no description, test contract or review feedback).
   */
  ticketDetailsBatch(
    select: { ids: readonly string[] } | { limit: number; offset: number },
    include: ReadonlySet<TicketDetailPart>,
    /**
     * PRINCIPAL SCOPES: a scoped principal's ticket filter. A ticket it may not see is
     * reported in `missing` (asked by id) or left out of the page and the total.
     */
    visible?: ((ticketId: string) => boolean) | null,
  ): { details: TicketDetailBatchItem[]; missing: string[]; total: number } {
    let rows: TicketSummary[];
    let total: number;
    const missing: string[] = [];
    if ("ids" in select) {
      const byId = new Map<string, TicketSummary>();
      const unique = [...new Set(select.ids)];
      const get = this.db.prepare(
        `SELECT ${TICKET_SUMMARY_COLUMNS.join(", ")} FROM tickets WHERE id = ?`,
      );
      for (const id of unique) {
        const row = get.get(id) as TicketSummary | undefined;
        if (row && (!visible || visible(row.id))) byId.set(id, row);
        else missing.push(id);
      }
      rows = unique.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
      total = rows.length;
    } else if (visible) {
      // The whole list filtered, then windowed, so `total` counts what it may see.
      const all = (this.tickets.listPage({}, { summary: true }).tickets as TicketSummary[]).filter(
        (t) => visible(t.id),
      );
      rows = all.slice(select.offset, select.offset + select.limit);
      total = all.length;
    } else {
      const page = this.tickets.listPage(
        {},
        { limit: select.limit, offset: select.offset, summary: true },
      );
      rows = page.tickets as TicketSummary[];
      total = page.total;
    }
    const details = rows.map((ticket) => {
      const item: TicketDetailBatchItem = { ticket };
      if (include.has("repositories")) item.repositories = this.repos.listForTicket(ticket.id);
      if (include.has("scopes")) item.scopes = this.ticketScopes.listForTicket(ticket.id);
      if (include.has("dependencies"))
        item.dependencies = this.ticketDependencies.listForTicket(ticket.id);
      if (include.has("rework_trail"))
        item.rework_trail = this.reworkAttempts.listForTicket(ticket.id);
      if (include.has("events")) item.events = listEvents(this.db, "ticket", ticket.id);
      if (include.has("evidence"))
        item.evidence = this.enrichEvidenceProvenance(this.evidence.listForTicket(ticket.id));
      return item;
    });
    return { details, missing, total };
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
   * Record a plan conversation that happened elsewhere (`gaffer plan` in the terminal)
   * as a finished session, so it sits in the plan-session history the dashboard reads
   * (GET /plan-sessions) beside the panel's own. The messages are the panel's shape (a
   * user turn's text; an assistant turn is the POST /plan-build reply as JSON) and the
   * stored plan is the one created. Written in one transaction straight into its final
   * status, so it is never the active session and never archives the one a dashboard
   * panel has open (createPlanSession would abandon it).
   */
  recordPlanSession(input: {
    brief: string;
    messages: ReadonlyArray<Omit<PlanMessage, "ts">>;
    plan: unknown;
    status: "confirmed" | "abandoned";
  }): PlanSession {
    return inTransaction(this.db, () => {
      const now = this.clock.now();
      const id = newId();
      this.planSessions.create({ id, created_at: now, updated_at: now });
      input.messages.forEach((m, i) => {
        this.planSessions.appendMessage({
          id,
          message: { role: m.role, content: m.content, ts: now },
          ...(i === 0 ? { brief: input.brief } : {}),
          ...(i === input.messages.length - 1 ? { plan_json: JSON.stringify(input.plan) } : {}),
          updated_at: now,
        });
      });
      this.planSessions.archive({ id, status: input.status, updated_at: now });
      return this.planSessions.getById(id)!;
    });
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
  board(repo?: string, window?: BoardWindow, visible?: (ticketId: string) => boolean): BoardView {
    const view = this.boardSvc.board(repo, window, visible);
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
