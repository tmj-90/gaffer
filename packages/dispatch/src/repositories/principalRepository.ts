import type { Db } from "../db/connection.js";

/**
 * PER-PRINCIPAL CREDENTIALS — data access for `api_principals` (schema v24).
 *
 * A dumb store: rows hold the SHA-256 of a bearer token, the actor the token
 * speaks for, its capability tier and its optional repo/ticket scope (v31).
 * Token generation, hashing and the authentication decision live in {@link import("../services/principalService.js")}
 * and `api/auth.ts`; nothing here reads the environment or compares secrets.
 * Rows are never deleted — revocation stamps `revoked_at` so the record of who
 * held access survives.
 */

export const PRINCIPAL_CAPABILITIES = ["full", "read"] as const;
export type PrincipalCapability = (typeof PRINCIPAL_CAPABILITIES)[number];

export const PRINCIPAL_ACTOR_TYPES = ["human", "admin"] as const;
export type PrincipalActorType = (typeof PRINCIPAL_ACTOR_TYPES)[number];

/** One stored row (snake_case, straight from the table). Never exposes the token. */
export interface PrincipalRow {
  id: string;
  name: string;
  token_hash: string;
  capability: PrincipalCapability;
  actor_type: PrincipalActorType;
  actor_id: string;
  created_by: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  /** JSON array of repository ids (schema v31); NULL: no repo scope. */
  scope_repos: string | null;
  /** JSON array of ticket ids (schema v31); NULL: no ticket scope. */
  scope_tickets: string | null;
}

/**
 * A principal's scope as callers see it: each axis is null when unset, else the
 * repos (id + current name) or tickets (id + number) it grants. A repo or ticket
 * deleted since keeps its id with a null name/number, so the grant stays visible.
 */
export interface PrincipalScopeView {
  repos: Array<{ id: string; name: string | null }> | null;
  tickets: Array<{ id: string; number: number | null }> | null;
}

/** The public view: everything but the hash, with the scope resolved (null: unscoped). */
export type PrincipalView = Omit<PrincipalRow, "token_hash" | "scope_repos" | "scope_tickets"> & {
  scope: PrincipalScopeView | null;
};

export interface PrincipalInsert {
  id: string;
  name: string;
  tokenHash: string;
  capability: PrincipalCapability;
  actorType: PrincipalActorType;
  actorId: string;
  createdBy: string | null;
  now: string;
  /** Repository ids (undefined: no repo scope). */
  scopeRepos?: readonly string[] | undefined;
  /** Ticket ids (undefined: no ticket scope). */
  scopeTickets?: readonly string[] | undefined;
}

const PUBLIC_COLUMNS =
  "id, name, capability, actor_type, actor_id, created_by, created_at, last_used_at, revoked_at, " +
  "scope_repos, scope_tickets";

type StoredRow = Omit<PrincipalRow, "token_hash">;

function idList(json: string | null): string[] | null {
  if (json === null) return null;
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    // A corrupt scope must never widen access: an unreadable axis grants nothing.
    return [];
  }
}

export class PrincipalRepository {
  constructor(private readonly db: Db) {}

  insert(input: PrincipalInsert): PrincipalView {
    this.db
      .prepare(
        `INSERT INTO api_principals
           (id, name, token_hash, capability, actor_type, actor_id, created_by, created_at,
            scope_repos, scope_tickets)
         VALUES (@id, @name, @tokenHash, @capability, @actorType, @actorId, @createdBy, @now,
                 @scopeRepos, @scopeTickets)`,
      )
      .run({
        id: input.id,
        name: input.name,
        tokenHash: input.tokenHash,
        capability: input.capability,
        actorType: input.actorType,
        actorId: input.actorId,
        createdBy: input.createdBy,
        now: input.now,
        scopeRepos: input.scopeRepos ? JSON.stringify([...input.scopeRepos]) : null,
        scopeTickets: input.scopeTickets ? JSON.stringify([...input.scopeTickets]) : null,
      });
    const row = this.get(input.id);
    if (!row) throw new Error("api_principals insert did not persist");
    return row;
  }

  /** A stored row with its scope resolved to names and numbers. */
  private view(row: StoredRow | undefined): PrincipalView | undefined {
    if (!row) return undefined;
    const { scope_repos, scope_tickets, ...rest } = row;
    const repos = idList(scope_repos);
    const tickets = idList(scope_tickets);
    const repoName = this.db.prepare("SELECT name FROM repositories WHERE id = ?");
    const ticketNo = this.db.prepare("SELECT number FROM tickets WHERE id = ?");
    const scope: PrincipalScopeView | null =
      repos === null && tickets === null
        ? null
        : {
            repos:
              repos?.map((id) => ({
                id,
                name: (repoName.get(id) as { name: string } | undefined)?.name ?? null,
              })) ?? null,
            tickets:
              tickets?.map((id) => ({
                id,
                number: (ticketNo.get(id) as { number: number } | undefined)?.number ?? null,
              })) ?? null,
          };
    return { ...rest, scope };
  }

  get(id: string): PrincipalView | undefined {
    return this.view(
      this.db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM api_principals WHERE id = ?`).get(id) as
        StoredRow | undefined,
    );
  }

  getByName(name: string): PrincipalView | undefined {
    return this.view(
      this.db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM api_principals WHERE name = ?`).get(name) as
        StoredRow | undefined,
    );
  }

  /** Newest first; revoked rows included so the history is visible. */
  list(): PrincipalView[] {
    return (
      this.db
        .prepare(`SELECT ${PUBLIC_COLUMNS} FROM api_principals ORDER BY created_at DESC, name ASC`)
        .all() as StoredRow[]
    ).map((r) => this.view(r) as PrincipalView);
  }

  /** The ACTIVE row for a token hash, or undefined (unknown or revoked). */
  findActiveByHash(tokenHash: string): PrincipalView | undefined {
    return this.view(
      this.db
        .prepare(
          `SELECT ${PUBLIC_COLUMNS} FROM api_principals WHERE token_hash = ? AND revoked_at IS NULL`,
        )
        .get(tokenHash) as StoredRow | undefined,
    );
  }

  /** Stamp revoked_at once; returns false when the row is missing or already revoked. */
  revoke(id: string, now: string): boolean {
    const info = this.db
      .prepare("UPDATE api_principals SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(now, id);
    return info.changes > 0;
  }

  /** Best-effort usage stamp (coarse: the caller throttles to once a minute). */
  touch(id: string, now: string): void {
    this.db.prepare("UPDATE api_principals SET last_used_at = ? WHERE id = ?").run(now, id);
  }
}
