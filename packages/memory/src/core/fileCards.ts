/**
 * File Cards — retrieval-aid index for the file graph (migration 006).
 *
 * A file card is a HEURISTIC summary of one file in a repository. Its
 * purpose is to help agents choose what to read — not to replace reading
 * the actual file before editing. This framing is non-negotiable and must
 * be surfaced in every agent-facing prompt that references cards.
 *
 * TRUST SPLIT (see plan §split-trust, enforced here, not by callers):
 *   - card_status = 'active'  → mechanical fields (path, content_hash, loc,
 *     symbols, source) are valid and are always returned.
 *   - model_status = 'active' → tldr / rolePrimary / roleTags are valid and
 *     are returned alongside the mechanical fields.
 *   When model_status ≠ 'active', those three fields are null'd out in the
 *   returned FileCard even if the underlying row holds a value. Callers must
 *   never bypass this by reading the DB directly.
 *
 * ISOLATION (non-negotiable):
 *   This module has NO imports from dispatch or crew. File cards are a
 *   standalone memory primitive. Scope resolution lives in the runner; it
 *   is the runner's job to pass paths/queries to this layer, not the other
 *   way around.
 *
 * WRITE DISCIPLINE:
 *   Every card write and its corresponding FTS row update happen inside ONE
 *   db.transaction call. A failed write leaves neither the card row nor its
 *   FTS entry in a partial state. The same discipline applies to watermark
 *   writes via setWatermark.
 */
import { createHash } from "node:crypto";

import type { Database } from "better-sqlite3";

import { newLoreId } from "./ids.js";
import type {
  CardStatus,
  FileCard,
  FileCardRow,
  ModelStatus,
  RepoSync,
  RepoSyncRow,
} from "../db/types.js";

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Repo names are the join key across the whole factory — trim only, no
 * case-folding. Mirrors normaliseRepo in lore.ts / boundaries.ts so the
 * same repo string lines up across record kinds.
 */
function normaliseRepo(r: string): string {
  return r.trim();
}

/**
 * Stable, opaque identity key for a repo. Computed as the sha256 hex
 * digest of the canonical path or remote URL — NOT the friendly display
 * name. This means:
 *   - renames of the display label don't orphan cards
 *   - two worktrees of the same remote share a key
 *   - a local path and its remote origin produce distinct keys (correct:
 *     they could diverge)
 *
 * `canonical` should be the normalised absolute path (for local repos) or
 * the remote origin URL (for remote repos). Callers are responsible for
 * canonicalising before calling.
 */
export function repoKey(canonical: string): string {
  return createHash("sha256").update(canonical).digest("hex");
}

// ── FTS helpers ───────────────────────────────────────────────────────

/**
 * Derive the symbols_fts column value from a parsed symbols array.
 * A flat space-joined string so FTS5 tokenises individual symbol names.
 * Mirrors the lore_fts discipline: updated in TS, not via SQL triggers.
 */
function symbolsToFts(symbols: ReadonlyArray<string>): string {
  return symbols.join(" ");
}

/**
 * Translate a free-text query into an FTS5 MATCH expression.
 * OR-mode with optional prefix, mirroring toFtsQuery in lore.ts.
 * Multiple tokens joined with OR so partial matches surface; bm25
 * does the ranking.
 */
function toFtsQuery(input: string, prefix = false): string {
  const parts = input
    .split(/\s+/)
    .map((p) => p.replace(/"/g, ""))
    .filter(Boolean);
  if (parts.length === 0) return '""';
  const tokens = parts.map((p) => (prefix && p.length >= 3 ? `"${p}"*` : `"${p}"`));
  return tokens.length === 1 ? tokens[0]! : tokens.join(" OR ");
}

// ── Row → domain object ───────────────────────────────────────────────

/**
 * Convert a raw FileCardRow to the public FileCard shape, applying the
 * trust-split serving rule:
 *
 *   - mechanical fields (path, contentHash, loc, symbols, source,
 *     syncedCommit) are always included when card_status = 'active'.
 *   - tldr / rolePrimary / roleTags are null'd unless model_status = 'active'.
 *
 * This function is the ONLY place where the trust-split rule is applied.
 * Callers receive a consistent, trustworthy shape without needing to
 * implement the rule themselves.
 */
function rowToFileCard(row: FileCardRow): FileCard {
  const modelActive = row.model_status === "active";

  let symbols: ReadonlyArray<string>;
  try {
    const parsed: unknown = JSON.parse(row.symbols);
    symbols = Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    symbols = [];
  }

  let roleTags: ReadonlyArray<string> | null = null;
  if (modelActive && row.role_tags !== null) {
    try {
      const parsed: unknown = JSON.parse(row.role_tags);
      roleTags = Array.isArray(parsed) ? (parsed as string[]) : null;
    } catch {
      roleTags = null;
    }
  }

  return {
    id: row.id,
    repoKey: row.repo_key,
    repo: row.repo,
    path: row.path,
    contentHash: row.content_hash,
    loc: row.loc,
    symbols,
    syncedCommit: row.synced_commit ?? undefined,
    source: row.source,
    // Trust-split: serve model fields only when model is active.
    tldr: modelActive ? row.tldr : null,
    rolePrimary: modelActive ? row.role_primary : null,
    roleTags: modelActive ? roleTags : null,
    cardStatus: row.card_status,
    modelStatus: row.model_status,
    validatedAt: row.validated_at ?? undefined,
    validationError: row.validation_error ?? undefined,
    model: row.model ?? undefined,
    promptVersion: row.prompt_version ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRepoSync(row: RepoSyncRow): RepoSync {
  return {
    repoKey: row.repo_key,
    repo: row.repo,
    syncedCommit: row.synced_commit,
    updatedAt: row.updated_at,
  };
}

// ── Upsert ────────────────────────────────────────────────────────────

export interface UpsertFileCardInput {
  readonly repoKey: string;
  /** Display name for the repo (not used as a key). */
  readonly repo: string;
  readonly path: string;
  readonly contentHash: string;
  readonly loc: number;
  readonly symbols: ReadonlyArray<string>;
  readonly syncedCommit?: string;
  readonly source: string;
  readonly tldr?: string;
  readonly rolePrimary?: string;
  readonly roleTags?: ReadonlyArray<string>;
  readonly cardStatus?: CardStatus;
  readonly modelStatus?: ModelStatus;
  readonly validatedAt?: string;
  readonly validationError?: string;
  readonly model?: string;
  readonly promptVersion?: string;
}

/**
 * Insert or update a file card. The UPSERT key is (repo_key, path).
 *
 * The card row write and the file_card_fts update happen inside ONE
 * db.transaction. A failed write (e.g. a CHECK constraint violation)
 * rolls back both, so the FTS index and the card table always agree.
 * Appends a 'file_card_upserted' event keyed by 'repo_key:path' for the
 * audit trail (mirrors the events discipline in lore.ts / repoUnderstanding.ts).
 *
 * symbols_fts is derived from the symbols array at write time — a flat
 * space-joined string that FTS5 can tokenise per-symbol.
 */
export function upsertFileCard(db: Database, input: UpsertFileCardInput): FileCard {
  const rk = input.repoKey;
  if (!rk) throw new Error("upsertFileCard: repoKey must be non-empty");
  const repo = normaliseRepo(input.repo);
  if (!repo) throw new Error("upsertFileCard: repo must be non-empty");
  const path = input.path.trim();
  if (!path) throw new Error("upsertFileCard: path must be non-empty");
  if (!input.contentHash) throw new Error("upsertFileCard: contentHash must be non-empty");
  if (!input.source.trim()) throw new Error("upsertFileCard: source must be non-empty");

  const symbolsJson = JSON.stringify(input.symbols ?? []);
  const symbolsFts = symbolsToFts(input.symbols ?? []);
  const roleTagsJson = input.roleTags !== undefined ? JSON.stringify(input.roleTags) : null;
  const ts = nowIso();
  const cardStatus: CardStatus = input.cardStatus ?? "active";
  const modelStatus: ModelStatus = input.modelStatus ?? "absent";

  const eventKey = `${rk}:${path}`;

  const tx = db.transaction(() => {
    // Check for an existing row to get its rowid for FTS maintenance.
    const existingRow = db
      .prepare("SELECT rowid FROM file_card WHERE repo_key = ? AND path = ?")
      .get(rk, path) as { rowid: number } | undefined;

    let rowid: number;

    if (existingRow) {
      db.prepare(
        `UPDATE file_card SET
           repo = ?, content_hash = ?, loc = ?, symbols = ?,
           synced_commit = ?, source = ?, tldr = ?, role_primary = ?,
           role_tags = ?, card_status = ?, model_status = ?,
           validated_at = ?, validation_error = ?, model = ?,
           prompt_version = ?, updated_at = ?
         WHERE repo_key = ? AND path = ?`,
      ).run(
        repo,
        input.contentHash,
        input.loc,
        symbolsJson,
        input.syncedCommit ?? null,
        input.source,
        input.tldr ?? null,
        input.rolePrimary ?? null,
        roleTagsJson,
        cardStatus,
        modelStatus,
        input.validatedAt ?? null,
        input.validationError ?? null,
        input.model ?? null,
        input.promptVersion ?? null,
        ts,
        rk,
        path,
      );
      rowid = existingRow.rowid;

      // Maintain FTS: delete the stale row before inserting the fresh one.
      db.prepare("DELETE FROM file_card_fts WHERE rowid = ?").run(rowid);
    } else {
      const newId = newLoreId();
      const info = db
        .prepare(
          `INSERT INTO file_card
             (id, repo_key, repo, path, content_hash, loc, symbols,
              synced_commit, source, tldr, role_primary, role_tags,
              card_status, model_status, validated_at, validation_error,
              model, prompt_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newId,
          rk,
          repo,
          path,
          input.contentHash,
          input.loc,
          symbolsJson,
          input.syncedCommit ?? null,
          input.source,
          input.tldr ?? null,
          input.rolePrimary ?? null,
          roleTagsJson,
          cardStatus,
          modelStatus,
          input.validatedAt ?? null,
          input.validationError ?? null,
          input.model ?? null,
          input.promptVersion ?? null,
          ts,
          ts,
        );
      rowid = Number(info.lastInsertRowid);
    }

    // Insert fresh FTS row. tldr is indexed ONLY when model_status = 'active':
    // a failed or absent summary shouldn't drive search ranking. path and
    // symbols_fts are always indexed so mechanical fields remain discoverable.
    const ftsTldr = modelStatus === "active" ? (input.tldr ?? null) : null;
    db.prepare("INSERT INTO file_card_fts(rowid, path, tldr, symbols_fts) VALUES (?, ?, ?, ?)").run(
      rowid,
      path,
      ftsTldr,
      symbolsFts,
    );

    // Audit trail: one event per upsert, keyed by 'repo_key:path'.
    db.prepare(
      "INSERT INTO events (lore_id, kind, ts, payload) VALUES (?, 'file_card_upserted', ?, ?)",
    ).run(eventKey, ts, JSON.stringify({ repoKey: rk, path, cardStatus, modelStatus }));
  });
  tx();

  return getFileCard(db, rk, path)!;
}

// ── Read ──────────────────────────────────────────────────────────────

/**
 * Fetch a single card by (repoKey, path).
 *
 * Applies the trust-split serving rule via rowToFileCard:
 *   - Returns the card when card_status = 'active'.
 *   - Returns null when card_status ≠ 'active' (stale / shadow cards are
 *     not served through this function — callers who want them should
 *     query the DB directly and own the caveats).
 *   - tldr / rolePrimary / roleTags are null'd unless model_status = 'active',
 *     even if the underlying row holds values.
 */
export function getFileCard(db: Database, rk: string, path: string): FileCard | null {
  const row = db
    .prepare("SELECT * FROM file_card WHERE repo_key = ? AND path = ? AND card_status = 'active'")
    .get(rk, path) as FileCardRow | undefined;
  return row ? rowToFileCard(row) : null;
}

// ── Search ────────────────────────────────────────────────────────────

const SEARCH_FILE_CARDS_DEFAULT_LIMIT = 20;

/**
 * FTS5 bm25 search over file cards in a repo. Searches path, tldr, and
 * symbols_fts columns. Only 'active' cards are returned.
 *
 * Uses OR-join + prefix approach mirroring searchLore in lore.ts. bm25
 * column weights: path is the strongest signal (agents usually know what
 * file or module they want), then tldr, then symbol name breadcrumbs.
 *
 * Trust-split applies: model fields in results follow the same rule as
 * getFileCard — null'd unless model_status = 'active'.
 */
export function searchFileCards(
  db: Database,
  rk: string,
  query: string,
  limit = SEARCH_FILE_CARDS_DEFAULT_LIMIT,
): FileCard[] {
  if (!query.trim()) return [];
  const ftsQuery = toFtsQuery(query.trim(), true);
  const rows = db
    .prepare(
      `SELECT fc.*
       FROM file_card fc
       JOIN file_card_fts fts ON fts.rowid = fc.rowid
       WHERE file_card_fts MATCH ?
         AND fc.repo_key = ?
         AND fc.card_status = 'active'
       ORDER BY bm25(file_card_fts, 3.0, 2.0, 1.0) ASC
       LIMIT ?`,
    )
    .all(ftsQuery, rk, limit) as FileCardRow[];
  return rows.map(rowToFileCard);
}

// ── Bulk lookup ───────────────────────────────────────────────────────

/**
 * Fetch active cards for a specific list of paths (exact match). Useful
 * when the runner has already resolved a scope to a set of file paths and
 * wants to pull their cards without going through FTS.
 *
 * Returns only 'active' cards; paths with no card or with stale/shadow
 * status are silently omitted — callers should treat absence as "no card,
 * read the file normally".
 */
export function listCardsForPaths(
  db: Database,
  rk: string,
  paths: ReadonlyArray<string>,
): FileCard[] {
  if (paths.length === 0) return [];
  const placeholders = paths.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT * FROM file_card
       WHERE repo_key = ?
         AND path IN (${placeholders})
         AND card_status = 'active'
       ORDER BY path`,
    )
    .all(rk, ...paths) as FileCardRow[];
  return rows.map(rowToFileCard);
}

/**
 * Fetch active cards whose path starts with any of the given prefixes.
 * Useful for scope expansion: if the runner passes directory paths (e.g.
 * "src/api"), this returns all carded files under those directories.
 *
 * Trailing "/" is normalised away before the LIKE pattern is built so
 * both "src/api" and "src/api/" produce the same prefix match.
 *
 * Only 'active' cards are returned; paths with no card or with stale/shadow
 * status are silently omitted — callers treat absence as "no card, read
 * the file normally".
 */
export function listCardsForPathPrefixes(
  db: Database,
  rk: string,
  prefixes: ReadonlyArray<string>,
): FileCard[] {
  if (prefixes.length === 0) return [];
  const conditions = prefixes.map(() => "path LIKE ?").join(" OR ");
  // Normalise: strip trailing "/" then append "/%"
  const likeArgs = prefixes.map((p) => `${p.replace(/\/+$/, "")}/%`);
  const rows = db
    .prepare(
      `SELECT * FROM file_card
       WHERE repo_key = ?
         AND card_status = 'active'
         AND (${conditions})
       ORDER BY path`,
    )
    .all(rk, ...likeArgs) as FileCardRow[];
  return rows.map(rowToFileCard);
}

// ── Watermark ─────────────────────────────────────────────────────────

/**
 * Fetch the current watermark (last synced commit) for a repo. Returns
 * null when no onboard scan has completed yet.
 */
export function getWatermark(db: Database, rk: string): RepoSync | null {
  const row = db.prepare("SELECT * FROM repo_sync WHERE repo_key = ?").get(rk) as
    | RepoSyncRow
    | undefined;
  return row ? rowToRepoSync(row) : null;
}

/**
 * Write (or replace) the watermark for a repo. Called at the end of an
 * onboard scan to record which commit the card set was built from.
 * Wrapped in a transaction to stay consistent with the event log pattern
 * used by digest writes (upsertDigest in repoUnderstanding.ts).
 */
export function setWatermark(db: Database, rk: string, repo: string, commit: string): RepoSync {
  const normRepo = normaliseRepo(repo);
  if (!rk) throw new Error("setWatermark: repoKey must be non-empty");
  if (!normRepo) throw new Error("setWatermark: repo must be non-empty");
  if (!commit.trim()) throw new Error("setWatermark: commit must be non-empty");

  const ts = nowIso();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO repo_sync (repo_key, repo, synced_commit, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(repo_key) DO UPDATE SET
         repo = excluded.repo,
         synced_commit = excluded.synced_commit,
         updated_at = excluded.updated_at`,
    ).run(rk, normRepo, commit, ts);
    db.prepare(
      "INSERT INTO events (lore_id, kind, ts, payload) VALUES (?, 'repo_sync_updated', ?, ?)",
    ).run(rk, ts, JSON.stringify({ repoKey: rk, repo: normRepo, syncedCommit: commit }));
  });
  tx();
  return getWatermark(db, rk)!;
}

// ── Review gate (semantic validation) ────────────────────────────────

/**
 * Downgrade a card's model_status to 'failed_validation' after a semantic
 * review (the review gate in onboard-analyze.mjs). Only touches the model
 * trust fields — mechanical fields (path, content_hash, loc, symbols) are
 * never modified by this call.
 *
 * Also removes the tldr from the FTS index (tldr is only indexed when
 * model_status = 'active') so a downgraded summary doesn't continue to
 * drive search ranking.
 *
 * Returns true when the row was updated (i.e. the card existed and had
 * model_status = 'active'), false otherwise.
 */
export function markCardReviewFailed(
  db: Database,
  rk: string,
  path: string,
  reason: string,
): boolean {
  const ts = nowIso();
  let changed = false;

  const tx = db.transaction(() => {
    // Only downgrade cards that currently have model_status = 'active'.
    // A card already in 'failed_validation' or 'absent' is left alone.
    const existing = db
      .prepare(
        "SELECT rowid FROM file_card WHERE repo_key = ? AND path = ? AND model_status = 'active'",
      )
      .get(rk, path) as { rowid: number } | undefined;
    if (!existing) return;

    db.prepare(
      `UPDATE file_card SET
         model_status = 'failed_validation',
         validation_error = ?,
         validated_at = ?,
         updated_at = ?
       WHERE repo_key = ? AND path = ?`,
    ).run(reason, ts, ts, rk, path);

    // Remove tldr from FTS — only indexed when model_status = 'active'.
    db.prepare("DELETE FROM file_card_fts WHERE rowid = ?").run(existing.rowid);
    const row = db
      .prepare("SELECT path, symbols FROM file_card WHERE repo_key = ? AND path = ?")
      .get(rk, path) as { path: string; symbols: string } | undefined;
    if (row) {
      let symsText = "";
      try {
        const parsed: unknown = JSON.parse(row.symbols);
        if (Array.isArray(parsed)) symsText = (parsed as string[]).join(" ");
      } catch {
        /* symsText stays as "" */
      }
      db.prepare(
        "INSERT INTO file_card_fts(rowid, path, tldr, symbols_fts) VALUES (?, ?, NULL, ?)",
      ).run(existing.rowid, row.path, symsText);
    }

    db.prepare(
      "INSERT INTO events (lore_id, kind, ts, payload) VALUES (?, 'file_card_review_failed', ?, ?)",
    ).run(`${rk}:${path}`, ts, JSON.stringify({ repoKey: rk, path, reason }));
    changed = true;
  });
  tx();
  return changed;
}
