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
  type Ticket,
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
import { DispatchError } from "../util/errors.js";
import { type LandingStatus } from "./landingStatus.js";
import { isTestingEnabled, testerProvenance } from "../util/testingLane.js";
import { type TesterTestIdentity } from "./testerReplay.js";
import type { ReviewGateInternals } from "./reviewGate/internals.js";
import { reviewerPatch } from "./reviewGate/shared.js";
import { notTestedMessage } from "./reviewGate/tester.js";

// The method bodies, by concern (services/reviewGate/).
import * as staleness from "./reviewGate/staleness.js";
import * as ci from "./reviewGate/ci.js";
import * as landing from "./reviewGate/landing.js";
import * as sendBack from "./reviewGate/sendBack.js";
import * as tester from "./reviewGate/tester.js";
import * as testerVerdict from "./reviewGate/testerVerdict.js";

// Re-export so consumers don't need to reach into core directly.
export { isTestingEnabled, testerProvenance };
export { capRetry } from "./reviewGate/shared.js";

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
export { approvalUnchanged } from "./reviewGate/staleness.js";

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
    const covered = this.internals.ticketSvc.resolveTicket(ticketRef);
    const unavailable = this.unavailableWriteRepos(covered);
    if (agentApproveAllowed) {
      this.assertWriteReposAvailable(covered, unavailable);
      this.enforceObservedRiskCeiling(ticketRef, actor);
    }
    const ticket = this.internals.ticketSvc.resolveTicket(ticketRef);
    // REQUIRED CI (server-side, like the other holds): when the runner has recorded CI
    // results for this ticket (GAFFER_REQUIRE_CI), approval needs a PASS for the
    // CANDIDATE commit — the head being approved. A CLI approve used to go through while
    // the CI poll was still open, and the late red result could no longer stop it.
    ci.assertCiPassed(this, ticket, ci.approveCiCandidate(this, this.internals, ticket));
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
        this.internals.requireRegisteredAgentApprover &&
        (actor.id === undefined ||
          !this.internals.agents ||
          !this.internals.agents.findById(actor.id))
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
    const approvedUnchanged = staleness.computeApprovedUnchanged(this.internals, ticket);
    // REVIEW PIN + STALE REVISION (external review #2). The heads are resolved before the
    // transition (git runs outside the write lock). When the approver names the commits
    // they saw, every write repo's head must still BE that commit — a branch that moved
    // between the render and the click is refused (409 stale_revision), never approved.
    // The pins recorded below are the commits the approver saw, one per repo, written in
    // the SAME transaction as the transition. Without named commits (library callers) a
    // HUMAN approval pins the current heads, as before; an agent approval without commits
    // is pinned by the runner (lib/review.sh) only.
    const heads = staleness.resolveReviewedHeads(this.internals, ticket);
    const pins = staleness.checkShownCommits(ticket, heads, actor, opts, unavailable);
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
      const runner = tester.runnerLaneSafe(this.internals, ticket);
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
      return inTransaction(this.internals.db, () => {
        const result = this.internals.transitions.transition({
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
        writeEvent(this.internals.db, {
          entity_type: "ticket",
          entity_id: ticket.id,
          actor,
          event_type: "ticket.routed_to_testing",
          payload: { from: "in_review", ...(ticket.acceptance === 1 ? { acceptance: true } : {}) },
        });
        staleness.recordApprovalPins(this.internals, ticket, actor, pins);
        return result;
      });
    }
    // The done gate's git runs HERE, before transition() takes the write lock.
    const deliveryDiff = this.internals.transitions.deliveryDiffProof(ticket.id);
    return inTransaction(this.internals.db, () => {
      const result = this.internals.transitions.transition({
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
      staleness.recordApprovalPins(this.internals, ticket, actor, pins);
      return result;
    });
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

  testerRoutePlan(
    ticket: Ticket,
  ):
    | { route: true; why: null; coverage: TesterCoverage }
    | { route: false; why: string; coverage: TesterCoverage | null } {
    return tester.testerRoutePlan(this, this.internals, ticket);
  }

  routeAllToTester(actor: Actor): TesterRoute[] {
    return tester.routeAllToTester(this, this.internals, actor);
  }

  approveCiHold(ticket: Ticket): { state: string | null; commit: string | null } | null {
    return ci.approveCiHold(this, this.internals, ticket);
  }

  /**
   * APPROVAL COVERS EVERY WRITE REPO: the write repos whose delivery head cannot be read
   * now (the same read the Review button's outcome names). A resolver throw is read as
   * "unknown", and an unknown cannot be approved either: it fails toward the human.
   */
  unavailableWriteRepos(ticket: Ticket): readonly UnavailableWriteRepo[] {
    if (!this.internals.unavailableWriteReposResolver) return [];
    try {
      return this.internals.unavailableWriteReposResolver(ticket);
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

  /**
   * The agent id on the ticket's MOST RECENT claim (active or released) — the principal
   * that delivered the work now under review. `null` when the ticket was never claimed
   * (e.g. a human-driven delivery), in which case the reviewer≠author rule is inert.
   */
  private deliveringAgentId(ticketId: string): string | null {
    const row = this.internals.db
      .prepare(
        "SELECT agent_id FROM ticket_claims WHERE ticket_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(ticketId) as { agent_id: string } | undefined;
    return row?.agent_id ?? null;
  }

  /**
   * GRADUATED-AUTONOMY (Spec 2, Phase 3): does an explicit mode='auto' approve policy
   * cover this ticket (its risk × ALL its write repos)? Pure policy check — NO env
   * read (the P0 gate ORs this with the env flag). FAIL-CLOSED: an absent predicate,
   * an unresolvable ticket, or ANY throw yields false, so a policy-probe failure can
   * never grant an approval it shouldn't.
   */
  private policyGrantsAgentApprove(ticketRef: string): boolean {
    if (!this.internals.policyAllowsAgentApprove) return false;
    try {
      const ticket = this.internals.ticketSvc.resolveTicket(ticketRef);
      return this.internals.policyAllowsAgentApprove(ticket);
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
    if (!this.internals.observedRiskResolver) return;
    const ticket = this.internals.ticketSvc.resolveTicket(ticketRef);
    let observed: ObservedRisk | null;
    try {
      observed = this.internals.observedRiskResolver(ticket);
    } catch {
      observed = null; // a probe failure must fail toward a human, never silently ship.
    }
    // A missing observation is indeterminate ⇒ escalate (hold for a human).
    const escalate = !observed || shouldEscalate(observed, ticket.risk_level);
    if (!escalate) return;
    const observedLevel = observed?.level ?? "unknown";
    const reasons = observed?.reasons.length ? observed.reasons : ["diff unavailable to observe"];
    // Record the reason on the EXISTING append-only event log (no new mutation surface).
    writeEvent(this.internals.db, {
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

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------
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
