import type { Db } from "../db/connection.js";
import { EPIC_MEMBER_RELATIONS, ownAcceptanceTicketId } from "./epicAcceptance.js";

/**
 * FEATURE LANDING (external review 17, finding 3): which tickets make up a memory-ledger
 * feature, and have they all landed?
 *
 * The idle feature-backlog loop files a feature as an EPIC (createEpic) whose
 * implementation tickets each carry a `Feature-Id: <id>` line, and createEpic adds the
 * epic's own ACCEPTANCE ticket (which carries no marker). The merge runner used to ship
 * the feature when ANY one ticket with the marker merged. The membership is now explicit:
 *
 *   - every ticket whose description carries `Feature-Id: <id>` on its own line (the
 *     marker; the first such line of a description counts, as the runner reads it);
 *   - every epic that confirms (a `primary` / `secondary` link, the epic membership rule
 *     in epicAcceptance.ts) at least one of those tickets, and through it every confirmed
 *     implementation member of that epic and the epic's OWN acceptance ticket
 *     (`ownAcceptanceTicketId`, the rule `wg stats` counts acceptance by);
 *   - when the caller names a ticket that claims the feature some other way (a prepared
 *     digest delta naming it), that ticket.
 *
 * Membership is the UNION of the marker set and the epic set, so the two cross-check each
 * other: a ticket that is in one and not the other still has to land.
 *
 * The decision: a ticket in `done` has landed (done is reached only through mark-merged,
 * once every write repo's approved revision landed). A `cancelled` ticket (won't-do) is
 * not landed work, but it is not waited for either: it is left out of the count, so a
 * feature whose remaining work was abandoned does not wait forever. Every other status
 * (draft, ready, in review, ready_for_merge, blocked, failed, paused...) is still to land.
 * The feature is COMPLETE only when at least one counted ticket exists and every counted
 * ticket has landed: a feature with no tickets, or whose every ticket was cancelled, is
 * never complete (nothing landed).
 */

/** `Feature-Id: <id>` on its own line; the first one in a description counts. */
const FEATURE_ID_LINE = /^\s*Feature-Id:\s*(\S+)\s*$/im;

/** The feature id a ticket description carries, or null. */
export function featureIdOf(description: string | null | undefined): string | null {
  const m = FEATURE_ID_LINE.exec(String(description ?? ""));
  return m ? m[1]! : null;
}

export type FeatureMembership = "marker" | "epic" | "ticket";

export interface FeatureLandingTicket {
  readonly number: number | null;
  readonly title: string;
  readonly status: string;
  readonly acceptance: boolean;
  /** How the ticket belongs to the feature (one or more). */
  readonly via: FeatureMembership[];
  /** status === done. */
  readonly landed: boolean;
  /** Counted toward completion (everything but cancelled). */
  readonly counted: boolean;
}

export interface FeatureLanding {
  readonly feature_id: string | null;
  /** Where the id came from: the caller, the named ticket's marker, or its epic. */
  readonly resolved_from: "argument" | "marker" | "epic" | null;
  readonly epics: Array<{ id: string; name: string; acceptance_ticket: number | null }>;
  readonly tickets: FeatureLandingTicket[];
  readonly landed: Array<number | null>;
  readonly pending: Array<number | null>;
  readonly cancelled: Array<number | null>;
  readonly complete: boolean;
  readonly reason: string;
}

interface TicketRow {
  id: string;
  number: number | null;
  title: string;
  status: string;
  acceptance: number;
  description: string | null;
}

const MEMBER_SQL = EPIC_MEMBER_RELATIONS.map((r) => `'${r}'`).join(", ");

function ticketByRef(db: Db, ref: string): TicketRow | undefined {
  const n = /^#?\d+$/.test(ref.trim()) ? Number(ref.trim().replace(/^#/, "")) : null;
  const sql =
    "SELECT id, number, title, status, acceptance, description FROM tickets WHERE " +
    (n !== null ? "number = ?" : "id = ?");
  return db.prepare(sql).get(n !== null ? n : ref.trim()) as TicketRow | undefined;
}

/** The epics that confirm a ticket as a member. */
function epicsOf(db: Db, ticketIds: readonly string[]): Array<{ id: string; name: string }> {
  if (ticketIds.length === 0) return [];
  const marks = ticketIds.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT DISTINCT n.id AS id, n.name AS name
         FROM ticket_scope_nodes s JOIN scope_nodes n ON n.id = s.scope_node_id
        WHERE n.type = 'epic' AND s.relation IN (${MEMBER_SQL}) AND s.ticket_id IN (${marks})
        ORDER BY n.created_at, n.rowid`,
    )
    .all(...ticketIds) as Array<{ id: string; name: string }>;
}

/** Every ticket carrying `Feature-Id: <featureId>` (exact id, own line). */
function markerTickets(db: Db, featureId: string): TicketRow[] {
  const rows = db
    .prepare(
      `SELECT id, number, title, status, acceptance, description FROM tickets
        WHERE description LIKE '%Feature-Id:%' ORDER BY number`,
    )
    .all() as TicketRow[];
  return rows.filter((r) => featureIdOf(r.description) === featureId);
}

/** The epic's confirmed implementation members (any status) and its own acceptance ticket. */
function epicMembers(
  db: Db,
  epicId: string,
): { members: TicketRow[]; acceptance: TicketRow | null } {
  const members = db
    .prepare(
      `SELECT t.id, t.number, t.title, t.status, t.acceptance, t.description
         FROM ticket_scope_nodes s JOIN tickets t ON t.id = s.ticket_id
        WHERE s.scope_node_id = ? AND t.acceptance = 0 AND s.relation IN (${MEMBER_SQL})
        ORDER BY t.number`,
    )
    .all(epicId) as TicketRow[];
  const accId = ownAcceptanceTicketId(db, epicId);
  const acceptance = accId
    ? ((db
        .prepare(
          "SELECT id, number, title, status, acceptance, description FROM tickets WHERE id = ?",
        )
        .get(accId) as TicketRow | undefined) ?? null)
    : null;
  return { members, acceptance };
}

/**
 * The feature a ticket belongs to: its own marker, else the one feature the marked members
 * of its epics name. Null when there is none, or when its epics name more than one (the
 * caller cannot tell which feature this landing is for, so it ships nothing).
 */
function resolveFromTicket(
  db: Db,
  t: TicketRow,
): { id: string | null; from: "marker" | "epic" | null; ambiguous: string[] } {
  const own = featureIdOf(t.description);
  if (own) return { id: own, from: "marker", ambiguous: [] };
  const ids = new Set<string>();
  for (const e of epicsOf(db, [t.id])) {
    const { members, acceptance } = epicMembers(db, e.id);
    for (const m of [...members, ...(acceptance ? [acceptance] : [])]) {
      const f = featureIdOf(m.description);
      if (f) ids.add(f);
    }
  }
  if (ids.size === 1) return { id: [...ids][0]!, from: "epic", ambiguous: [] };
  return { id: null, from: null, ambiguous: [...ids].sort() };
}

function label(t: { number: number | null; status: string }): string {
  return `#${t.number ?? "?"} (${t.status})`;
}

/**
 * The tickets of a feature and whether they have all landed (see the module doc).
 * `featureId` names the feature; `ticketRef` (a number or id) names a ticket that is part
 * of it: alone, the feature is resolved from that ticket; with an id, that ticket is
 * counted as a member too.
 */
export function featureLanding(
  db: Db,
  opts: { featureId?: string | null; ticketRef?: string | null },
): FeatureLanding {
  const empty = (
    featureId: string | null,
    from: FeatureLanding["resolved_from"],
    reason: string,
  ): FeatureLanding => ({
    feature_id: featureId,
    resolved_from: from,
    epics: [],
    tickets: [],
    landed: [],
    pending: [],
    cancelled: [],
    complete: false,
    reason,
  });

  let featureId = String(opts.featureId ?? "").trim() || null;
  let from: FeatureLanding["resolved_from"] = featureId ? "argument" : null;
  const named = opts.ticketRef ? ticketByRef(db, String(opts.ticketRef)) : undefined;
  if (opts.ticketRef && !named) {
    return empty(featureId, from, `ticket ${String(opts.ticketRef)} does not exist`);
  }
  if (!featureId) {
    if (!named) return empty(null, null, "no feature id and no ticket named");
    const r = resolveFromTicket(db, named);
    if (!r.id) {
      return empty(
        null,
        null,
        r.ambiguous.length > 0
          ? `ticket ${label(named)} is in epics that name more than one feature (${r.ambiguous.join(", ")})`
          : `ticket ${label(named)} belongs to no feature`,
      );
    }
    featureId = r.id;
    from = r.from;
  }

  const byId = new Map<string, { row: TicketRow; via: Set<FeatureMembership> }>();
  const add = (row: TicketRow, via: FeatureMembership): void => {
    const cur = byId.get(row.id);
    if (cur) cur.via.add(via);
    else byId.set(row.id, { row, via: new Set([via]) });
  };
  const marked = markerTickets(db, featureId);
  for (const r of marked) add(r, "marker");
  if (named && !byId.has(named.id)) add(named, "ticket");

  const epics: FeatureLanding["epics"] = [];
  for (const e of epicsOf(db, [...byId.keys()])) {
    const { members, acceptance } = epicMembers(db, e.id);
    for (const m of members) add(m, "epic");
    if (acceptance) add(acceptance, "epic");
    epics.push({ id: e.id, name: e.name, acceptance_ticket: acceptance?.number ?? null });
  }

  const tickets: FeatureLandingTicket[] = [...byId.values()]
    .map(({ row, via }) => ({
      number: row.number,
      title: row.title,
      status: row.status,
      acceptance: row.acceptance === 1,
      via: [...via].sort(),
      landed: row.status === "done",
      counted: row.status !== "cancelled",
    }))
    .sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  const counted = tickets.filter((t) => t.counted);
  const pendingT = counted.filter((t) => !t.landed);
  const landed = counted.filter((t) => t.landed).map((t) => t.number);
  const pending = pendingT.map((t) => t.number);
  const cancelled = tickets.filter((t) => !t.counted).map((t) => t.number);
  const complete = counted.length > 0 && pendingT.length === 0;
  const reason =
    tickets.length === 0
      ? `no ticket belongs to feature ${featureId}`
      : counted.length === 0
        ? `every ticket of feature ${featureId} was cancelled: nothing landed`
        : complete
          ? `every ticket of feature ${featureId} landed (${landed.map((n) => `#${n ?? "?"}`).join(", ")})` +
            (cancelled.length > 0
              ? `; cancelled, not counted: ${cancelled.map((n) => `#${n ?? "?"}`).join(", ")}`
              : "")
          : `feature ${featureId} is waiting on ${pendingT.map(label).join(", ")}`;
  return {
    feature_id: featureId,
    resolved_from: from,
    epics,
    tickets,
    landed,
    pending,
    cancelled,
    complete,
    reason,
  };
}
