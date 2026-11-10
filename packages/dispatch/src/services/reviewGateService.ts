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

import { type Db } from "../db/connection.js";
import { ephemeralGateKeyring, type GateKeyring } from "../events/gateSeal.js";
import {
  type AcStatus,
  type Actor,
  type ReopenForReviewCause,
  type Ticket,
} from "../domain/types.js";
import { type ObservedRisk } from "./observedRisk.js";
import { AcRepository } from "../repositories/acRepository.js";
import { EvidenceRepository } from "../repositories/evidenceRepository.js";
import { TicketRepository } from "../repositories/ticketRepository.js";
import type { AgentRepository } from "../repositories/agentRepository.js";
import type { TransitionResult, TransitionService } from "./transitionService.js";
import type { TicketService } from "./ticketService.js";
import type { Clock } from "../util/clock.js";
import { type LandingStatus } from "./landingStatus.js";
import { isTestingEnabled, testerProvenance } from "../util/testingLane.js";
import { type TesterTestIdentity } from "./testerReplay.js";
import type { ReviewGateInternals } from "./reviewGate/internals.js";

// The method bodies, by concern (services/reviewGate/).
import * as ci from "./reviewGate/ci.js";
import * as landing from "./reviewGate/landing.js";
import * as sendBack from "./reviewGate/sendBack.js";
import * as tester from "./reviewGate/tester.js";
import * as testerVerdict from "./reviewGate/testerVerdict.js";
import * as approval from "./reviewGate/approval.js";

// Re-export so consumers don't need to reach into core directly.
export { isTestingEnabled, testerProvenance };
export { capRetry } from "./reviewGate/shared.js";
export { approvalUnchanged } from "./reviewGate/staleness.js";
export { unavailableRepoRemedy } from "./reviewGate/approval.js";

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

/** The current head of one write repo's delivery branch (see reviewedHeadsResolver). */
export interface ReviewedHead {
  repoId: string;
  repo: string;
  branch: string;
  sha: string;
}

/**
 * A write repo on the ticket whose delivery head cannot be resolved right now: no
 * checkout on this machine, an unreadable path, no delivery branch name, or a branch git
 * cannot find (see unavailableWriteReposResolver).
 */
export interface UnavailableWriteRepo {
  repoId: string;
  repo: string;
  why: string;
  /** Which read failed (drives the remedy the refusal names); absent → "unknown". */
  kind?: "no_checkout" | "unreadable_checkout" | "no_branch" | "branch_missing" | "unknown";
}

/** REVOCATION-SAFE LANDING: one landing started or committed on the current approval. */
export interface LandingStarted {
  repo: string;
  repoId: string;
  commit: string;
  /** On record, or git shows the commit on the repo's default branch. */
  landed: boolean;
  via: string | null;
  at: string;
}

/**
 * A commit the approver SAW (the Review view sends the `headSha` the diff endpoint
 * returned; the CLI takes `--commit <repo>=<sha>`). `repo` is the repo id or name; null
 * means "the ticket's only repo" and is refused for a multi-repo ticket.
 */
export interface ShownCommit {
  repo: string | null;
  sha: string;
}

export interface ApproveReviewOptions {
  /** The commit(s) the approver reviewed. When present every write repo must match. */
  commits?: readonly ShownCommit[] | undefined;
  /**
   * Entry points (REST, CLI) set this: an approval that names no commit is refused when
   * any write repo has a resolvable head. The library default stays permissive so
   * fixtures without git keep working; production callers always pass commits.
   */
  requireCommits?: boolean | undefined;
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
  /** The reject cap, or a function answering it now (read per reject, never cached). */
  readonly maxAttempts: number | (() => number);
  /**
   * Does the independent tester gate this ticket (an epic's acceptance ticket, or a
   * testable one whose tester lane is on: GAFFER_TESTING on, or the `auto` default with a
   * registered test command in every write repo)? Undefined: acceptance tickets, plus
   * testable ones while GAFFER_TESTING is on.
   */
  readonly testerLaneApplies?: ((ticket: Ticket) => boolean) | undefined;
  /**
   * LANE-SETTING CONSISTENCY: the tester lane the runner last recorded, when it differs
   * from this process's (its mode, and whether the tester gates the ticket under it), or
   * null. The not-tested refusal names a split instead of promising a route.
   */
  readonly runnerTesterLane?:
    ((ticket: Ticket) => { mode: string; at: string; gates: boolean } | null) | undefined;
  /** The agents table — lets the approve path verify an agent approver is REGISTERED. */
  readonly agents?: AgentRepository | undefined;
  /**
   * When true, an `agent` actor may approve only if `agents.findById(actor.id)` exists:
   * the reviewer-not-author rule then compares two registered principals rather than a
   * free string. Production entry points turn this on; fixtures leave it off.
   */
  readonly requireRegisteredAgentApprover?: boolean | undefined;
  /**
   * SIGNED GATE EVENTS: seals every approval and tester PASS this service records, and
   * verifies them before any landing is started, recorded or completed. Undefined: a
   * process-local random key (fixtures), never accepted by another process.
   */
  readonly gateKeyring?: GateKeyring | undefined;
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
   * REVIEW PIN: resolves the CURRENT delivery-branch head of every write repo (one entry
   * per repo whose branch resolves), so `approveReview` can (a) refuse an approval whose
   * shown commits no longer match (`stale_revision`) and (b) record one reviewed-commit
   * pin per repo (system `commit` evidence, uri `gaffer-reviewed-commit:<sha>`, `repo_id`
   * set) that runner/lib/tester-binding.mjs enforces on every landing path and the done
   * gate requires to have landed. `undefined` (the default) or `[]` records no pin.
   */
  readonly reviewedHeadsResolver?: (ticket: Ticket) => readonly ReviewedHead[];
  /**
   * APPROVAL COVERS EVERY WRITE REPO (external review #7): the ticket's active write repos
   * whose delivery head cannot be resolved now. An approval pins one commit per write repo
   * and `done` needs every pinned commit landed — a repo whose head could not be read at
   * approve time used to be left out of the pins, so the landing merged the others, marked
   * the ticket done and left that repo's change on its branch. approveReview refuses
   * (STATE_CONFLICT, details.reason `repo_unavailable`, naming each repo) while any is
   * listed, for every actor and every entry point. `undefined` (library fixtures without
   * git) lists none.
   */
  readonly unavailableWriteReposResolver?: (ticket: Ticket) => readonly UnavailableWriteRepo[];
  /**
   * PER-REPOSITORY LANDING: true when `sha` is already contained in the repo's default
   * branch (`git merge-base --is-ancestor`). markMerged uses it as POSITIVE evidence for a
   * pending repo a merge path landed without recording it (a configured
   * DISPATCH_MERGE_CMD, a merge by hand) and records the landing; anything it cannot
   * verify stays pending. `undefined` verifies nothing.
   */
  readonly landedOnDefaultResolver?: (repoId: string, sha: string) => boolean;
  /**
   * PR LANDINGS (exploratory finding cli-wg/F-01): does `ref` in the repo carry the change
   * of `sha` (an ancestor, or, for a squash or rebase merge, merging `sha` into it changes
   * nothing)? `refs` names what to look at: "default" (the local default branch) and/or
   * "remote-default" (every remote-tracking ref of it). → true carried by one of them ·
   * false none carries it · null none of the refs exists here.
   */
  readonly changeOnRefsResolver?: (
    repoId: string,
    sha: string,
    refs: ReadonlyArray<"default" | "remote-default">,
  ) => boolean | null;
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

export class ReviewGateService {
  private readonly internals: ReviewGateInternals;

  constructor(deps: ReviewGateServiceDeps) {
    const cap = deps.maxAttempts;
    const maxAttemptsOf = typeof cap === "function" ? cap : () => cap;
    this.internals = {
      db: deps.db,
      clock: deps.clock,
      tickets: deps.tickets,
      acs: deps.acs,
      evidence: deps.evidence,
      transitions: deps.transitions,
      ticketSvc: deps.ticketSvc,
      maxAttemptsOf,
      get maxAttempts(): number {
        return this.maxAttemptsOf();
      },
      testerLaneAppliesFn: deps.testerLaneApplies,
      runnerTesterLaneFn: deps.runnerTesterLane,
      agents: deps.agents,
      requireRegisteredAgentApprover: deps.requireRegisteredAgentApprover ?? false,
      gateKeyring: deps.gateKeyring ?? ephemeralGateKeyring(),
      onTicketParked: deps.onTicketParked,
      approvalShaResolver: deps.approvalShaResolver,
      reviewedHeadsResolver: deps.reviewedHeadsResolver,
      unavailableWriteReposResolver: deps.unavailableWriteReposResolver,
      landedOnDefaultResolver: deps.landedOnDefaultResolver,
      changeOnRefsResolver: deps.changeOnRefsResolver,
      policyAllowsAgentApprove: deps.policyAllowsAgentApprove,
      observedRiskResolver: deps.observedRiskResolver,
    };
  }

  // ---------------------------------------------------------------------------
  // Public methods
  // ---------------------------------------------------------------------------

  approveReview(ticketRef: string, actor: Actor, opts?: ApproveReviewOptions): TransitionResult {
    return approval.approveReview(this, this.internals, ticketRef, actor, opts);
  }

  approveRoutesToTesting(ticket: Ticket): boolean {
    return tester.approveRoutesToTesting(this, ticket);
  }

  laneApplies(ticket: Ticket): boolean {
    return tester.laneApplies(this.internals, ticket);
  }

  testerCoverage(ticket: Ticket, heads?: readonly ReviewedHead[]): TesterCoverage {
    return tester.testerCoverage(this.internals, ticket, heads);
  }

  routeToTester(ref: string, actor: Actor): TesterRoute {
    return tester.routeToTester(this, this.internals, ref, actor);
  }

  testerRoutePlan(ticket: Ticket):
    | { route: true; why: null; code: "routed"; coverage: TesterCoverage }
    | {
        route: false;
        why: string;
        code: Exclude<TesterRouteCode, "routed" | "error">;
        coverage: TesterCoverage | null;
      } {
    return tester.testerRoutePlan(this, this.internals, ticket);
  }

  routeAllToTester(actor: Actor): TesterRoute[] {
    return tester.routeAllToTester(this, this.internals, actor);
  }

  approveCiHold(ticket: Ticket): { state: string | null; commit: string | null } | null {
    return ci.approveCiHold(this, this.internals, ticket);
  }

  unavailableWriteRepos(ticket: Ticket): readonly UnavailableWriteRepo[] {
    return approval.unavailableWriteRepos(this.internals, ticket);
  }

  landingStatus(ref: string): LandingStatus {
    return landing.landingStatus(this.internals, ref);
  }

  recordLanding(
    ref: string,
    input: { repo: string; commit: string; via?: string | undefined },
    actor: Actor,
  ): { ticketId: string; repo: string; commit: string; recorded: boolean; status: LandingStatus } {
    return landing.recordLanding(this, this.internals, ref, input, actor);
  }

  approvalRef(ticketId: string): string | null {
    return landing.approvalRef(this.internals, ticketId);
  }

  beginLanding(
    ref: string,
    input: {
      repo: string;
      commit: string;
      approval?: string | undefined;
      via?: string | undefined;
    },
    actor: Actor,
  ): {
    ticketId: string;
    repo: string;
    repoId: string;
    commit: string;
    approval: string | null;
    eventId: string;
  } {
    return landing.beginLanding(this, this.internals, ref, input, actor);
  }

  landingsStarted(ticketId: string): LandingStarted[] {
    return landing.landingsStarted(this.internals, ticketId);
  }

  recordTesterReplay(
    ref: string,
    input: {
      commit: string;
      pin: string;
      files: readonly string[];
      /** The test identities proven to have run and passed on `commit`. */
      tests?: unknown;
      /** What the runner proved: "identities" or "files" (checked against the bound PASS). */
      evidence?: string | undefined;
      repo?: string | undefined;
      via?: string | undefined;
      note?: string | undefined;
    },
    actor: Actor,
  ): {
    ticketId: string;
    commit: string;
    tested: string;
    files: string[];
    tests: TesterTestIdentity[];
    evidence: "identities" | "files";
    recorded: boolean;
  } {
    return tester.recordTesterReplay(this.internals, ref, input, actor);
  }

  recordAcCheck(
    raw: unknown,
    actor: Actor,
  ): { status: AcStatus; evidenceId: string; eventId: string } {
    return testerVerdict.recordAcCheck(this.internals, raw, actor);
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
      /** The runner's acceptance evidence row for a profiled ticket (cli, api, ...). */
      acceptance_evidence?: string;
      /** TEST IDENTITIES the runner's clean replay saw pass (system only, see testerReplay.ts). */
      tests?: unknown;
      /** The tester agent (and run) whose verdict the runner records (system only). */
      tester_agent?: unknown;
      /** The testing round the verdict was made in (a stale one is refused). */
      round?: string;
    },
    actor: Actor,
  ): TransitionResult {
    return testerVerdict.testerPass(this, this.internals, ticketRef, input, actor);
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
  ): TransitionResult {
    return testerVerdict.testerFail(this.internals, ticketRef, input, actor);
  }

  markMerged(ref: string, actor: Actor): TransitionResult {
    return landing.markMerged(this, this.internals, ref, actor);
  }

  reopenForReview(
    ref: string,
    input: { reason: string; resolution: string; cause?: ReopenForReviewCause },
    actor: Actor,
  ): { ticketId: string; status: string; eventId: string } {
    return sendBack.reopenForReview(this.internals, ref, input, actor);
  }

  holdForHuman(
    ticketRef: string,
    input: { reasonCode: string; reason: string },
    actor: Actor,
  ): TransitionResult {
    return sendBack.holdForHuman(this.internals, ticketRef, input, actor);
  }

  recordCiResult(
    ticketRef: string,
    input: { commit: string; state: "pending" | "pass" | "fail"; detail?: string },
    actor: Actor,
  ): { state: string; held: boolean; status: string; eventId: string } {
    return ci.recordCiResult(this, this.internals, ticketRef, input, actor);
  }

  recordCiRequired(
    ticketRef: string,
    input: { detail?: string },
    actor: Actor,
  ): { required: true; eventId: string | null } {
    return ci.recordCiRequired(this.internals, ticketRef, input, actor);
  }

  ciStatus(
    ticketId: string,
    commit: string | null,
  ): { required: boolean; state: string | null; commit: string | null } {
    return ci.ciStatus(this.internals, ticketId, commit);
  }

  rejectReview(
    ticketRef: string,
    to: "ready" | "refining" | "cancelled",
    actor: Actor,
    reason?: string,
  ): TransitionResult {
    return sendBack.rejectReview(this, this.internals, ticketRef, to, actor, reason);
  }

  wontDo(ref: string, actor: Actor, reason?: string): TransitionResult {
    return sendBack.wontDo(this, this.internals, ref, actor, reason);
  }

  reopenFromWontDo(ref: string, to: "refining" | "draft", actor: Actor): TransitionResult {
    return sendBack.reopenFromWontDo(this.internals, ref, to, actor);
  }
}

/** TESTER FIRST: whether a tester PASS covers the candidate (see testerCoverage). */
export interface TesterCoverage {
  covered: boolean;
  /** Why not: no verdict this round, the latest one failed, another commit, a new contract. */
  why: "no_verdict" | "failed" | "other_commit" | "contract_changed" | null;
  /** The commit the latest verdict tested, when recorded. */
  tested: string | null;
  /** The primary write repo's head now, when it resolves. */
  head: string | null;
}

/**
 * Why routeToTester did or did not send a ticket to the tester, as a word a caller can
 * branch on (`why` is the sentence for a person). The runner's agent review runs only
 * when the tester has nothing left to say about the head: `not_gated` or `covered`.
 */
export type TesterRouteCode =
  "routed" | "not_in_review" | "not_gated" | "head_unreadable" | "covered" | "ci_pending" | "error";

/** What routeToTester did for one ticket. */
export interface TesterRoute {
  ticketId: string;
  number: number | null;
  routed: boolean;
  why: string | null;
  head: string | null;
  code: TesterRouteCode;
}
