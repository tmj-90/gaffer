import type { Db } from "../db/connection.js";
import type { PausedDelivery, PauseReason } from "../domain/types.js";

/**
 * The fields a pause records as the durable resume context (PAUSE-ON-CAP). The
 * upsert preserves the original `created_at`; a re-pause (e.g. a resumed delivery
 * that capped again) refreshes the rest and resets `resume_requested` to 0.
 */
export interface PauseContext {
  reason: PauseReason;
  branch_name: string | null;
  worktree_path: string | null;
  worktrees_json: string | null;
  repo: string | null;
  attempt: number;
  turns: number | null;
  spend: string | null;
}

/**
 * Data access for the `paused_deliveries` table (PAUSE-ON-CAP). No business rules
 * here — the service layer owns the ticket-status transitions; this only persists
 * and reads the resume context that must survive a runner restart.
 */
export class PausedDeliveryRepository {
  constructor(private readonly db: Db) {}

  /**
   * Insert-or-replace the resume context for a ticket, keeping the original
   * `created_at` on a re-pause and clearing `resume_requested` (a fresh pause is
   * never already resume-requested). Run inside the caller's transaction.
   */
  upsert(ticketId: string, ctx: PauseContext, nowIso: string): void {
    this.db
      .prepare(
        `INSERT INTO paused_deliveries
           (ticket_id, reason, branch_name, worktree_path, worktrees_json, repo,
            attempt, turns, spend, resume_requested, created_at, updated_at)
         VALUES
           (@ticket_id, @reason, @branch_name, @worktree_path, @worktrees_json, @repo,
            @attempt, @turns, @spend, 0, @now, @now)
         ON CONFLICT(ticket_id) DO UPDATE SET
            reason = excluded.reason,
            branch_name = excluded.branch_name,
            worktree_path = excluded.worktree_path,
            worktrees_json = excluded.worktrees_json,
            repo = excluded.repo,
            attempt = excluded.attempt,
            turns = excluded.turns,
            spend = excluded.spend,
            resume_requested = 0,
            updated_at = excluded.updated_at`,
      )
      .run({
        ticket_id: ticketId,
        reason: ctx.reason,
        branch_name: ctx.branch_name,
        worktree_path: ctx.worktree_path,
        worktrees_json: ctx.worktrees_json,
        repo: ctx.repo,
        attempt: ctx.attempt,
        turns: ctx.turns,
        spend: ctx.spend,
        now: nowIso,
      });
  }

  find(ticketId: string): PausedDelivery | undefined {
    return this.db.prepare(`SELECT * FROM paused_deliveries WHERE ticket_id = ?`).get(ticketId) as
      | PausedDelivery
      | undefined;
  }

  /** Mark a paused ticket resume-requested (the human pressed Continue). */
  setResumeRequested(ticketId: string, value: boolean, nowIso: string): void {
    this.db
      .prepare(
        `UPDATE paused_deliveries SET resume_requested = @v, updated_at = @now
         WHERE ticket_id = @id`,
      )
      .run({ id: ticketId, v: value ? 1 : 0, now: nowIso });
  }

  /**
   * All paused tickets a human has asked to continue (oldest first), so the
   * factory loop resumes them deterministically.
   */
  listResumeRequested(): PausedDelivery[] {
    return this.db
      .prepare(`SELECT * FROM paused_deliveries WHERE resume_requested = 1 ORDER BY created_at ASC`)
      .all() as PausedDelivery[];
  }

  /** Remove the resume context (on resume-completion or Stop/abandon). */
  delete(ticketId: string): void {
    this.db.prepare(`DELETE FROM paused_deliveries WHERE ticket_id = ?`).run(ticketId);
  }
}
