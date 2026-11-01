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
  type ReviewFeedback,
  type Ticket,
  type TicketStatus,
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
  LANDING_PREFIX,
  type LandingStatus,
  REVIEW_PIN_PREFIX,
} from "./landingStatus.js";
import { isTestingEnabled, testerProvenance } from "../util/testingLane.js";
import { readBoundTesterPass, TESTER_REPLAY_PREFIX } from "./testerReplay.js";
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
  /** Per-instance override for the GAFFER_TESTING toggle (undefined = read env). */
  readonly testingEnabledOverride?: boolean | undefined;
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
  opts: { strict: boolean; currentHash: string | null; verdict: "pass" | "fail" },
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
  return out;
}

/**
 * PER-REPOSITORY LANDING: the `via` values whose landing happened upstream (a merged PR,
 * possibly squashed), so the local default branch cannot confirm it. Every other landing
 * is checked against git before it is recorded.
 */
const UNVERIFIABLE_LANDING_VIAS: ReadonlySet<string> = new Set(["pr", "pr-stale"]);

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
  private readonly testingEnabledOverride: boolean | undefined;
  private readonly agents: AgentRepository | undefined;
  private readonly requireRegisteredAgentApprover: boolean;
  private readonly onTicketParked:
    ((ticket: import("../domain/types.js").Ticket, detail: string) => void) | undefined;
  private readonly approvalShaResolver: ApprovalShaResolver | undefined;
  private readonly reviewedHeadsResolver: ReviewGateServiceDeps["reviewedHeadsResolver"];
  private readonly unavailableWriteReposResolver: ReviewGateServiceDeps["unavailableWriteReposResolver"];
  private readonly landedOnDefaultResolver: ReviewGateServiceDeps["landedOnDefaultResolver"];
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
    this.testingEnabledOverride = deps.testingEnabledOverride;
    this.agents = deps.agents;
    this.requireRegisteredAgentApprover = deps.requireRegisteredAgentApprover ?? false;
    this.onTicketParked = deps.onTicketParked;
    this.approvalShaResolver = deps.approvalShaResolver;
    this.reviewedHeadsResolver = deps.reviewedHeadsResolver;
    this.unavailableWriteReposResolver = deps.unavailableWriteReposResolver;
    this.landedOnDefaultResolver = deps.landedOnDefaultResolver;
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
      const author = this.deliveringAgentId(ticket.id);
      if (author !== null && actor.id !== undefined && actor.id === author) {
        throw new DispatchError(
          "ACTOR_NOT_PERMITTED",
          "An agent may not approve its own delivery: the approving actor id matches the agent that claimed and delivered this ticket. Approve as a distinct reviewer principal (or a human).",
          { actor_type: actor.type, actor_id: actor.id, delivering_agent_id: author },
        );
      }
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
    // BBT-001: when the testing lane is ON and this ticket is eligible, route
    // through the independent tester (`in_review -> in_testing`) instead of
    // straight to merge. testerVerdict:true guards this transition.
    // ACCEPTANCE GATE: an epic's acceptance ticket ALWAYS takes this route — the
    // GAFFER_TESTING toggle does not apply. Acceptance is a gate, not an option: the
    // only ways out of in_testing are a recorded tester verdict or a human's
    // tester-pass / tester-fail (auditable evidence), never a plain approve.
    if (this.approveRoutesToTesting(ticket)) {
      return inTransaction(this.db, () => {
        const result = this.transitions.transition({
          ticketId: ticket.id,
          actor,
          toStatus: "in_testing",
          reason: "review_approved_to_testing",
          expectedFromStatus: "in_review",
          testerVerdict: true,
          approvedUnchanged,
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
    return ticket.acceptance === 1 || (this.testingEnabled() && ticket.can_be_tested === 1);
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
    const ci = this.ciStatus(ticket.id, this.approveCiCandidate(ticket));
    if (!ci.required || ci.state === "pass") return null;
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
      if (ticket.status !== "ready_for_merge") {
        throw new DispatchError(
          "ILLEGAL_TRANSITION",
          "A landing can only be recorded for an approved ticket (ready_for_merge).",
          { status: ticket.status },
        );
      }
      const before = computeLandingStatus(this.db, ticket.id);
      const target = before.repos.find((r) => r.repoId === input.repo || r.repo === input.repo);
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
   * The independent black-box tester PASSED (`in_testing -> ready_for_merge`).
   * testerVerdict:true guards this transition.
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
    const deliveryDiff =
      pre.status === "in_testing" ? this.transitions.deliveryDiffProof(pre.id) : undefined;
    // REQUIRED CI's candidate: the tested commit, else the branch head — resolved (git)
    // here, outside the write transaction, and only when CI results exist at all.
    const ciCandidate =
      input.tested_commit ??
      (this.ciStatus(pre.id, null).required ? (this.ciCandidateHead(pre)?.sha ?? null) : null);
    return inTransaction(this.db, () => {
      const ticket = this.ticketSvc.resolveTicket(ticketRef);
      if (ticket.status !== "in_testing") {
        throw new DispatchError(
          "ILLEGAL_TRANSITION",
          "Only a ticket in testing can be passed by the tester.",
          { from: ticket.status, to: "ready_for_merge" },
        );
      }
      const binding = validatedBinding(input, {
        strict: ticket.acceptance === 1 && testerProvenance(actor) !== "human",
        currentHash: contractHash(this.db, ticket.id),
        verdict: "pass",
      });
      // REQUIRED CI: the tester's PASS is the other way into ready_for_merge.
      this.assertCiPassed(ticket, ciCandidate);
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
        }),
        created_by: actor.id ?? actor.type,
        recorded_by_actor_type: actor.type,
        created_at: now,
      });
      const result = this.transitions.transition({
        ticketId: ticket.id,
        actor,
        toStatus: "ready_for_merge",
        reason: "tester_passed",
        expectedFromStatus: "in_testing",
        testerVerdict: true,
        ...(deliveryDiff ? { deliveryDiff } : {}),
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

      const { nextAttempt, capReached } = capRetry(ticket.attempt_count, this.maxAttempts);
      const target: TicketStatus = capReached ? "blocked" : failTo;
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
      for (const r of landing.repos.filter((x) => !x.landed && x.pinned)) {
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
              ? `${r.repo} (${r.sha.slice(0, 12)})`
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
          merge_conflict_resolved: true,
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
    if (rows.length === 0) return { required: false, state: null, commit };
    const c = commit ? commit.toLowerCase() : null;
    const hit = c
      ? rows.find((r) => {
          const rc = String(r.commit_sha ?? "").toLowerCase();
          return rc !== "" && (c.startsWith(rc) || rc.startsWith(c));
        })
      : rows[0];
    return { required: true, state: hit?.state ?? null, commit: c ?? rows[0]?.commit_sha ?? null };
  }

  /** REQUIRED CI: refuse (POLICY_DENIED) unless the candidate commit's CI passed. */
  private assertCiPassed(ticket: Ticket, candidate: string | null): void {
    const ci = this.ciStatus(ticket.id, candidate);
    if (!ci.required || ci.state === "pass") return;
    const at = ci.commit ? ` for ${String(ci.commit).slice(0, 12)}` : "";
    throw new DispatchError(
      "POLICY_DENIED",
      ci.state === "fail"
        ? `Required CI failed${at}; the ticket cannot advance to merge.`
        : `Required CI has not passed${at} (${ci.state ?? "no result for this commit"}); approval waits for a passing CI result for the candidate commit.`,
      { ci_state: ci.state, commit: ci.commit },
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

      const isRequeue = to === "ready" || to === "refining";
      // Abandoning (cancelled) never increments the counter; re-queue does.
      const { nextAttempt, capReached } = isRequeue
        ? capRetry(ticket.attempt_count, this.maxAttempts)
        : { nextAttempt: ticket.attempt_count, capReached: false };
      const target: TicketStatus = capReached ? "blocked" : to;

      const result = this.transitions.transition({
        ticketId: ticket.id,
        actor,
        toStatus: target,
        reason: capReached ? `retry_cap_reached:${resolvedReason}` : resolvedReason,
        expectedFromStatus: ticket.status,
        ...(isRequeue ? { patch: { attempt_count: nextAttempt }, reviewReject: true } : {}),
        ...(to === "cancelled" ? { wontDo: true } : {}),
        ...(capReached ? { park: true } : {}),
      });
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
          `retry cap reached (attempt ${p.attempt}/${this.maxAttempts}): ${p.reason}`,
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
   * PARTLY LANDED (exploratory finding cli-runner/F-02): a ticket whose approved change
   * already reached a default branch in at least one repository cannot be cancelled.
   * Cancelling read "won't do" while that repository's default branch carried the merge,
   * and dropped the ticket out of the human queue's *Partly merged* item. Land the rest
   * (`gaffer merge <n>`), or revert the landed merge first.
   */
  private refuseCancelOfLanded(ticket: Ticket): void {
    const landing = computeLandingStatus(this.db, ticket.id);
    const landed = landing.repos.filter((r) => r.landed).map((r) => r.repo);
    if (landed.length === 0) return;
    const pending = landing.repos.filter((r) => !r.landed).map((r) => r.repo);
    throw new DispatchError(
      "PARTLY_LANDED",
      `#${ticket.number ?? "?"} already landed in ${landed.join(", ")}; a ticket whose change is on a default branch cannot be cancelled. ` +
        (pending.length > 0
          ? `Land the rest (gaffer merge ${ticket.number ?? "<n>"}: ${pending.join(", ")} still pending), or revert the landed merge first.`
          : `Finish it (gaffer merge ${ticket.number ?? "<n>"}), or revert the landed merge first.`),
      { ticket_number: ticket.number, landed, pending },
    );
  }

  /**
   * BBT-001 toggle accessor — overridable per-instance for tests. Defaults to the
   * `GAFFER_TESTING` env read via `isTestingEnabled`.
   */
  private testingEnabled(): boolean {
    return this.testingEnabledOverride ?? isTestingEnabled();
  }
}
