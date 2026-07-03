import type { Db } from "../db/connection.js";
import type { AcceptanceCriterion, AcStatus } from "../domain/types.js";

/** Data access for acceptance criteria. */
export class AcRepository {
  constructor(private readonly db: Db) {}

  insert(ac: AcceptanceCriterion): void {
    this.db
      .prepare(
        `INSERT INTO acceptance_criteria
          (id, ticket_id, text, sort_order, status, verification_method, evidence_required,
           verified_by, verified_at, spec_clause_id, created_at, updated_at)
         VALUES
          (@id, @ticket_id, @text, @sort_order, @status, @verification_method, @evidence_required,
           @verified_by, @verified_at, @spec_clause_id, @created_at, @updated_at)`,
      )
      .run(ac);
  }

  nextSortOrder(ticketId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(sort_order), -1) AS n FROM acceptance_criteria WHERE ticket_id = ?`,
      )
      .get(ticketId) as { n: number };
    return row.n + 1;
  }

  findById(id: string): AcceptanceCriterion | undefined {
    return this.db.prepare(`SELECT * FROM acceptance_criteria WHERE id = ?`).get(id) as
      | AcceptanceCriterion
      | undefined;
  }

  listForTicket(ticketId: string): AcceptanceCriterion[] {
    return this.db
      .prepare(`SELECT * FROM acceptance_criteria WHERE ticket_id = ? ORDER BY sort_order ASC`)
      .all(ticketId) as AcceptanceCriterion[];
  }

  setStatus(id: string, status: AcStatus, verifiedBy: string | null, nowIso: string): void {
    this.db
      .prepare(
        `UPDATE acceptance_criteria
         SET status = @status, verified_by = @verified_by,
             verified_at = CASE WHEN @status = 'satisfied' THEN @now ELSE verified_at END,
             updated_at = @now
         WHERE id = @id`,
      )
      .run({ id, status, verified_by: verifiedBy, now: nowIso });
  }

  /**
   * Reset every acceptance criterion on a ticket back to `pending`, clearing the
   * verifier/verification stamp. Used when a delivery is rejected at review: the
   * ACs the (now-rejected) delivery marked satisfied are stale and misleading, so
   * the ticket must show 0/N satisfied again. Returns the number of rows reset.
   */
  resetForTicket(ticketId: string, nowIso: string): number {
    const info = this.db
      .prepare(
        `UPDATE acceptance_criteria
         SET status = 'pending', verified_by = NULL, verified_at = NULL, updated_at = @now
         WHERE ticket_id = @ticket_id`,
      )
      .run({ ticket_id: ticketId, now: nowIso });
    return info.changes;
  }
}
