/**
 * Pause-on-cap service (PAUSE-ON-CAP).
 *
 * Replaces the old "bail to refining + tear down the worktree" behaviour for a
 * mid-delivery cap-hit with a RESUMABLE, one-click-continue model:
 *
 *   pause(...)        in-flight delivery hit the turn/budget cap -> `paused`. The
 *                     runner KEEPS the worktree + branch alive; this persists the
 *                     durable resume context and notifies the human gate.
 *   requestContinue() the human pressed Continue -> mark the paused row
 *                     `resume_requested=1`. The factory loop picks it up.
 *   beginResume()     the loop re-entered delivery in the EXISTING worktree ->
 *                     `paused -> in_progress` (guarded), clear resume_requested.
 *   stop(...)         the human abandoned it -> `paused -> cancelled` (guarded
 *                     won't-do), drop the resume context. The runner then reaps the
 *                     worktree (it no longer belongs to a paused ticket).
 *
 * SECURITY: the pause/resume transitions are guarded in TransitionService
 * (`pauseDelivery` / `resumeDelivery`), so a board-drag can never park a ticket as
 * paused (orphaning a live worktree) or fake a resume of someone else's work.
 */

import { type Db, inTransaction } from "../db/connection.js";
import { type Actor, type PauseReason, type Ticket } from "../domain/types.js";
import { writeEvent } from "../events/eventWriter.js";
import {
  PausedDeliveryRepository,
  type PauseContext,
} from "../repositories/pausedDeliveryRepository.js";
import { TicketRepository } from "../repositories/ticketRepository.js";
import type { TransitionResult, TransitionService } from "./transitionService.js";
import type { TicketService } from "./ticketService.js";
import type { Clock } from "../util/clock.js";
import { DispatchError } from "../util/errors.js";

/** In-flight statuses a delivery may be paused from. */
const PAUSABLE_FROM = new Set(["in_progress", "in_review", "claimed"]);

export interface PauseServiceDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly tickets: TicketRepository;
  readonly paused: PausedDeliveryRepository;
  readonly transitions: TransitionService;
  readonly ticketSvc: TicketService;
  /**
   * Called after a delivery is paused, with a human-readable detail (cap reason +
   * spend). Best-effort — errors are swallowed so notifications never break callers.
   */
  readonly onTicketPaused?: (ticket: Ticket, detail: string) => void;
}

/** The resume-context payload a pause records (sans the reason, passed separately). */
export interface PauseInput {
  reason: PauseReason;
  branch_name?: string | null;
  worktree_path?: string | null;
  worktrees_json?: string | null;
  repo?: string | null;
  attempt?: number;
  turns?: number | null;
  spend?: string | null;
}

export class PauseService {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly tickets: TicketRepository;
  private readonly paused: PausedDeliveryRepository;
  private readonly transitions: TransitionService;
  private readonly ticketSvc: TicketService;
  private readonly onTicketPaused: ((ticket: Ticket, detail: string) => void) | undefined;

  constructor(deps: PauseServiceDeps) {
    this.db = deps.db;
    this.clock = deps.clock;
    this.tickets = deps.tickets;
    this.paused = deps.paused;
    this.transitions = deps.transitions;
    this.ticketSvc = deps.ticketSvc;
    this.onTicketPaused = deps.onTicketPaused;
  }

  /**
   * Pause an in-flight delivery that hit a cap. Transitions the ticket to `paused`
   * (guarded) and persists/refreshes the durable resume context, all in one
   * transaction, then notifies the human gate best-effort AFTER the commit.
   */
  pauseDelivery(ticketRef: string, input: PauseInput, actor: Actor): TransitionResult {
    let detail = "";
    const result = inTransaction(this.db, () => {
      const ticket = this.ticketSvc.resolveTicket(ticketRef);
      if (!PAUSABLE_FROM.has(ticket.status)) {
        throw new DispatchError(
          "ILLEGAL_TRANSITION",
          `Only an in-flight delivery can be paused (status was '${ticket.status}').`,
          { from: ticket.status, to: "paused" },
        );
      }
      const res = this.transitions.transition({
        ticketId: ticket.id,
        actor,
        toStatus: "paused",
        reason: `paused_${input.reason}`,
        expectedFromStatus: ticket.status,
        pauseDelivery: true,
      });
      const ctx: PauseContext = {
        reason: input.reason,
        branch_name: input.branch_name ?? null,
        worktree_path: input.worktree_path ?? null,
        worktrees_json: input.worktrees_json ?? null,
        repo: input.repo ?? null,
        attempt: input.attempt ?? 0,
        turns: input.turns ?? null,
        spend: input.spend ?? null,
      };
      this.paused.upsert(ticket.id, ctx, this.clock.now());
      writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.paused",
        payload: {
          reason: input.reason,
          branch_name: ctx.branch_name,
          worktree_path: ctx.worktree_path,
          attempt: ctx.attempt,
          turns: ctx.turns,
          spend: ctx.spend,
        },
      });
      detail =
        input.reason === "budget_cap"
          ? `paused: budget cap reached mid-delivery (spend ${ctx.spend ?? "unknown"}); worktree preserved`
          : `paused: hit the turn cap mid-delivery (turns ${ctx.turns ?? "unknown"}, spend ${ctx.spend ?? "unknown"}); worktree preserved`;
      return res;
    });
    try {
      this.onTicketPaused?.(result.ticket, detail);
    } catch {
      // Notifications are never allowed to break the caller.
    }
    return result;
  }

  /**
   * The human pressed Continue: mark the paused ticket resume-requested so the
   * factory loop re-enters delivery. Idempotent — re-requesting is a no-op flip.
   */
  requestContinue(ticketRef: string, actor: Actor): { ticketId: string; eventId: string } {
    return inTransaction(this.db, () => {
      const ticket = this.ticketSvc.resolveTicket(ticketRef);
      if (ticket.status !== "paused") {
        throw new DispatchError(
          "ILLEGAL_TRANSITION",
          `Only a paused ticket can be continued (status was '${ticket.status}').`,
          { from: ticket.status },
        );
      }
      if (this.paused.find(ticket.id) === undefined) {
        throw new DispatchError(
          "NOT_FOUND",
          "No paused-delivery resume context found for this ticket.",
          { ticket_id: ticket.id },
        );
      }
      this.paused.setResumeRequested(ticket.id, true, this.clock.now());
      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.resume_requested",
        payload: {},
      });
      return { ticketId: ticket.id, eventId };
    });
  }

  /**
   * The factory loop re-entered delivery in the existing worktree: `paused ->
   * in_progress` (guarded), clearing resume_requested. Returns the resume context
   * the runner needs (worktree path, branch, attempt) so it re-invokes the agent in
   * place. The resume context row is KEPT (so a re-pause upserts over it and a crash
   * mid-resume leaves the context intact); it is dropped on stop or by the runner
   * once the resumed delivery finally leaves `paused`/`in_progress`.
   */
  beginResume(
    ticketRef: string,
    actor: Actor,
  ): {
    ticketId: string;
    eventId: string;
    context: import("../domain/types.js").PausedDelivery;
  } {
    return inTransaction(this.db, () => {
      const ticket = this.ticketSvc.resolveTicket(ticketRef);
      if (ticket.status !== "paused") {
        throw new DispatchError(
          "ILLEGAL_TRANSITION",
          `Only a paused ticket can resume delivery (status was '${ticket.status}').`,
          { from: ticket.status, to: "in_progress" },
        );
      }
      const context = this.paused.find(ticket.id);
      if (context === undefined) {
        throw new DispatchError(
          "NOT_FOUND",
          "No paused-delivery resume context found for this ticket.",
          { ticket_id: ticket.id },
        );
      }
      this.transitions.transition({
        ticketId: ticket.id,
        actor,
        toStatus: "in_progress",
        reason: "resume_delivery",
        expectedFromStatus: "paused",
        resumeDelivery: true,
      });
      this.paused.setResumeRequested(ticket.id, false, this.clock.now());
      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.resumed",
        payload: { branch_name: context.branch_name, attempt: context.attempt },
      });
      return { ticketId: ticket.id, eventId, context };
    });
  }

  /**
   * Stop/abandon a paused delivery: `paused -> cancelled` (guarded won't-do), reset
   * its ACs, and drop the resume context. The runner's worktree cleanup then reaps
   * the worktree on the next pass (it no longer belongs to a paused ticket).
   */
  stop(ticketRef: string, actor: Actor, reason?: string): TransitionResult {
    return inTransaction(this.db, () => {
      const ticket = this.ticketSvc.resolveTicket(ticketRef);
      if (ticket.status !== "paused") {
        throw new DispatchError(
          "ILLEGAL_TRANSITION",
          `Only a paused ticket can be stopped (status was '${ticket.status}').`,
          { from: ticket.status, to: "cancelled" },
        );
      }
      const res = this.transitions.transition({
        ticketId: ticket.id,
        actor,
        toStatus: "cancelled",
        reason: reason && reason.trim().length > 0 ? reason : "paused_delivery_stopped",
        expectedFromStatus: "paused",
        wontDo: true,
      });
      this.ticketSvc.resetAcceptanceCriteria(ticket.id, actor);
      this.paused.delete(ticket.id);
      writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.paused_stopped",
        payload: { reason: reason ?? null },
      });
      return res;
    });
  }

  /** Read the resume context for a paused ticket (or null). */
  getContext(ticketRef: string): import("../domain/types.js").PausedDelivery | null {
    const ticket = this.ticketSvc.resolveTicket(ticketRef);
    return this.paused.find(ticket.id) ?? null;
  }

  /** All tickets a human has asked to continue (oldest first). */
  listResumeRequested(): import("../domain/types.js").PausedDelivery[] {
    return this.paused.listResumeRequested();
  }

  /** Drop a resume context (runner calls this once a resumed delivery completes). */
  clearContext(ticketRef: string): void {
    const ticket = this.ticketSvc.resolveTicket(ticketRef);
    this.paused.delete(ticket.id);
  }
}
