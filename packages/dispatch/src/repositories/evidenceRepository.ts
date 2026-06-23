import type { Db } from "../db/connection.js";
import type { Evidence } from "../domain/types.js";

/** Data access for evidence rows. */
export class EvidenceRepository {
  constructor(private readonly db: Db) {}

  insert(evidence: Evidence): void {
    this.db
      .prepare(
        `INSERT INTO evidence
          (id, ticket_id, ac_id, repo_id, decision_id, evidence_type, summary, uri, payload_json, created_by, created_at)
         VALUES
          (@id, @ticket_id, @ac_id, @repo_id, @decision_id, @evidence_type, @summary, @uri, @payload_json, @created_by, @created_at)`,
      )
      .run(evidence);
  }

  listForTicket(ticketId: string): Evidence[] {
    return this.db
      .prepare(`SELECT * FROM evidence WHERE ticket_id = ? ORDER BY created_at ASC`)
      .all(ticketId) as Evidence[];
  }

  /** Map of ac_id -> evidence count for a ticket (only rows linked to an AC). */
  countByAc(ticketId: string): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT ac_id, COUNT(*) AS n FROM evidence WHERE ticket_id = ? AND ac_id IS NOT NULL GROUP BY ac_id`,
      )
      .all(ticketId) as Array<{ ac_id: string; n: number }>;
    return new Map(rows.map((r) => [r.ac_id, r.n]));
  }

  /**
   * @deprecated DO NOT use for the done-gate. An agent-authored `diff_summary`
   * evidence row is NOT proof of a real change — it passed the gate with no
   * correspondence to git (red-team P0). The done-gate now recomputes the REAL
   * `git diff` via {@link TransitionService.hasRealDeliveryDiff}. Retained only
   * for non-gating informational reads.
   */
  hasPrOrDiff(ticketId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM evidence WHERE ticket_id = ? AND evidence_type IN ('pull_request','diff_summary')`,
      )
      .get(ticketId) as { n: number };
    return row.n > 0;
  }
}
