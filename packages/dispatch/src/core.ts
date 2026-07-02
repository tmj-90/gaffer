import { existsSync } from "node:fs";

import { type Db, inTransaction, openDatabase } from "./db/connection.js";
import { claimTicketInput } from "./domain/schemas.js";
import {
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
import { listEvents, writeEvent } from "./events/eventWriter.js";
import { AcRepository } from "./repositories/acRepository.js";
import { AgentRepository } from "./repositories/agentRepository.js";
import { ClaimRepository, type ActiveClaimView } from "./repositories/claimRepository.js";
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
import { SpecsService } from "./services/specsService.js";
import { SpecCoverageService } from "./services/specCoverageService.js";
import { resolveSpecClauseSeeder } from "./services/specClauseSeeder.js";
import { resolveSpecLoreReader } from "./services/specLoreReader.js";
import {
  BoardService,
  resolveMoveTarget,
  type BoardView,
  type DashboardSummary,
} from "./services/boardService.js";
import { PauseService, type PauseInput } from "./services/pauseService.js";
import { HumanQueueService, type HumanQueue } from "./services/humanQueueService.js";
import { ReviewGateService, type ApprovalShas } from "./services/reviewGateService.js";
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
import { isAutonomyAllowed, policyGrantsAuto } from "./services/autonomyPolicyService.js";
export { BOARD_COLUMNS } from "./services/boardService.js";
export type { BoardColumn } from "./services/boardService.js";
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

/** BBT-001 global toggle: is the independent black-box testing lane ON? */
export { isTestingEnabled, testerProvenance } from "./util/testingLane.js";

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

export type {
  BoardCard,
  BoardCardClaim,
  BoardColumnView,
  BoardView,
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
  readonly reviewGateSvc: ReviewGateService;
  readonly autonomyRecommendations: AutonomyRecommendationService;
  readonly pauseSvc: PauseService;
  readonly humanQueueSvc: HumanQueueService;
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
    this.reworkAttempts = new ReworkAttemptRepository(db);
    this.pausedDeliveries = new PausedDeliveryRepository(db);
    this.specsRepo = new SpecRepository(db);
    this.specCoverageRepo = new SpecCoverageRepository(db);
    this.autonomyPolicy = new AutonomyPolicyRepository(db);
    this.transitions = new TransitionService(db, clock, gitRunner, this.pausedDeliveries);
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
    });
    this.reviewGateSvc = new ReviewGateService({
      db,
      clock: this.clock,
      tickets: this.tickets,
      acs: this.acs,
      evidence: this.evidence,
      transitions: this.transitions,
      ticketSvc: this.ticketSvc,
      maxAttempts: this.maxAttempts,
      testingEnabledOverride: this.testingEnabledOverride,
      onTicketParked: (ticket, detail) => {
        this.emitGate("ticket_parked", ticket, { status: "blocked", detail });
      },
      // GRADUATED-AUTONOMY (Spec 2, Phase 1): resolve delivery-vs-merge SHAs so the
      // approve path can emit `approved_unchanged`. Pure read; degrades to unknown.
      approvalShaResolver: (ticket) => this.resolveApprovalShas(ticket),
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
    if (!this.gitRunner) return null;
    const runGit = this.gitRunner;
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
   * GRADUATED-AUTONOMY (Spec 2, Phase 3): the MERGE chokepoint decision — may the
   * auto-merge fire for this approved ticket? Reads a mode='auto' merge policy across
   * the ticket's write repos, ELSE falls back to the env default (true — today's
   * merge always fires post-approve; the mergeRunner still enforces DISPATCH_MERGE_CMD,
   * unchanged). So with no policy row this is byte-identical to today; a mode='auto'
   * merge policy is an additional, explicit, evidence-backed allow-path.
   */
  autonomyMergeAllowed(ticket: Ticket): boolean {
    return isAutonomyAllowed(
      this.autonomyPolicy,
      this.writeRepoIdsForTicket(ticket),
      ticket.risk_level,
      "merge",
    );
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

  // --- Tickets -------------------------------------------------------------

  createTicket(raw: unknown, actor: Actor): Ticket {
    return this.ticketSvc.createTicket(raw, actor);
  }

  /** TRACK-3a: set or clear a ticket's per-ticket delivery-budget ceiling (USD). */
  setDeliveryBudget(raw: unknown, actor: Actor): Ticket {
    return this.ticketSvc.setDeliveryBudget(raw, actor);
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

  approveReview(ticketRef: string, actor: Actor): TransitionResult {
    return this.reviewGateSvc.approveReview(ticketRef, actor);
  }

  testerPass(
    ticketRef: string,
    input: { summary: string; uri?: string },
    actor: Actor,
  ): TransitionResult {
    return this.reviewGateSvc.testerPass(ticketRef, input, actor);
  }

  testerFail(
    ticketRef: string,
    input: { summary: string; uri?: string },
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

  getTestContract(ticketRef: string): TestContract | null {
    return this.ticketSvc.getTestContract(ticketRef);
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
  ): TransitionResult {
    return this.reviewGateSvc.rejectReview(ticketRef, to, actor, reason);
  }

  resetAcceptanceCriteria(
    ref: string,
    actor: Actor,
  ): { ticketId: string; reset: number; eventId: string } {
    return this.ticketSvc.resetAcceptanceCriteria(ref, actor);
  }

  wontDo(ref: string, actor: Actor, reason?: string): TransitionResult {
    return this.reviewGateSvc.wontDo(ref, actor, reason);
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
   */
  beginResume(
    ref: string,
    actor: Actor,
  ): { ticketId: string; eventId: string; context: PausedDelivery } {
    return this.pauseSvc.beginResume(ref, actor);
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
    },
    actor: Actor,
  ): { status: string; eventId: string } {
    const result = this.claims.runnerRelease(input, actor);
    // Parking to the VISIBLE `blocked` column needs a human to unblock it — fire the
    // gate AFTER the claim transaction commits, best-effort (mirrors markBlocked).
    if (result.status === "blocked") {
      const ticket = this.tickets.findById(input.ticket_id);
      if (ticket) this.emitGate("ticket_blocked", ticket, { detail: input.reason });
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
    },
    actor: Actor,
  ): { eventId: string } {
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
      // BBT-001: parse the JSON-encoded test_contract to a structured object so
      // consumers (CLI, API) never receive a JSON-in-JSON string.
      testContract: parseTestContract(ticket.test_contract),
      // FAILURE-DIAGNOSIS: the full ordered "why did #N fail" trail.
      reworkTrail: this.reworkAttempts.listForTicket(ticket.id),
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
   * Kanban board: tickets grouped into columns, AC progress enriched. Read-only.
   *
   * @param repo Optional repository name/id — when supplied, only tickets
   *   linked to that repo are included. Omit for the full board.
   */
  board(repo?: string): BoardView {
    return this.boardSvc.board(repo);
  }

  /**
   * GRADUATED-AUTONOMY (Spec 2, Phase 2): read-only, advisory per-repo/per-risk/
   * per-gate autonomy recommendations backed by the review track record. NEVER
   * enables anything — the operator acts on it (Phase 3 adds the enable action).
   */
  autonomyRecommendationsList(): AutonomyRecommendation[] {
    return this.autonomyRecommendations.recommend();
  }

  activity(query: ActivityQuery): { events: ActivityEvent[]; total: number } {
    return this.boardSvc.activity(query);
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
    return this.humanQueueSvc.build();
  }
}
