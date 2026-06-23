/**
 * Verified-absence markers.
 *
 * Records "we checked here, nothing relevant exists, this is intentional
 * for now". When `search_lore` returns zero hits AND a matching active
 * marker exists, the response is decorated with the marker so the next
 * agent knows it's an acknowledged gap rather than an oversight. Markers
 * expire (default 14 days) so stale "we checked" claims age out
 * automatically instead of becoming permanent dead-end annotations.
 *
 * Distinct from drafts. Drafts gate on human review; absence markers are
 * low-stakes ("we looked, nothing here") and self-expiring, so they have
 * no approval surface. They are recorded explicitly — never auto-emitted
 * on every zero-hit search, since that would surface every random one-off
 * query as a marker.
 */
import type { Database } from "better-sqlite3";

import { newLoreId } from "./ids.js";

export interface AbsenceMarker {
  readonly id: string;
  readonly query: string;
  readonly repo: string | null;
  readonly reason: string;
  readonly recordedAt: string;
  readonly expiresAt: string;
  readonly recordedBy: string;
}

export interface RecordAbsenceInput {
  readonly query: string;
  readonly reason: string;
  readonly repo?: string;
  readonly recordedBy: string;
  /**
   * Default 14. Shorter half-life than the 30 we originally shipped —
   * external review flagged that MCP-writable retrieval state is a
   * trust-model exception and should age out faster by default. CLI
   * callers can still pass --expires-days for longer retention.
   * Clamped [1, 365] by the CLI/MCP layer; core trusts the caller.
   */
  readonly expiresInDays?: number;
}

/** Default expiry. Kept here so CLI + MCP + tests all agree. */
export const DEFAULT_ABSENCE_EXPIRY_DAYS = 14;

/**
 * Normalise a query for marker matching. Order-independent (sorted),
 * case-insensitive, whitespace-collapsed. Not synonym-aware — that's
 * fine; the agent re-records if its phrasing differs enough to matter,
 * and over-aggressive matching would silently swallow real searches.
 *
 *   "Retry policy payments-svc" → "payments-svc policy retry"
 *   "payments-svc retry policy"  → "payments-svc policy retry"  (same key)
 *   "backoff strategy"           → "backoff strategy"            (distinct)
 */
export function normaliseAbsenceQuery(q: string): string {
  return q
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .sort()
    .join(" ");
}

/**
 * Does a recorded marker apply to a search query? Both inputs are
 * already-normalised keys (see `normaliseAbsenceQuery`). We match on
 * token-set CONTAINMENT in either direction: the marker fires when its
 * tokens are a subset of the query's, OR the query's are a subset of the
 * marker's. Exact match is the degenerate (mutual-subset) case.
 *
 * Why containment rather than exact equality: exact-key matching meant
 * one extra or missing token missed entirely, so the feature almost
 * never fired in practice ("payments-svc retry policy" wouldn't match a
 * "retry policy" marker). Containment fixes the common add/drop-a-word
 * case while staying conservative — it deliberately does NOT match on
 * mere overlap ("retry policy" vs "policy timeout" share a token but
 * neither contains the other, so no match), preserving the existing
 * "not synonym-aware, won't silently swallow unrelated searches"
 * property the module documents.
 *
 * Empty keys never match (defensive; a blank query has no tokens).
 */
export function absenceQueryMatches(markerKey: string, queryKey: string): boolean {
  if (markerKey.length === 0 || queryKey.length === 0) return false;
  if (markerKey === queryKey) return true;
  const markerTokens = markerKey.split(" ");
  const queryTokens = new Set(queryKey.split(" "));
  const markerSet = new Set(markerTokens);
  // marker ⊆ query ?
  const markerSubsetOfQuery = markerTokens.every((t) => queryTokens.has(t));
  if (markerSubsetOfQuery) return true;
  // query ⊆ marker ?
  return [...queryTokens].every((t) => markerSet.has(t));
}

function nowIso(): string {
  return new Date().toISOString();
}

function isoNDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 86400_000).toISOString();
}

function rowToMarker(row: {
  id: string;
  query: string;
  repo: string | null;
  reason: string;
  recorded_at: string;
  expires_at: string;
  recorded_by: string;
}): AbsenceMarker {
  return {
    id: row.id,
    query: row.query,
    repo: row.repo,
    reason: row.reason,
    recordedAt: row.recorded_at,
    expiresAt: row.expires_at,
    recordedBy: row.recorded_by,
  };
}

export function recordAbsence(
  db: Database,
  input: RecordAbsenceInput,
): { id: string; expiresAt: string } {
  if (input.query.trim().length === 0) {
    throw new Error("recordAbsence: query must be non-empty");
  }
  if (input.reason.trim().length === 0) {
    throw new Error("recordAbsence: reason must be non-empty");
  }
  const id = newLoreId();
  const recordedAt = nowIso();
  const expiresAt = isoNDaysFromNow(input.expiresInDays ?? DEFAULT_ABSENCE_EXPIRY_DAYS);
  db.prepare(
    `INSERT INTO absence_markers (id, query, repo, reason, recorded_at, expires_at, recorded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    normaliseAbsenceQuery(input.query),
    input.repo ?? null,
    input.reason.trim(),
    recordedAt,
    expiresAt,
    input.recordedBy,
  );
  return { id, expiresAt };
}

/**
 * Return the most-recent active (non-expired) marker matching the
 * normalised query under token-set containment (see
 * `absenceQueryMatches`). When `repo` is given, prefer markers scoped to
 * that repo; fall back to global markers (repo IS NULL) if no
 * repo-specific marker matches. Returns null when nothing matches.
 *
 * Matching happens in TS rather than SQL because containment isn't a
 * column equality. We scan active markers in each scope tier ordered by
 * recency and take the first match — the active-marker set is bounded
 * (markers self-expire, default 14 days), so the scan is cheap. The
 * `expires_at > now` predicate and `idx_absence_expires` keep the
 * candidate set to live markers only.
 */
export function findActiveAbsence(
  db: Database,
  opts: { query: string; repo?: string },
): AbsenceMarker | null {
  const key = normaliseAbsenceQuery(opts.query);
  if (key.length === 0) return null;
  const now = nowIso();
  const firstMatch = (rows: Array<Parameters<typeof rowToMarker>[0]>): AbsenceMarker | null => {
    for (const r of rows) {
      if (absenceQueryMatches(r.query, key)) return rowToMarker(r);
    }
    return null;
  };
  if (opts.repo) {
    const specific = db
      .prepare(
        `SELECT * FROM absence_markers
         WHERE repo = ? AND expires_at > ?
         ORDER BY recorded_at DESC`,
      )
      .all(opts.repo, now) as Array<Parameters<typeof rowToMarker>[0]>;
    const hit = firstMatch(specific);
    if (hit) return hit;
  }
  const global = db
    .prepare(
      `SELECT * FROM absence_markers
       WHERE repo IS NULL AND expires_at > ?
       ORDER BY recorded_at DESC`,
    )
    .all(now) as Array<Parameters<typeof rowToMarker>[0]>;
  return firstMatch(global);
}

/**
 * Hard-delete absence markers that have already expired. `findActiveAbsence`
 * and `listAbsences` already filter on `expires_at > now`, so expired rows
 * are invisible — but they accumulate forever without this. Returns the
 * number of rows deleted. Called opportunistically on prune; safe anytime.
 */
export function pruneExpiredAbsences(db: Database): number {
  const info = db.prepare("DELETE FROM absence_markers WHERE expires_at <= ?").run(nowIso());
  return info.changes;
}

export function listAbsences(
  db: Database,
  opts: { includeExpired?: boolean } = {},
): AbsenceMarker[] {
  const sql = opts.includeExpired
    ? "SELECT * FROM absence_markers ORDER BY recorded_at DESC"
    : "SELECT * FROM absence_markers WHERE expires_at > ? ORDER BY recorded_at DESC";
  const rows = (
    opts.includeExpired ? db.prepare(sql).all() : db.prepare(sql).all(nowIso())
  ) as Array<Parameters<typeof rowToMarker>[0]>;
  return rows.map(rowToMarker);
}
