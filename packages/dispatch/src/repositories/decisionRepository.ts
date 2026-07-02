import type { Db } from "../db/connection.js";
import type { Decision, TicketStatus } from "../domain/types.js";

/**
 * A pending decision joined to the ticket it concerns (when it blocks/informs
 * one). The decision is a genuine unmade decision the agent delegated to a
 * human; the joined ticket columns are null for a decision raised with no
 * ticket link. Powers the human-queue read model.
 */
export interface PendingDecisionWithTicket extends Decision {
  ticket_id: string | null;
  ticket_number: number | null;
  ticket_title: string | null;
  ticket_status: TicketStatus | null;
}

/** Data access for decisions and their ticket links. */
export class DecisionRepository {
  constructor(private readonly db: Db) {}

  insert(decision: Decision): void {
    this.db
      .prepare(
        `INSERT INTO decisions
          (id, title, question, rationale, status, decision_type, severity, proposed_answer,
           proposed_by, confidence, resolved_answer, resolved_by, resolved_at,
           memory_record_id, created_at, updated_at)
         VALUES
          (@id, @title, @question, @rationale, @status, @decision_type, @severity, @proposed_answer,
           @proposed_by, @confidence, @resolved_answer, @resolved_by, @resolved_at,
           @memory_record_id, @created_at, @updated_at)`,
      )
      .run(decision);
  }

  findById(id: string): Decision | undefined {
    return this.db.prepare(`SELECT * FROM decisions WHERE id = ?`).get(id) as Decision | undefined;
  }

  /**
   * Resolve a decision to a terminal status, stamping the resolved_* columns.
   * Returns true when a row was updated. The caller is responsible for guarding
   * against re-resolving an already-terminal decision.
   */
  resolve(
    id: string,
    status: "accepted" | "rejected",
    resolvedAnswer: string | null,
    rationale: string | null,
    resolvedBy: string | null,
    nowIso: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE decisions
         SET status = @status,
             resolved_answer = @resolved_answer,
             rationale = COALESCE(@rationale, rationale),
             resolved_by = @resolved_by,
             resolved_at = @now,
             updated_at = @now
         WHERE id = @id`,
      )
      .run({
        id,
        status,
        resolved_answer: resolvedAnswer,
        rationale,
        resolved_by: resolvedBy,
        now: nowIso,
      });
    return result.changes === 1;
  }

  link(ticketId: string, decisionId: string, relation: string, nowIso: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO ticket_decisions (ticket_id, decision_id, relation, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(ticketId, decisionId, relation, nowIso);
  }

  listPending(): Decision[] {
    return this.db
      .prepare(
        `SELECT * FROM decisions
         WHERE status IN ('requested','agent_proposed','human_required')
         ORDER BY created_at ASC`,
      )
      .all() as Decision[];
  }

  /**
   * Pending decisions (awaiting a human) LEFT-joined to the ticket each one
   * blocks/informs — oldest first. A decision may block multiple tickets or none;
   * we surface the first linked ticket (by link creation order) so the human queue
   * can point at a ticket without fanning a decision into N rows. The `question`
   * carried on each row is the REASON the agent needs a human.
   */
  listPendingWithTicket(): PendingDecisionWithTicket[] {
    return this.db
      .prepare(
        `SELECT d.*,
                t.id     AS ticket_id,
                t.number AS ticket_number,
                t.title  AS ticket_title,
                t.status AS ticket_status
         FROM decisions d
         LEFT JOIN (
           SELECT decision_id, MIN(rowid) AS first_link
           FROM ticket_decisions
           GROUP BY decision_id
         ) fl ON fl.decision_id = d.id
         LEFT JOIN ticket_decisions td ON td.rowid = fl.first_link
         LEFT JOIN tickets t ON t.id = td.ticket_id
         WHERE d.status IN ('requested','agent_proposed','human_required')
         ORDER BY d.created_at ASC`,
      )
      .all() as PendingDecisionWithTicket[];
  }

  /**
   * Open blocking decisions for a ticket — a `blocks` relation to a decision that
   * is not yet resolved. Used by claim/readiness policy.
   */
  blockingForTicket(ticketId: string): Decision[] {
    return this.db
      .prepare(
        `SELECT d.* FROM ticket_decisions td JOIN decisions d ON d.id = td.decision_id
         WHERE td.ticket_id = ? AND td.relation = 'blocks'
           AND d.status NOT IN ('accepted','rejected','superseded')`,
      )
      .all(ticketId) as Decision[];
  }

  hasUnresolvedHumanRequired(ticketId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM ticket_decisions td JOIN decisions d ON d.id = td.decision_id
         WHERE td.ticket_id = ? AND td.relation = 'blocks'
           AND d.severity = 'human_required'
           AND d.status NOT IN ('accepted','rejected','superseded')`,
      )
      .get(ticketId) as { n: number };
    return row.n > 0;
  }
}
