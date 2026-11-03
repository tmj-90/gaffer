/**
 * Ticket links the facade makes in one transaction: a ticket created with its repo, scope
 * and access links, decisions linked by any ticket reference, and EPIC MEMBERSHIP: the
 * acceptance ticket's dependency on each confirmed member, wired and withdrawn as scope
 * links change.
 */
import { inTransaction } from "../db/connection.js";
import {
  type Actor,
  type Decision,
  type DecisionSeverity,
  type Ticket,
  type TicketScopeNode,
} from "../domain/types.js";
import { writeEvent } from "../events/eventWriter.js";
import { EPIC_MEMBER_RELATIONS, ownAcceptanceTicketId } from "./epicAcceptance.js";
import { DispatchError } from "../util/errors.js";
import type { Dispatch } from "../core.js";

/** What these functions read from the {@link Dispatch} facade they are handed. */
export type TicketLinksHost = Pick<
  Dispatch,
  | "db"
  | "decisionSvc"
  | "linkTicketScope"
  | "repoSvc"
  | "resolveTicket"
  | "scope"
  | "scopeNodes"
  | "ticketDependencies"
  | "ticketSvc"
  | "tickets"
>;

/**
 * Create a ticket AND its links in ONE transaction: the primary repo, the scope
 * nodes (the first primary, the rest secondary) and the confirmed per-repo access.
 * A bad reference (unknown repo or scope node) rolls the whole create back, so a
 * failed POST /tickets or MCP create_ticket never leaves an orphan draft for a
 * retry to duplicate. (better-sqlite3 nests the services' own transactions as
 * savepoints, as createDraftTicket already relies on.)
 */
export function createTicketWithLinks(
  host: TicketLinksHost,
  raw: unknown,
  links: {
    repo?: string | undefined;
    scopeNodeIds?: readonly string[] | undefined;
    repoAccess?: ReadonlyArray<{ repo_id: string; access: string }> | undefined;
  },
  actor: Actor,
): Ticket {
  return inTransaction(host.db, () => {
    const ticket = host.ticketSvc.createTicket(raw, actor);
    if (links.repo) host.repoSvc.linkRepository(ticket.id, links.repo, "primary", actor);
    (links.scopeNodeIds ?? []).forEach((scopeNodeId, i) => {
      host.linkTicketScope(
        {
          ticket_id: ticket.id,
          scope_node_id: scopeNodeId,
          relation: i === 0 ? "primary" : "secondary",
        },
        actor,
      );
    });
    for (const r of links.repoAccess ?? []) {
      host.repoSvc.setTicketRepoAccess(
        { ticket_id: ticket.id, repo_id: r.repo_id, access: r.access, relation: "confirmed" },
        actor,
      );
    }
    return ticket;
  });
}

export function linkTicketScope(
  host: TicketLinksHost,
  raw: unknown,
  actor: Actor,
): TicketScopeNode {
  return inTransaction(host.db, () => {
    const link = host.scope.linkTicketScope(raw, actor);
    wireEpicAcceptance(host, link.ticket_id, link.scope_node_id, link.relation, actor);
    unwireEpicAcceptance(host, link.ticket_id, link.scope_node_id, actor);
    return link;
  });
}

export function setPrimaryScope(
  host: TicketLinksHost,
  ticketRef: string,
  scopeNodeId: string,
  actor: Actor,
): TicketScopeNode {
  return inTransaction(host.db, () => {
    const link = host.scope.setPrimaryScope(ticketRef, scopeNodeId, actor);
    wireEpicAcceptance(host, link.ticket_id, link.scope_node_id, link.relation, actor);
    return link;
  });
}

/**
 * EPIC MEMBERSHIP (external review #8): a ticket confirmed into an epic after it was
 * planned (a `primary` / `secondary` link) is part of the build the epic's acceptance
 * ticket must test, so that acceptance ticket now DEPENDS on it, exactly like the
 * members createEpic wired: the final cannot be claimed until the new member is done.
 * Before this the final ran (and the epic read accepted) with the new member still
 * ready. Nothing is wired for a suggested / rejected link, an acceptance ticket, a
 * cancelled member, or a final already done or cancelled (`wg stats` then reads the
 * epic pending / stale instead of accepted). Inside the caller's transaction.
 */
export function wireEpicAcceptance(
  host: Pick<TicketLinksHost, "db" | "scopeNodes" | "ticketDependencies" | "ticketSvc" | "tickets">,
  ticketId: string,
  scopeNodeId: string,
  relation: string,
  actor: Actor,
): void {
  if (!(EPIC_MEMBER_RELATIONS as readonly string[]).includes(relation)) return;
  const node = host.scopeNodes.findById(scopeNodeId);
  if (!node || node.type !== "epic") return;
  const ticket = host.tickets.findById(ticketId);
  if (!ticket || ticket.acceptance === 1 || ticket.status === "cancelled") return;
  const finalId = ownAcceptanceTicketId(host.db, scopeNodeId);
  if (finalId === null || finalId === ticket.id) return;
  const final = host.tickets.findById(finalId);
  if (!final || final.status === "done" || final.status === "cancelled") return;
  if (host.ticketDependencies.exists(final.id, ticket.id)) return;
  try {
    host.ticketSvc.addDependency({ ticket: final.id, depends_on: ticket.id }, actor);
  } catch (err) {
    // A member that itself waits on the final (a follow-up that depends on it) cannot
    // also be a dependency of it. The link stands; `wg stats` reads the epic pending,
    // then stale, until its acceptance ticket is re-run on the finished scope.
    if (err instanceof DispatchError && err.code === "INVALID_DEPENDENCY") return;
    throw err;
  }
  // Marks this edge as the membership's, so withdrawing the membership withdraws it.
  writeEvent(host.db, {
    entity_type: "ticket",
    entity_id: final.id,
    actor,
    event_type: "epic.member_dependency_wired",
    payload: { epic_node_id: scopeNodeId, member_ticket_id: ticket.id },
  });
}

/**
 * EPIC MEMBERSHIP: the reverse of wireEpicAcceptance. When a ticket stops being a
 * confirmed member of an epic (its link removed, or changed to suggested / rejected),
 * the dependency of the epic's acceptance ticket on it goes too, but only an edge the
 * membership wired (an explicit dependency someone added stays), and never on a final
 * already done or cancelled. Before this, a ticket taken out of the epic kept its
 * acceptance ticket blocked (DEPENDENCY_BLOCKED) on work that was no longer in scope.
 */
export function unwireEpicAcceptance(
  host: Pick<TicketLinksHost, "db" | "scopeNodes" | "ticketDependencies" | "ticketSvc" | "tickets">,
  ticketId: string,
  scopeNodeId: string,
  actor: Actor,
): void {
  const node = host.scopeNodes.findById(scopeNodeId);
  if (!node || node.type !== "epic") return;
  const finalId = ownAcceptanceTicketId(host.db, scopeNodeId);
  if (finalId === null || finalId === ticketId) return;
  const final = host.tickets.findById(finalId);
  if (!final || final.status === "done" || final.status === "cancelled") return;
  const stillMember = host.db
    .prepare(
      `SELECT 1 AS hit FROM ticket_scope_nodes WHERE ticket_id = ? AND scope_node_id = ?
         AND relation IN (${EPIC_MEMBER_RELATIONS.map((r) => `'${r}'`).join(", ")})`,
    )
    .get(ticketId, scopeNodeId);
  if (stillMember) return;
  if (!host.ticketDependencies.exists(final.id, ticketId)) return;
  const last = (eventType: string, field: string, value: string): number => {
    const row = host.db
      .prepare(
        `SELECT MAX(rowid) AS r FROM work_events
          WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = ?
            AND json_extract(payload_json, '$.' || ?) = ?`,
      )
      .get(final.id, eventType, field, value) as { r: number | null } | undefined;
    return Number(row?.r ?? 0);
  };
  const wired = last("epic.member_dependency_wired", "member_ticket_id", ticketId);
  // The current edge is the membership's only if nobody removed and re-added it since.
  if (wired === 0 || last("ticket.dependency_removed", "depends_on_ticket_id", ticketId) > wired)
    return;
  host.ticketSvc.removeDependency(final.id, ticketId, actor);
}

export function removeTicketScope(
  host: TicketLinksHost,
  ticketRef: string,
  scopeNodeId: string,
  actor: Actor,
): { ticketId: string; scopeNodeId: string; eventId: string } {
  return inTransaction(host.db, () => {
    const res = host.scope.removeTicketScope(ticketRef, scopeNodeId, actor);
    unwireEpicAcceptance(host, res.ticketId, res.scopeNodeId, actor);
    return res;
  });
}

export function createDecision(
  host: TicketLinksHost,
  input: {
    title: string;
    question: string;
    severity?: DecisionSeverity;
    ticketId?: string;
    ticketIds?: readonly string[];
  },
  actor: Actor,
): Decision {
  // Accept any ticket reference (id, 15, #15, T-15) like every other ticket tool; the
  // link table stores the id, so an unresolved number would fail its foreign key.
  const ticketId = input.ticketId ? host.resolveTicket(input.ticketId).id : undefined;
  const ticketIds = input.ticketIds?.map((ref) => host.resolveTicket(ref).id);
  return host.decisionSvc.createDecision(
    {
      ...input,
      ...(ticketId !== undefined ? { ticketId } : {}),
      ...(ticketIds !== undefined ? { ticketIds } : {}),
    },
    actor,
  );
}
