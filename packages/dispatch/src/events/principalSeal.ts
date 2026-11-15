import { createHash } from "node:crypto";

import type { GateKeyring, SealDb } from "./gateSeal.js";
import {
  retireRowSeal,
  sealRow,
  verifyRowSeal,
  type RowFacts,
  type RowSealCheck,
  type RowSealSubject,
} from "./rowSeal.js";

/**
 * SEALED PRINCIPALS (events/rowSeal.ts applied to `api_principals`). A principal row is
 * honoured only with a valid seal under the factory key over its identity and authority
 * and the event that last set its state. The lifecycle events:
 *  - `principal.created`: the operator minted it (sealed in the same transaction);
 *  - `principal.resigned`: a person re-signed a row the factory does not trust yet (one
 *    created before signing, restored from a backup, or written outside the factory);
 *  - `principal.revoked`: the seal is retired; the event supersedes any seal before it.
 * SealDb only: the runner's landing check (node:sqlite) applies the same verification.
 */

export const PRINCIPAL_SEAL_KIND = "principal";
export const PRINCIPAL_LIFECYCLE_EVENTS = [
  "principal.created",
  "principal.resigned",
  "principal.revoked",
] as const;

/** The stored row, token hash included (never leaves this module's callers). */
export interface PrincipalSealRow {
  id: string;
  name: string;
  token_hash: string;
  capability: string;
  actor_type: string;
  actor_id: string;
  scope_repos: string | null;
  scope_tickets: string | null;
  created_at: string;
  created_by: string | null;
  revoked_at: string | null;
}

const ROW_COLUMNS =
  "id, name, token_hash, capability, actor_type, actor_id, scope_repos, scope_tickets, " +
  "created_at, created_by, revoked_at";

export function principalSubject(id: string): RowSealSubject {
  return {
    kind: PRINCIPAL_SEAL_KIND,
    rowId: id,
    entityType: "principal",
    lifecycleEvents: PRINCIPAL_LIFECYCLE_EVENTS,
  };
}

/** What a principal's seal binds: who it is and what it may do. */
export function principalFacts(row: PrincipalSealRow): RowFacts {
  return {
    id: row.id,
    name: row.name,
    token_hash: row.token_hash,
    capability: row.capability,
    actor_type: row.actor_type,
    actor_id: row.actor_id,
    scope_repos: row.scope_repos,
    scope_tickets: row.scope_tickets,
    created_at: row.created_at,
    created_by: row.created_by,
  };
}

export function readPrincipalRow(db: SealDb, id: string): PrincipalSealRow | null {
  const row = db.prepare(`SELECT ${ROW_COLUMNS} FROM api_principals WHERE id = ?`).get(id) as
    PrincipalSealRow | undefined;
  return row ?? null;
}

/** Seal principal `id` against event `eventId` (a trusted host act, in its transaction). */
export function sealPrincipal(
  db: SealDb,
  keyring: GateKeyring,
  id: string,
  eventId: string,
  now: string,
): void {
  const row = readPrincipalRow(db, id);
  if (!row) throw new Error(`principal ${id} is not on record`);
  sealRow(db, keyring, principalSubject(id), eventId, principalFacts(row), now);
}

/** Retire principal `id`'s seal (its revocation, in the same transaction). */
export function retirePrincipalSeal(db: SealDb, id: string): void {
  retireRowSeal(db, principalSubject(id));
}

/**
 * The principal `id` may act: on record, not revoked, and sealed by this factory for
 * its current identity, authority and state. Read-only; never creates a key or a seal.
 *
 * It answers a yes/no question about an ID. A caller that goes on to USE the row's
 * fields (who it acts as, what it may do, where) must not read the row again for them:
 * it reads the row once and hands that row to {@link verifyPrincipalRow}.
 */
export function verifyPrincipal(db: SealDb, keyring: GateKeyring, id: string): RowSealCheck {
  let row: PrincipalSealRow | null;
  try {
    row = readPrincipalRow(db, id);
  } catch (e) {
    return {
      ok: false,
      failure: "unreadable",
      detail: `the principal could not be read (${e instanceof Error ? e.message : String(e)})`,
    };
  }
  if (!row) return { ok: false, failure: "unsigned", detail: "the principal is not on record" };
  return verifyPrincipalRow(db, keyring, row);
}

/**
 * THESE facts are a principal that may act: `row` as the caller read it is not revoked
 * and carries a valid seal under the factory key over exactly its identity, token hash,
 * capability, actor and scope. The row is not read again, so what the caller accepts
 * from `row` afterwards is what was verified, whatever another connection writes between
 * the caller's read and this check. Read-only; never creates a key or a seal.
 */
export function verifyPrincipalRow(
  db: SealDb,
  keyring: GateKeyring,
  row: PrincipalSealRow,
): RowSealCheck {
  if (row.revoked_at !== null) {
    return { ok: false, failure: "superseded", detail: "the principal is revoked" };
  }
  return verifyRowSeal(db, keyring, principalSubject(row.id), principalFacts(row));
}

/**
 * The confirmation code of a set of principal rows AS HANDED IN: each row's stored
 * identity and authority, order-independent. What a person is shown and the code they
 * confirm must be computed from the same rows (`reviewUnsignedPrincipals`).
 */
export function principalRowsFingerprint(rows: readonly PrincipalSealRow[]): string {
  const facts = rows
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
    .update(JSON.stringify(["gaffer-unsigned-principals", 1, facts]))
    .digest("hex")
    .slice(0, 16);
}

/** The operator-facing sentence for a principal that is not signed (logs, doctor). */
export function unsignedPrincipalMessage(name: string, check: RowSealCheck): string {
  const why = check.ok ? "" : ` (${check.detail})`;
  if (!check.ok && check.failure === "missing_key") {
    return `principal ${name} cannot be checked: the factory key does not exist${why}; no principal signs in until it is restored or a person reviews and re-signs the principals under a new key (gaffer wg principal unsigned, then gaffer wg principal resign)`;
  }
  return `principal ${name} is not signed by this factory: it was created before signing, restored from a backup, or written outside the factory${why}. Review it, then re-sign it (gaffer wg principal resign ${name}) or revoke it`;
}

/** One active principal the factory does not honour, and why. */
export interface UnsignedPrincipal {
  id: string;
  name: string;
  capability: string;
  actor_type: string;
  actor_id: string;
  created_at: string;
  created_by: string | null;
  scoped: boolean;
  failure: string;
  detail: string;
  /** The `principal.created` event on record for it that matches the row, if any. */
  creation_event: string | null;
}

/**
 * The `principal.created` event for row `row` that matches it (same name, capability,
 * actor and scope axes, recorded by a person or the operator, not an agent), or null. A
 * row with none was not minted by this factory's own path (or its event is gone).
 */
export function matchingCreationEvent(db: SealDb, row: PrincipalSealRow): string | null {
  const events = db
    .prepare(
      "SELECT id, actor_type, payload_json FROM work_events WHERE entity_type = 'principal' " +
        "AND entity_id = ? AND event_type = 'principal.created' ORDER BY rowid ASC",
    )
    .all(row.id) as Array<{ id: string; actor_type: string; payload_json: string | null }>;
  const axis = (json: string | null): number | null => {
    if (json === null) return null;
    try {
      const v = JSON.parse(json) as unknown;
      return Array.isArray(v) ? v.length : -1;
    } catch {
      return -1;
    }
  };
  for (const ev of events) {
    if (String(ev.actor_type) === "agent") continue;
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(String(ev.payload_json ?? "{}")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const len = (v: unknown): number | null => (Array.isArray(v) ? v.length : null);
    if (
      p.name === row.name &&
      p.capability === row.capability &&
      p.actor_type === row.actor_type &&
      p.actor_id === row.actor_id &&
      len(p.scope_repos) === axis(row.scope_repos) &&
      len(p.scope_tickets) === axis(row.scope_tickets)
    ) {
      return String(ev.id);
    }
  }
  return null;
}

/** Every ACTIVE principal that does not verify (what a person reviews and re-signs). */
export function unsignedPrincipals(db: SealDb, keyring: GateKeyring): UnsignedPrincipal[] {
  return unsignedPrincipalRows(db, keyring).map((e) => e.unsigned);
}

/**
 * The same list with the stored row each entry was built from, so a caller can show a
 * row and fingerprint it without reading it again.
 */
export function unsignedPrincipalRows(
  db: SealDb,
  keyring: GateKeyring,
): Array<{ row: PrincipalSealRow; unsigned: UnsignedPrincipal }> {
  let rows: PrincipalSealRow[];
  try {
    rows = db
      .prepare(
        `SELECT ${ROW_COLUMNS} FROM api_principals WHERE revoked_at IS NULL ORDER BY created_at ASC, name ASC`,
      )
      .all() as PrincipalSealRow[];
  } catch {
    return [];
  }
  const out: Array<{ row: PrincipalSealRow; unsigned: UnsignedPrincipal }> = [];
  for (const row of rows) {
    const v = verifyRowSeal(db, keyring, principalSubject(row.id), principalFacts(row));
    if (v.ok) continue;
    out.push({
      row,
      unsigned: {
        id: row.id,
        name: row.name,
        capability: row.capability,
        actor_type: row.actor_type,
        actor_id: row.actor_id,
        created_at: row.created_at,
        created_by: row.created_by,
        scoped: row.scope_repos !== null || row.scope_tickets !== null,
        failure: v.failure,
        detail: v.detail,
        creation_event: matchingCreationEvent(db, row),
      },
    });
  }
  return out;
}
