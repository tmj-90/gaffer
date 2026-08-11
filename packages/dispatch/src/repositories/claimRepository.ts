import type { Db } from "../db/connection.js";
import type { ClaimStatus, TicketClaim } from "../domain/types.js";

/** Row returned by the claim-next candidate query. */
export interface CandidateRow {
  id: string;
  priority: number;
  created_at: string;
  /** Id of an active-but-expired claim blocking this ticket, to be reaped before reclaim. */
  expired_claim_id: string | null;
}

/** Eligibility inputs the candidate query filters on (P0-1). */
export interface CandidateCriteria {
  /** The claiming agent's risk ceiling rank (RISK_LEVELS index). */
  maxRiskRank: number;
  /** The capabilities the agent holds. */
  capabilities: readonly string[];
}

/**
 * Denormalised active-claim row for the human "active factory" view: the claim
 * joined to its ticket and agent. Read-only — no token hash is exposed.
 */
export interface ActiveClaimView {
  claim_id: string;
  ticket_id: string;
  ticket_number: number | null;
  ticket_title: string;
  ticket_status: string;
  branch_name: string | null;
  agent_id: string;
  agent_display_name: string | null;
  status: ClaimStatus;
  expires_at: string;
  heartbeat_at: string;
  created_at: string;
}

/** Data access for ticket claims. No business rules here. */
export class ClaimRepository {
  constructor(private readonly db: Db) {}

  insert(claim: TicketClaim): void {
    this.db
      .prepare(
        `INSERT INTO ticket_claims
          (id, ticket_id, agent_id, claim_token_hash, status, expires_at, heartbeat_at, created_at, released_at)
         VALUES
          (@id, @ticket_id, @agent_id, @claim_token_hash, @status, @expires_at, @heartbeat_at, @created_at, @released_at)`,
      )
      .run(claim);
  }

  /**
   * Ordered list of `ready` tickets eligible for the given agent: no unresolved
   * `blocks` decision, no unsatisfied dependency (EP-001: every depended-on ticket
   * must be `done`), no *unexpired* active claim, and — enforcing eligibility
   * (P0-1) — the agent's risk ceiling covers the ticket risk and the agent holds
   * every required capability. A ticket whose only active claim is past its TTL is
   * still a candidate (P0-2): `expired_claim_id` carries that claim so the caller
   * can reap it inside the same transaction before inserting the new claim.
   *
   * Risk ranks are passed as parameters (mirroring RISK_LEVELS order) so the SQL
   * stays free of hard-coded enum knowledge. The caller attempts each candidate in
   * order, relying on the partial unique index to arbitrate concurrent claims.
   */
  candidateTickets(nowIso: string, criteria: CandidateCriteria): CandidateRow[] {
    // Bind each capability the agent holds as a parameter so the "ticket requires
    // a capability the agent lacks" check runs entirely in SQL. An empty set is
    // handled with a sentinel that never matches a stored capability.
    const caps = criteria.capabilities.length > 0 ? criteria.capabilities : ["\u0000__none__"];
    const capPlaceholders = caps.map(() => "?").join(", ");

    return this.db
      .prepare(
        `SELECT
            t.id,
            t.priority,
            t.created_at,
            (
              SELECT c.id FROM ticket_claims c
              WHERE c.ticket_id = t.id AND c.status = 'active' AND c.expires_at <= ?
              ORDER BY c.expires_at ASC LIMIT 1
            ) AS expired_claim_id
         FROM tickets t
         WHERE (
             t.status = 'ready'
             OR (
               t.status IN ('claimed','in_progress')
               AND EXISTS (
                 SELECT 1 FROM ticket_claims c
                 WHERE c.ticket_id = t.id AND c.status = 'active' AND c.expires_at <= ?
               )
             )
           )
           -- TRACK-2b: NEVER select a ticket a human took by hand. This is the
           -- structural agent-skip: a human-owned ticket sits in_progress with no
           -- claim, so the status filter above already excludes it, but the explicit
           -- marker filter guarantees exclusion regardless of status (belt-and-braces
           -- against any future path that leaves a human-owned ticket in a claimable
           -- state) — the human's in-flight work is theirs alone.
           AND t.human_owner IS NULL
           AND (t.scheduled_after IS NULL OR t.scheduled_after <= ?)
           AND CASE t.risk_level
                 WHEN 'low' THEN 0 WHEN 'medium' THEN 1
                 WHEN 'high' THEN 2 WHEN 'critical' THEN 3 ELSE 99
               END <= ?
           AND NOT EXISTS (
             SELECT 1 FROM ticket_required_capabilities trc
             WHERE trc.ticket_id = t.id
               AND trc.capability NOT IN (${capPlaceholders})
           )
           AND NOT EXISTS (
             SELECT 1 FROM ticket_decisions td
             JOIN decisions d ON d.id = td.decision_id
             WHERE td.ticket_id = t.id
               AND td.relation = 'blocks'
               AND d.status NOT IN ('accepted','rejected','superseded')
           )
           AND NOT EXISTS (
             SELECT 1 FROM ticket_dependencies dep
             JOIN tickets dt ON dt.id = dep.depends_on_ticket_id
             WHERE dep.ticket_id = t.id
               AND dt.status <> 'done'
           )
           AND NOT EXISTS (
             SELECT 1 FROM ticket_claims c
             WHERE c.ticket_id = t.id
               AND c.status = 'active'
               AND c.expires_at > ?
           )
         ORDER BY t.priority DESC, t.created_at ASC`,
      )
      .all(nowIso, nowIso, nowIso, criteria.maxRiskRank, ...caps, nowIso) as CandidateRow[];
  }

  /**
   * Eligibility row for a SPECIFIC chosen ticket (claim_ticket path). Applies the
   * SAME rules as {@link candidateTickets} — ready or reclaimable-expired, within
   * the agent's risk ceiling, every required capability held, no unexpired active
   * claim, no unresolved blocking decision, no unsatisfied dependency (EP-001) —
   * but scoped to one ticket id. Returns
   * undefined when the ticket is not claimable for this agent; `expired_claim_id`
   * carries an active-but-expired claim to reap before reclaiming (P0-2).
   */
  candidateForTicket(
    ticketId: string,
    nowIso: string,
    criteria: CandidateCriteria,
  ): CandidateRow | undefined {
    const caps = criteria.capabilities.length > 0 ? criteria.capabilities : [" __none__"];
    const capPlaceholders = caps.map(() => "?").join(", ");

    return this.db
      .prepare(
        `SELECT
            t.id,
            t.priority,
            t.created_at,
            (
              SELECT c.id FROM ticket_claims c
              WHERE c.ticket_id = t.id AND c.status = 'active' AND c.expires_at <= ?
              ORDER BY c.expires_at ASC LIMIT 1
            ) AS expired_claim_id
         FROM tickets t
         WHERE t.id = ?
           AND (
             t.status = 'ready'
             OR (
               t.status IN ('claimed','in_progress')
               AND EXISTS (
                 SELECT 1 FROM ticket_claims c
                 WHERE c.ticket_id = t.id AND c.status = 'active' AND c.expires_at <= ?
               )
             )
           )
           -- TRACK-2b: never claim a ticket a human took by hand (structural skip).
           AND t.human_owner IS NULL
           AND (t.scheduled_after IS NULL OR t.scheduled_after <= ?)
           AND CASE t.risk_level
                 WHEN 'low' THEN 0 WHEN 'medium' THEN 1
                 WHEN 'high' THEN 2 WHEN 'critical' THEN 3 ELSE 99
               END <= ?
           AND NOT EXISTS (
             SELECT 1 FROM ticket_required_capabilities trc
             WHERE trc.ticket_id = t.id
               AND trc.capability NOT IN (${capPlaceholders})
           )
           AND NOT EXISTS (
             SELECT 1 FROM ticket_decisions td
             JOIN decisions d ON d.id = td.decision_id
             WHERE td.ticket_id = t.id
               AND td.relation = 'blocks'
               AND d.status NOT IN ('accepted','rejected','superseded')
           )
           AND NOT EXISTS (
             SELECT 1 FROM ticket_dependencies dep
             JOIN tickets dt ON dt.id = dep.depends_on_ticket_id
             WHERE dep.ticket_id = t.id
               AND dt.status <> 'done'
           )
           AND NOT EXISTS (
             SELECT 1 FROM ticket_claims c
             WHERE c.ticket_id = t.id
               AND c.status = 'active'
               AND c.expires_at > ?
           )`,
      )
      .get(nowIso, ticketId, nowIso, nowIso, criteria.maxRiskRank, ...caps, nowIso) as
      CandidateRow | undefined;
  }

  /** The active, unexpired claim matching this token hash (if any). */
  findActiveByTokenHash(tokenHash: string, nowIso: string): TicketClaim | undefined {
    return this.db
      .prepare(
        `SELECT * FROM ticket_claims
         WHERE claim_token_hash = ? AND status = 'active' AND expires_at > ?`,
      )
      .get(tokenHash, nowIso) as TicketClaim | undefined;
  }

  /** A claim by its id, regardless of status. */
  findById(id: string): TicketClaim | undefined {
    return this.db.prepare(`SELECT * FROM ticket_claims WHERE id = ?`).get(id) as
      TicketClaim | undefined;
  }

  /**
   * Active claims for the human view: each active claim joined to its ticket and
   * agent, newest first. Excludes released/expired/revoked/completed claims.
   */
  listActive(): ActiveClaimView[] {
    return this.db
      .prepare(
        `SELECT
            c.id            AS claim_id,
            c.ticket_id     AS ticket_id,
            t.number        AS ticket_number,
            t.title         AS ticket_title,
            t.status        AS ticket_status,
            t.branch_name   AS branch_name,
            c.agent_id      AS agent_id,
            a.display_name  AS agent_display_name,
            c.status        AS status,
            c.expires_at    AS expires_at,
            c.heartbeat_at  AS heartbeat_at,
            c.created_at    AS created_at
         FROM ticket_claims c
         JOIN tickets t ON t.id = c.ticket_id
         JOIN agents a  ON a.id = c.agent_id
         WHERE c.status = 'active'
         ORDER BY c.created_at DESC`,
      )
      .all() as ActiveClaimView[];
  }

  /** Any active claim row matching this token hash, ignoring expiry. */
  findByTokenHash(tokenHash: string): TicketClaim | undefined {
    return this.db
      .prepare(`SELECT * FROM ticket_claims WHERE claim_token_hash = ? AND status = 'active'`)
      .get(tokenHash) as TicketClaim | undefined;
  }

  /** Active claims whose expiry is strictly before `nowIso` (stale/recoverable). */
  listExpired(nowIso: string): TicketClaim[] {
    return this.db
      .prepare(
        `SELECT * FROM ticket_claims WHERE status = 'active' AND expires_at < ? ORDER BY expires_at ASC`,
      )
      .all(nowIso) as TicketClaim[];
  }

  /** Extend an active claim's expiry + heartbeat. Returns true when a row changed. */
  extend(id: string, expiresAt: string, heartbeatAt: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE ticket_claims SET expires_at = @expires_at, heartbeat_at = @heartbeat_at
         WHERE id = @id AND status = 'active'`,
      )
      .run({ id, expires_at: expiresAt, heartbeat_at: heartbeatAt });
    return result.changes === 1;
  }

  /** Move a claim to a terminal status, stamping released_at for non-active states. */
  setStatus(id: string, status: ClaimStatus, nowIso: string): void {
    this.db
      .prepare(
        `UPDATE ticket_claims
         SET status = @status,
             released_at = CASE WHEN @status = 'active' THEN released_at ELSE @now END
         WHERE id = @id`,
      )
      .run({ id, status, now: nowIso });
  }

  /**
   * Release EVERY active claim on a ticket (mark 'released', stamp released_at).
   * Called when a ticket leaves the delivery lane back to a queue/parked state so a
   * stale lease can never strand it: the candidate queries reject any ticket with an
   * UNEXPIRED active claim, so without this a ticket dragged `blocked -> ready` (or
   * otherwise re-queued while still holding a lease) becomes silently un-claimable
   * until its TTL runs out. Idempotent — no active claim means zero rows changed.
   * Returns the number of claims released.
   */
  releaseActiveForTicket(ticketId: string, nowIso: string): number {
    return this.db
      .prepare(
        `UPDATE ticket_claims
         SET status = 'released', released_at = @now
         WHERE ticket_id = @ticket_id AND status = 'active'`,
      )
      .run({ ticket_id: ticketId, now: nowIso }).changes;
  }
}
