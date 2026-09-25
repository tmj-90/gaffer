import type { Db } from "../db/connection.js";
import { inTransaction } from "../db/connection.js";
import {
  isActiveTicketRepoRelation,
  TICKET_REPO_DELIVERY_EVIDENCED_STATUSES,
  type Actor,
  type Ticket,
  type TicketStatus,
} from "../domain/types.js";
import { writeEvent } from "../events/eventWriter.js";
import {
  evaluatePolicy,
  type PolicyGate,
  type PolicyResult,
  type RepoDeliveryContext,
  type ScopeRepoContext,
} from "../policy/policy.js";
import { computeTicketDiff, type GitRunner } from "./diffService.js";
import { AcRepository } from "../repositories/acRepository.js";
import { ClaimRepository } from "../repositories/claimRepository.js";
import { DecisionRepository } from "../repositories/decisionRepository.js";
import { EvidenceRepository } from "../repositories/evidenceRepository.js";
import { PausedDeliveryRepository } from "../repositories/pausedDeliveryRepository.js";
import { RepoRepository } from "../repositories/repoRepository.js";
import { TicketRepoDeliveryRepository } from "../repositories/ticketRepoDeliveryRepository.js";
import { ScopeRepoRepository } from "../repositories/scopeRepoRepository.js";
import { TicketScopeNodeRepository } from "../repositories/ticketScopeNodeRepository.js";
import { TicketRepository } from "../repositories/ticketRepository.js";
import type { Clock } from "../util/clock.js";
import { DispatchError, notFound } from "../util/errors.js";

/** Allowed ticket transitions (from docs/04-state-machine-policies.md). */
const ALLOWED: ReadonlySet<string> = new Set([
  "draft->refining",
  "draft->ready",
  "refining->ready",
  "ready->claimed",
  // TRACK-2b (human + agent in parallel): a human takes a ready ticket "by hand".
  // It moves to `in_progress` OWNED BY THE HUMAN (marked via tickets.human_owner)
  // rather than being claimed by an agent — the agent selection loop structurally
  // skips human-owned tickets. Guarded by the `humanClaim` flag so a stray board
  // drag can never conjure it; only Dispatch.humanClaimTicket sets it.
  "ready->in_progress",
  "claimed->in_progress",
  "claimed->ready",
  "claimed->blocked",
  "in_progress->blocked",
  "in_progress->in_review",
  "in_progress->failed",
  // RUNNER-OWNED-BOOKKEEPING: the factory runner now holds the delivery claim and
  // is the authority that releases/parks it when a delivery fails or exhausts its
  // retries. On FAILURE it returns the ticket to `ready` (blind-requeue safe); on
  // PARK it routes to `refining` (needs triage, branch preserved). A resumed
  // delivery is `in_progress`, so both source states must be reachable. These are
  // guarded by the `runnerRelease` flag below so a stray board-drag can never use
  // them — only Dispatch.runnerRelease sets it.
  "claimed->refining",
  "in_progress->ready",
  "in_progress->refining",
  "blocked->ready",
  "blocked->refining",
  // Approve takes a delivery to `ready_for_merge` (NOT `done`): the human has
  // approved the diff and the merge runner now does the git merge. `done` is
  // reached only once the merge actually lands (ready_for_merge->done below), so
  // `done` can never mean "approved but the merge failed".
  "in_review->ready_for_merge",
  "in_review->ready",
  "in_review->refining",
  // BBT-001 independent testing lane. Review approval routes here instead of
  // straight to `ready_for_merge` when the global GAFFER_TESTING toggle is on AND
  // the ticket is `can_be_tested` (decided in approveReview). From `in_testing`:
  // the tester PASSED -> `ready_for_merge` (proceed to merge); the tester FAILED ->
  // `refining` (reuses the reject path, the failing test as evidence). Both are
  // guarded by the `testerVerdict` flag so only the tester paths can route here.
  "in_review->in_testing",
  "in_testing->ready_for_merge",
  "in_testing->refining",
  // Park a testing ticket whose retry budget is exhausted, mirroring the review
  // park; guarded by the `park` flag.
  "in_testing->blocked",
  // Abandon a testing ticket in one step (won't-do); guarded by the `wontDo` flag.
  "in_testing->cancelled",
  // MERGE-COMPLETE: the runner finished the git merge and marks the ticket merged.
  // GUARDED by `markMerged` (system/admin only, same pattern as won't-do) so a
  // user or a board-drag can never fake "merged".
  "ready_for_merge->done",
  // Conflict reopen: the auto-merge loop hit a CONFLICT; a resolver fixed the
  // branch and the ticket returns to review for a re-read of the resolved diff.
  // Reuses the guarded reopen-for-review path.
  "ready_for_merge->in_review",
  // Human changes their mind PRE-merge: send the approved-and-merging ticket back
  // for rework, or abandon it. Both reset ACs (the reject path does this). The
  // cancelled move is the guarded won't-do path.
  "ready_for_merge->refining",
  "ready_for_merge->cancelled",
  // Reject-for-rework lands in `refining` (a human triages the rejection reason
  // before it re-enters the delivery queue — no blind retry); `ready`/`refining`
  // stay above for backward compatibility.
  //
  // Won't-do (terminal "we will NOT build this") reuses the `cancelled` status as
  // its bucket. It is reachable from review (abandon a delivery in one step) and
  // from the non-in-flight live states below. It is a DELIBERATE, guarded move
  // (see `wontDo` flag) so it can never be conjured by a stray board-drag, and it
  // is REVERSIBLE via cancelled->refining / cancelled->draft.
  "in_review->cancelled",
  "blocked->cancelled",
  "failed->cancelled",
  // Re-open a merged-but-conflicted ticket for re-review (auto-merge loop). The
  // runner's merge helper hits a CONFLICT, a resolver agent fixes it on the
  // delivery branch, then calls back so a human re-reviews the RESOLVED diff. This
  // is a SYSTEM/admin-only reopen — guarded below by `reopenForReview`, so it can
  // never be conjured by an arbitrary user board-drag of a `done` card.
  "done->in_review",
  // P1 retry-cap park: a delivery rejected at review for the Nth time (N = max
  // attempts) is PARKED to `blocked` (needs-human) instead of being re-queued to
  // be re-delivered forever. Guarded by the `park` flag so only the reject path
  // can route here; a human unblocks via blocked->ready / blocked->refining.
  "in_review->blocked",
  "ready_for_merge->blocked",
  "ready->cancelled",
  "refining->cancelled",
  "draft->cancelled",
  "failed->ready",
  "failed->refining",
  // Reversible "un-ready" moves (human/admin board re-organisation). Sending a
  // ticket back to `draft` is always safe: neither `ready` nor `refining` holds
  // an active claim (claims only attach via ready->claimed), so this can never
  // touch in-flight work. The matching forward moves (draft->ready,
  // refining->ready) stay policy-gated; the reverse needs no gate.
  "ready->draft",
  "refining->draft",
  // Reopen a won't-do (cancelled) ticket. Abandoning a ticket is reversible: a
  // human can pull it back into the delivery pipeline at `refining` (triage first)
  // or all the way to `draft`. Neither target holds a claim, so reopening can
  // never resurrect stale in-flight work.
  "cancelled->refining",
  "cancelled->draft",
  // PAUSE-ON-CAP: an IN-FLIGHT delivery that hit the turn/budget cap is paused IN
  // PLACE (worktree kept alive). Reachable from the live delivery states only, and
  // guarded by `pauseDelivery` so a stray board-drag can never park a ticket as
  // paused. `claimed` is included because a delivery may cap before it announces
  // `in_progress`; `in_review` because the cap can land on a post-submit step.
  "in_progress->paused",
  "in_review->paused",
  "claimed->paused",
  // Resume: the human pressed Continue and the factory loop re-entered delivery in
  // the EXISTING worktree, so the ticket returns to `in_progress`. Guarded by
  // `resumeDelivery` so only the loop's resume entry point can route here.
  "paused->in_progress",
  // Stop: the human abandoned the paused delivery (tear down + cancel). Reuses the
  // guarded won't-do path (`wontDo`).
  "paused->cancelled",
  // Reversible un-pause WITHOUT resuming: a human triages a paused ticket back into
  // the queue at `refining`. Neither target holds a claim, so this is always safe —
  // no guard, mirroring cancelled->refining.
  "paused->refining",
]);

/**
 * TRACK-2b: the review lane — the statuses across which the durable
 * `human_delivered` marker stays meaningful once a hand delivery has been
 * submitted for review. The moment a ticket moves to any status OUTSIDE this set
 * it has re-entered the delivery pipeline (rework, hand-back, park, abandon …),
 * so the marker is cleared: whatever is delivered NEXT must earn the done-gate on
 * its own terms (a later agent redelivery is never exempted by a stale marker).
 */
const REVIEW_LANE_STATUSES: ReadonlySet<TicketStatus> = new Set<TicketStatus>([
  "in_review",
  "in_testing",
  "ready_for_merge",
  "done",
]);

/**
 * States a ticket enters when it leaves active delivery back to the queue, or is
 * parked/abandoned. Entering one RELEASES any active claim lease (see the release in
 * {@link TransitionService.transition}) so a stale lease can never strand it — the
 * claim candidate queries reject any ticket carrying an unexpired active claim, so a
 * ticket dragged `blocked -> ready` (or otherwise re-queued while still leased) would
 * otherwise be silently un-claimable until the TTL expired. Live-delivery states
 * (`claimed`/`in_progress`) and the review/`paused` lane deliberately KEEP their lease.
 */
const REQUEUE_STATES: ReadonlySet<TicketStatus> = new Set<TicketStatus>([
  "ready",
  "draft",
  "refining",
  "blocked",
  "cancelled",
]);

/** Which gated transitions trigger a policy evaluation. */
function gateFor(to: TicketStatus): PolicyGate | null {
  if (to === "ready") return "ready";
  if (to === "claimed") return "claim";
  // The done-gate (AC satisfied, PR/diff present, per-repo delivery) now fires at
  // APPROVE time: `in_review -> ready_for_merge`. This is the human sign-off, so
  // the policy must pass here. The later `ready_for_merge -> done` (merge-complete)
  // is a guarded system action with nothing left to evaluate.
  if (to === "ready_for_merge") return "done";
  return null;
}

export interface TransitionInput {
  ticketId: string;
  actor: Actor;
  toStatus: TicketStatus;
  reason?: string;
  /** If set, the transition fails unless the ticket is currently in this status. */
  expectedFromStatus?: TicketStatus;
  patch?: Partial<Pick<Ticket, "branch_name" | "pr_url" | "reviewer" | "attempt_count">>;
  correlationId?: string;
  /** Skip policy gating — used by system recovery (claim expiry). */
  systemOverride?: boolean;
  /**
   * Opt-in flag the `done -> in_review` reopen path MUST set. This transition is
   * only reachable through {@link Dispatch.reopenForReview} (a system/admin
   * auto-merge re-approval), never through an arbitrary user board move — without
   * this flag the transition is rejected as ILLEGAL_TRANSITION even though it's in
   * the ALLOWED set.
   */
  reopenForReview?: boolean;
  /**
   * Opt-in flag the merge-complete path (`ready_for_merge -> done`) MUST set. This
   * transition is only reachable through {@link Dispatch.markMerged} (the merge
   * runner confirming the git merge actually landed), never through an arbitrary
   * user board move — so a human/board-drag can't fake "merged". Without this flag
   * the transition is rejected as ILLEGAL_TRANSITION even though it's in the
   * ALLOWED set. Same guarded-flag pattern as {@link wontDo}.
   */
  markMerged?: boolean;
  /**
   * Opt-in flag the won't-do path (`* -> cancelled`) MUST set. Abandoning a ticket
   * is a deliberate, terminal decision — never something a stray board-drag onto a
   * "Won't do" column should trigger silently. Without this flag a transition into
   * `cancelled` is rejected as ILLEGAL_TRANSITION even though it's in the ALLOWED
   * set. The reverse (cancelled -> refining/draft) needs no flag — reopening is
   * always safe.
   */
  wontDo?: boolean;
  /**
   * Opt-in flag the retry-cap park path (`in_review|ready_for_merge -> blocked`)
   * MUST set. Parking a delivery that has exhausted its retry budget is a
   * deliberate move taken only by {@link Dispatch.rejectReview}; without this flag
   * a transition into `blocked` from review is rejected as ILLEGAL_TRANSITION even
   * though it's in the ALLOWED set, so a stray board-drag can't park a ticket.
   */
  park?: boolean;
  /**
   * BBT-001 opt-in flag the independent-testing paths MUST set. Routing INTO the
   * testing lane (`in_review -> in_testing`) and OUT of it on a tester verdict
   * (`in_testing -> ready_for_merge` on pass, `in_testing -> refining` on fail) is
   * only reachable through {@link Dispatch.routeToTesting} /
   * {@link Dispatch.testerPass} / {@link Dispatch.rejectReview}. Without this flag
   * those transitions are rejected as ILLEGAL_TRANSITION even though they are in the
   * ALLOWED set, so a stray board-drag can never push a ticket into or out of
   * testing. Same guarded-flag pattern as {@link wontDo} / {@link markMerged}.
   */
  testerVerdict?: boolean;
  /**
   * PAUSE-ON-CAP opt-in flag the pause path (`in_progress|in_review|claimed ->
   * paused`) MUST set. Pausing an in-flight delivery on a turn/budget cap is a
   * deliberate runner action taken only by {@link Dispatch.pauseDelivery}; without
   * this flag a transition into `paused` is rejected as ILLEGAL_TRANSITION even
   * though it is in the ALLOWED set, so a stray board-drag can never park a ticket
   * as paused (and orphan a live worktree).
   */
  pauseDelivery?: boolean;
  /**
   * PAUSE-ON-CAP opt-in flag the resume path (`paused -> in_progress`) MUST set.
   * Re-entering delivery in the existing worktree is reachable only through the
   * factory loop's resume entry point ({@link Dispatch.beginResume}); without this
   * flag the transition is rejected as ILLEGAL_TRANSITION so a board-drag cannot
   * fake a resume of paused work.
   */
  resumeDelivery?: boolean;
  /**
   * RUNNER-OWNED-BOOKKEEPING opt-in flag the runner-release/park paths
   * (`claimed->refining`, `in_progress->ready`, `in_progress->refining`) MUST set.
   * Releasing or parking a runner-held delivery claim is a deliberate factory
   * action taken only by {@link Dispatch.runnerRelease}; without this flag those
   * transitions are rejected as ILLEGAL_TRANSITION even though they are in the
   * ALLOWED set, so a stray board-drag can never re-route an in-flight delivery.
   * Same guarded-flag pattern as {@link wontDo} / {@link pauseDelivery}.
   */
  runnerRelease?: boolean;
  /**
   * TRACK-2b opt-in flag the human-claim path (`ready -> in_progress`) MUST set.
   * A human taking a ticket "by hand" is a deliberate action taken only by
   * {@link Dispatch.humanClaimTicket}; without this flag `ready -> in_progress` is
   * rejected as ILLEGAL_TRANSITION even though it is in the ALLOWED set, so a stray
   * board drag can never move a ready ticket straight into in-flight work.
   */
  humanClaim?: boolean;
  /**
   * TRACK-2b opt-in flag the human hand-back path (`in_progress -> ready`) MUST set
   * when the release is a HUMAN handing their by-hand ticket back (as opposed to the
   * runner releasing a delivery claim, which sets {@link runnerRelease}). Either flag
   * legalises `in_progress -> ready`; both are guarded so an ordinary board drag can
   * never re-route in-flight work. Set only by {@link Dispatch.humanReleaseTicket}.
   */
  humanRelease?: boolean;
  /**
   * GRADUATED-AUTONOMY (Spec 2, Phase 1) signal: on a review APPROVAL, whether the
   * delivery was approved UNCHANGED (`true`), edited before approval (`false`), or
   * indeterminate (`null` — SHAs unknown, so we never overstate agreement). Set ONLY
   * by {@link import("./reviewGateService.js").ReviewGateService.approveReview}; when
   * provided (including `null`) it is emitted on the `ticket.transitioned` payload as
   * `approved_unchanged` so the read-only recommendation service can compute an
   * honest per-repo/per-risk "approved unchanged" rate. Absent on every non-approve
   * transition, so their payload shape is byte-for-byte unchanged.
   */
  approvedUnchanged?: boolean | null;
  /**
   * CLAIM opt-in flag the agent-claim path (`ready -> claimed`) MUST set. A claim is
   * real only when a `ticket_claims` lease row backs it — {@link
   * import("./claimService.js").ClaimService} inserts that row THEN sets this flag.
   * Without it `ready -> claimed` is rejected as ILLEGAL_TRANSITION even though it is
   * in the ALLOWED set, so a raw board move can never CONJURE a claimed ticket with no
   * lease (a "ghost claim" the expiry sweeper can't see, stranding the ticket forever).
   * Same guarded-flag pattern as {@link wontDo}.
   */
  agentClaim?: boolean;
  /**
   * REVIEW-APPROVE opt-in flag the review-approval path (`in_review -> ready_for_merge`)
   * MUST set. Approving a delivery for merge is reachable ONLY through {@link
   * import("./reviewGateService.js").ReviewGateService.approveReview}, which routes a
   * testable ticket through the independent tester first (GAFFER_TESTING + can_be_tested)
   * and enforces the agent-approve authz check. Without this flag the raw board move
   * `in_review -> ready_for_merge` is rejected as ILLEGAL_TRANSITION even though it is in
   * the ALLOWED set, so a board drag can never approve-and-merge while skipping the tester
   * or the "an agent can never approve its own work" invariant.
   */
  reviewApprove?: boolean;
}

/**
 * GUARDED EDGES — the capability table behind {@link TransitionService.transition}.
 *
 * Every edge listed here is in {@link ALLOWED} but legal ONLY through the facade
 * path that sets one of its `anyOf` flags on the {@link TransitionInput}. The raw
 * board-move path sets none of them, so a stray drag can never fake a merge, park a
 * ticket, approve a review, claim without a lease, or re-route an in-flight
 * delivery. `edges` are exact `from->to` keys; `to:<status>` matches that
 * destination from ANY source.
 *
 * Adding a guarded edge is one row here — not another if-block — and the messages
 * are part of the API surface (tests and the dashboard's error toasts read them).
 */
export interface GuardedEdge {
  readonly edges: readonly string[];
  /** Input flags ANY of which legalises the edge — the facade paths that may take it. */
  readonly anyOf: readonly (keyof TransitionInput)[];
  readonly message: string;
  /** Why the edge is guarded (kept next to the rule, not in a commit message). */
  readonly why: string;
}

export const GUARDED_EDGES: readonly GuardedEdge[] = [
  {
    edges: ["done->in_review", "ready_for_merge->in_review"],
    anyOf: ["reopenForReview"],
    message: "A ticket can only return to review via the reopen-for-review path.",
    why: "Auto-merge re-approval / conflict-reopen are deliberate system actions, never a card drag into in_review.",
  },
  {
    edges: ["ready_for_merge->done"],
    anyOf: ["markMerged"],
    message: "A ticket can only be marked merged via the mark-merged path.",
    why: "MERGE-COMPLETE only: a user or board-drag can never fake 'merged'.",
  },
  {
    edges: ["in_review->blocked", "ready_for_merge->blocked", "in_testing->blocked"],
    anyOf: ["park"],
    message: "A ticket can only be parked to blocked via the retry-cap reject path.",
    why: "Retry-cap park is reachable only once a delivery has exhausted its retry budget.",
  },
  {
    edges: ["in_review->in_testing", "in_testing->ready_for_merge", "in_testing->refining"],
    anyOf: ["testerVerdict"],
    message: "A ticket can only move into or out of testing via the testing-lane paths.",
    why: "BBT-001: into the lane on approval, out of it on a tester verdict — never a drag.",
  },
  {
    edges: ["to:paused"],
    anyOf: ["pauseDelivery"],
    message: "A ticket can only be paused via the pause-on-cap path.",
    why: "PAUSE-ON-CAP keeps a live worktree; only the runner's pause path may take it.",
  },
  {
    edges: ["paused->in_progress"],
    anyOf: ["resumeDelivery"],
    message: "A paused ticket can only resume delivery via the resume path.",
    why: "Only the loop's resume entry point may re-enter delivery.",
  },
  {
    edges: ["ready->in_progress"],
    anyOf: ["humanClaim"],
    message: "A ready ticket can only be taken by hand via the human-claim path.",
    why: "TRACK-2b: Dispatch.humanClaimTicket records who took it; a drag would push ready work straight into in-flight human-owned state.",
  },
  {
    edges: ["claimed->refining", "in_progress->refining"],
    anyOf: ["runnerRelease"],
    message: "An in-flight delivery can only be released/parked via the runner-release path.",
    why: "RUNNER-OWNED-BOOKKEEPING: releasing/parking a runner-held claim is the runner's call.",
  },
  {
    edges: ["in_progress->ready"],
    anyOf: ["runnerRelease", "humanRelease", "systemOverride"],
    message:
      "An in-flight delivery can only be released/parked to ready via the runner-release path (or human hand-back).",
    why: "Shared hand-back route: runner release, human hand-back, or system recovery (claim expiry / reclaim / admin revoke — without systemOverride the expiry sweep's single transaction would wedge on this ticket).",
  },
  {
    edges: ["to:cancelled"],
    anyOf: ["wontDo"],
    message: "A ticket can only be abandoned via the won't-do path.",
    why: "A deliberate terminal abandon; a drag onto a 'Won't do' column must not swallow a ticket.",
  },
  {
    edges: ["ready->claimed"],
    anyOf: ["agentClaim"],
    message: "A ticket can only be claimed via the claim path (which creates the lease).",
    why: "GHOST-CLAIM guard: `claimed` is real only when a ticket_claims lease row backs it; a ghost is stranded forever (the expiry sweeper scans active claims only).",
  },
  {
    edges: ["in_review->ready_for_merge"],
    anyOf: ["reviewApprove"],
    message: "A ticket can only be approved for merge via the review-approve path.",
    why: "ReviewGateService.approveReview routes testable tickets through the tester and enforces reviewer ≠ author; a drag would skip both.",
  },
];

/**
 * The first guarded-edge rule `key` violates given the flags on `input`, or null
 * when the edge is unguarded or a legalising flag is set. Pure; exported so the
 * table is unit-testable without standing up a ticket in every source state.
 */
export function violatedGuard(
  key: string,
  input: Pick<TransitionInput, "toStatus"> & Partial<TransitionInput>,
): GuardedEdge | null {
  const toKey = `to:${input.toStatus}`;
  for (const rule of GUARDED_EDGES) {
    if (!rule.edges.some((e) => e === key || e === toKey)) continue;
    if (rule.anyOf.some((flag) => Boolean(input[flag]))) continue;
    return rule;
  }
  return null;
}

export interface TransitionResult {
  ticket: Ticket;
  eventId: string;
  policy?: PolicyResult;
}

/**
 * Centralised ticket state transitions. Validates the transition is allowed,
 * evaluates the active policy pack for gated transitions, applies the change with
 * optimistic concurrency, and appends an event — all in one transaction.
 */
export class TransitionService {
  private readonly tickets: TicketRepository;
  private readonly acs: AcRepository;
  private readonly claims: ClaimRepository;
  private readonly repos: RepoRepository;
  private readonly decisions: DecisionRepository;
  private readonly evidence: EvidenceRepository;
  private readonly scopeRepos: ScopeRepoRepository;
  private readonly ticketScopes: TicketScopeNodeRepository;
  private readonly repoDeliveries: TicketRepoDeliveryRepository;

  /**
   * Git runner used to RECOMPUTE the real diff for the done-gate (P0). Injectable
   * so tests can drive the gate without a real repo on disk; defaults to the real
   * `git` spawn inside {@link computeTicketDiff}.
   */
  private readonly gitRunner: GitRunner | undefined;

  /**
   * Optional handle to the paused-delivery store. When present, any transition
   * OUT of `paused` that is NOT a resume (`paused->in_progress`) atomically deletes
   * the stale context row — including `paused->refining` (human board triage) and
   * `paused->cancelled` (stop, though PauseService.stop() also cleans up directly).
   * Injectable so callers that don't have the repo can omit it.
   */
  private readonly pausedDeliveries: PausedDeliveryRepository | undefined;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    gitRunner?: GitRunner,
    pausedDeliveries?: PausedDeliveryRepository,
  ) {
    this.gitRunner = gitRunner;
    this.pausedDeliveries = pausedDeliveries;
    this.tickets = new TicketRepository(db);
    this.acs = new AcRepository(db);
    this.claims = new ClaimRepository(db);
    this.repos = new RepoRepository(db);
    this.decisions = new DecisionRepository(db);
    this.evidence = new EvidenceRepository(db);
    this.scopeRepos = new ScopeRepoRepository(db);
    this.ticketScopes = new TicketScopeNodeRepository(db);
    this.repoDeliveries = new TicketRepoDeliveryRepository(db);
  }

  /** Evaluate (without mutating) whether a gated transition would pass policy. */
  preview(ticketId: string, to: TicketStatus): PolicyResult | null {
    const gate = gateFor(to);
    if (!gate) return null;
    const ticket = this.tickets.findById(ticketId);
    if (!ticket) throw notFound("ticket", ticketId);
    return this.evaluate(ticket, gate);
  }

  transition(input: TransitionInput): TransitionResult {
    return inTransaction(this.db, () => {
      const ticket = this.tickets.findById(input.ticketId);
      if (!ticket) throw notFound("ticket", input.ticketId);

      if (input.expectedFromStatus && ticket.status !== input.expectedFromStatus) {
        throw new DispatchError(
          "STATE_CONFLICT",
          `Expected ticket in '${input.expectedFromStatus}' but it is '${ticket.status}'.`,
          { expected: input.expectedFromStatus, actual: ticket.status },
        );
      }

      const key = `${ticket.status}->${input.toStatus}`;
      if (ticket.status === input.toStatus) {
        throw new DispatchError("NO_OP", `Ticket already '${input.toStatus}'.`);
      }
      if (!ALLOWED.has(key)) {
        throw new DispatchError("ILLEGAL_TRANSITION", `Transition not allowed: ${key}.`, {
          from: ticket.status,
          to: input.toStatus,
        });
      }

      // GUARDED EDGES: an edge in ALLOWED that is legal only through the facade path
      // that sets its flag. One declarative table + one check replaces the former
      // eleven near-identical if-blocks (see GUARDED_EDGES for each edge's rationale).
      const guard = violatedGuard(key, input);
      if (guard) {
        throw new DispatchError("ILLEGAL_TRANSITION", guard.message, {
          from: ticket.status,
          to: input.toStatus,
        });
      }

      const gate = gateFor(input.toStatus);
      let policy: PolicyResult | undefined;
      if (gate && !input.systemOverride) {
        policy = this.evaluate(ticket, gate);
        if (!policy.allowed) {
          throw new DispatchError(
            "POLICY_DENIED",
            `Policy '${ticket.policy_pack}' denied ${gate}.`,
            {
              policy,
            },
          );
        }
      }

      const now = this.clock.now();
      const ok = this.tickets.updateStatus(
        ticket.id,
        input.toStatus,
        ticket.row_version,
        input.patch ?? {},
        now,
      );
      if (!ok) {
        throw new DispatchError("CONCURRENCY_CONFLICT", "Ticket changed concurrently; retry.");
      }

      // CLAIM SAFETY-NET: a ticket returning to a queue/parked state must not keep an
      // active claim lease. The runner-release path releases explicitly, but a RAW BOARD
      // MOVE (a human dragging `blocked -> ready`) does not — and the claim candidate
      // queries reject any ticket with an unexpired active claim, so the ticket would be
      // silently un-claimable until its TTL expired. Release here so EVERY path into a
      // re-queue state clears the lease. Idempotent (no active claim → no rows changed).
      if (REQUEUE_STATES.has(input.toStatus)) {
        this.claims.releaseActiveForTicket(ticket.id, now);
      }

      // WG-049: entering `in_review` (re-)submits the work for a fresh read, so any
      // prior rejection feedback is now stale — clear it so it never masquerades as
      // current. Covers every route in (submit, reopen-for-review, conflict reopen).
      if (input.toStatus === "in_review") {
        this.tickets.setReviewFeedback(ticket.id, null);
      }

      // TRACK-2b: the human-owned marker only means "a human is working this IN
      // PLACE (in_progress)". The instant the ticket leaves in_progress — hand-back
      // to `ready`, submit to `in_review`, block, cancel, … — it is no longer the
      // human's in-flight work, so clear the marker centrally on EVERY exit route.
      // (The human-claim path stamps it AFTER its `ready -> in_progress` transition,
      // whose from-status is `ready` with no marker, so this never fights that.)
      if (ticket.human_owner !== null && input.toStatus !== "in_progress") {
        this.tickets.setHumanOwner(ticket.id, null);
        // A HUMAN-OWNED ticket submitting for review is a hand delivery: stamp the
        // DURABLE delivered-by-hand marker (it survives the human_owner clear
        // above) so the done-gate can exempt it from the server-recomputed-diff
        // requirement it structurally can never meet — no delivery branch/repo row
        // is ever recorded for by-hand work.
        if (input.toStatus === "in_review") {
          this.tickets.setHumanDelivered(ticket.id, ticket.human_owner);
        }
      }
      // The delivered-by-hand marker only describes the CURRENT review submission.
      // Any move that re-enters the delivery pipeline (rework to ready/refining,
      // park, abandon, a fresh claim …) invalidates it, so a later agent
      // redelivery is never exempted by a stale marker. (Setting + clearing can't
      // collide: the set above targets `in_review`, which is inside the lane.)
      if (ticket.human_delivered !== null && !REVIEW_LANE_STATUSES.has(input.toStatus)) {
        this.tickets.setHumanDelivered(ticket.id, null);
      }

      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor: input.actor,
        event_type: "ticket.transitioned",
        payload: {
          from: ticket.status,
          to: input.toStatus,
          reason: input.reason ?? null,
          patch: input.patch ?? null,
          // GRADUATED-AUTONOMY: only the approve path sets this key, so a non-approve
          // transition's payload stays byte-for-byte unchanged. `null` is meaningful
          // (approved, but unchanged/edited couldn't be determined).
          ...(input.approvedUnchanged !== undefined
            ? { approved_unchanged: input.approvedUnchanged }
            : {}),
        },
        ...(input.correlationId ? { correlation_id: input.correlationId } : {}),
      });

      // Exiting `paused` to any state other than `in_progress` (resume): the live
      // worktree is no longer tracked; drop the stale pause context atomically so
      // no reader sees ghost data.  The resume path keeps the context alive so a
      // re-cap upserts over it.  PauseService.stop() (paused->cancelled) also calls
      // delete directly; the double-delete is a no-op in SQLite.
      if (ticket.status === "paused" && input.toStatus !== "in_progress") {
        this.pausedDeliveries?.delete(ticket.id);
      }

      const updated = this.tickets.findById(ticket.id)!;
      return policy ? { ticket: updated, eventId, policy } : { ticket: updated, eventId };
    });
  }

  private evaluate(ticket: Ticket, gate: PolicyGate): PolicyResult {
    const ac = this.acs.listForTicket(ticket.id);
    return evaluatePolicy(ticket.policy_pack, gate, {
      ticket,
      acceptanceCriteria: ac,
      repoCount: this.repos.countForTicket(ticket.id),
      blockingDecisions: this.decisions.blockingForTicket(ticket.id),
      hasUnresolvedHumanRequired: this.decisions.hasUnresolvedHumanRequired(ticket.id),
      evidenceCountByAc: this.evidence.countByAc(ticket.id),
      hasPrOrDiff: this.hasRealDeliveryDiff(ticket),
      humanDelivered: ticket.human_delivered !== null,
      hasReviewer: ticket.reviewer !== null && ticket.reviewer !== "",
      humanApprovedReady: this.hasReadyApproval(ticket.id),
      scopeRepo: this.scopeRepoContext(ticket.id),
      repoDelivery: this.repoDeliveryContext(ticket.id),
    });
  }

  /**
   * P0 done-gate backing: the PR/diff requirement is satisfied ONLY by REAL git,
   * never by agent-authored input. It requires that {@link computeTicketDiff}
   * (real `git diff base...delivery-branch`) yields a NON-EMPTY diff for at least
   * one ACTIVE write repo, on the branch the factory actually recorded (per-repo
   * `ticket_repos.branch_name`/delivery row, or the ticket branch) — or, for a
   * bootstrap, a non-empty initial-commit diff.
   *
   * H1: `pr_url` is UNVALIDATED agent input (set via `record_delivery_artifact`),
   * so it MUST NOT short-circuit this gate. Previously any non-empty `pr_url`
   * returned true, letting a prompt-injected agent satisfy the "real diff" gate by
   * stuffing a bogus URL with no corresponding git change. `pr_url` is kept ONLY as
   * an evidence/navigation link on the ticket — never as diff proof. The server-side
   * git diff is the sole source of truth here.
   *
   * This also closes the older hole where any recorded `diff_summary` row (agent
   * prose) passed the gate with no correspondence to git. A `repo_not_on_disk` /
   * `no_branch` / `empty` / `git_error` repo contributes nothing — neither prose
   * nor an agent-supplied PR link ever qualifies.
   */
  private hasRealDeliveryDiff(ticket: Ticket): boolean {
    const diff = computeTicketDiff(
      {
        repos: this.repos,
        tickets: this.tickets,
        repoDeliveries: this.repoDeliveries,
        ...(this.gitRunner ? { runGit: this.gitRunner } : {}),
      },
      ticket.id,
    );
    // A repo qualifies only when git produced a real, non-empty diff (no
    // `unavailable` reason) on a resolved delivery branch.
    return diff.repos.some(
      (r) => r.unavailable === undefined && r.branch !== null && r.diff.trim() !== "",
    );
  }

  /**
   * Derive the per-repo delivery evidence the strict done-gate (WG-005) needs:
   * the names of ACTIVE write repos that have NO delivery evidence yet. A repo is
   * evidenced when its ticket_repo_delivery row exists AND either carries a
   * review_ready/done status or a recorded branch/PR. Looser packs ignore this,
   * so the list is only consulted for factory_strict / regulated `done`.
   */
  private repoDeliveryContext(ticketId: string): RepoDeliveryContext {
    const writeRepos = this.repos
      .accessLinksForTicket(ticketId)
      .filter((l) => isActiveTicketRepoRelation(l.relation) && l.access === "write");
    const evidenced = new Set<string>(TICKET_REPO_DELIVERY_EVIDENCED_STATUSES);
    const writeReposWithoutDelivery: string[] = [];
    for (const repo of writeRepos) {
      const delivery = this.repoDeliveries.find(ticketId, repo.id);
      const hasEvidence =
        delivery !== undefined &&
        (evidenced.has(delivery.status) ||
          delivery.branch_name !== null ||
          delivery.pr_url !== null);
      if (!hasEvidence) writeReposWithoutDelivery.push(repo.name);
    }
    return { writeReposWithoutDelivery };
  }

  /**
   * Derive the scope/repo confirmation state the readiness gate (WG-003) needs:
   * whether any repo is linked, how many active write repos exist, whether a
   * primary scope is set, whether mono_fallback applies, and how many suggested
   * repos remain unresolved.
   *
   * mono_fallback condition: exactly one ticket repo AND that repo has no
   * scope-graph mapping. A repo that is already promoted to
   * relation='implicit_single_repo' (source mono_fallback) still satisfies this,
   * so a strict ticket stays ready after fallback is applied.
   */
  private scopeRepoContext(ticketId: string): ScopeRepoContext {
    const links = this.repos.accessLinksForTicket(ticketId);
    const writeRepoCount = links.filter(
      (l) => isActiveTicketRepoRelation(l.relation) && l.access === "write",
    ).length;
    const unresolvedSuggestedRepoCount = links.filter((l) => l.relation === "suggested").length;
    const hasPrimaryScope = this.ticketScopes.findPrimary(ticketId) !== undefined;

    let monoFallbackApplies = false;
    if (links.length === 1) {
      const only = links[0]!;
      monoFallbackApplies = this.scopeRepos.scopesForRepo(only.id).length === 0;
    }

    return {
      hasAnyRepo: links.length > 0,
      writeRepoCount,
      hasPrimaryScope,
      monoFallbackApplies,
      unresolvedSuggestedRepoCount,
    };
  }

  /**
   * True once a human/admin has granted a persisted ready-approval for the
   * ticket — recorded as a `ticket.ready_approved` work-event. This gates the
   * `regulated` pack's readiness; without it a regulated ticket can never reach
   * `ready` (see policy.ts HUMAN_APPROVAL_REQUIRED).
   */
  private hasReadyApproval(ticketId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM work_events
         WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = 'ticket.ready_approved'
         LIMIT 1`,
      )
      .get(ticketId);
    return row !== undefined;
  }
}
