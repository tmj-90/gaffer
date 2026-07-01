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

/** Row shape returned by the bouncing group-by (pre-gate-breakdown). */
interface BouncingRow {
  ticket_id: string;
  number: number | null;
  title: string;
  status: string;
  rework_count: number;
  distinct_gates: number;
  last_attempt_at: string;
}

/** Row shape for a per-ticket gate breakdown. */
interface GateCountRow {
  gate: string;
  c: number;
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
    const rows = this.db
      .prepare(
        `SELECT ra.ticket_id                AS ticket_id,
                t.number                     AS number,
                t.title                      AS title,
                t.status                     AS status,
                COUNT(*)                     AS rework_count,
                COUNT(DISTINCT ra.gate)      AS distinct_gates,
                MAX(ra.created_at)           AS last_attempt_at
           FROM rework_attempts ra
           JOIN tickets t ON t.id = ra.ticket_id
          GROUP BY ra.ticket_id
         HAVING rework_count >= @minReworks`,
      )
      .all({ minReworks }) as BouncingRow[];

    const enriched: BouncingTicket[] = rows.map((row) => {
      const top = this.db
        .prepare(
          `SELECT gate, COUNT(*) AS c
             FROM rework_attempts
            WHERE ticket_id = ? AND gate IS NOT NULL
            GROUP BY gate
            ORDER BY c DESC, gate ASC
            LIMIT 1`,
        )
        .get(row.ticket_id) as GateCountRow | undefined;
      return {
        ticket_id: row.ticket_id,
        number: row.number,
        title: row.title,
        status: row.status,
        rework_count: row.rework_count,
        distinct_gates: row.distinct_gates,
        top_gate: top?.gate ?? null,
        top_gate_count: top?.c ?? 0,
        last_attempt_at: row.last_attempt_at,
      };
    });

    // Rank: same-gate repeats first (the stuck-on-one-gate signal), then total
    // rework volume, then recency. Sorted in JS so the ranking stays readable.
    enriched.sort((a, b) => {
      if (b.top_gate_count !== a.top_gate_count) return b.top_gate_count - a.top_gate_count;
      if (b.rework_count !== a.rework_count) return b.rework_count - a.rework_count;
      return b.last_attempt_at.localeCompare(a.last_attempt_at);
    });
    return enriched.slice(0, limit);
  }
}
