/**
 * Per-principal API credentials: minting, listing and revoking them, resolving a bearer
 * token, and the PRINCIPAL SCOPES check REST and the CLI share. The pure rules live in
 * principalService.ts and accessScope.ts (the light modules the CLI's fast paths load); this
 * module is their database side.
 */
import { inTransaction } from "../db/connection.js";
import { type Actor } from "../domain/types.js";
import { writeEvent } from "../events/eventWriter.js";
import {
  type PrincipalActorType,
  type PrincipalCapability,
  type PrincipalView,
} from "../repositories/principalRepository.js";
import {
  hashPrincipalToken,
  mintPrincipalToken,
  PRINCIPAL_NAME_RE,
  principalAccess,
  principalActor,
} from "./principalService.js";
import {
  type Access,
  type AccessAction,
  type ScopeTicket,
  authorizeAccess,
  describeDenial,
  isScoped,
  evaluateTicketScope,
} from "./accessScope.js";
import { DispatchError, notFound } from "../util/errors.js";
import { newId } from "../util/id.js";
import type { Dispatch } from "../core.js";

/** What these functions read from the {@link Dispatch} facade they are handed. */
export type PrincipalAdminHost = Pick<
  Dispatch,
  "clock" | "db" | "getDecision" | "principals" | "repos" | "resolveTicket" | "tickets"
>;

/**
 * Mint a named bearer credential bound to an actor identity and a capability.
 * Returns the token ONCE (it is never stored — only its SHA-256). The creating
 * actor and the new principal's identity are recorded as a `principal.created`
 * event so the credential's provenance is in the tamper-evident log.
 */
export function createPrincipal(
  host: PrincipalAdminHost,
  input: {
    name: string;
    capability?: PrincipalCapability | undefined;
    actorType?: PrincipalActorType | undefined;
    actorId?: string | undefined;
    /** Repo names or ids: the principal may reach only tickets on these repos. */
    repos?: readonly string[] | undefined;
    /** Ticket numbers or ids: the principal may reach these tickets. */
    tickets?: ReadonlyArray<string | number> | undefined;
  },
  actor: Actor,
): { principal: PrincipalView; token: string } {
  const name = String(input.name ?? "").trim();
  if (!PRINCIPAL_NAME_RE.test(name)) {
    throw new DispatchError(
      "VALIDATION_ERROR",
      "Principal name must be 1–64 characters: letters, digits, '.', '_', '@' or '-', starting with a letter or digit.",
      { name },
    );
  }
  if (host.principals.getByName(name)) {
    throw new DispatchError("DUPLICATE", `A principal named '${name}' already exists.`, { name });
  }
  const capability = input.capability ?? "full";
  const actorType = input.actorType ?? "human";
  const actorId = String(input.actorId ?? name).trim() || name;
  // IDENTITY COLLISION (exploratory finding api/F8): a principal (human or admin) may not
  // speak as a registered agent's id. One recorded "human/<agent id>" approval on that agent's
  // own delivery, and the dashboard showed the delivering agent as its own approver.
  // Case-insensitively: an agent id in capitals is the same id to a reader.
  const agentWithId = host.db
    .prepare("SELECT id FROM agents WHERE lower(id) = lower(?) LIMIT 1")
    .get(actorId) as { id: string } | undefined;
  if (agentWithId) {
    throw new DispatchError(
      "DUPLICATE",
      `actor_id '${actorId}' is a registered agent's id; a ${actorType} principal needs its own identity (pick another actor_id). Nothing was created.`,
      { reason: "actor_id_is_agent", actor_id: actorId, actor_type: actorType },
    );
  }
  // PRINCIPAL SCOPES: resolve every repo and ticket now (an unknown one is a 404
  // and nothing is created); the row stores ids, so a rename keeps the grant.
  const scopeRepos =
    input.repos && input.repos.length > 0
      ? [
          ...new Map(
            input.repos.map((ref) => {
              const r = host.repos.findByName(ref) ?? host.repos.findById(ref);
              if (!r) throw notFound("repository", ref);
              return [r.id, r] as const;
            }),
          ).values(),
        ]
      : undefined;
  const scopeTickets =
    input.tickets && input.tickets.length > 0
      ? [
          ...new Map(
            input.tickets.map((ref) => {
              const t = host.resolveTicket(String(ref));
              return [t.id, t] as const;
            }),
          ).values(),
        ]
      : undefined;
  const token = mintPrincipalToken();
  const now = host.clock.now();
  const principal = inTransaction(host.db, () => {
    const row = host.principals.insert({
      id: newId(),
      name,
      tokenHash: hashPrincipalToken(token),
      capability,
      actorType,
      actorId,
      createdBy: actor.id ?? actor.type,
      now,
      scopeRepos: scopeRepos?.map((r) => r.id),
      scopeTickets: scopeTickets?.map((t) => t.id),
    });
    writeEvent(host.db, {
      entity_type: "principal",
      entity_id: row.id,
      actor,
      event_type: "principal.created",
      payload: {
        name,
        capability,
        actor_type: actorType,
        actor_id: actorId,
        ...(scopeRepos ? { scope_repos: scopeRepos.map((r) => r.name) } : {}),
        ...(scopeTickets ? { scope_tickets: scopeTickets.map((t) => t.number) } : {}),
      },
    });
    return row;
  });
  return { principal, token };
}

/** One principal by id or name (revoked ones included). Throws NOT_FOUND. */
export function getPrincipal(host: PrincipalAdminHost, ref: string): PrincipalView {
  const row = host.principals.get(ref) ?? host.principals.getByName(ref);
  if (!row) throw notFound("principal", ref);
  return row;
}

/** Revoke by id or name. Idempotent on an already-revoked principal (NO_OP). */
export function revokePrincipal(
  host: PrincipalAdminHost,
  ref: string,
  actor: Actor,
): PrincipalView {
  const row = host.principals.get(ref) ?? host.principals.getByName(ref);
  if (!row) throw notFound("principal", ref);
  if (row.revoked_at) {
    throw new DispatchError("NO_OP", `Principal '${row.name}' is already revoked.`, {
      id: row.id,
    });
  }
  const now = host.clock.now();
  return inTransaction(host.db, () => {
    host.principals.revoke(row.id, now);
    writeEvent(host.db, {
      entity_type: "principal",
      entity_id: row.id,
      actor,
      event_type: "principal.revoked",
      payload: { name: row.name },
    });
    const after = host.principals.get(row.id);
    if (!after) throw notFound("principal", ref);
    return after;
  });
}

/**
 * PRINCIPAL SCOPES: a ticket as the scope evaluation sees it. Its repos are its
 * confirmed WRITE repos (what a delivery changes); a ticket with none is judged on
 * every repo linked to it (rejected suggestions aside), and one with no repo at all
 * is reachable only through a ticket scope.
 */
export function scopeTicket(host: PrincipalAdminHost, ref: string): ScopeTicket {
  const ticket = host.resolveTicket(ref);
  return scopeTicketFor(host, ticket.id, ticket.number);
}

export function scopeTicketFor(
  host: Pick<PrincipalAdminHost, "repos">,
  id: string,
  number: number | null,
): ScopeTicket {
  const links = host.repos.listForTicket(id);
  const writes = links.filter(
    (l) =>
      l.access === "write" &&
      ["confirmed", "implicit_single_repo"].includes(String(l.relation ?? "")),
  );
  const linked = links.filter((l) => String(l.relation ?? "") !== "rejected");
  return { id, number, repos: (writes.length > 0 ? writes : linked).map((l) => l.id) };
}

/**
 * The ticket filter for a scoped principal: true for every ticket it may see (the
 * read rule is the write rule). Null when the principal is unscoped, so a caller
 * can skip filtering altogether.
 */
export function ticketVisibility(
  host: PrincipalAdminHost,
  principal: PrincipalView,
): ((ticketId: string) => boolean) | null {
  const access = principalAccess(principal);
  if (!isScoped(access.scope)) return null;
  const memo = new Map<string, boolean>();
  return (ticketId: string): boolean => {
    const hit = memo.get(ticketId);
    if (hit !== undefined) return hit;
    const t = host.tickets.findById(ticketId);
    const ok = t
      ? evaluateTicketScope(access.scope, scopeTicketFor(host, t.id, t.number)).allowed
      : false;
    memo.set(ticketId, ok);
    return ok;
  };
}

/** The tickets a decision is linked to (blocks or informs), for the scope check. */
export function decisionTicketIds(host: PrincipalAdminHost, decisionId: string): string[] {
  host.getDecision(decisionId); // NOT_FOUND for an unknown decision
  return (
    host.db
      .prepare("SELECT DISTINCT ticket_id FROM ticket_decisions WHERE decision_id = ?")
      .all(decisionId) as Array<{ ticket_id: string }>
  ).map((r) => r.ticket_id);
}

/**
 * PRINCIPAL SCOPES: refuse an action outside what a principal may do — the one check
 * REST and the CLI share (services/accessScope.ts decides; this names the scope).
 * Throws READ_ONLY_TOKEN for a write by a read-only principal, else SCOPE_DENIED
 * with `details.scope` (the repos and tickets it holds), `details.reason`, and the
 * ticket / repos / requirement that put the action outside it.
 */
export function assertPrincipalAccess(
  host: PrincipalAdminHost,
  principal: PrincipalView,
  action: AccessAction,
  access: Access = principalAccess(principal),
): void {
  const d = authorizeAccess(access, action);
  if (d.allowed) return;
  if (d.code === "READ_ONLY_TOKEN") {
    throw new DispatchError("READ_ONLY_TOKEN", describeDenial("read_only", { scope: "" }));
  }
  const scope = principal.scope ?? { repos: null, tickets: null };
  const label =
    [
      scope.repos ? `repos ${scope.repos.map((r) => r.name ?? r.id).join(", ")}` : "",
      scope.tickets ? `tickets ${scope.tickets.map((t) => `#${t.number ?? t.id}`).join(", ")}` : "",
    ]
      .filter((x) => x !== "")
      .join(" and ") || "no scope";
  const ticket =
    action.kind === "read_ticket" || action.kind === "write_ticket" ? action.ticket : undefined;
  const repoName = (id: string): string => host.repos.findById(id)?.name ?? id;
  const outside = d.outsideRepos.map(repoName);
  throw new DispatchError(
    "SCOPE_DENIED",
    describeDenial(d.reason, {
      scope: label,
      ticket: ticket
        ? `ticket #${ticket.number ?? ticket.id}`
        : action.kind === "create_ticket"
          ? "the new ticket"
          : undefined,
      outsideRepos: outside,
    }),
    {
      principal: principal.name,
      scope,
      reason: d.reason,
      ...(ticket ? { ticket: ticket.number ?? ticket.id } : {}),
      ...(outside.length > 0 ? { outside_repos: outside } : {}),
      ...(d.reason === "admin_required" ? { required: "admin" } : {}),
    },
  );
}

/**
 * Authenticate a bearer credential against the ACTIVE principals. Returns the
 * principal and the actor it speaks for, or null for an unknown/revoked token.
 * Stamps `last_used_at` at most once a minute per principal (best-effort).
 */
export function resolvePrincipalToken(
  host: PrincipalAdminHost,
  token: string,
): { principal: PrincipalView; actor: Actor } | null {
  const row = host.principals.findActiveByHash(hashPrincipalToken(token));
  if (!row) return null;
  const now = host.clock.now();
  if (!row.last_used_at || Date.parse(now) - Date.parse(row.last_used_at) > 60_000) {
    try {
      host.principals.touch(row.id, now);
    } catch {
      // A usage stamp must never fail authentication.
    }
  }
  return { principal: row, actor: principalActor(row) };
}
