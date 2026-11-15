/**
 * Per-principal API credentials: minting, listing and revoking them, resolving a bearer
 * token, and the PRINCIPAL SCOPES check REST and the CLI share. The pure rules live in
 * principalService.ts and accessScope.ts (the light modules the CLI's fast paths load); this
 * module is their database side.
 */
import { createHash } from "node:crypto";

import { inTransaction } from "../db/connection.js";
import { type Actor } from "../domain/types.js";
import { writeEvent } from "../events/eventWriter.js";
import { GateKeyError } from "../events/gateSeal.js";
import {
  matchingCreationEvent,
  readPrincipalRow,
  retirePrincipalSeal,
  sealPrincipal,
  unsignedPrincipalMessage,
  unsignedPrincipals,
  verifyPrincipal,
  type UnsignedPrincipal,
} from "../events/principalSeal.js";
import {
  type PrincipalActorType,
  type PrincipalCapability,
  type PrincipalScopeView,
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
  decisionInScope,
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
  | "clock"
  | "db"
  | "gateKeyring"
  | "getDecision"
  | "principals"
  | "repos"
  | "resolveTicket"
  | "tickets"
>;

/** A key this process may not sign with: the whole act rolls back. */
function refuseSealKey(e: unknown): never {
  if (e instanceof GateKeyError) {
    throw new DispatchError(
      "GATE_KEY_REFUSED",
      `Nothing was recorded: ${e.message}. Principals are signed with the factory key on the host (gaffer setup creates it).`,
      { reason: e.why },
    );
  }
  throw e;
}

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
    const eventId = writeEvent(host.db, {
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
    // SEALED PRINCIPALS: the row is honoured only with this seal (same transaction: a key
    // that cannot be used rolls the whole creation back).
    try {
      sealPrincipal(host.db, host.gateKeyring, row.id, eventId, now);
    } catch (e) {
      refuseSealKey(e);
    }
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
    // SEALED PRINCIPALS: the seal is retired with the revocation, and the revocation event
    // supersedes any copy of it restored later.
    retirePrincipalSeal(host.db, row.id);
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
 * DECISION VISIBILITY for a holder whose ticket filter is `ticketVisible`: a predicate
 * on a decision id, true when the holder may read that decision (the one rule,
 * {@link decisionInScope}). Null when the holder is unscoped (no filtering). An unknown
 * decision is not visible.
 */
export function decisionVisibility(
  host: PrincipalAdminHost,
  ticketVisible: ((ticketId: string) => boolean) | null,
): ((decisionId: string) => boolean) | null {
  if (!ticketVisible) return null;
  const memo = new Map<string, boolean>();
  const linked = host.db.prepare(
    "SELECT DISTINCT ticket_id FROM ticket_decisions WHERE decision_id = ?",
  );
  return (decisionId: string): boolean => {
    const hit = memo.get(decisionId);
    if (hit !== undefined) return hit;
    const ids = (linked.all(decisionId) as Array<{ ticket_id: string }>).map((r) => r.ticket_id);
    const ok = decisionInScope(ids, ticketVisible);
    memo.set(decisionId, ok);
    return ok;
  };
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
  // SEALED PRINCIPALS: an active row is a principal only with a valid seal under the
  // factory key; anything else is refused exactly like an unknown token. Never creates a
  // key or a seal.
  const check = verifyPrincipal(host.db, host.gateKeyring, row.id);
  if (!check.ok) {
    logUnsignedPrincipal(row.id, row.name, check);
    return null;
  }
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

/**
 * Where a refused unsigned principal is reported: the REST server sets a sink (one
 * server-side line per principal and reason per process, not one per request). The CLI
 * sets none: its refusal is the same one-line error as an unknown token.
 */
let unsignedLog: ((line: string) => void) | null = null;
export function setUnsignedPrincipalLog(sink: ((line: string) => void) | null): void {
  unsignedLog = sink;
}
const LOGGED_UNSIGNED = new Set<string>();
function logUnsignedPrincipal(
  id: string,
  name: string,
  check: Parameters<typeof unsignedPrincipalMessage>[1],
): void {
  if (!unsignedLog) return;
  const key = `${id}:${check.ok ? "" : check.failure}`;
  if (LOGGED_UNSIGNED.has(key)) return;
  LOGGED_UNSIGNED.add(key);
  try {
    unsignedLog(`dispatch: sign-in refused: ${unsignedPrincipalMessage(name, check)}`);
  } catch {
    // logging never decides authentication
  }
}

/** Every active principal this factory does not honour (doctor, the dashboard callout). */
export type UnsignedPrincipalView = UnsignedPrincipal;
export function listUnsignedPrincipals(host: PrincipalAdminHost): UnsignedPrincipal[] {
  return unsignedPrincipals(host.db, host.gateKeyring);
}

/** One unsigned principal as a person reviews it: what it may do, where, made by whom. */
export type UnsignedPrincipalReviewRow = UnsignedPrincipal & { scope: PrincipalScopeView | null };

/**
 * What a person reviews before re-signing with `all`: every active unsigned principal with
 * its capability, actor, scope (resolved to repo names and ticket numbers), created_by and
 * created_at, and a FINGERPRINT of exactly that list. `resign --all` signs only when it is
 * handed the fingerprint of the list as it still is: a row added or changed after the
 * review is never signed by it.
 *
 * Why a review and not a rule: a process that can write the database can also append a
 * `principal.created` event that matches its forged row (the chain has no key), so "its
 * creation is on record" cannot tell a forged row from a real one. Only a person who knows
 * which sign-ins they made can.
 */
export interface UnsignedPrincipalReview {
  unsigned: UnsignedPrincipalReviewRow[];
  fingerprint: string;
}

export function reviewUnsignedPrincipals(host: PrincipalAdminHost): UnsignedPrincipalReview {
  const unsigned = unsignedPrincipals(host.db, host.gateKeyring);
  return {
    unsigned: unsigned.map((u) => ({ ...u, scope: host.principals.get(u.id)?.scope ?? null })),
    fingerprint: reviewFingerprint(host, unsigned),
  };
}

/** The fingerprint of an unsigned list: every row's stored identity and authority. */
function reviewFingerprint(host: PrincipalAdminHost, unsigned: UnsignedPrincipal[]): string {
  const rows = unsigned
    .map((u) => readPrincipalRow(host.db, u.id))
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .map((r) => [
      r.id,
      r.name,
      r.token_hash,
      r.capability,
      r.actor_type,
      r.actor_id,
      r.scope_repos,
      r.scope_tickets,
      r.created_at,
      r.created_by,
    ])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return createHash("sha256")
    .update(JSON.stringify(["gaffer-unsigned-principals", 1, rows]))
    .digest("hex")
    .slice(0, 16);
}

export interface ResignResult {
  resigned: Array<{ id: string; name: string; event_id: string }>;
  skipped: Array<{ id: string; name: string; reason: string }>;
}

/**
 * RE-SIGN principals the factory does not honour (created before signing, restored from a
 * backup, or written outside the factory): a PERSON's deliberate act, operator only (the
 * REST and CLI gates refuse every principal token; the safety hook denies the verb to
 * agents). Each re-signed row gets a `principal.resigned` event and a fresh seal in one
 * transaction. Nothing is ever signed on upgrade or on a read.
 *
 * `all`: the person reviewed the list ({@link reviewUnsignedPrincipals}) and passes its
 * fingerprint as `confirm`; without it, or when the list changed since, nothing is signed.
 * Of that list, a row with no matching `principal.created` event is still skipped and must
 * be named on purpose (a heuristic for a row inserted straight into the database: a forged
 * event defeats it, which is why the review is required). `names`: exactly those (a revoked
 * or unknown one is refused; an already signed one is skipped).
 */
export function resignPrincipals(
  host: PrincipalAdminHost,
  input: {
    names?: readonly string[] | undefined;
    all?: boolean | undefined;
    confirm?: string | undefined;
  },
  actor: Actor,
): ResignResult {
  const names = (input.names ?? []).map((n) => String(n).trim()).filter((n) => n !== "");
  if (!input.all && names.length === 0) {
    throw new DispatchError(
      "VALIDATION_ERROR",
      "Name the principals to re-sign, or pass --all with the confirmation code of the list you reviewed (gaffer wg principal unsigned).",
    );
  }
  if (input.all && names.length > 0) {
    throw new DispatchError("VALIDATION_ERROR", "Pass names or --all, not both.");
  }
  const confirm = String(input.confirm ?? "").trim();
  if (input.all && confirm === "") {
    throw new DispatchError(
      "VALIDATION_ERROR",
      "Nothing was re-signed: review the unsigned principals first (gaffer wg principal unsigned lists who each one is, what it may do and who created it), then pass the confirmation code it prints: gaffer wg principal resign --all --confirm <code>. A row written into the database can carry a forged creation event, so only your review tells it apart.",
    );
  }
  const result: ResignResult = { resigned: [], skipped: [] };
  const now = host.clock.now();
  inTransaction(host.db, () => {
    const targets: Array<{ id: string; name: string; explicit: boolean }> = [];
    if (input.all) {
      const list = unsignedPrincipals(host.db, host.gateKeyring);
      if (reviewFingerprint(host, list) !== confirm) {
        throw new DispatchError(
          "STATE_CONFLICT",
          "Nothing was re-signed: the unsigned principals changed since you reviewed them (a sign-in was added, changed or removed). Review the list again (gaffer wg principal unsigned) and confirm its new code.",
          { reason: "review_stale" },
        );
      }
      for (const u of list) targets.push({ id: u.id, name: u.name, explicit: false });
    } else {
      for (const ref of names) {
        const row = host.principals.get(ref) ?? host.principals.getByName(ref);
        if (!row) throw notFound("principal", ref);
        if (row.revoked_at) {
          throw new DispatchError(
            "STATE_CONFLICT",
            `Principal '${row.name}' is revoked; a revoked principal is never re-signed (create a new one). Nothing was re-signed.`,
            { name: row.name },
          );
        }
        targets.push({ id: row.id, name: row.name, explicit: true });
      }
    }
    for (const t of targets) {
      const before = verifyPrincipal(host.db, host.gateKeyring, t.id);
      if (before.ok) {
        result.skipped.push({ id: t.id, name: t.name, reason: "already signed" });
        continue;
      }
      const row = readPrincipalRow(host.db, t.id);
      if (!row || row.revoked_at !== null) {
        result.skipped.push({ id: t.id, name: t.name, reason: "revoked" });
        continue;
      }
      const created = matchingCreationEvent(host.db, row);
      if (!created && !t.explicit) {
        result.skipped.push({
          id: t.id,
          name: t.name,
          reason:
            "no matching principal.created event on record (the shape of a row written outside the factory): review it and re-sign it by name, or revoke it",
        });
        continue;
      }
      const eventId = writeEvent(host.db, {
        entity_type: "principal",
        entity_id: t.id,
        actor,
        event_type: "principal.resigned",
        payload: {
          name: row.name,
          capability: row.capability,
          actor_type: row.actor_type,
          actor_id: row.actor_id,
          scoped: row.scope_repos !== null || row.scope_tickets !== null,
          creation_event: created,
          was: before.failure,
        },
      });
      try {
        sealPrincipal(host.db, host.gateKeyring, t.id, eventId, now);
      } catch (e) {
        refuseSealKey(e);
      }
      result.resigned.push({ id: t.id, name: t.name, event_id: eventId });
    }
  });
  return result;
}
