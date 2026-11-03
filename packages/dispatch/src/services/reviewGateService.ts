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
  type ReopenForReviewCause,
  type ReviewFeedback,
  type Ticket,
  type TicketStatus,
  parseTestContract,
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
import {
  computeLandingStatus,
  recordedLandingRepos,
  LANDING_PREFIX,
  type LandingStatus,
  REJECT_PIN_PREFIX,
  REVIEW_PIN_PREFIX,
} from "./landingStatus.js";
import { isTestingEnabled, testerProvenance } from "../util/testingLane.js";
import { readBoundTesterPass, TESTER_REPLAY_PREFIX } from "./testerReplay.js";
import {
  ACCEPTANCE_EVIDENCE_PREFIX,
  contractProfile,
  EXECUTABLE_PROFILES,
  type AcceptanceProfile,
} from "../domain/acceptanceProfile.js";
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

/**
 * What the human can do about an unavailable write repo (the refusal and the Review
 * button say it): attach the checkout / restore the branch, or — when this ticket should
 * not change that repository — take its write access away (a read-only repo never blocks).
 */
export function unavailableRepoRemedy(
  m: UnavailableWriteRepo,
  ticketNumber: number | null,
): string {
  const n = ticketNumber ?? "<ticket>";
  const readOnly = `or, if this ticket should not change ${m.repo}, make it read-only on the ticket (\`runner/gaffer wg ticket repo-access set ${n} ${m.repo} --access read\`)`;
  switch (m.kind) {
    case "no_checkout":
      return `attach ${m.repo}'s checkout on this machine (register the repository with its local path, \`runner/gaffer wg repo add -n ${m.repo} --path <dir>\`), ${readOnly}`;
    case "unreadable_checkout":
      return `restore ${m.repo}'s checkout at its registered path (or register the path it lives at now), ${readOnly}`;
    case "no_branch":
    case "branch_missing":
      return `restore ${m.repo}'s delivery branch (or deliver to it again), ${readOnly}`;
    default:
      return `make ${m.repo}'s delivery head readable again, ${readOnly}`;
  }
}

/**
 * A commit the approver SAW (the Review view sends the `headSha` the diff endpoint
 * returned; the CLI takes `--commit <repo>=<sha>`). `repo` is the repo id or name; null
 * means "the ticket's only repo" and is refused for a multi-repo ticket.
 */
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
  input: { tested_commit?: string; contract_hash?: string; replay?: string; tests_commit?: string },
  opts: {
    strict: boolean;
    currentHash: string | null;
    verdict: "pass" | "fail";
    /** A human (or admin) verdict: a waiver, never refused for a missing replay. */
    human?: boolean;
  },
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
  if (input.tests_commit !== undefined) {
    const t = input.tests_commit.trim().toLowerCase();
    if (t !== "none" && !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(t)) {
      throw new DispatchError(
        "VALIDATION_ERROR",
        'tests_commit must be a full git commit id (40 or 64 hex characters) or "none".',
      );
    }
    out.tests_commit = t;
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
  // FALSE GREEN, on every ticket (not only an acceptance ticket): a non-human PASS is
  // recorded only when it carries the runner's clean replay as PASSED. A replay that was
  // skipped (no registered test command, the replay switched off) or failed proves
  // nothing about the candidate, and neither does a PASS with no replay at all (the
  // `wg ticket tester-pass` default is `--as agent`, so an unbound PASS typed by hand used
  // to record as an automated tester PASS). The runner's tester always sends the replay.
  // A human PASS is a waiver and is never refused here.
  if (opts.verdict === "pass" && !opts.human && out.replay !== "passed") {
    const state = out.replay ?? "absent";
    throw new DispatchError(
      "BINDING_REQUIRED",
      out.replay
        ? `An automated PASS whose clean replay is '${out.replay}' is not a verified PASS: the runner did not show the candidate passes the tester's tests (register the repo's test command and re-test). A human can record the verdict instead (tester-pass --as human), which is reported as a waiver.`
        : "An automated PASS must carry the runner's clean replay (replay=passed): without it nothing shows the candidate passes the tester's tests. A human can record the verdict instead (tester-pass --as human), which is reported as a waiver.",
      { missing: ["replay=passed"], replay: state },
    );
  }
  return out;
}

/**
 * PER-REPOSITORY LANDING: the `via` values whose landing happened upstream (a merged PR,
 * possibly squashed), so ancestry of the local default branch alone cannot confirm it:
 * assertPrLanding checks them (a PR on record, the change carried by the default branch or
 * its remote-tracking copy). Every other landing is checked by ancestry before it is
 * recorded.
 */
const UNVERIFIABLE_LANDING_VIAS: ReadonlySet<string> = new Set(["pr", "pr-stale"]);

/**
 * cli-wg/F-04: the person who approves or rejects a review is its reviewer. A ticket
 * with no reviewer assigned (the loose packs never need one before ready) records the
 * human/admin who decided it, so `ticket.reviewer` names who looked; an assigned
 * reviewer is never overwritten, and an agent or runner decision sets nothing.
 */
function reviewerPatch(ticket: Ticket, actor: Actor): { patch?: { reviewer: string } } {
  if (ticket.reviewer !== null) return {};
  if (actor.type !== "human" && actor.type !== "admin") return {};
  return actor.id ? { patch: { reviewer: actor.id } } : {};
}

export class ReviewGateService {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly tickets: TicketRepository;
  private readonly acs: AcRepository;
  private readonly evidence: EvidenceRepository;
  private readonly transitions: TransitionService;
  private readonly ticketSvc: TicketService;
  private readonly maxAttemptsOf: () => number;
  private get maxAttempts(): number {
    return this.maxAttemptsOf();
  }
  private readonly testerLaneAppliesFn: ((ticket: Ticket) => boolean) | undefined;
  private readonly runnerTesterLaneFn: ReviewGateServiceDeps["runnerTesterLane"];
  private readonly agents: AgentRepository | undefined;
  private readonly requireRegisteredAgentApprover: boolean;
  private readonly onTicketParked:
    ((ticket: import("../domain/types.js").Ticket, detail: string) => void) | undefined;
  private readonly approvalShaResolver: ApprovalShaResolver | undefined;
  private readonly reviewedHeadsResolver: ReviewGateServiceDeps["reviewedHeadsResolver"];
  private readonly unavailableWriteReposResolver: ReviewGateServiceDeps["unavailableWriteReposResolver"];
  private readonly landedOnDefaultResolver: ReviewGateServiceDeps["landedOnDefaultResolver"];
  private readonly changeOnRefsResolver: ReviewGateServiceDeps["changeOnRefsResolver"];
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
    const cap = deps.maxAttempts;
    this.maxAttemptsOf = typeof cap === "function" ? cap : () => cap;
    this.testerLaneAppliesFn = deps.testerLaneApplies;
    this.runnerTesterLaneFn = deps.runnerTesterLane;
    this.agents = deps.agents;
    this.requireRegisteredAgentApprover = deps.requireRegisteredAgentApprover ?? false;
    this.onTicketParked = deps.onTicketParked;
    this.approvalShaResolver = deps.approvalShaResolver;
    this.reviewedHeadsResolver = deps.reviewedHeadsResolver;
    this.unavailableWriteReposResolver = deps.unavailableWriteReposResolver;
    this.landedOnDefaultResolver = deps.landedOnDefaultResolver;
    this.changeOnRefsResolver = deps.changeOnRefsResolver;
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
  approveReview(
    ticketRef: string,
    actor: Actor,
    opts: ApproveReviewOptions = {},
  ): TransitionResult {
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
    // APPROVAL COVERS EVERY WRITE REPO (external review #7), for every actor: an approval
    // pins one head per write repo, so while a write repo's head cannot be read the
    // approval is refused (repo_unavailable, naming it) — never approved as a subset. The
    // read runs git, so it is taken here, outside the write lock. An agent's auto-ship
    // gate reads the diff, which an unavailable repo cannot show, so for an agent the
    // refusal comes first; a human's approval keeps its policy refusals (unresolved ACs,
    // no delivery diff) and the coverage refusal is the last gate before the pins.
    const covered = this.ticketSvc.resolveTicket(ticketRef);
    const unavailable = this.unavailableWriteRepos(covered);
    if (agentApproveAllowed) {
      this.assertWriteReposAvailable(covered, unavailable);
      this.enforceObservedRiskCeiling(ticketRef, actor);
    }
    const ticket = this.ticketSvc.resolveTicket(ticketRef);
    // REQUIRED CI (server-side, like the other holds): when the runner has recorded CI
    // results for this ticket (GAFFER_REQUIRE_CI), approval needs a PASS for the
    // CANDIDATE commit — the head being approved. A CLI approve used to go through while
    // the CI poll was still open, and the late red result could no longer stop it.
    this.assertCiPassed(ticket, this.approveCiCandidate(ticket));
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
    }
    // REVIEWER ≠ AUTHOR by id, whatever the actor type (exploratory finding api/F8): a
    // human or admin principal whose actor_id is the delivering agent's id is that agent
    // speaking under another type, and its approval would read as the agent approving
    // its own work.
    const author = this.deliveringAgentId(ticket.id);
    if (
      author !== null &&
      actor.id !== undefined &&
      actor.id.trim().toLowerCase() === author.toLowerCase()
    ) {
      throw new DispatchError(
        "ACTOR_NOT_PERMITTED",
        actor.type === "agent"
          ? "An agent may not approve its own delivery: the approving actor id matches the agent that claimed and delivered this ticket. Approve as a distinct reviewer principal (or a human)."
          : `The approving ${actor.type} id '${actor.id}' is the id of the agent that claimed and delivered this ticket; nobody may approve a delivery under its author's id. Approve under your own identity.`,
        { actor_type: actor.type, actor_id: actor.id, delivering_agent_id: author },
      );
    }
    // GRADUATED-AUTONOMY (Spec 2, Phase 1): capture whether this delivery is being
    // approved UNCHANGED vs edited, emitted on the transition below. Best-effort — a
    // resolver throw or absence yields `null` (unknown) and never blocks the approve.
    const approvedUnchanged = this.computeApprovedUnchanged(ticket);
    // REVIEW PIN + STALE REVISION (external review #2). The heads are resolved before the
    // transition (git runs outside the write lock). When the approver names the commits
    // they saw, every write repo's head must still BE that commit — a branch that moved
    // between the render and the click is refused (409 stale_revision), never approved.
    // The pins recorded below are the commits the approver saw, one per repo, written in
    // the SAME transaction as the transition. Without named commits (library callers) a
    // HUMAN approval pins the current heads, as before; an agent approval without commits
    // is pinned by the runner (lib/review.sh) only.
    const heads = this.resolveReviewedHeads(ticket);
    const pins = this.checkShownCommits(ticket, heads, actor, opts, unavailable);
    // TESTER FIRST: when the independent tester gates this ticket (an epic's acceptance
    // ticket always; a testable one while its lane is on), it tests the candidate BEFORE
    // a person reviews it (the runner routes in_review -> in_testing, see routeToTester,
    // and a PASS returns it to in_review). A person approves only the commit the tester
    // passed: an approval of any other commit (none tested yet, a push after the PASS, a
    // contract edited since) is REFUSED here (STATE_CONFLICT, reason not_tested), and the
    // runner sends that commit to the tester. An agent's approval (the runner's earned
    // autonomy; no person in the loop) of an untested commit routes it to the tester, as
    // the lane always has: its PASS then goes straight to ready_for_merge. A covered
    // commit goes to ready_for_merge below: there is no second testing pass.
    const coverage = this.laneApplies(ticket) ? this.testerCoverage(ticket, heads) : null;
    if (coverage && !coverage.covered && (actor.type === "human" || actor.type === "admin")) {
      const runner = this.runnerLaneSafe(ticket);
      const split = runner && !runner.gates ? runner : null;
      throw new DispatchError("STATE_CONFLICT", notTestedMessage(ticket, coverage, split), {
        reason: "not_tested",
        why: coverage.why,
        tested: coverage.tested,
        head: coverage.head,
        ...(split ? { runner_tester_lane: split.mode, runner_lane_at: split.at } : {}),
      });
    }
    if (coverage && !coverage.covered) {
      return inTransaction(this.db, () => {
        const result = this.transitions.transition({
          ticketId: ticket.id,
          actor,
          toStatus: "in_testing",
          reason: "review_approved_to_testing",
          expectedFromStatus: "in_review",
          testerVerdict: true,
          approvedUnchanged,
          ...reviewerPatch(ticket, actor),
        });
        this.assertWriteReposAvailable(ticket, unavailable); // rolls the transition back
        writeEvent(this.db, {
          entity_type: "ticket",
          entity_id: ticket.id,
          actor,
          event_type: "ticket.routed_to_testing",
          payload: { from: "in_review", ...(ticket.acceptance === 1 ? { acceptance: true } : {}) },
        });
        this.recordApprovalPins(ticket, actor, pins);
        return result;
      });
    }
    // The done gate's git runs HERE, before transition() takes the write lock.
    const deliveryDiff = this.transitions.deliveryDiffProof(ticket.id);
    return inTransaction(this.db, () => {
      const result = this.transitions.transition({
        ticketId: ticket.id,
        actor,
        toStatus: "ready_for_merge",
        reason: "review_approved",
        expectedFromStatus: "in_review",
        approvedUnchanged,
        reviewApprove: true, // reached the merge-ready state through the guarded approve path
        deliveryDiff,
        ...reviewerPatch(ticket, actor),
      });
      this.assertWriteReposAvailable(ticket, unavailable); // rolls the transition back
      this.recordApprovalPins(ticket, actor, pins);
      return result;
    });
  }

  /**
   * BBT-001 + ACCEPTANCE GATE: does an approve of this ticket go to the independent
   * tester (in_review -> in_testing) rather than to merge? The ONE predicate approveReview
   * routes on, public so the Review view's "what happens on approve" names the same route.
   */
  approveRoutesToTesting(ticket: Ticket): boolean {
    return this.laneApplies(ticket) && !this.testerCoverage(ticket).covered;
  }

  /** The runner's differing lane for a ticket (see the dep), or null; never throws. */
  private runnerLaneSafe(ticket: Ticket): { mode: string; at: string; gates: boolean } | null {
    try {
      return this.runnerTesterLaneFn?.(ticket) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Does the independent tester gate this ticket at all: an epic's acceptance ticket
   * (always), or a testable one whose lane is on (see util/testingLane.ts)?
   */
  laneApplies(ticket: Ticket): boolean {
    if (ticket.acceptance === 1) return true;
    if (ticket.can_be_tested !== 1) return false;
    return this.testerLaneAppliesFn ? this.testerLaneAppliesFn(ticket) : isTestingEnabled();
  }

  /**
   * TESTER FIRST: does a tester PASS cover the candidate a person would approve now?
   * Covered when the latest tester verdict since this round began (the latest entry into
   * in_review that was not a tester PASS returning it) is a PASS, the commit it tested is
   * the primary write repo's head now (compared when both are known: the tester runs in
   * the primary repo), and the contract it tested is the one on record (when it recorded
   * one). `heads` reuses a read the caller already made (git).
   */
  testerCoverage(ticket: Ticket, heads?: readonly ReviewedHead[]): TesterCoverage {
    // The tester runs in one write repo (runner/bin/merge-ticket.mjs resolveTicket's pick,
    // the first write link); its tested commit must be that repo's head now, so it is
    // compared with every write repo's head (a commit id names one commit).
    const allHeads = (heads ?? this.resolveReviewedHeads(ticket))
      .map((h) => h.sha?.toLowerCase())
      .filter((h): h is string => Boolean(h));
    const head = allHeads[0] ?? null;
    const round = this.db
      .prepare(
        `SELECT rowid AS rid FROM work_events
          WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = 'ticket.transitioned'
            AND json_extract(payload_json, '$.to') = 'in_review'
            AND COALESCE(json_extract(payload_json, '$.from'), '') <> 'in_testing'
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(ticket.id) as { rid: number } | undefined;
    const verdict = this.db
      .prepare(
        `SELECT rowid AS rid, event_type, payload_json FROM work_events
          WHERE entity_type = 'ticket' AND entity_id = ?
            AND event_type IN ('ticket.tester_passed', 'ticket.tester_failed')
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(ticket.id) as
      { rid: number; event_type: string; payload_json: string | null } | undefined;
    if (!verdict || (round && verdict.rid < round.rid)) {
      return { covered: false, why: "no_verdict", tested: null, head };
    }
    const parse = (raw: string | null | undefined): Record<string, unknown> => {
      try {
        const v: unknown = JSON.parse(raw ?? "{}");
        return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    };
    const p = parse(verdict.payload_json);
    const row =
      typeof p.evidence_id === "string"
        ? (this.db
            .prepare("SELECT payload_json FROM evidence WHERE id = ? AND ticket_id = ?")
            .get(p.evidence_id, ticket.id) as { payload_json: string | null } | undefined)
        : undefined;
    const binding = parse(row?.payload_json);
    const asSha = (v: unknown): string | null =>
      typeof v === "string" && /^[0-9a-f]{7,64}$/i.test(v.trim()) ? v.trim().toLowerCase() : null;
    const tested = asSha(p.tested_head) ?? asSha(binding.tested_commit);
    if (verdict.event_type !== "ticket.tester_passed") {
      return { covered: false, why: "failed", tested, head };
    }
    const same = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);
    if (allHeads.length > 0 && (tested === null || !allHeads.some((h) => same(h, tested)))) {
      return { covered: false, why: "other_commit", tested, head };
    }
    // The contract the PASS was about: the tester's binding, else (a person's waiver
    // before review) the hash recorded on the PASS event.
    const recorded =
      typeof binding.contract_hash === "string"
        ? binding.contract_hash
        : typeof p.contract_hash === "string"
          ? p.contract_hash
          : null;
    if (recorded && recorded !== contractHash(this.db, ticket.id)) {
      return { covered: false, why: "contract_changed", tested, head };
    }
    return {
      covered: true,
      why: null,
      tested,
      head: (tested && allHeads.find((h) => same(h, tested))) ?? head,
    };
  }

  /**
   * TESTER FIRST: send an in_review ticket to the independent tester before a person
   * reviews it (`in_review -> in_testing`, reason tester_before_review). The runner's
   * call (system) or an admin's; anyone else is refused. Not an error when nothing is to
   * do: a ticket that is not in review, that the tester does not gate, whose write repo
   * cannot be read, or whose head a PASS already covers comes back `routed: false` with
   * why, so the runner can ask for every in_review ticket.
   */
  routeToTester(ref: string, actor: Actor): TesterRoute {
    if (actor.type !== "system" && actor.type !== "admin") {
      throw new DispatchError(
        "ACTOR_NOT_PERMITTED",
        "Only the runner (system) or an admin may send a ticket to the independent tester.",
        { actor_type: actor.type },
      );
    }
    const pre = this.ticketSvc.resolveTicket(ref);
    const out = (routed: boolean, why: string | null, head: string | null = null): TesterRoute => ({
      ticketId: pre.id,
      number: pre.number,
      routed,
      why,
      head,
    });
    // git runs here, before the write transaction.
    const plan = this.testerRoutePlan(pre);
    if (!plan.route) return out(false, plan.why, plan.coverage?.head ?? null);
    const coverage = plan.coverage;
    return inTransaction(this.db, () => {
      const ticket = this.ticketSvc.resolveTicket(ref);
      if (ticket.status !== "in_review") return out(false, `not in review (${ticket.status})`);
      this.transitions.transition({
        ticketId: ticket.id,
        actor,
        toStatus: "in_testing",
        reason: "tester_before_review",
        expectedFromStatus: "in_review",
        testerVerdict: true,
      });
      writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.routed_to_testing",
        payload: {
          from: "in_review",
          before_review: true,
          head: coverage.head,
          ...(coverage.why === "other_commit" && coverage.tested
            ? { tested: coverage.tested }
            : {}),
          ...(ticket.acceptance === 1 ? { acceptance: true } : {}),
        },
      });
      return out(true, null, coverage.head);
    });
  }

  /**
   * TESTER FIRST: would routeToTester send this ticket to the tester now, and if not, why?
   * The one decision behind the route and Poll for work's count (Dispatch.pendingTesterRoutes),
   * so Poll never counts a ticket the route would leave. Not when: it is not in review, the
   * tester does not gate it, a write repo's head cannot be read, a PASS covers its head, or
   * CI is required and has not passed on its head (the tester runs after the gates: a red or
   * pending CI is the delivery tick's to settle, and a red one goes back to rework). Reads git.
   */
  testerRoutePlan(
    ticket: Ticket,
  ):
    | { route: true; why: null; coverage: TesterCoverage }
    | { route: false; why: string; coverage: TesterCoverage | null } {
    if (ticket.status !== "in_review") {
      return { route: false, why: `not in review (${ticket.status})`, coverage: null };
    }
    if (!this.laneApplies(ticket)) {
      return {
        route: false,
        why: "the independent tester does not gate this ticket",
        coverage: null,
      };
    }
    const unavailable = this.unavailableWriteRepos(ticket);
    if (unavailable.length > 0) {
      return {
        route: false,
        why: `the delivery head of ${unavailable.map((m) => m.repo).join(", ")} cannot be read: ${unavailable[0]!.why}`,
        coverage: null,
      };
    }
    const coverage = this.testerCoverage(ticket, this.resolveReviewedHeads(ticket));
    if (coverage.covered) {
      return {
        route: false,
        why: `the tester already passed ${coverage.tested ? coverage.tested.slice(0, 12) : "this candidate"}`,
        coverage,
      };
    }
    const ci = this.ciStatus(ticket.id, coverage.head);
    if (ci.required && ci.state !== "pass") {
      return {
        route: false,
        why: `CI has not passed on ${coverage.head ? coverage.head.slice(0, 12) : "the candidate"} yet (${ci.state ?? "no result"}): the tester runs after the gates`,
        coverage,
      };
    }
    return { route: true, why: null, coverage };
  }

  /** Every in_review ticket the tester gates and has not passed, sent to it (see routeToTester). */
  routeAllToTester(actor: Actor): TesterRoute[] {
    if (actor.type !== "system" && actor.type !== "admin") {
      throw new DispatchError(
        "ACTOR_NOT_PERMITTED",
        "Only the runner (system) or an admin may send a ticket to the independent tester.",
        { actor_type: actor.type },
      );
    }
    const ids = (
      this.db
        .prepare("SELECT id FROM tickets WHERE status = 'in_review' ORDER BY number ASC")
        .all() as Array<{ id: string }>
    ).map((r) => r.id);
    const out: TesterRoute[] = [];
    for (const id of ids) {
      try {
        out.push(this.routeToTester(id, actor));
      } catch (err) {
        // One ticket's failure (a concurrent move) never stops the others.
        out.push({
          ticketId: id,
          number: null,
          routed: false,
          why: err instanceof Error ? err.message : String(err),
          head: null,
        });
      }
    }
    return out;
  }

  /** The latest entry into in_testing was the runner's tester-first route (not an approval). */
  private enteredTestingBeforeReview(ticketId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT json_extract(payload_json, '$.before_review') AS before_review FROM work_events
          WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = 'ticket.routed_to_testing'
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(ticketId) as { before_review: number | null } | undefined;
    return row?.before_review === 1;
  }

  /** The candidate commit REQUIRED CI is read for on approve (null when no CI is recorded). */
  private approveCiCandidate(ticket: Ticket): string | null {
    return this.ciStatus(ticket.id, null).required
      ? (this.ciCandidateHead(ticket)?.sha ?? null)
      : null;
  }

  /**
   * REQUIRED CI: the hold an approve of this ticket would hit right now (the same check
   * approveReview's assertCiPassed raises), or null when approval is not held by CI.
   */
  approveCiHold(ticket: Ticket): { state: string | null; commit: string | null } | null {
    const candidate = this.approveCiCandidate(ticket);
    const ci = this.ciStatus(ticket.id, candidate);
    if (!ci.required || (candidate !== null && ci.state === "pass")) return null;
    return { state: ci.state, commit: ci.commit };
  }

  /**
   * REQUIRED CI's candidate: the delivery head of the ticket's PRIMARY write repo (the
   * first write repo in role order — the repo whose PR the runner's CI gate polls), or
   * null when it does not resolve.
   */
  private ciCandidateHead(ticket: Ticket): ReviewedHead | null {
    return this.resolveReviewedHeads(ticket)[0] ?? null;
  }

  /**
   * APPROVAL COVERS EVERY WRITE REPO: the write repos whose delivery head cannot be read
   * now (the same read the Review button's outcome names). A resolver throw is read as
   * "unknown", and an unknown cannot be approved either: it fails toward the human.
   */
  unavailableWriteRepos(ticket: Ticket): readonly UnavailableWriteRepo[] {
    if (!this.unavailableWriteReposResolver) return [];
    try {
      return this.unavailableWriteReposResolver(ticket);
    } catch (e) {
      return [
        {
          repoId: "",
          repo: "(unknown)",
          why: `the ticket's write repositories could not be read (${e instanceof Error ? e.message : String(e)})`,
        },
      ];
    }
  }

  /** Refuse an approval that would leave a write repo without a pin (repo_unavailable). */
  private assertWriteReposAvailable(
    ticket: Ticket,
    missing: readonly UnavailableWriteRepo[],
  ): void {
    if (missing.length === 0) return;
    const names = missing.map((m) => m.repo);
    throw new DispatchError(
      "STATE_CONFLICT",
      `Approve held: ${names.join(", ")} ${names.length === 1 ? "is" : "are"} unavailable — ` +
        missing.map((m) => `${m.repo}: ${m.why}`).join("; ") +
        ". An approval covers every repository this ticket writes to, and nothing was approved. To approve: " +
        missing.map((m) => unavailableRepoRemedy(m, ticket.number)).join("; ") +
        "; then review again.",
      {
        reason: "repo_unavailable",
        ticket_number: ticket.number,
        repos: missing.map((m) => ({
          repo: m.repo,
          repo_id: m.repoId,
          why: m.why,
          remedy: unavailableRepoRemedy(m, ticket.number),
        })),
      },
    );
  }

  /** Best-effort head lookup (a throw resolves no head: nothing to compare or pin). */
  private resolveReviewedHeads(ticket: Ticket): readonly ReviewedHead[] {
    try {
      return this.reviewedHeadsResolver?.(ticket) ?? [];
    } catch {
      return [];
    }
  }

  /**
   * STALE REVISION: compare the commits the approver saw with the current heads, and
   * return the pins to record. Refuses (STATE_CONFLICT, details.reason `stale_revision`)
   * when any write repo's head differs from what was shown, a repo was not shown at all,
   * or a shown repo no longer resolves; and (`revision_required`) when the entry point
   * requires named commits and none were given while a head exists.
   */
  private checkShownCommits(
    ticket: Ticket,
    heads: readonly ReviewedHead[],
    actor: Actor,
    opts: ApproveReviewOptions,
    unavailable: readonly UnavailableWriteRepo[] = [],
  ): readonly ReviewedHead[] {
    const commits = opts.commits;
    if (commits === undefined || commits.length === 0) {
      if (opts.requireCommits && heads.length > 0) {
        throw new DispatchError(
          "STATE_CONFLICT",
          `Approve names the commit you reviewed. Current head${heads.length > 1 ? "s" : ""}: ` +
            heads.map((h) => `${h.repo}=${h.sha}`).join(", ") +
            ". Look at the diff, then approve with those commits (the dashboard sends them; " +
            "on the CLI pass --commit <repo>=<sha> for each repo).",
          {
            reason: "revision_required",
            ticket_number: ticket.number,
            current: heads.map((h) => ({ repo: h.repo, repo_id: h.repoId, sha: h.sha })),
          },
        );
      }
      // Legacy library path: a human approval pins what is there now; an agent's is
      // pinned by the runner.
      return actor.type === "human" || actor.type === "admin" ? heads : [];
    }
    const matches = (c: ShownCommit, h: ReviewedHead): boolean =>
      c.repo === null ? heads.length === 1 : c.repo === h.repoId || c.repo === h.repo;
    // DUPLICATE PINS (exploratory finding api/F12): one commit per repository. With two
    // entries for one repo the first decided the outcome, so [head, other] approved and
    // [other, head] read as a stale revision: the order of the list chose the answer.
    const named = (c: ShownCommit): string =>
      c.repo === null
        ? (heads[0]?.repoId ?? "(unnamed)")
        : (heads.find((h) => matches(c, h))?.repoId ?? c.repo);
    const seen = new Map<string, number>();
    for (const c of commits) seen.set(named(c), (seen.get(named(c)) ?? 0) + 1);
    const dupes = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
    if (dupes.length > 0) {
      const label = (k: string): string => heads.find((h) => h.repoId === k)?.repo ?? k;
      throw new DispatchError(
        "VALIDATION_ERROR",
        `Each repository can be approved at one commit only; ${dupes.map(label).join(", ")} ` +
          "was named more than once. Nothing was approved.",
        { reason: "duplicate_repo", repos: dupes.map(label) },
      );
    }
    const moved: Array<{ repo: string; shown: string | null; current: string | null }> = [];
    for (const h of heads) {
      const shown = commits.find((c) => matches(c, h));
      const sha = shown ? shown.sha.trim().toLowerCase() : null;
      if (sha !== h.sha) moved.push({ repo: h.repo, shown: sha, current: h.sha });
    }
    // A shown repo that is UNAVAILABLE now is the coverage refusal's to name
    // (repo_unavailable), not a stale revision.
    const isUnavailable = (c: ShownCommit): boolean =>
      c.repo !== null && unavailable.some((u) => u.repoId === c.repo || u.repo === c.repo);
    for (const c of commits) {
      if (!heads.some((h) => matches(c, h)) && !isUnavailable(c))
        moved.push({
          repo: c.repo ?? "(unnamed)",
          shown: c.sha.trim().toLowerCase(),
          current: null,
        });
    }
    if (moved.length > 0) {
      const what = moved
        .map((m) =>
          m.current === null
            ? `${m.repo} no longer has a delivery head to approve`
            : m.shown === null
              ? `${m.repo} (${m.current.slice(0, 12)}) was not in what you approved`
              : `${m.repo} is now ${m.current.slice(0, 12)} (you reviewed ${m.shown.slice(0, 12)})`,
        )
        .join("; ");
      throw new DispatchError(
        "STATE_CONFLICT",
        moved.every((m) => m.shown === null)
          ? `The approval does not cover every repository this ticket changes: ${what}. Nothing was approved — review every repository's diff and approve them together.`
          : `The change moved since it was shown: ${what}. Nothing was approved — reload the diff and review it again.`,
        { reason: "stale_revision", ticket_number: ticket.number, repos: moved },
      );
    }
    return heads;
  }

  /**
   * Record the commit(s) an approval covers as REVIEW PINS — one SYSTEM `commit` evidence
   * row per write repo (agents record evidence as `agent` and cannot forge one) that the
   * landing check reads on every path (the merge lane, the dashboard Merge, `gaffer
   * merge`) and the done gate requires to have landed. Without them an approval bound
   * nothing: commits pushed to a branch between the approve and the merge landed
   * unreviewed, and a second repo's change could be left behind.
   */
  private recordApprovalPins(ticket: Ticket, actor: Actor, pins: readonly ReviewedHead[]): void {
    const who = actor.type === "agent" ? "agent review" : "human review";
    for (const pin of pins) {
      this.evidence.insert({
        id: newId(),
        ticket_id: ticket.id,
        ac_id: null,
        repo_id: pin.repoId,
        decision_id: null,
        evidence_type: "commit",
        summary: `${who} (${actor.id ?? actor.type}) approved commit ${pin.sha} of ${pin.branch} in ${pin.repo}`,
        uri: `${REVIEW_PIN_PREFIX}${pin.sha}`,
        payload_json: JSON.stringify({
          kind: "review_pin",
          approver_type: actor.type,
          repo: pin.repo,
        }),
        created_by: "dispatch",
        recorded_by_actor_type: "system",
        created_at: this.clock.now(),
      });
    }
  }

  /**
   * REJECT PINS (review comments A2/A3): one SYSTEM `commit` evidence row per write repo
   * naming the commit a rejection sent back (uri `gaffer-rejected-commit:<sha>`). The
   * "changes since your review" interdiff starts from it. A distinct prefix from the review
   * pin, so the landing check and the tester binding never read it as an approval.
   */
  private recordRejectPins(
    ticket: Ticket,
    actor: Actor,
    heads: readonly ReviewedHead[],
    attempt: number,
  ): void {
    const who =
      actor.type === "agent"
        ? "agent review"
        : actor.type === "system"
          ? "the runner"
          : "human review";
    for (const pin of heads) {
      this.evidence.insert({
        id: newId(),
        ticket_id: ticket.id,
        ac_id: null,
        repo_id: pin.repoId,
        decision_id: null,
        evidence_type: "commit",
        summary: `${who} (${actor.id ?? actor.type}) sent back commit ${pin.sha} of ${pin.branch} in ${pin.repo}`,
        uri: `${REJECT_PIN_PREFIX}${pin.sha}`,
        payload_json: JSON.stringify({
          kind: "reject_pin",
          rejecter_type: actor.type,
          repo: pin.repo,
          attempt,
        }),
        created_by: "dispatch",
        recorded_by_actor_type: "system",
        created_at: this.clock.now(),
      });
    }
  }

  /** PER-REPOSITORY LANDING: which approved revisions have landed (see landingStatus.ts). */
  landingStatus(ref: string): LandingStatus {
    const ticket = this.ticketSvc.resolveTicket(ref);
    return computeLandingStatus(this.db, ticket.id);
  }

  /**
   * PER-REPOSITORY LANDING: record that one write repo's approved commit reached its
   * default branch. SYSTEM/admin only (the landing paths run as the runner). Idempotent:
   * recording the same (repo, commit) again returns the existing row. The commit must be
   * that repo's current review pin — landing something nobody approved is refused.
   */
  recordLanding(
    ref: string,
    input: { repo: string; commit: string; via?: string | undefined },
    actor: Actor,
  ): { ticketId: string; repo: string; commit: string; recorded: boolean; status: LandingStatus } {
    if (actor.type !== "system" && actor.type !== "admin") {
      throw new DispatchError(
        "ACTOR_NOT_PERMITTED",
        "Only a system or admin actor may record a landing.",
        { actor_type: actor.type },
      );
    }
    const sha = input.commit.trim().toLowerCase();
    if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(sha)) {
      throw new DispatchError(
        "VALIDATION_ERROR",
        "commit must be a full git commit id (40 or 64 hex characters).",
      );
    }
    return inTransaction(this.db, () => {
      const ticket = this.ticketSvc.resolveTicket(ref);
      // REVOCATION-SAFE LANDING: a landing that STARTED (landing-begin) on the approval the
      // ticket had, before a revocation moved it off ready_for_merge, cannot be stopped by
      // it; once git shows it, it is recorded all the same, so the ticket's record says
      // what its default branches carry (and the partly-landed guards see it).
      const startedBefore =
        ticket.status === "ready_for_merge"
          ? null
          : this.startedOnApproval(ticket.id, input.repo, sha);
      if (ticket.status !== "ready_for_merge" && !startedBefore) {
        throw new DispatchError(
          "ILLEGAL_TRANSITION",
          "A landing can only be recorded for an approved ticket (ready_for_merge), or for a landing that started before its approval was revoked.",
          { status: ticket.status },
        );
      }
      const before = computeLandingStatus(this.db, ticket.id);
      if (startedBefore) {
        const already = this.db
          .prepare(
            `SELECT 1 AS hit FROM evidence WHERE ticket_id = ? AND repo_id = ? AND uri = ?
               AND evidence_type = 'commit' AND recorded_by_actor_type = 'system' LIMIT 1`,
          )
          .get(ticket.id, startedBefore.repoId, `${LANDING_PREFIX}${sha}`);
        if (already) {
          return {
            ticketId: ticket.id,
            repo: startedBefore.repo,
            commit: sha,
            recorded: false,
            status: before,
          };
        }
      }
      const target = startedBefore
        ? { ...startedBefore, sha, landed: false }
        : before.repos.find((r) => r.repoId === input.repo || r.repo === input.repo);
      if (!target || target.sha !== sha) {
        throw new DispatchError(
          "STATE_CONFLICT",
          `${input.repo} has no approved revision ${sha.slice(0, 12)} on #${ticket.number}; only an approved commit can be recorded as landed.`,
          {
            reason: "not_approved_revision",
            approved: before.repos.map((r) => ({ repo: r.repo, sha: r.sha })),
          },
        );
      }
      if (target.landed) {
        return {
          ticketId: ticket.id,
          repo: target.repo,
          commit: sha,
          recorded: false,
          status: before,
        };
      }
      if (UNVERIFIABLE_LANDING_VIAS.has(input.via ?? ""))
        this.assertPrLanding(ticket, target, sha, input.via as "pr" | "pr-stale");
      // A LOCAL landing is checkable: the merge paths merge the pinned commit itself, so
      // it must be contained in the repo's default branch. Fail closed — a commit git
      // cannot show there (or a check that errors) is not recorded, so a forged or
      // mistaken row can never let markMerged close a ticket whose repo never landed.
      // A PR landing (`pr`, `pr-stale`) happens upstream and may be squashed, so the
      // local branch is no evidence either way; only the merge lane records one.
      if (this.landedOnDefaultResolver && !UNVERIFIABLE_LANDING_VIAS.has(input.via ?? "")) {
        let onDefault: boolean;
        try {
          onDefault = this.landedOnDefaultResolver(target.repoId, sha);
        } catch {
          onDefault = false;
        }
        if (!onDefault) {
          throw new DispatchError(
            "STATE_CONFLICT",
            `${target.repo}'s default branch does not contain ${sha.slice(0, 12)}; a local landing is recorded only once git shows the approved commit there.`,
            { reason: "not_on_default_branch", repo: target.repo, commit: sha },
          );
        }
      }
      this.evidence.insert({
        id: newId(),
        ticket_id: ticket.id,
        ac_id: null,
        repo_id: target.repoId,
        decision_id: null,
        evidence_type: "commit",
        summary: `landed ${sha} of #${ticket.number} on ${target.repo}'s default branch${input.via ? ` (via ${input.via})` : ""}`,
        uri: `${LANDING_PREFIX}${sha}`,
        payload_json: JSON.stringify({
          kind: "landing",
          repo: target.repo,
          via: input.via ?? null,
        }),
        created_by: "dispatch",
        recorded_by_actor_type: "system",
        created_at: this.clock.now(),
      });
      writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.repo_landed",
        payload: { repo: target.repo, commit: sha, via: input.via ?? null },
      });
      return {
        ticketId: ticket.id,
        repo: target.repo,
        commit: sha,
        recorded: true,
        status: computeLandingStatus(this.db, ticket.id),
      };
    });
  }

  /**
   * REVOCATION-SAFE LANDING (external review #8): the approval a landing is acting on —
   * the id of the ticket's latest transition into ready_for_merge (a human/agent approve,
   * a tester PASS), or null when it never got there. The merge runner reads it before its
   * gates run and hands it back to beginLanding, so a re-approval while the gates ran
   * (even of the same commit) is a different approval and nothing lands on the old one.
   */
  approvalRef(ticketId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT id FROM work_events
          WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = 'ticket.transitioned'
            AND json_extract(payload_json, '$.to') = 'ready_for_merge'
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(ticketId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /**
   * REVOCATION-SAFE LANDING (external review #8). A cancellation or a red required check
   * recorded while the merge gate ran used to be acknowledged by Dispatch and then
   * overridden by the landing that followed: both default branches advanced, the merge
   * exited 0, and the ticket still read cancelled. The landing paths now call this
   * IMMEDIATELY before they advance a default branch (or ask the provider to merge a PR),
   * once per repository. In ONE immediate transaction it re-checks that the ticket is
   * still ready_for_merge, on the same approval (`approval`, from approvalRef), that
   * `commit` is still that repo's approved revision, and that required CI for the
   * approved commits is still green — and records the landing as STARTED
   * (`ticket.landing_started`). A refusal (STATE_CONFLICT, `details.reason` revoked |
   * approval_changed | ci_not_green) means: land nothing. Because the check and the
   * record are one transaction, a revocation is either committed first (this refuses) or
   * sees the started landing (rejectReview / recordCiResult then report it). System/admin.
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
  ): {
    ticketId: string;
    repo: string;
    repoId: string;
    commit: string;
    approval: string | null;
    eventId: string;
  } {
    if (actor.type !== "system" && actor.type !== "admin") {
      throw new DispatchError(
        "ACTOR_NOT_PERMITTED",
        "Only a system or admin actor may start a landing.",
        { actor_type: actor.type },
      );
    }
    const sha = input.commit.trim().toLowerCase();
    if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(sha)) {
      throw new DispatchError(
        "VALIDATION_ERROR",
        "commit must be a full git commit id (40 or 64 hex characters).",
      );
    }
    return inTransaction(this.db, () => {
      const ticket = this.ticketSvc.resolveTicket(ref);
      if (ticket.status !== "ready_for_merge") {
        throw new DispatchError(
          "STATE_CONFLICT",
          `#${ticket.number} is ${ticket.status}, no longer ready_for_merge: its approval was revoked while the landing was being prepared.`,
          { reason: "revoked", status: ticket.status },
        );
      }
      const approval = this.approvalRef(ticket.id);
      if (input.approval && approval !== input.approval) {
        throw new DispatchError(
          "STATE_CONFLICT",
          `#${ticket.number} was re-approved while the landing was being prepared; the approval it started on is no longer current.`,
          { reason: "approval_changed", started_on: input.approval, current: approval },
        );
      }
      const landing = computeLandingStatus(this.db, ticket.id);
      const target = landing.repos.find((r) => r.repoId === input.repo || r.repo === input.repo);
      // A legacy approval (no per-repo pins) has no plan: the status/approval/CI checks
      // still apply; with a plan, the commit must be the repo's current approved revision.
      if (landing.repos.length > 0 && (!target || target.sha !== sha)) {
        throw new DispatchError(
          "STATE_CONFLICT",
          `${input.repo} has no approved revision ${sha.slice(0, 12)} on #${ticket.number} any more; the approval changed while the landing was being prepared.`,
          {
            reason: "approval_changed",
            approved: landing.repos.map((r) => ({ repo: r.repo, sha: r.sha })),
          },
        );
      }
      // REQUIRED CI for the approved commits must still be green.
      if (this.ciStatus(ticket.id, null).required) {
        const pins = landing.repos.filter((r) => r.pinned).map((r) => r.sha);
        const states = (pins.length > 0 ? pins : [sha]).map((c) => ({
          state: this.ciStatus(ticket.id, c).state,
          commit: c,
        }));
        const red = states.find((x) => x.state !== null && x.state !== "pass");
        const anyPass = states.some((x) => x.state === "pass");
        if (red || !anyPass) {
          const at = red ? red.commit : (pins[0] ?? sha);
          throw new DispatchError(
            "STATE_CONFLICT",
            `Required CI for ${String(at).slice(0, 12)} on #${ticket.number} is ${red?.state ?? "not passed"}; nothing may land on it.`,
            { reason: "ci_not_green", commit: at, ci_state: red?.state ?? null },
          );
        }
      }
      const repoId = target?.repoId ?? input.repo;
      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.landing_started",
        payload: {
          repo: target?.repo ?? input.repo,
          repo_id: repoId,
          commit: sha,
          via: input.via ?? null,
          approval,
        },
      });
      return {
        ticketId: ticket.id,
        repo: target?.repo ?? input.repo,
        repoId,
        commit: sha,
        approval,
        eventId,
      };
    });
  }

  /**
   * REVOCATION-SAFE LANDING: the `ticket.landing_started` of `sha` in `repo` (id or name)
   * on the ticket's current approval (approvalRef), as { repoId, repo }, or null.
   */
  private startedOnApproval(
    ticketId: string,
    repo: string,
    sha: string,
  ): { repoId: string; repo: string } | null {
    const approval = this.approvalRef(ticketId);
    if (!approval) return null;
    const row = this.db
      .prepare(
        `SELECT json_extract(payload_json, '$.repo_id') AS repo_id,
                json_extract(payload_json, '$.repo') AS repo
           FROM work_events
          WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = 'ticket.landing_started'
            AND json_extract(payload_json, '$.approval') = ?
            AND lower(json_extract(payload_json, '$.commit')) = ?
            AND (json_extract(payload_json, '$.repo_id') = ? OR json_extract(payload_json, '$.repo') = ?)
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(ticketId, approval, sha, repo, repo) as
      { repo_id: string | null; repo: string | null } | undefined;
    if (!row?.repo_id) return null;
    const known = this.db
      .prepare(`SELECT id, name FROM repositories WHERE id = ?`)
      .get(row.repo_id) as { id: string; name: string } | undefined;
    return known ? { repoId: known.id, repo: known.name } : null;
  }

  /**
   * REVOCATION-SAFE LANDING: the landings already started or committed on the ticket's
   * current approval (since it last entered in_review): every `ticket.landing_started`
   * and every recorded landing, one row per repo and commit. `landed` is true when the
   * landing is on record or git shows the approved commit on that repo's default branch;
   * false means the landing had started (the default branch may be moving right now).
   * A revocation (rejectReview, a failed CI result) reports these: it cannot undo them.
   */
  landingsStarted(ticketId: string): LandingStarted[] {
    const entered = this.db
      .prepare(
        `SELECT created_at AS at FROM work_events
          WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = 'ticket.transitioned'
            AND json_extract(payload_json, '$.to') = 'in_review'
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(ticketId) as { at: string } | undefined;
    const since = entered?.at ?? "";
    const started = this.db
      .prepare(
        `SELECT payload_json, created_at FROM work_events
          WHERE entity_type = 'ticket' AND entity_id = ? AND created_at >= ?
            AND event_type IN ('ticket.landing_started', 'ticket.repo_landed')
          ORDER BY rowid ASC`,
      )
      .all(ticketId, since) as Array<{ payload_json: string | null; created_at: string }>;
    const status = computeLandingStatus(this.db, ticketId);
    const out = new Map<string, LandingStarted>();
    for (const row of started) {
      let p: Record<string, unknown> = {};
      try {
        p = JSON.parse(row.payload_json ?? "{}") as Record<string, unknown>;
      } catch {
        p = {};
      }
      const commit = String(p.commit ?? "").toLowerCase();
      const repo = String(p.repo ?? "");
      const st = status.repos.find((r) => r.repoId === String(p.repo_id ?? "") || r.repo === repo);
      if (!commit) continue;
      const key = `${st?.repoId ?? repo}\u0000${commit}`;
      const prev = out.get(key);
      out.set(key, {
        repo: st?.repo ?? repo,
        repoId: st?.repoId ?? String(p.repo_id ?? repo),
        commit,
        landed: prev?.landed ?? false,
        via: (p.via as string | null | undefined) ?? prev?.via ?? null,
        at: prev?.at ?? row.created_at,
      });
    }
    for (const [key, v] of out) {
      let landed = status.repos.some(
        (r) => r.repoId === v.repoId && r.sha === v.commit && r.landed,
      );
      if (!landed && this.landedOnDefaultResolver && !UNVERIFIABLE_LANDING_VIAS.has(v.via ?? "")) {
        try {
          landed = this.landedOnDefaultResolver(v.repoId, v.commit);
        } catch {
          landed = false;
        }
      }
      out.set(key, { ...v, landed });
    }
    return [...out.values()];
  }

  /**
   * TESTER REPLAY ON THE LANDED REVISION (external review #4): record that the
   * independent tester's test files passed on the exact revision that landed (see
   * testerReplay.ts). SYSTEM only — the runner's landing path, after the merge gate
   * replayed the tester's tests on the merge candidate and that candidate landed; not an
   * admin, a human or an agent (the epic is counted as accepted on this record, so nobody
   * but the landing path may assert it). Idempotent per landed revision. Refused unless:
   * the ticket is approved (ready_for_merge — recorded before mark-merged, like a landing);
   * its tester PASS (the row a `ticket.tester_passed` event names, from an agent/system
   * tester) is bound to exactly `pin`; `pin` is the approved revision when the repo has a
   * review pin; and, for a local landing, git shows `commit` on the repo's default branch.
   */
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
  ): { ticketId: string; commit: string; tested: string; files: string[]; recorded: boolean } {
    if (actor.type !== "system") {
      throw new DispatchError(
        "ACTOR_NOT_PERMITTED",
        "Only the runner's landing path (the system actor) may record a tester replay.",
        { actor_type: actor.type },
      );
    }
    const sha = (v: string, what: string): string => {
      const s = String(v ?? "")
        .trim()
        .toLowerCase();
      if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(s)) {
        throw new DispatchError(
          "VALIDATION_ERROR",
          `${what} must be a full git commit id (40 or 64 hex characters).`,
        );
      }
      return s;
    };
    const commit = sha(input.commit, "commit");
    const pin = sha(input.pin, "pin");
    const files = [...new Set((input.files ?? []).map((f) => String(f).trim()).filter(Boolean))];
    if (files.length > 500 || files.some((f) => f.length > 1000 || /[\n\r\0]/.test(f))) {
      throw new DispatchError(
        "VALIDATION_ERROR",
        "files must be at most 500 single-line paths of at most 1000 characters.",
      );
    }
    const note = String(input.note ?? "")
      .replace(/[\r\n\t]+/g, " ")
      .trim()
      .slice(0, 500);
    // PR-STALE: the PR merged upstream but the local default branch was not fast-forwarded,
    // so nothing here can show which revision landed. No record: never accepted on a guess.
    if (input.via === "pr-stale") {
      throw new DispatchError(
        "STATE_CONFLICT",
        "the landed revision of a PR merge whose local default branch was not fast-forwarded cannot be verified; no tester replay is recorded for it.",
        { reason: "unverifiable_landing" },
      );
    }
    return inTransaction(this.db, () => {
      const ticket = this.ticketSvc.resolveTicket(ref);
      if (ticket.status !== "ready_for_merge") {
        throw new DispatchError(
          "ILLEGAL_TRANSITION",
          "A tester replay can only be recorded for an approved ticket (ready_for_merge).",
          { status: ticket.status },
        );
      }
      const bound = readBoundTesterPass(this.db, ticket.id);
      if (!bound || bound.provenance === "human" || bound.testedCommit !== pin) {
        throw new DispatchError(
          "STATE_CONFLICT",
          `#${ticket.number} has no tester PASS bound to ${pin.slice(0, 12)}; a replay is recorded only for the tested commit that landed.`,
          { reason: "not_tested_commit", tested: bound?.testedCommit ?? null },
        );
      }
      // The repo: the one named, else the ticket's primary repo.
      const landing = computeLandingStatus(this.db, ticket.id);
      let repoId: string | null = null;
      if (input.repo) {
        const named = this.db
          .prepare("SELECT id FROM repositories WHERE id = ? OR name = ? LIMIT 1")
          .get(input.repo, input.repo) as { id: string } | undefined;
        if (!named) throw notFound("repository", input.repo);
        repoId = named.id;
      } else {
        const primary = this.db
          .prepare(
            "SELECT repo_id FROM ticket_repos WHERE ticket_id = ? ORDER BY role = 'primary' DESC LIMIT 1",
          )
          .get(ticket.id) as { repo_id: string } | undefined;
        repoId = primary?.repo_id ?? null;
      }
      const approved = repoId ? landing.repos.find((r) => r.repoId === repoId) : undefined;
      if (approved && approved.sha !== pin) {
        throw new DispatchError(
          "STATE_CONFLICT",
          `${pin.slice(0, 12)} is not the approved revision of #${ticket.number} (approved ${approved.sha.slice(0, 12)}).`,
          { reason: "not_approved_revision" },
        );
      }
      const uri = `${TESTER_REPLAY_PREFIX}${commit}`;
      const existing = this.db
        .prepare(
          "SELECT 1 FROM evidence WHERE ticket_id = ? AND evidence_type = 'commit' AND recorded_by_actor_type = 'system' AND uri = ? LIMIT 1",
        )
        .get(ticket.id, uri);
      if (existing) return { ticketId: ticket.id, commit, tested: pin, files, recorded: false };
      // The landed revision must be on the default branch for EVERY landing path: a PR
      // landing records the local default's head after the fast-forward (whose tree the
      // runner checked equals the candidate it replayed on), never the scratch candidate.
      if (repoId && this.landedOnDefaultResolver) {
        let onDefault: boolean;
        try {
          onDefault = this.landedOnDefaultResolver(repoId, commit);
        } catch {
          onDefault = false;
        }
        if (!onDefault) {
          throw new DispatchError(
            "STATE_CONFLICT",
            `the default branch does not contain ${commit.slice(0, 12)}; a replay is recorded only for the revision that landed.`,
            { reason: "not_on_default_branch", commit },
          );
        }
      }
      // MULTI-REPO: the tester ran in (and saved tests for) the replayed repo only; say which
      // other write repos of the ticket its assertions did not cover.
      const repoName = repoId
        ? ((
            this.db.prepare("SELECT name FROM repositories WHERE id = ?").get(repoId) as
              { name: string } | undefined
          )?.name ?? null)
        : null;
      const notReplayed = (
        this.db
          .prepare(
            `SELECT r.name AS name FROM ticket_repos tr JOIN repositories r ON r.id = tr.repo_id
              WHERE tr.ticket_id = ? AND tr.access = 'write' AND tr.repo_id IS NOT ?
              ORDER BY r.name`,
          )
          .all(ticket.id, repoId) as Array<{ name: string }>
      ).map((r) => r.name);
      this.evidence.insert({
        id: newId(),
        ticket_id: ticket.id,
        ac_id: null,
        repo_id: repoId,
        decision_id: null,
        evidence_type: "commit",
        summary:
          (files.length
            ? `the independent tester's ${files.length} test file(s) (${files.slice(0, 5).join(", ")}${files.length > 5 ? ", …" : ""}) passed`
            : "NO tester test file was replayed (the repository's own suite passed)") +
          ` on the landed revision ${commit} (the merge of tested commit ${pin.slice(0, 12)})${input.via ? ` via ${input.via}` : ""}` +
          (notReplayed.length ? `; not replayed in ${notReplayed.join(", ")}` : "") +
          (note ? ` — ${note}` : ""),
        uri,
        payload_json: JSON.stringify({
          kind: "tester_replay",
          tested: pin,
          pin,
          files,
          via: input.via ?? null,
          repo: repoName,
          not_replayed_repos: notReplayed,
          ...(note ? { note } : {}),
          tester_evidence_id: bound.evidenceId,
        }),
        created_by: "dispatch",
        recorded_by_actor_type: "system",
        created_at: this.clock.now(),
      });
      writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.tester_replayed",
        payload: { commit, tested: pin, files, via: input.via ?? null },
      });
      return { ticketId: ticket.id, commit, tested: pin, files, recorded: true };
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
      const ticket = this.tickets.resolveRef(input.ticket_id);
      const ac = this.acs.findById(input.ac_id);
      if (!ac || ac.ticket_id !== ticket.id) throw notFound("acceptance_criterion", input.ac_id);
      if (!ac.check_command) {
        throw new DispatchError(
          "VALIDATION_ERROR",
          "This acceptance criterion has no check_command; a check result can only be recorded for a machine-checkable AC.",
          { ac_id: ac.id },
        );
      }
      // BYTE-EXACT: a result is evidence about the command that RAN. One that differs
      // from the stored check (a TAB rewritten to a space, a trimmed line) is about a
      // different criterion and is refused, never recorded against this one.
      if (input.command !== ac.check_command) {
        throw new DispatchError(
          "VALIDATION_ERROR",
          "The executed command does not match this criterion's stored check_command byte for byte; the result was not recorded.",
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
        ...(observed?.holds?.length ? { holds: observed.holds } : {}),
      },
    });
    // GATE INTEGRITY: a hard hold (the delivery weakened its own tests) is named as such —
    // the declared level does not matter for it, so "exceeds declared" would mislead.
    const message = observed?.holds?.length
      ? `Auto-approve held for human review: the delivery modified the tests that gate it (${observed.holds.join("; ")}). A human can approve, or allow test changes on the ticket.`
      : `Auto-approve held for human review: observed risk '${observedLevel}' exceeds declared '${ticket.risk_level}'.`;
    throw new DispatchError("OBSERVED_RISK_ESCALATED", message, {
      declared: ticket.risk_level,
      observed: observedLevel,
      reasons,
      ...(observed?.holds?.length ? { holds: observed.holds } : {}),
    });
  }

  /**
   * ACCEPTANCE PROFILE guard (C1/C2, like BINDING_REQUIRED): an automated PASS on a ticket
   * whose test contract names a profile other than unit must point at a runner-recorded
   * (system) acceptance evidence row on this ticket that passed, for the same profile, the
   * tested commit and the current contract. A profile the runner cannot run yet (web,
   * migration, performance) can never meet this: a person records the verdict. Returns the
   * binding to store with the PASS, or null for a unit ticket.
   */
  private assertAcceptanceEvidence(
    ticket: Ticket,
    evidenceId: string | undefined,
    binding: VerdictBinding,
    contractNow: string | null,
  ): { profile: AcceptanceProfile; evidence_id: string } | null {
    const profile = contractProfile(parseTestContract(ticket.test_contract));
    if (profile === "unit") return null;
    const refuse = (why: string): never => {
      throw new DispatchError(
        "ACCEPTANCE_EVIDENCE_REQUIRED",
        `An automated PASS on a ticket with the ${profile} acceptance profile needs the runner's passed ${profile} evidence for the tested commit: ${why}. A human can record the verdict instead (tester-pass --as human), which is reported as a waiver.`,
        { profile, ...(evidenceId ? { acceptance_evidence: evidenceId } : {}) },
      );
    };
    if (!EXECUTABLE_PROFILES.includes(profile))
      refuse(`the runner cannot run the ${profile} profile yet`);
    if (!evidenceId) refuse("no acceptance evidence was named");
    const row = this.evidence.listForTicket(ticket.id).find((e) => e.id === evidenceId);
    if (!row) refuse(`evidence ${evidenceId} is not on this ticket`);
    const r = row as NonNullable<typeof row>;
    if (
      r.recorded_by_actor_type !== "system" ||
      !String(r.uri ?? "").startsWith(ACCEPTANCE_EVIDENCE_PREFIX)
    )
      refuse("the named evidence is not the runner's acceptance record");
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(r.payload_json ?? "{}") as Record<string, unknown>;
    } catch {
      refuse("the acceptance record cannot be read");
    }
    if (payload.profile !== profile)
      refuse(`the record is for the ${String(payload.profile)} profile`);
    if (payload.passed !== true) refuse("the runner's acceptance run did not pass");
    if (!binding.tested_commit || String(payload.tested_commit) !== binding.tested_commit)
      refuse("the record is for a different commit than the one tested");
    if (contractNow && payload.contract_hash !== contractNow)
      refuse("the record was made against a different contract");
    return { profile, evidence_id: r.id };
  }

  /**
   * The independent black-box tester PASSED. TESTER FIRST: a ticket the runner sent to
   * the tester before review (routeToTester) returns to `in_review` for a person, with
   * the commit it tested recorded on the `ticket.tester_passed` event (`tested_head`);
   * a ticket an approval sent (an agent's approval, or a person's before tester-first)
   * goes on to `ready_for_merge` as before. testerVerdict:true guards both transitions.
   */
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
    },
    actor: Actor,
  ): TransitionResult {
    const summary = input.summary.trim();
    if (summary.length === 0) {
      throw new DispatchError("VALIDATION_ERROR", "A test-result summary is required.");
    }
    // The done gate needs real git; run it BEFORE the outer write transaction (a
    // nested transition() is only a savepoint inside it, so "before transition()" is
    // not enough). The gate re-checks the proof's fingerprint inside the transaction.
    const pre = this.ticketSvc.resolveTicket(ticketRef);
    const toReview = pre.status === "in_testing" && this.enteredTestingBeforeReview(pre.id);
    const target: TicketStatus = toReview ? "in_review" : "ready_for_merge";
    const deliveryDiff =
      pre.status === "in_testing" && !toReview
        ? this.transitions.deliveryDiffProof(pre.id)
        : undefined;
    // REQUIRED CI's candidate: the tested commit, else the branch head — resolved (git)
    // here, outside the write transaction, and only when CI results exist at all. A PASS
    // that returns the ticket to review approves nothing: approval reads CI itself.
    const ciCandidate = toReview
      ? null
      : (input.tested_commit ??
        (this.ciStatus(pre.id, null).required ? (this.ciCandidateHead(pre)?.sha ?? null) : null));
    // The commit this PASS is about, for the approval's same-commit check: the tested
    // commit the runner's tester names, else (a person's waiver) the head now.
    const headNow = toReview ? (this.ciCandidateHead(pre)?.sha ?? null) : null;
    return inTransaction(this.db, () => {
      const ticket = this.ticketSvc.resolveTicket(ticketRef);
      if (ticket.status !== "in_testing") {
        throw new DispatchError(
          "ILLEGAL_TRANSITION",
          "Only a ticket in testing can be passed by the tester.",
          { from: ticket.status, to: target },
        );
      }
      const contractNow = contractHash(this.db, ticket.id);
      const binding = validatedBinding(input, {
        strict: ticket.acceptance === 1 && testerProvenance(actor) !== "human",
        currentHash: contractNow,
        verdict: "pass",
        human: testerProvenance(actor) === "human",
      });
      // ACCEPTANCE PROFILE: on a ticket whose contract names a profile, an automated PASS
      // also needs the runner's own evidence of the running change (the CLI transcript,
      // the API probes) for the tested commit and the current contract.
      const acceptanceEvidence =
        testerProvenance(actor) === "human"
          ? null
          : this.assertAcceptanceEvidence(ticket, input.acceptance_evidence, binding, contractNow);
      // REQUIRED CI: the tester's PASS is the other way into ready_for_merge.
      if (!toReview) this.assertCiPassed(ticket, ciCandidate);
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
          ...(acceptanceEvidence ? { acceptance: acceptanceEvidence } : {}),
        }),
        created_by: actor.id ?? actor.type,
        recorded_by_actor_type: actor.type,
        created_at: now,
      });
      const result = this.transitions.transition({
        ticketId: ticket.id,
        actor,
        toStatus: target,
        reason: "tester_passed",
        expectedFromStatus: "in_testing",
        testerVerdict: true,
        ...(deliveryDiff ? { deliveryDiff } : {}),
      });
      const testedHead = binding.tested_commit ?? headNow?.toLowerCase() ?? null;
      writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.tester_passed",
        payload: {
          evidence_id: evidenceId,
          ...(toReview ? { to: "in_review", before_review: true } : {}),
          ...(testedHead ? { tested_head: testedHead } : {}),
          // The contract a PASS before review was about, when its binding names none (a
          // person's waiver): a contract edited after it then needs the tester again.
          ...(toReview && !binding.contract_hash && contractNow
            ? { contract_hash: contractNow }
            : {}),
        },
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
      tests_commit?: string;
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

      // PARTLY LANDED: a tester FAIL of a ticket whose change already reached a default
      // branch holds it for a person instead of re-queueing it (as rejectReview does).
      const landedRepos = recordedLandingRepos(this.db, ticket.id);
      const holdLanded = landedRepos.length > 0;
      const { nextAttempt, capReached } = holdLanded
        ? { nextAttempt: ticket.attempt_count, capReached: false }
        : capRetry(ticket.attempt_count, this.maxAttempts);
      const target: TicketStatus = capReached || holdLanded ? "blocked" : failTo;
      const reason = `tester_failed:${summary}`;
      const result = this.transitions.transition({
        ticketId: ticket.id,
        actor,
        toStatus: target,
        reason: holdLanded
          ? `partly_landed:${reason}`
          : capReached
            ? `retry_cap_reached:${reason}`
            : reason,
        expectedFromStatus: "in_testing",
        patch: { attempt_count: nextAttempt },
        ...(capReached || holdLanded ? { park: true } : { testerVerdict: true }),
      });
      if (holdLanded) this.partlyLandedHold(ticket, landedRepos, failTo, reason, actor);
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
    // PER-REPOSITORY LANDING: `done` means EVERY approved revision landed. A two-repo
    // ticket whose second repo's change is still on its delivery branch stays
    // ready_for_merge (a visible "partly merged" item in the human queue); the merge
    // paths land the rest and call this again.
    let landing = computeLandingStatus(this.db, ticket.id);
    if (landing.pending > 0 && this.landedOnDefaultResolver) {
      // Git is the truth for a local landing: record what is verifiably on the default
      // branch already (as SYSTEM evidence, via "git-verified"), then re-read.
      // (Not for a repo with a recorded PR: its checkout holding the commit is no evidence
      // that the PR merged upstream — external review #8.)
      for (const r of landing.repos.filter((x) => !x.landed && x.pinned && !x.prUrl)) {
        let onDefault: boolean;
        try {
          onDefault = this.landedOnDefaultResolver(r.repoId, r.sha);
        } catch {
          onDefault = false;
        }
        if (onDefault)
          this.recordLanding(
            ticket.id,
            { repo: r.repoId, commit: r.sha, via: "git-verified" },
            { type: "system" },
          );
      }
      landing = computeLandingStatus(this.db, ticket.id);
    }
    if (landing.pending > 0) {
      const pending = landing.repos.filter((r) => !r.landed);
      // EVERY WRITE REPO: an unpinned write repo is pending too, and says why.
      const unpinned = pending.filter((r) => !r.pinned);
      throw new DispatchError(
        "STATE_CONFLICT",
        `#${ticket.number} is not done: ${pending
          .map((r) =>
            r.pinned
              ? `${r.repo} (${r.sha.slice(0, 12)}${r.prUrl ? `, its PR ${r.prUrl} has not merged upstream` : ""})`
              : `${r.repo} (not covered by the approval)`,
          )
          .join(", ")} ` +
          `${pending.length === 1 ? "has" : "have"} not landed yet` +
          (landing.landed > 0 ? ` (${landing.landed} of ${landing.repos.length} landed)` : "") +
          ". Merge the remaining repositories; the ticket is done when every write repository has landed." +
          (unpinned.length > 0
            ? ` ${unpinned.map((r) => r.repo).join(", ")} ${unpinned.length === 1 ? "has" : "have"} no approved commit: move the ticket back to review and approve every repository together.`
            : ""),
        {
          reason: landing.partial ? "partial_landing" : "not_landed",
          pending: pending.map((r) => ({ repo: r.repo, sha: r.sha, pinned: r.pinned })),
          landed: landing.repos.filter((r) => r.landed).map((r) => ({ repo: r.repo, sha: r.sha })),
        },
      );
    }
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
    input: { reason: string; resolution: string; cause?: ReopenForReviewCause },
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
          // What sent it back (the caller's cause; Dispatch.reopenForReview infers one
          // from the ticket's hold). Only the resolver's conflict reopen says a merge
          // conflict was resolved.
          cause: input.cause ?? "merge_conflict",
          merge_conflict_resolved: (input.cause ?? "merge_conflict") === "merge_conflict",
          evidence_id: evidenceId,
        },
      });
      return { ticketId: ticket.id, status: result.ticket.status, eventId };
    });
  }

  /**
   * HOLD FOR A HUMAN: park an approved ticket (`ready_for_merge | in_testing -> blocked`)
   * with a structured reason code, so it leaves the merge lane and waits in the human
   * queue (the `parked` kind) with the reason. SYSTEM/admin only — the runner's merge
   * gate (the combined code failed the gates on the target) and a late red CI result
   * use it; a board drag cannot (the `park` guard).
   */
  holdForHuman(
    ticketRef: string,
    input: { reasonCode: string; reason: string },
    actor: Actor,
  ): TransitionResult {
    if (actor.type !== "system" && actor.type !== "admin") {
      throw new DispatchError(
        "ACTOR_NOT_PERMITTED",
        "Only the runner (system) or an admin may hold an approved ticket for a human.",
        { actor_type: actor.type },
      );
    }
    const code = input.reasonCode.trim();
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(code)) {
      throw new DispatchError("VALIDATION_ERROR", "reason code must be a snake_case word.", {
        reason_code: input.reasonCode,
      });
    }
    const reason = input.reason.trim().slice(0, 4_000) || code;
    return inTransaction(this.db, () => {
      const ticket = this.ticketSvc.resolveTicket(ticketRef);
      if (ticket.status !== "ready_for_merge" && ticket.status !== "in_testing") {
        throw new DispatchError(
          "ILLEGAL_TRANSITION",
          "Only an approved ticket (ready_for_merge or in_testing) can be held for a human.",
          { from: ticket.status, to: "blocked" },
        );
      }
      const result = this.transitions.transition({
        ticketId: ticket.id,
        actor,
        toStatus: "blocked",
        reason: `held:${code}`,
        expectedFromStatus: ticket.status,
        park: true,
      });
      writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.blocked",
        payload: { reason, reason_code: code },
      });
      return result;
    });
  }

  /**
   * REQUIRED CI: record a CI result for a ticket's candidate commit (SYSTEM/admin only —
   * the runner's CI gate; an admin may record a human override, which is auditable).
   * A FAIL on a ticket that is already approved (`ready_for_merge` / `in_testing`)
   * HOLDS it for a human with the failing check as the reason: the rejection path only
   * acted on `in_review`, so a late red result left an approved ticket landable.
   */
  recordCiResult(
    ticketRef: string,
    input: { commit: string; state: "pending" | "pass" | "fail"; detail?: string },
    actor: Actor,
  ): { state: string; held: boolean; status: string; eventId: string } {
    if (actor.type !== "system" && actor.type !== "admin") {
      throw new DispatchError(
        "ACTOR_NOT_PERMITTED",
        "Only the runner (system) or an admin may record a CI result.",
        { actor_type: actor.type },
      );
    }
    const commit = input.commit.trim().toLowerCase();
    if (!/^[0-9a-f]{7,64}$/.test(commit)) {
      throw new DispatchError("VALIDATION_ERROR", "commit must be a git commit id.", {
        commit: input.commit,
      });
    }
    if (!["pending", "pass", "fail"].includes(input.state)) {
      throw new DispatchError("VALIDATION_ERROR", "state must be pending, pass or fail.", {
        state: input.state,
      });
    }
    const detail = (input.detail ?? "").trim().slice(0, 2_000);
    const ticket = this.ticketSvc.resolveTicket(ticketRef);
    // THE TICKET'S COMMITS ONLY (exploratory finding cli-wg/F-11): a result for a commit
    // that is not one of the ticket's candidates was recorded anyway, and `ci-status` then
    // reported that unrelated PASS while the real head was red.
    const candidates = this.ciCandidateCommits(ticket);
    const known = candidates.some((c) => c.startsWith(commit) || commit.startsWith(c));
    if (!known) {
      throw new DispatchError(
        "STATE_CONFLICT",
        `${commit.slice(0, 12)} is not a commit of #${ticket.number ?? "?"}: a CI result is recorded only for the ticket's candidate commit (a write repo's delivery head, a recorded delivery commit, or an approved revision).`,
        {
          reason: "not_ticket_commit",
          commit,
          candidates: candidates.map((c) => c.slice(0, 12)),
        },
      );
    }
    const eventId = writeEvent(this.db, {
      entity_type: "ticket",
      entity_id: ticket.id,
      actor,
      event_type: "ticket.ci_result",
      payload: { commit, state: input.state, ...(detail ? { detail } : {}) },
    });
    let held = false;
    let status: string = ticket.status;
    if (
      input.state === "fail" &&
      (ticket.status === "ready_for_merge" || ticket.status === "in_testing")
    ) {
      const r = this.holdForHuman(
        ticket.id,
        {
          reasonCode: "ci_red",
          reason: `Required CI failed for ${commit.slice(0, 12)}${detail ? `: ${detail}` : ""}`,
        },
        actor,
      );
      held = true;
      status = r.ticket.status;
    }
    return { state: input.state, held, status, eventId };
  }

  /**
   * REQUIRED CI, recorded BEFORE any result (external review #9, finding 4): the runner
   * marks the ticket as needing CI when it submits a delivery that CI will gate
   * (GAFFER_REQUIRE_CI with PR creation on), so the requirement exists before the ticket
   * is exposed for review. Until a PASS is recorded for the candidate commit, approval
   * and a tester PASS are refused ("CI required: not reported"), whether the gate then
   * runs, fails, or never reports (no gh, no GitHub remote). System/admin only;
   * idempotent (one requirement per ticket is enough, later calls record nothing new).
   */
  recordCiRequired(
    ticketRef: string,
    input: { detail?: string },
    actor: Actor,
  ): { required: true; eventId: string | null } {
    if (actor.type !== "system" && actor.type !== "admin") {
      throw new DispatchError(
        "ACTOR_NOT_PERMITTED",
        "Only the runner (system) or an admin may record that a ticket requires CI.",
        { actor_type: actor.type },
      );
    }
    const ticket = this.ticketSvc.resolveTicket(ticketRef);
    const already = this.db
      .prepare(
        `SELECT 1 FROM work_events
          WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = 'ticket.ci_required' LIMIT 1`,
      )
      .get(ticket.id);
    if (already) return { required: true, eventId: null };
    const detail = (input.detail ?? "").trim().slice(0, 2_000);
    const eventId = writeEvent(this.db, {
      entity_type: "ticket",
      entity_id: ticket.id,
      actor,
      event_type: "ticket.ci_required",
      payload: detail ? { detail } : {},
    });
    return { required: true, eventId };
  }

  /**
   * REQUIRED CI: every commit a CI result may be recorded for: each write repo's current
   * delivery head (git), each recorded per-repo delivery commit, and each review pin
   * (an approved revision). Lower-case full or abbreviated ids, deduplicated.
   */
  private ciCandidateCommits(ticket: Ticket): string[] {
    const out = new Set<string>();
    for (const h of this.resolveReviewedHeads(ticket)) if (h.sha) out.add(h.sha.toLowerCase());
    const rows = this.db
      .prepare(
        `SELECT commit_sha AS sha FROM ticket_repo_delivery
          WHERE ticket_id = ? AND commit_sha IS NOT NULL AND commit_sha <> ''
         UNION ALL
         SELECT substr(uri, ${REVIEW_PIN_PREFIX.length + 1}) AS sha FROM evidence
          WHERE ticket_id = ? AND evidence_type = 'commit' AND recorded_by_actor_type = 'system'
            AND uri LIKE '${REVIEW_PIN_PREFIX}%'`,
      )
      .all(ticket.id, ticket.id) as Array<{ sha: string }>;
    for (const r of rows) {
      const sha = String(r.sha).trim().toLowerCase();
      if (/^[0-9a-f]{7,64}$/.test(sha)) out.add(sha);
    }
    return [...out];
  }

  /**
   * The latest recorded CI state for `commit` (or, with no candidate commit known, the
   * latest result overall), and whether any CI result was ever recorded for the ticket.
   */
  ciStatus(
    ticketId: string,
    commit: string | null,
  ): { required: boolean; state: string | null; commit: string | null } {
    const rows = this.db
      .prepare(
        `SELECT json_extract(payload_json, '$.commit') AS commit_sha,
                json_extract(payload_json, '$.state')  AS state
           FROM work_events
          WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = 'ticket.ci_result'
          ORDER BY rowid DESC`,
      )
      .all(ticketId) as Array<{ commit_sha: string | null; state: string | null }>;
    // A recorded requirement (recordCiRequired) makes CI required before any result.
    const requiredMark =
      rows.length > 0 ||
      this.db
        .prepare(
          `SELECT 1 FROM work_events
            WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = 'ticket.ci_required' LIMIT 1`,
        )
        .get(ticketId) !== undefined;
    if (!requiredMark) return { required: false, state: null, commit };
    if (rows.length === 0) return { required: true, state: null, commit };
    const c = commit ? commit.toLowerCase() : null;
    const hit = c
      ? rows.find((r) => {
          const rc = String(r.commit_sha ?? "").toLowerCase();
          return rc !== "" && (c.startsWith(rc) || rc.startsWith(c));
        })
      : rows[0];
    return { required: true, state: hit?.state ?? null, commit: c ?? rows[0]?.commit_sha ?? null };
  }

  /**
   * REQUIRED CI: refuse (POLICY_DENIED) unless the candidate commit's CI passed. A
   * candidate that cannot be resolved has no result of its own, so it is held too (the
   * latest result overall may be another commit's PASS).
   */
  private assertCiPassed(ticket: Ticket, candidate: string | null): void {
    const ci = this.ciStatus(ticket.id, candidate);
    if (!ci.required || (candidate !== null && ci.state === "pass")) return;
    const at = ci.commit ? ` for ${String(ci.commit).slice(0, 12)}` : "";
    throw new DispatchError(
      "POLICY_DENIED",
      ci.state === "fail"
        ? `Required CI failed${at}; the ticket cannot advance to merge.`
        : ci.state === null
          ? `CI required: not reported${at}; approval waits for a passing CI result for the candidate commit.`
          : `Required CI has not passed${at} (${ci.state}); approval waits for a passing CI result for the candidate commit.`,
      { ci_state: ci.state, commit: ci.commit, reason: "ci_required" },
    );
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
    // REJECT PINS: the heads the reviewer sent back, read before the write lock is taken
    // (git never runs under it). Only a re-queue records them; abandoning has no next round.
    const pinHeads =
      to === "cancelled" ? [] : this.resolveReviewedHeads(this.ticketSvc.resolveTicket(ticketRef));
    const result = inTransaction(this.db, () => {
      const ticket = this.ticketSvc.resolveTicket(ticketRef);
      if (ticket.status !== "in_review" && ticket.status !== "ready_for_merge") {
        throw new DispatchError(
          "ILLEGAL_TRANSITION",
          "Only an in-review or merging ticket can be rejected.",
          { from: ticket.status, to },
        );
      }
      if (to === "cancelled") this.refuseCancelOfLanded(ticket);
      const resolvedReason = reason && reason.trim().length > 0 ? reason : "review_rejected";

      // PARTLY LANDED (cli-runner/F-02): a send-back of a ticket whose change already
      // reached a default branch is held for a person (blocked, reason code
      // partly_landed) instead of re-queued: re-queued, it read as ordinary rework while
      // half the change sat on main, and nothing then stopped it being cancelled.
      const landedRepos =
        to === "ready" || to === "refining" ? recordedLandingRepos(this.db, ticket.id) : [];
      const holdLanded = landedRepos.length > 0;
      const isRequeue = (to === "ready" || to === "refining") && !holdLanded;
      // Abandoning (cancelled) never increments the counter; re-queue does.
      const { nextAttempt, capReached } = isRequeue
        ? capRetry(ticket.attempt_count, this.maxAttempts)
        : { nextAttempt: ticket.attempt_count, capReached: false };
      const target: TicketStatus = capReached || holdLanded ? "blocked" : to;

      const result = this.transitions.transition({
        ticketId: ticket.id,
        actor,
        toStatus: target,
        reason: holdLanded
          ? `partly_landed:${resolvedReason}`
          : capReached
            ? `retry_cap_reached:${resolvedReason}`
            : resolvedReason,
        expectedFromStatus: ticket.status,
        ...(isRequeue
          ? {
              patch: { attempt_count: nextAttempt, ...reviewerPatch(ticket, actor).patch },
              reviewReject: true,
            }
          : reviewerPatch(ticket, actor)),
        ...(to === "cancelled" ? { wontDo: true } : {}),
        ...(capReached || holdLanded ? { park: true } : {}),
      });
      if (holdLanded) {
        const why = this.partlyLandedHold(ticket, landedRepos, to, resolvedReason, actor);
        parked = { attempt: ticket.attempt_count, requestedTarget: to, reason: why };
      }
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
      this.recordRejectPins(ticket, actor, pinHeads, nextAttempt);
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
          p.reason.startsWith("partly landed")
            ? p.reason
            : `retry cap reached (attempt ${p.attempt}/${this.maxAttempts}): ${p.reason}`,
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
      this.refuseCancelOfLanded(ticket);
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
   * PR LANDINGS (exploratory finding cli-wg/F-01): `record-landing --via pr|pr-stale` used
   * to record any approved commit as landed with nothing checked, and mark-merged then
   * closed the ticket while its branch sat unmerged. The rule now:
   *   - a PR must be on record for that repository (its ticket_repos / delivery pr_url, or
   *     the ticket's pr_url when it is the ticket's primary write repo): no PR, no PR
   *     landing (`no_pr_recorded`);
   *   - `pr` says the local default branch was fast-forwarded from the merged PR's base, so
   *     the local default must carry the approved change (an ancestor, or for a squash or
   *     rebase merge, merging the commit into it changes nothing): `not_on_default_branch`;
   *   - `pr-stale` says the local default could NOT be updated, so it is checked the same way
   *     against the remote-tracking refs of the default branch (or the local default) when
   *     the checkout has any; with none here, the recorded PR is the only evidence there is.
   */
  private assertPrLanding(
    ticket: Ticket,
    target: { repoId: string; repo: string },
    sha: string,
    via: "pr" | "pr-stale",
  ): void {
    const repoPr = this.db
      .prepare(
        `SELECT COALESCE(NULLIF(tr.pr_url, ''), NULLIF(d.pr_url, '')) AS pr
           FROM ticket_repos tr
           LEFT JOIN ticket_repo_delivery d ON d.ticket_id = tr.ticket_id AND d.repo_id = tr.repo_id
          WHERE tr.ticket_id = ? AND tr.repo_id = ?`,
      )
      .get(ticket.id, target.repoId) as { pr: string | null } | undefined;
    const primary = this.db
      .prepare(
        `SELECT repo_id FROM ticket_repos WHERE ticket_id = ?
          ORDER BY (access = 'write') DESC, (role = 'primary') DESC LIMIT 1`,
      )
      .get(ticket.id) as { repo_id: string } | undefined;
    const ticketPr = String(ticket.pr_url ?? "").trim();
    const pr =
      String(repoPr?.pr ?? "").trim() || (primary?.repo_id === target.repoId ? ticketPr : "");
    if (!pr) {
      throw new DispatchError(
        "STATE_CONFLICT",
        `#${ticket.number ?? "?"} has no pull request on record for ${target.repo}; a landing --via ${via} is recorded only for a PR the delivery opened. A local merge records --via local (checked against git).`,
        { reason: "no_pr_recorded", repo: target.repo, via },
      );
    }
    if (!this.changeOnRefsResolver) return;
    let carried: boolean | null;
    try {
      carried = this.changeOnRefsResolver(
        target.repoId,
        sha,
        via === "pr" ? ["default"] : ["remote-default", "default"],
      );
    } catch {
      carried = false;
    }
    // pr-stale with no remote-tracking ref here: the local default is known stale and
    // nothing local can show the merge; the PR record above is the evidence.
    if (carried === true) return;
    if (via === "pr-stale" && carried === null) return;
    throw new DispatchError(
      "STATE_CONFLICT",
      via === "pr"
        ? `${target.repo}'s default branch does not carry ${sha.slice(0, 12)}; a PR landing is recorded once the merged PR has been pulled into the local default branch (git shows the approved change there).`
        : `Neither ${target.repo}'s default branch nor its remote-tracking copy carries ${sha.slice(0, 12)}; fetch or pull the default branch, then record the landing again (--via pr once it is pulled).`,
      { reason: "not_on_default_branch", repo: target.repo, commit: sha, via, pr_url: pr },
    );
  }

  /**
   * PARTLY LANDED (exploratory finding cli-runner/F-02): a ticket whose change already
   * reached a default branch in at least one repository cannot be cancelled. Cancelling
   * read "won't do" while that repository's default branch carried the merge, and dropped
   * the ticket out of the human queue's *Partly merged* item. Every landing on record
   * counts (recordedLandingRepos), not only the current approval's: a send-back or a
   * reopen withdraws the approval but not the merge, so neither opens a way to cancel. A
   * reverted merge still has its landing on record; such a ticket ends as done.
   */
  private refuseCancelOfLanded(ticket: Ticket): void {
    // REVOCATION-SAFE LANDING: a landing that started on the current approval and that git
    // already shows on the default branch counts as well. Its record is written a moment
    // after git moves; a cancellation in that gap used to be accepted, the record was then
    // refused (the ticket was cancelled) and the merge read as a clean success.
    const landed = [
      ...new Set([
        ...recordedLandingRepos(this.db, ticket.id),
        ...this.landingsStarted(ticket.id)
          .filter((l) => l.landed)
          .map((l) => l.repo),
      ]),
    ].sort();
    if (landed.length === 0) return;
    const current = computeLandingStatus(this.db, ticket.id);
    const pending = current.repos
      .filter((r) => !r.landed && !landed.includes(r.repo))
      .map((r) => r.repo);
    const n = ticket.number ?? "<n>";
    throw new DispatchError(
      "PARTLY_LANDED",
      `#${ticket.number ?? "?"} already landed in ${landed.join(", ")}; a ticket whose change is on a default branch cannot be cancelled, it can only be finished. ` +
        (ticket.status === "ready_for_merge"
          ? pending.length > 0
            ? `Land the rest (gaffer merge ${n}: ${pending.join(", ")} still pending).`
            : `Finish it (gaffer merge ${n}).`
          : `Take it through review again and land the rest (gaffer merge ${n} once it is approved).`),
      { ticket_number: ticket.number, landed, pending },
    );
  }

  /**
   * The hold a send-back (reject, tester FAIL) of a partly landed ticket becomes: a
   * `ticket.blocked` park event with reason code `partly_landed` naming what landed, so
   * the human queue lists it as parked with that reason. Returns the reason text.
   */
  private partlyLandedHold(
    ticket: Ticket,
    landed: string[],
    requested: string,
    reason: string,
    actor: Actor,
  ): string {
    const why =
      `partly landed: ${landed.join(", ")} already merged on the default branch, so this ` +
      `send-back to ${requested} is held for a person instead of re-queued (${reason}). ` +
      `Rework and re-approve it from here (unblock), then land the rest; it cannot be cancelled.`;
    writeEvent(this.db, {
      entity_type: "ticket",
      entity_id: ticket.id,
      actor,
      event_type: "ticket.blocked",
      payload: {
        reason: why,
        reason_code: "partly_landed",
        landed,
        requested_target: requested,
      },
    });
    return why;
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

/** What routeToTester did for one ticket. */
export interface TesterRoute {
  ticketId: string;
  number: number | null;
  routed: boolean;
  why: string | null;
  head: string | null;
}

/** The refusal a person's approval of a commit the tester did not pass gets. */
function notTestedMessage(
  ticket: Ticket,
  c: TesterCoverage,
  split: { mode: string; at: string } | null = null,
): string {
  const n = ticket.number !== null ? `#${ticket.number}` : "This ticket";
  const head = c.head ? ` ${c.head.slice(0, 12)}` : "";
  const what =
    c.why === "other_commit"
      ? `the independent tester passed ${c.tested ? c.tested.slice(0, 12) : "another commit"}, but the branch is now at${head}`
      : c.why === "failed"
        ? "the independent tester's latest verdict is a FAIL"
        : c.why === "contract_changed"
          ? "the ticket's contract changed after the tester passed it"
          : `the independent tester has not passed this commit${head} yet`;
  // LANE-SETTING CONSISTENCY: the runner last routed under a lane that does not gate this
  // ticket, so it will not send it to the tester. Say so instead of promising a route.
  if (split) {
    return `${n} is not tested on this commit: ${what}. A person approves only the commit the tester passed, but the runner last routed with GAFFER_TESTING ${split.mode} (recorded ${split.at.slice(0, 16).replace("T", " ")} UTC), which does not send this ticket to the tester, while this dashboard's setting does. Set GAFFER_TESTING the same for the dashboard and the runner (Settings, with neither environment overriding it); the runner then sends it to the tester.`;
  }
  return `${n} is not tested on this commit: ${what}. A person approves only the commit the tester passed; the runner sends this one to the tester, and it returns to review after a PASS.`;
}
