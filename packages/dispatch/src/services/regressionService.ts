/**
 * ESCAPED DEFECTS (MF5) on the facade: filing and withdrawing a regression link between
 * tickets, and the standing links folded from the event log (escapedDefects.ts holds the
 * pure rules).
 */
import { inTransaction } from "../db/connection.js";
import { type Actor } from "../domain/types.js";
import { writeEvent } from "../events/eventWriter.js";
import {
  assertMayFileRegression,
  currentRegressionLinks,
  DEFECT_ESCAPED_EVENT,
  DEFECT_ESCAPED_WITHDRAWN_EVENT,
  regressionNote,
  type RegressionEventRow,
  type RegressionLink,
} from "./escapedDefects.js";
import { DispatchError } from "../util/errors.js";
import type { Dispatch } from "../core.js";
import type { TicketView } from "../core.js";

/** What these functions read from the {@link Dispatch} facade they are handed. */
export type RegressionHost = Pick<Dispatch, "db" | "regressionLinkRows" | "resolveTicket">;

/** One side of a regression link as the ticket view shows it. */
export interface RegressionLinkView {
  ticket_id: string;
  number: number | null;
  title: string;
  status: string;
  filed_by: { type: string; id: string | null };
  filed_at: string;
  note: string | null;
}

/**
 * ESCAPED DEFECT (MF5): a person says `ref` (a defect report or its fix) is a regression
 * of the accepted change `of` (a ticket id or number). Recorded as `ticket.defect_escaped`
 * on `ref`, the actor columns saying who filed it. Human or admin only; the target must be
 * another ticket that is done (an accepted change). Filing the same standing link again
 * records nothing. A measurement: nothing gates on it, and it never bumps updated_at.
 */
export function fileRegression(
  host: RegressionHost,
  ref: string,
  of: string,
  actor: Actor,
  note: string | null = null,
): { ticketId: string; regressionOf: string; recorded: boolean; eventId: string | null } {
  assertMayFileRegression(actor);
  const ticket = host.resolveTicket(ref);
  const target = host.resolveTicket(of);
  if (target.id === ticket.id)
    throw new DispatchError("VALIDATION_ERROR", "A ticket cannot be a regression of itself.", {
      ticket_id: ticket.id,
    });
  if (target.status !== "done")
    throw new DispatchError(
      "STATE_CONFLICT",
      `#${target.number ?? "?"} is not an accepted change (it is ${target.status}); a regression links to a change that reached done.`,
      { regression_of: target.id, status: target.status },
    );
  return inTransaction(host.db, () => {
    const standing = host
      .regressionLinkRows()
      .some((l) => l.ticketId === ticket.id && l.regressionOf === target.id);
    if (standing)
      return { ticketId: ticket.id, regressionOf: target.id, recorded: false, eventId: null };
    const eventId = writeEvent(host.db, {
      entity_type: "ticket",
      entity_id: ticket.id,
      actor,
      event_type: DEFECT_ESCAPED_EVENT,
      payload: {
        regression_of: target.id,
        regression_of_number: target.number ?? null,
        note: regressionNote(note),
      },
    });
    return { ticketId: ticket.id, regressionOf: target.id, recorded: true, eventId };
  });
}

/** Take back a regression link filed in error (human or admin; nothing standing: no-op). */
export function withdrawRegression(
  host: RegressionHost,
  ref: string,
  of: string,
  actor: Actor,
): { ticketId: string; regressionOf: string; recorded: boolean; eventId: string | null } {
  assertMayFileRegression(actor);
  const ticket = host.resolveTicket(ref);
  const target = host.resolveTicket(of);
  return inTransaction(host.db, () => {
    const standing = host
      .regressionLinkRows()
      .some((l) => l.ticketId === ticket.id && l.regressionOf === target.id);
    if (!standing)
      return { ticketId: ticket.id, regressionOf: target.id, recorded: false, eventId: null };
    const eventId = writeEvent(host.db, {
      entity_type: "ticket",
      entity_id: ticket.id,
      actor,
      event_type: DEFECT_ESCAPED_WITHDRAWN_EVENT,
      payload: { regression_of: target.id, regression_of_number: target.number ?? null },
    });
    return { ticketId: ticket.id, regressionOf: target.id, recorded: true, eventId };
  });
}

/** Every standing regression link (the event log folded, see services/escapedDefects.ts). */
export function regressionLinkRows(host: RegressionHost): RegressionLink[] {
  const rows = host.db
    .prepare(
      `SELECT entity_id AS ticketId, event_type AS eventType, actor_type AS actorType,
              actor_id AS actorId, created_at AS at,
              json_extract(payload_json, '$.regression_of') AS regressionOf,
              json_extract(payload_json, '$.note') AS note
         FROM work_events
        WHERE entity_type = 'ticket' AND event_type IN (?, ?)
        ORDER BY rowid`,
    )
    .all(DEFECT_ESCAPED_EVENT, DEFECT_ESCAPED_WITHDRAWN_EVENT) as RegressionEventRow[];
  return currentRegressionLinks(rows);
}

export function regressionLinksOf(
  host: Pick<RegressionHost, "db" | "regressionLinkRows">,
  ticketId: string,
): TicketView["regression"] {
  const links = host.regressionLinkRows();
  const side = (otherId: string, l: RegressionLink): RegressionLinkView[] => {
    const row = host.db
      .prepare(`SELECT number, title, status FROM tickets WHERE id = ?`)
      .get(otherId) as { number: number | null; title: string; status: string } | undefined;
    if (!row) return [];
    return [
      {
        ticket_id: otherId,
        number: row.number,
        title: row.title,
        status: row.status,
        filed_by: l.filedBy,
        filed_at: l.filedAt,
        note: l.note,
      },
    ];
  };
  return {
    regression_of: links
      .filter((l) => l.ticketId === ticketId)
      .flatMap((l) => side(l.regressionOf, l)),
    regressed_by: links
      .filter((l) => l.regressionOf === ticketId)
      .flatMap((l) => side(l.ticketId, l)),
  };
}
