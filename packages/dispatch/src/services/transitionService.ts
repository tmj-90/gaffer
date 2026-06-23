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
import { DecisionRepository } from "../repositories/decisionRepository.js";
import { EvidenceRepository } from "../repositories/evidenceRepository.js";
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
  "claimed->in_progress",
  "claimed->ready",
  "claimed->blocked",
  "in_progress->blocked",
  "in_progress->in_review",
  "in_progress->failed",
  "blocked->ready",
  "blocked->refining",
  // Approve takes a delivery to `ready_for_merge` (NOT `done`): the human has
  // approved the diff and the merge runner now does the git merge. `done` is
  // reached only once the merge actually lands (ready_for_merge->done below), so
  // `done` can never mean "approved but the merge failed".
  "in_review->ready_for_merge",
  "in_review->ready",
  "in_review->refining",
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

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    gitRunner?: GitRunner,
  ) {
    this.gitRunner = gitRunner;
    this.tickets = new TicketRepository(db);
    this.acs = new AcRepository(db);
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

      // `done -> in_review` and `ready_for_merge -> in_review` are the auto-merge
      // re-approval/conflict-reopen paths only. Reject them on any other route
      // (e.g. a user dragging a card to the in_review column) so re-opening stays a
      // deliberate system action.
      if (
        (key === "done->in_review" || key === "ready_for_merge->in_review") &&
        !input.reopenForReview
      ) {
        throw new DispatchError(
          "ILLEGAL_TRANSITION",
          "A ticket can only return to review via the reopen-for-review path.",
          { from: ticket.status, to: input.toStatus },
        );
      }

      // `ready_for_merge -> done` is the MERGE-COMPLETE path only. Reject it on any
      // route that did not opt in via the mark-merged path so a user/board-drag can
      // never fake "merged" (the board-move path never sets this flag).
      if (key === "ready_for_merge->done" && !input.markMerged) {
        throw new DispatchError(
          "ILLEGAL_TRANSITION",
          "A ticket can only be marked merged via the mark-merged path.",
          { from: ticket.status, to: input.toStatus },
        );
      }

      // Retry-cap park (`in_review|ready_for_merge -> blocked`) is reachable only
      // through the reject path once a delivery has exhausted its retry budget.
      // Reject it on any route that did not opt in via the `park` flag so a stray
      // board-drag onto a "Blocked" column can never park a ticket.
      if ((key === "in_review->blocked" || key === "ready_for_merge->blocked") && !input.park) {
        throw new DispatchError(
          "ILLEGAL_TRANSITION",
          "A ticket can only be parked to blocked via the retry-cap reject path.",
          { from: ticket.status, to: input.toStatus },
        );
      }

      // Won't-do (`* -> cancelled`) is a deliberate terminal abandon. Reject it on
      // any route that did not opt in via the won't-do path so a stray board-drag
      // onto a "Won't do" column can never silently swallow a ticket.
      if (input.toStatus === "cancelled" && !input.wontDo) {
        throw new DispatchError(
          "ILLEGAL_TRANSITION",
          "A ticket can only be abandoned via the won't-do path.",
          { from: ticket.status, to: input.toStatus },
        );
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

      // WG-049: entering `in_review` (re-)submits the work for a fresh read, so any
      // prior rejection feedback is now stale — clear it so it never masquerades as
      // current. Covers every route in (submit, reopen-for-review, conflict reopen).
      if (input.toStatus === "in_review") {
        this.tickets.setReviewFeedback(ticket.id, null);
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
        },
        ...(input.correlationId ? { correlation_id: input.correlationId } : {}),
      });

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
