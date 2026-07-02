import type { Db } from "../db/connection.js";
import type { AcStatus } from "../domain/types.js";

/**
 * One covering-AC row: an acceptance criterion whose `spec_clause_id` references a
 * clause, joined to the ticket it belongs to. The read model assembles these into
 * per-clause coverage; the ticket join is what lets the trace show ticket status
 * beside each AC.
 */
export interface CoveringAcRow {
  clause_id: string;
  ac_id: string;
  ac_text: string;
  ac_status: AcStatus;
  sort_order: number;
  ticket_id: string;
  ticket_number: number | null;
  ticket_title: string;
  ticket_status: string;
}

/** One per-clause bounce aggregate: rework attempts on the clause's ACs' tickets. */
export interface ClauseBounceRow {
  clause_id: string;
  bounce_count: number;
  /** How many DISTINCT gates those tickets bounced off (a spread signal). */
  distinct_gates: number;
  /** Most recent attempt across the clause's tickets, or null when none. */
  last_attempt_at: string | null;
}

/**
 * TRACEABILITY: data access for the Phase-3 spec-coverage read model. Clauses live
 * as JSON on the `specs` row (not a normalized table), so this repository does the
 * heavy joins/aggregation SQL-side — keyed by a caller-supplied list of clause ids
 * — and the service assembles the result against the parsed clause list. A clause
 * with NO covering AC therefore returns NO rows here, which is exactly how it
 * surfaces as an orphan (the gap report) rather than being miscounted as covered.
 *
 * The bounce aggregate mirrors {@link ReworkAttemptRepository.bouncing}'s rigor:
 * one grouped statement over the append-only `rework_attempts` trail, joined to the
 * clause via a DISTINCT (clause, ticket) CTE so a ticket that covers a clause is
 * counted once and each rework attempt exactly once.
 */
export class SpecCoverageRepository {
  constructor(private readonly db: Db) {}

  /**
   * Every AC that covers one of `clauseIds`, with its ticket, ordered so a clause's
   * ACs read ticket-number-then-sort-order. Empty in ⇒ empty out (no query run).
   */
  coveringAcs(clauseIds: readonly string[]): CoveringAcRow[] {
    if (clauseIds.length === 0) return [];
    const placeholders = clauseIds.map(() => "?").join(", ");
    return this.db
      .prepare(
        `SELECT ac.spec_clause_id AS clause_id,
                ac.id             AS ac_id,
                ac.text           AS ac_text,
                ac.status         AS ac_status,
                ac.sort_order     AS sort_order,
                t.id              AS ticket_id,
                t.number          AS ticket_number,
                t.title           AS ticket_title,
                t.status          AS ticket_status
           FROM acceptance_criteria ac
           JOIN tickets t ON t.id = ac.ticket_id
          WHERE ac.spec_clause_id IN (${placeholders})
          ORDER BY ac.spec_clause_id ASC, t.number ASC, ac.sort_order ASC, ac.id ASC`,
      )
      .all(...clauseIds) as CoveringAcRow[];
  }

  /**
   * Per-clause bounce counts: rework attempts on the tickets that cover each clause.
   * The `clause_tickets` CTE reduces to DISTINCT (clause, ticket) first so a ticket
   * bearing several ACs for the same clause is not double-joined; the outer join +
   * GROUP BY then counts each attempt once. Only clauses WITH at least one attempt
   * appear — the service defaults the rest to zero.
   */
  bounceCounts(clauseIds: readonly string[]): ClauseBounceRow[] {
    if (clauseIds.length === 0) return [];
    const placeholders = clauseIds.map(() => "?").join(", ");
    return this.db
      .prepare(
        `WITH clause_tickets AS (
           SELECT DISTINCT ac.spec_clause_id AS clause_id, ac.ticket_id AS ticket_id
             FROM acceptance_criteria ac
            WHERE ac.spec_clause_id IN (${placeholders})
         )
         SELECT ct.clause_id            AS clause_id,
                COUNT(ra.id)            AS bounce_count,
                COUNT(DISTINCT ra.gate) AS distinct_gates,
                MAX(ra.created_at)      AS last_attempt_at
           FROM clause_tickets ct
           JOIN rework_attempts ra ON ra.ticket_id = ct.ticket_id
          GROUP BY ct.clause_id`,
      )
      .all(...clauseIds) as ClauseBounceRow[];
  }
}
