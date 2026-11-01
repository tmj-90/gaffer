import type { Db } from "../db/connection.js";

/**
 * EPIC MEMBERSHIP AND ITS ACCEPTANCE TICKET (external review #8).
 *
 * An epic (a `scope_nodes` row of type `epic`) groups its tickets through
 * `ticket_scope_nodes` links. Only a CONFIRMED link makes a ticket a member: the
 * `primary` and `secondary` relations. A `suggested` link is a proposal nobody accepted
 * and a `rejected` link is an explicit "not part of this", so neither adds an
 * implementation ticket to the epic's scope, and neither lets another epic's acceptance
 * ticket stand in for this one's.
 *
 * Each epic has exactly ONE acceptance ticket of its own: the one createEpic made for it,
 * named by the `epic.created` event (`acceptance_ticket`). An epic created before that
 * event carried it falls back to its lowest-numbered acceptance ticket linked by a
 * confirmed relation that is not another epic's own acceptance ticket. The acceptance
 * summary (`wg stats`) counts each epic once, against that ticket only.
 */
export const EPIC_MEMBER_RELATIONS = ["primary", "secondary"] as const;

const MEMBER_SQL = EPIC_MEMBER_RELATIONS.map((r) => `'${r}'`).join(", ");

/** The acceptance ticket number an epic's `epic.created` event declares, or null. */
function declaredAcceptanceNumber(db: Db, epicNodeId: string): number | null {
  const row = db
    .prepare(
      `SELECT json_extract(payload_json, '$.acceptance_ticket') AS n FROM work_events
        WHERE entity_type = 'scope_node' AND entity_id = ? AND event_type = 'epic.created'
        ORDER BY rowid DESC LIMIT 1`,
    )
    .get(epicNodeId) as { n: number | string | null } | undefined;
  const n = Number(row?.n);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Ticket ids that some epic declares as its OWN acceptance ticket, by epic node id. */
function declaredOwners(db: Db): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT e.entity_id AS epic_id, t.id AS ticket_id
         FROM work_events e
         JOIN tickets t ON t.number = json_extract(e.payload_json, '$.acceptance_ticket')
                       AND t.acceptance = 1
        WHERE e.entity_type = 'scope_node' AND e.event_type = 'epic.created'
        ORDER BY e.rowid ASC`,
    )
    .all() as Array<{ epic_id: string; ticket_id: string }>;
  const byTicket = new Map<string, string>();
  for (const r of rows) byTicket.set(r.ticket_id, r.epic_id);
  return byTicket;
}

/**
 * The epic's own acceptance ticket id (see the module doc), or null when it has none
 * (an epic created with `acceptance: false`, or a hand-made epic node).
 */
export function ownAcceptanceTicketId(db: Db, epicNodeId: string): string | null {
  const declared = declaredAcceptanceNumber(db, epicNodeId);
  if (declared !== null) {
    const t = db
      .prepare(`SELECT id FROM tickets WHERE number = ? AND acceptance = 1`)
      .get(declared) as { id: string } | undefined;
    if (t) return t.id;
  }
  const owners = declaredOwners(db);
  const candidates = db
    .prepare(
      `SELECT t.id AS id FROM ticket_scope_nodes s JOIN tickets t ON t.id = s.ticket_id
        WHERE s.scope_node_id = ? AND t.acceptance = 1 AND s.relation IN (${MEMBER_SQL})
        ORDER BY t.number ASC`,
    )
    .all(epicNodeId) as Array<{ id: string }>;
  for (const c of candidates) {
    const owner = owners.get(c.id);
    if (owner === undefined || owner === epicNodeId) return c.id;
  }
  return null;
}

/** One epic and its own acceptance ticket (each epic listed once). */
export interface EpicWithAcceptance {
  readonly epicNodeId: string;
  readonly epicName: string;
  readonly acceptanceTicketId: string;
}

/** Every epic that has an acceptance ticket of its own, each exactly once. */
export function epicsWithOwnAcceptance(db: Db): EpicWithAcceptance[] {
  const epics = db
    .prepare(`SELECT id, name FROM scope_nodes WHERE type = 'epic' ORDER BY created_at, rowid`)
    .all() as Array<{ id: string; name: string }>;
  const out: EpicWithAcceptance[] = [];
  for (const e of epics) {
    const acc = ownAcceptanceTicketId(db, e.id);
    if (acc !== null) out.push({ epicNodeId: e.id, epicName: e.name, acceptanceTicketId: acc });
  }
  return out;
}

/** The epic's confirmed implementation members (not acceptance tickets, not cancelled). */
export function epicImplementationMembers(
  db: Db,
  epicNodeId: string,
): Array<{ id: string; number: number | null; status: string; doneAt: string | null }> {
  return db
    .prepare(
      `SELECT t.id AS id, t.number AS number, t.status AS status,
              (SELECT MAX(w.created_at) FROM work_events w
                WHERE w.entity_type = 'ticket' AND w.entity_id = t.id
                  AND w.event_type = 'ticket.transitioned'
                  AND json_extract(w.payload_json, '$.to') = 'done') AS doneAt
         FROM ticket_scope_nodes s JOIN tickets t ON t.id = s.ticket_id
        WHERE s.scope_node_id = ? AND t.acceptance = 0 AND t.status <> 'cancelled'
          AND s.relation IN (${MEMBER_SQL})
        ORDER BY t.number ASC`,
    )
    .all(epicNodeId) as Array<{
    id: string;
    number: number | null;
    status: string;
    doneAt: string | null;
  }>;
}
