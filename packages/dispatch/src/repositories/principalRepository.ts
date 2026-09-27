import type { Db } from "../db/connection.js";

/**
 * PER-PRINCIPAL CREDENTIALS — data access for `api_principals` (schema v24).
 *
 * A dumb store: rows hold the SHA-256 of a bearer token, the actor the token
 * speaks for and its capability tier. Token generation, hashing and the
 * authentication decision live in {@link import("../services/principalService.js")}
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
}

/** The public view: everything but the hash. */
export type PrincipalView = Omit<PrincipalRow, "token_hash">;

export interface PrincipalInsert {
  id: string;
  name: string;
  tokenHash: string;
  capability: PrincipalCapability;
  actorType: PrincipalActorType;
  actorId: string;
  createdBy: string | null;
  now: string;
}

const PUBLIC_COLUMNS =
  "id, name, capability, actor_type, actor_id, created_by, created_at, last_used_at, revoked_at";

export class PrincipalRepository {
  constructor(private readonly db: Db) {}

  insert(input: PrincipalInsert): PrincipalView {
    this.db
      .prepare(
        `INSERT INTO api_principals
           (id, name, token_hash, capability, actor_type, actor_id, created_by, created_at)
         VALUES (@id, @name, @tokenHash, @capability, @actorType, @actorId, @createdBy, @now)`,
      )
      .run(input);
    const row = this.get(input.id);
    if (!row) throw new Error("api_principals insert did not persist");
    return row;
  }

  get(id: string): PrincipalView | undefined {
    return this.db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM api_principals WHERE id = ?`).get(id) as
      PrincipalView | undefined;
  }

  getByName(name: string): PrincipalView | undefined {
    return this.db
      .prepare(`SELECT ${PUBLIC_COLUMNS} FROM api_principals WHERE name = ?`)
      .get(name) as PrincipalView | undefined;
  }

  /** Newest first; revoked rows included so the history is visible. */
  list(): PrincipalView[] {
    return this.db
      .prepare(`SELECT ${PUBLIC_COLUMNS} FROM api_principals ORDER BY created_at DESC, name ASC`)
      .all() as PrincipalView[];
  }

  /** The ACTIVE row for a token hash, or undefined (unknown or revoked). */
  findActiveByHash(tokenHash: string): PrincipalView | undefined {
    return this.db
      .prepare(
        `SELECT ${PUBLIC_COLUMNS} FROM api_principals WHERE token_hash = ? AND revoked_at IS NULL`,
      )
      .get(tokenHash) as PrincipalView | undefined;
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
