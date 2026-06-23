import type { Db } from "../db/connection.js";
import type { Decision } from "../domain/types.js";

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
