/**
 * The review and landing lifecycle as the facade composes it over ReviewGateService: board
 * moves, the tester's PASS, holds and required CI, send-backs (reject, Fix these, Won't do)
 * with the REVOCATION-SAFE LANDING report, and the human-gate pings those transitions fire.
 */
import { inTransaction } from "../db/connection.js";
import { type Actor, type ReopenForReviewCause } from "../domain/types.js";
import { writeEvent } from "../events/eventWriter.js";
import { recordedLandingRepos } from "./landingStatus.js";
import { fixTheseReason, type ReviewCommentView } from "./reviewCommentService.js";
import { rejectOutcome as decideRejectOutcome, type RejectOutcome } from "./rejectOutcome.js";
import { resolveMoveTarget } from "./boardService.js";
import { type LandingStarted } from "./reviewGateService.js";
import { type TransitionResult } from "./transitionService.js";
import { DispatchError } from "../util/errors.js";
import type { DispatchInternals } from "./dispatchInternals.js";
import type { Dispatch } from "../core.js";
import { emitGate } from "./gateNotifications.js";

/** What these functions read from the {@link Dispatch} facade they are handed. */
export type ReviewLifecycleHost = Pick<
  Dispatch,
  | "claimsRepo"
  | "clock"
  | "db"
  | "landingState"
  | "maxAttempts"
  | "rejectOutcome"
  | "rejectReview"
  | "repos"
  | "resolveTicket"
  | "reviewCommentSvc"
  | "reviewGateSvc"
  | "tickets"
  | "transitions"
>;
/** The facade's private state these functions read. */
export type ReviewLifecycleInternals = Pick<DispatchInternals, "notifier">;

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
export function moveTicket(
  host: ReviewLifecycleHost,
  ticketRef: string,
  target: string,
  actor: Actor,
): TransitionResult {
  const ticket = host.resolveTicket(ticketRef);
  const toStatus = resolveMoveTarget(target);
  // Dragging a reviewed ticket back for rework IS a rejection: take the reject path
  // (AC reset, attempt bump, feedback, retry-cap park) instead of a raw move that
  // kept the previous delivery's satisfied ACs for the next done gate.
  if (
    (ticket.status === "in_review" || ticket.status === "ready_for_merge") &&
    (toStatus === "ready" || toStatus === "refining")
  ) {
    // (Through this.rejectReview: a landing already started is reported on the trail.)
    return host.rejectReview(ticket.id, toStatus, actor, "board_move");
  }
  return inTransaction(host.db, () => {
    // Handing in unleased in-progress work (a by-hand delivery, a tokenless resume)
    // by a move stays legal; dragging work an agent still holds a lease on is not.
    const unleasedSubmit =
      ticket.status === "in_progress" &&
      toStatus === "in_review" &&
      !host.claimsRepo.hasActiveForTicket(ticket.id);
    return host.transitions.transition({
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

/** The approval a landing acts on (the latest transition into ready_for_merge). */
export function landingApproval(host: ReviewLifecycleHost, ref: string): string | null {
  return host.reviewGateSvc.approvalRef(host.resolveTicket(ref).id);
}

/** The landings already started or committed on the ticket's current approval. */
export function landingsStarted(host: ReviewLifecycleHost, ref: string): LandingStarted[] {
  return host.reviewGateSvc.landingsStarted(host.resolveTicket(ref).id);
}

/**
 * A revocation (reject, a failed required check) acknowledged AFTER a landing started
 * cannot undo it: say so on the ticket's trail and hand the landings back to the caller,
 * which reports them ("a landing has already happened").
 */
export function revocationAfterLanding(
  host: Pick<ReviewLifecycleHost, "db" | "reviewGateSvc">,
  ticketId: string,
  actor: Actor,
  revocation: string,
): LandingStarted[] {
  const landed = host.reviewGateSvc.landingsStarted(ticketId);
  if (landed.length > 0) {
    writeEvent(host.db, {
      entity_type: "ticket",
      entity_id: ticketId,
      actor,
      event_type: "ticket.revoked_after_landing",
      payload: { revocation, landings: landed },
    });
  }
  return landed;
}

export function testerPass(
  host: ReviewLifecycleHost,
  internals: ReviewLifecycleInternals,
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
  },
  actor: Actor,
): TransitionResult {
  const result = host.reviewGateSvc.testerPass(ticketRef, input, actor);
  // TESTER FIRST: the PASS returned the ticket to review: now a person is needed.
  if (result.ticket.status === "in_review") {
    emitGate(host, internals, "review_needed", result.ticket, {
      detail: "the independent tester passed it",
    });
  }
  return result;
}

/**
 * HOLD FOR A HUMAN (`ready_for_merge | in_testing -> blocked`, reason-coded). The
 * runner's merge gate (the combined code failed on the target) and a late red CI
 * result use it; the ticket waits in the human queue with the reason. System/admin.
 */
export function holdForHuman(
  host: ReviewLifecycleHost,
  internals: ReviewLifecycleInternals,
  ref: string,
  input: { reasonCode: string; reason: string },
  actor: Actor,
): TransitionResult {
  const result = host.reviewGateSvc.holdForHuman(ref, input, actor);
  emitGate(host, internals, "ticket_parked", result.ticket, {
    status: "blocked",
    detail: input.reason,
  });
  return result;
}

/** REQUIRED CI: record a CI result for a ticket's candidate commit (system/admin). */
export function recordCiResult(
  host: ReviewLifecycleHost,
  internals: ReviewLifecycleInternals,
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
  const res = host.reviewGateSvc.recordCiResult(ref, input, actor);
  const ticket = host.tickets.resolveRef(ref);
  if (res.held) {
    emitGate(host, internals, "ticket_parked", ticket, {
      status: "blocked",
      detail: `required CI failed for ${input.commit.slice(0, 12)}`,
    });
  }
  // REVOCATION-SAFE LANDING: a red result after a landing started cannot stop it.
  const landedAlready =
    input.state === "fail" && ticket
      ? revocationAfterLanding(host, ticket.id, actor, `ci_failed:${input.commit.slice(0, 12)}`)
      : [];
  return { ...res, landedAlready };
}

/** REQUIRED CI: the latest CI state for a ticket's commit (null commit = latest overall). */
export function ciStatus(
  host: ReviewLifecycleHost,
  ref: string,
  commit: string | null = null,
): { required: boolean; state: string | null; commit: string | null } {
  const ticket = host.resolveTicket(ref);
  return host.reviewGateSvc.ciStatus(ticket.id, commit);
}

/**
 * Back to review (`done | ready_for_merge -> in_review`), system/admin only. `cause`
 * says why; without one it is the ticket's hold when a fresh review is what clears it
 * (`moved_since_review`, `unpinned_repo`), else `merge_conflict` (the resolver's
 * reopen, the call this path was built for).
 */
export function reopenForReview(
  host: ReviewLifecycleHost,
  ref: string,
  input: { reason: string; resolution: string; cause?: ReopenForReviewCause },
  actor: Actor,
): { ticketId: string; status: string; eventId: string } {
  let cause = input.cause;
  if (cause === undefined) {
    const ls = host.landingState(ref);
    cause =
      ls && ls.kind === "held" && (ls.hold === "moved_since_review" || ls.hold === "unpinned_repo")
        ? ls.hold
        : "merge_conflict";
  }
  return host.reviewGateSvc.reopenForReview(ref, { ...input, cause }, actor);
}

export function rejectReview(
  host: ReviewLifecycleHost,
  ticketRef: string,
  to: "ready" | "refining" | "cancelled",
  actor: Actor,
  reason?: string,
): TransitionResult & { landedAlready: LandingStarted[] } {
  const res = host.reviewGateSvc.rejectReview(ticketRef, to, actor, reason);
  // REVOCATION-SAFE LANDING: a landing that started before this rejection committed is
  // not undone by it; report it (the merge runner refuses every landing not yet started).
  const landedAlready = revocationAfterLanding(host, res.ticket.id, actor, `rejected_to_${to}`);
  return { ...res, landedAlready };
}

/**
 * A ticket's review comments, oldest first; `anchors` adds the git-derived anchor state
 * against each repo's head now ("anchor changed in this revision" / "anchor untouched").
 */
export function listReviewComments(
  host: ReviewLifecycleHost,
  ref: string,
  opts: { open?: boolean; anchors?: boolean } = {},
): ReviewCommentView[] {
  if (opts.anchors) return host.reviewCommentSvc.listWithAnchors(ref, { open: opts.open });
  const ticket = host.resolveTicket(ref);
  return host.reviewCommentSvc.listViews(ticket.id, { open: opts.open });
}

/**
 * What a "Fix these" send-back would do now (see rejectOutcome.ts): the destination, the
 * cap and the partly-landed hold read from the same facts rejectReview acts on.
 */
export function rejectOutcome(
  host: ReviewLifecycleHost,
  ref: string,
  to: "refining" | "ready" = "refining",
  requirements?: number,
): RejectOutcome {
  const ticket = host.resolveTicket(ref);
  return decideRejectOutcome({
    ticketNumber: ticket.number,
    to,
    attemptCount: ticket.attempt_count,
    maxAttempts: host.maxAttempts,
    landedRepos: recordedLandingRepos(host.db, ticket.id),
    requirements: requirements ?? host.reviewCommentSvc.counts(ticket.id).open_must_fix,
  });
}

/**
 * FIX THESE (A2): send the ticket back with its open must-fix comments (or the named
 * subset) as numbered requirements. A human/admin act. The transition reason is the
 * deterministic "Fix these: N requirements (ids)"; the comments are stamped with the
 * round they were sent into, and the next delivery's prompt lists them. Everything
 * rejectReview does still applies: the AC reset, the retry cap, the partly-landed hold,
 * the reject pins. The destination stays Refining unless `to: "ready"` is asked for.
 */
export function fixThese(
  host: ReviewLifecycleHost,
  ref: string,
  opts: { commentIds?: readonly string[]; to?: "refining" | "ready" },
  actor: Actor,
): TransitionResult & {
  landedAlready: LandingStarted[];
  requirements: ReviewCommentView[];
  rejectOutcome: RejectOutcome;
} {
  if (actor.type !== "human" && actor.type !== "admin") {
    throw new DispatchError(
      "ACTOR_NOT_PERMITTED",
      `Fix these is a reviewer's act: only a human or an admin may send a change back with review comments (this actor is ${actor.type}).`,
      { actor_type: actor.type, reason: "reviewer_only" },
    );
  }
  const ticket = host.resolveTicket(ref);
  const to = opts.to ?? "refining";
  const set = host.reviewCommentSvc.fixSet(ticket.id, opts.commentIds);
  if (set.length === 0) {
    throw new DispatchError(
      "VALIDATION_ERROR",
      `#${ticket.number ?? "?"} has no open must-fix review comment to send back. Write one, or use Send back with a reason.`,
      { reason: "no_requirements" },
    );
  }
  const predicted = host.rejectOutcome(ticket.id, to, set.length);
  const res = host.rejectReview(ticket.id, to, actor, fixTheseReason(set));
  host.reviewCommentSvc.markSent(
    set.map((c) => c.id),
    res.ticket.attempt_count,
  );
  const ids = new Set(set.map((c) => c.id));
  const requirements = host.reviewCommentSvc.listViews(ticket.id).filter((c) => ids.has(c.id));
  // Settled: what the send-back actually did (the predicted kind unless the status says
  // otherwise, e.g. a landing recorded between the read and the write).
  const status = res.ticket.status;
  const settled: RejectOutcome =
    status === predicted.to_status
      ? predicted
      : status === "blocked"
        ? decideRejectOutcome({
            ticketNumber: ticket.number,
            to,
            attemptCount: ticket.attempt_count,
            maxAttempts: host.maxAttempts,
            landedRepos: recordedLandingRepos(host.db, ticket.id),
            requirements: set.length,
          })
        : { ...predicted, to_status: status === "ready" ? "ready" : "refining" };
  return { ...res, requirements, rejectOutcome: settled };
}

export function wontDo(
  host: ReviewLifecycleHost,
  ref: string,
  actor: Actor,
  reason?: string,
): TransitionResult & { landedAlready: LandingStarted[] } {
  const res = host.reviewGateSvc.wontDo(ref, actor, reason);
  // REVOCATION-SAFE LANDING: the dashboard's Won't do is a cancellation too; a landing
  // that had already started is reported exactly as a rejection reports it.
  const landedAlready = revocationAfterLanding(host, res.ticket.id, actor, "wont_do");
  return { ...res, landedAlready };
}
