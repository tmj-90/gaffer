import type { Db } from "../db/connection.js";
import type { BouncingTicket, ReworkAttempt } from "../domain/types.js";

/** Fields needed to append one attempt to a ticket's failure trail. */
export interface ReworkAttemptInput {
  id: string;
  ticket_id: string;
  attempt: number;
  max_attempts: number | null;
  gate: string | null;
  distilled_failure: string;
  ac_id: string | null;
  created_at: string;
}

/** Options for {@link ReworkAttemptRepository.bouncing}. */
export interface BouncingOptions {
  /** Minimum rework count for a ticket to count as "bouncing" (default 2). */
  minReworks?: number;
  /** Cap on rows returned (default 20). */
  limit?: number;
}

/** Default rework-count floor before a ticket surfaces as "bouncing". */
export const DEFAULT_MIN_REWORKS = 2;
/** Default cap on the bouncing list. */
const DEFAULT_BOUNCING_LIMIT = 20;

/** Row shape returned by the bouncing query (gate breakdown included). */
interface BouncingRow {
  ticket_id: string;
  number: number | null;
  title: string;
  status: string;
  rework_count: number;
  distinct_gates: number;
  last_attempt_at: string;
  top_gate: string | null;
  top_gate_count: number;
}

/**
 * FAILURE-DIAGNOSIS: data access for the append-only rework failure trail. Where
 * `tickets.last_review_feedback` keeps only the latest attempt (for the board
 * chip), this table APPENDS every attempt so the full ordered history survives.
 */
export class ReworkAttemptRepository {
  constructor(private readonly db: Db) {}

  /** Append one attempt to a ticket's failure trail. */
  insert(input: ReworkAttemptInput): void {
    this.db
      .prepare(
        `INSERT INTO rework_attempts
           (id, ticket_id, attempt, max_attempts, gate, distilled_failure, ac_id, created_at)
         VALUES
           (@id, @ticket_id, @attempt, @max_attempts, @gate, @distilled_failure, @ac_id, @created_at)`,
      )
      .run(input);
  }

  /**
   * The full ordered trail for one ticket (attempt 1 → 2 → …). Ordered by attempt
   * then insertion order so a same-attempt re-record can never reorder the trail.
   * This is the "why did #N fail" read model.
   */
  listForTicket(ticketId: string): ReworkAttempt[] {
    return this.db
      .prepare(
        `SELECT id, ticket_id, attempt, max_attempts, gate, distilled_failure, ac_id, created_at
           FROM rework_attempts
          WHERE ticket_id = ?
          ORDER BY attempt ASC, rowid ASC`,
      )
      .all(ticketId) as ReworkAttempt[];
  }

  /**
   * Cross-ticket "these keep bouncing" signal: tickets with a rework trail at or
   * above `minReworks`, enriched with the single gate each ticket failed MOST (the
   * same-gate repeat signal). Ranked so the worst offenders surface first —
   * primarily by same-gate repeats (a ticket stuck on one gate is the strongest
   * quality signal), then by total rework count, then recency.
   */
  bouncing(options: BouncingOptions = {}): BouncingTicket[] {
    const minReworks = options.minReworks ?? DEFAULT_MIN_REWORKS;
    const limit = options.limit ?? DEFAULT_BOUNCING_LIMIT;
    // One statement, LIMIT applied in SQL. The ranking depends on the per-ticket
    // top-gate breakdown, so that breakdown (previously an N+1 per-row query with
    // the LIMIT applied only after enrichment) is computed alongside via CTEs:
    //   gate_counts — attempts per (ticket, gate), NULL gates excluded;
    //   top_gates   — each ticket's single worst gate (count DESC, gate ASC —
    //                 the same tie-break the old per-row query used).
    // Rank: same-gate repeats first (the stuck-on-one-gate signal), then total
    // rework volume, then recency — unchanged from the old JS sort.
    const rows = this.db
      .prepare(
        `WITH gate_counts AS (
           SELECT ticket_id, gate, COUNT(*) AS c
             FROM rework_attempts
            WHERE gate IS NOT NULL
            GROUP BY ticket_id, gate
         ),
         top_gates AS (
           SELECT ticket_id, gate, c
             FROM (SELECT ticket_id, gate, c,
                          ROW_NUMBER() OVER (
                            PARTITION BY ticket_id ORDER BY c DESC, gate ASC
                          ) AS rn
                     FROM gate_counts)
            WHERE rn = 1
         )
         SELECT ra.ticket_id                AS ticket_id,
                t.number                     AS number,
                t.title                      AS title,
                t.status                     AS status,
                COUNT(*)                     AS rework_count,
                COUNT(DISTINCT ra.gate)      AS distinct_gates,
                MAX(ra.created_at)           AS last_attempt_at,
                tg.gate                      AS top_gate,
                COALESCE(tg.c, 0)            AS top_gate_count
           FROM rework_attempts ra
           JOIN tickets t ON t.id = ra.ticket_id
           LEFT JOIN top_gates tg ON tg.ticket_id = ra.ticket_id
          GROUP BY ra.ticket_id
         HAVING rework_count >= @minReworks
          ORDER BY top_gate_count DESC, rework_count DESC, last_attempt_at DESC
          LIMIT @limit`,
      )
      .all({ minReworks, limit }) as BouncingRow[];

    return rows.map((row) => ({
      ticket_id: row.ticket_id,
      number: row.number,
      title: row.title,
      status: row.status,
      rework_count: row.rework_count,
      distinct_gates: row.distinct_gates,
      top_gate: row.top_gate,
      top_gate_count: row.top_gate_count,
      last_attempt_at: row.last_attempt_at,
    }));
  }
}
