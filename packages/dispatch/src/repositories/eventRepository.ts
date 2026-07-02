import type { Db } from "../db/connection.js";

/** Options for a page of the cross-ticket activity feed. */
export interface ActivityQuery {
  /** Max rows to return (already clamped by the caller). */
  limit: number;
  /** Skip this many rows from the newest end (for simple pagination). */
  offset: number;
}

/**
 * One row of the cross-entity activity feed: a work_event enriched with the
 * ticket number/title it concerns (when the event targets a ticket) so the UI
 * can render "#12 · evidence.recorded" without a second round-trip.
 *
 * SAFETY: this view deliberately carries metadata only — entity type/id, event
 * type, actor and timestamp. It NEVER selects work_events.payload_json, which
 * can hold free-text (titles, AC text, block reasons). The activity feed is an
 * audit-of-record meant to be safe to render wholesale; bodies stay in the
 * per-ticket detail view, which is fetched deliberately.
 */
export interface ActivityEvent {
  id: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  actor_type: string;
  actor_id: string | null;
  created_at: string;
  /** Ticket number, when the event targets a resolvable ticket. */
  ticket_number: number | null;
  /** Ticket title, when the event targets a resolvable ticket. */
  ticket_title: string | null;
}

/** A status → count pair from the tickets table. */
export interface StatusCount {
  status: string;
  count: number;
}

/**
 * One `ticket.transitioned` event reduced to its analytics-relevant fields: the
 * ticket it concerns, the state it left (`from_status`), the state it entered
 * (`to_status`) and when. Like {@link deliveredSince}, this reads only the
 * enum status fields out of the payload — never free-text — so the cycle-time
 * rollup stays safe to compute over the whole log.
 */
export interface TransitionRow {
  ticket_id: string;
  from_status: string | null;
  to_status: string | null;
  created_at: string;
}

/**
 * One review-lane transition fanned out to a WRITE repo, reduced to the fields the
 * GRADUATED-AUTONOMY recommendation service needs. `reason`/`fromStatus`/`toStatus`
 * classify the decision (approve vs reject); `approvedUnchanged` is the Phase-1
 * signal (null when the transition carried no such signal, e.g. a rejection or a
 * pre-Phase-1 event).
 */
export interface ReviewDecisionRow {
  repoId: string;
  repoName: string;
  riskLevel: string;
  actorType: string;
  fromStatus: string | null;
  toStatus: string | null;
  reason: string | null;
  approvedUnchanged: boolean | null;
}

/**
 * Read-only access to the work_events log for the cross-ticket activity feed
 * and dashboard rollups. Append-only by convention elsewhere; nothing here
 * mutates.
 */
export class EventRepository {
  constructor(private readonly db: Db) {}

  /**
   * Newest-first page of events across ALL entities, joined to the ticket the
   * event concerns when applicable. Ordered by rowid DESC (insertion order) —
   * created_at can tie at sub-millisecond resolution, so rowid is the stable
   * newest-first key, mirroring {@link import("../events/eventWriter.js")}.
   *
   * Payload bodies are intentionally not selected (see {@link ActivityEvent}).
   */
  listActivity(query: ActivityQuery): ActivityEvent[] {
    return this.db
      .prepare(
        `SELECT
            e.id           AS id,
            e.entity_type  AS entity_type,
            e.entity_id    AS entity_id,
            e.event_type   AS event_type,
            e.actor_type   AS actor_type,
            e.actor_id     AS actor_id,
            e.created_at   AS created_at,
            t.number       AS ticket_number,
            t.title        AS ticket_title
         FROM work_events e
         LEFT JOIN tickets t
           ON e.entity_type = 'ticket' AND t.id = e.entity_id
         ORDER BY e.rowid DESC
         LIMIT @limit OFFSET @offset`,
      )
      .all({ limit: query.limit, offset: query.offset }) as ActivityEvent[];
  }

  /** Total number of work_events (for pagination hints). */
  countActivity(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM work_events`).get() as { n: number };
    return row.n;
  }

  /** Ticket counts grouped by status (only statuses with ≥1 ticket appear). */
  ticketCountsByStatus(): StatusCount[] {
    return this.db
      .prepare(
        `SELECT status AS status, COUNT(*) AS count
         FROM tickets
         GROUP BY status`,
      )
      .all() as StatusCount[];
  }

  /**
   * Tickets that entered a delivered state (in_review or done) on or after the
   * given ISO instant, counted via the work_events trail. Transitions are logged
   * as `ticket.transitioned` with the destination status in payload `$.to`; we
   * read only that status field (an enum value, never free text) and count the
   * distinct tickets delivered since `sinceIso`.
   */
  deliveredSince(sinceIso: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT entity_id) AS n
         FROM work_events
         WHERE entity_type = 'ticket'
           AND event_type = 'ticket.transitioned'
           AND json_extract(payload_json, '$.to') IN ('in_review', 'done')
           AND created_at >= @since`,
      )
      .get({ since: sinceIso }) as { n: number };
    return row.n;
  }

  /**
   * Every ticket state transition, oldest-first within each ticket (rowid ASC),
   * for the cycle-time rollup. Consecutive rows for the same ticket bound the
   * time it held a state: the gap between a transition and the next one is how
   * long the ticket sat in the entered state. Reads only the `from`/`to` enum
   * fields from the payload (never free text).
   */
  stateTransitions(): TransitionRow[] {
    return this.db
      .prepare(
        `SELECT entity_id                              AS ticket_id,
                json_extract(payload_json, '$.from')   AS from_status,
                json_extract(payload_json, '$.to')     AS to_status,
                created_at                             AS created_at
         FROM work_events
         WHERE entity_type = 'ticket'
           AND event_type = 'ticket.transitioned'
         ORDER BY entity_id, rowid`,
      )
      .all() as TransitionRow[];
  }

  /**
   * The most recent transition of `ticketId` INTO `status`: when it entered the
   * state and the transition's optional free-text reason. Reads the `$.to` enum
   * and `$.reason` from the `ticket.transitioned` payload. Returns null when the
   * ticket never transitioned into that state (e.g. seeded directly). Powers the
   * human-queue "how long has this waited" + "why" for `in_review` tickets.
   */
  enteredStatusAt(ticketId: string, status: string): { at: string; reason: string | null } | null {
    const row = this.db
      .prepare(
        `SELECT created_at                            AS at,
                json_extract(payload_json, '$.reason') AS reason
         FROM work_events
         WHERE entity_type = 'ticket'
           AND entity_id = @ticketId
           AND event_type = 'ticket.transitioned'
           AND json_extract(payload_json, '$.to') = @status
         ORDER BY rowid DESC
         LIMIT 1`,
      )
      .get({ ticketId, status }) as { at: string; reason: string | null } | undefined;
    return row ?? null;
  }

  /**
   * GRADUATED-AUTONOMY (Spec 2, Phase 2): every review-lane `ticket.transitioned`
   * event fanned out to each WRITE repo of its ticket, carrying the enum status
   * fields, the actor type, and the Phase-1 `approved_unchanged` boolean. Powers the
   * read-only per-repo/per-risk recommendation service.
   *
   * SAFETY: like {@link stateTransitions}/{@link deliveredSince}, this reads only the
   * ENUM `$.from`/`$.to` and the BOOLEAN `$.approved_unchanged` out of payload_json —
   * plus `$.reason`, which CAN be free text. `reason` is used ONLY to classify
   * approvals (it equals a fixed `review_approved*` constant on that path) and is
   * NEVER surfaced by the recommendation service (which emits aggregate rates only),
   * so no free text leaves this layer. The fan-out over `ticket_repos` (write access)
   * scopes each decision to the repos the ticket actually delivers into.
   */
  reviewDecisions(): ReviewDecisionRow[] {
    const rows = this.db
      .prepare(
        `SELECT r.id                                          AS repo_id,
                r.name                                        AS repo_name,
                t.risk_level                                  AS risk_level,
                e.actor_type                                  AS actor_type,
                json_extract(e.payload_json, '$.from')        AS from_status,
                json_extract(e.payload_json, '$.to')          AS to_status,
                json_extract(e.payload_json, '$.reason')      AS reason,
                json_extract(e.payload_json, '$.approved_unchanged') AS approved_unchanged
         FROM work_events e
         JOIN tickets t       ON t.id = e.entity_id
         JOIN ticket_repos tr ON tr.ticket_id = t.id AND tr.access = 'write'
         JOIN repositories r  ON r.id = tr.repo_id
         WHERE e.entity_type = 'ticket'
           AND e.event_type  = 'ticket.transitioned'
           AND json_extract(e.payload_json, '$.from') IN ('in_review', 'ready_for_merge')`,
      )
      .all() as Array<{
      repo_id: string;
      repo_name: string;
      risk_level: string;
      actor_type: string;
      from_status: string | null;
      to_status: string | null;
      reason: string | null;
      // SQLite yields a JSON boolean as 1/0, or null when the key is absent.
      approved_unchanged: number | null;
    }>;
    return rows.map((r) => ({
      repoId: r.repo_id,
      repoName: r.repo_name,
      riskLevel: r.risk_level,
      actorType: r.actor_type,
      fromStatus: r.from_status,
      toStatus: r.to_status,
      reason: r.reason,
      approvedUnchanged: r.approved_unchanged === null ? null : r.approved_unchanged === 1,
    }));
  }

  /** True when the ticket has at least one work-event of the given type. */
  hasTicketEvent(ticketId: string, eventType: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM work_events
         WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = ?
         LIMIT 1`,
      )
      .get(ticketId, eventType);
    return row !== undefined;
  }
}
