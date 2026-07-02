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
import { canonicalizeRepo, legacyRepoIdentityForms } from "./repoIdentity.js";
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
 * `canonical` may be passed in ANY form — a remote origin URL (ssh, https,
 * git://, scp-like) or a local path. It is run through `canonicalizeRepo`
 * here, at the single chokepoint, so every equivalent form of the same repo
 * produces the SAME key. This is what makes read (search / scope) and write
 * (onboard) agree: both go through this function, so neither can drift.
 * `canonicalizeRepo` is idempotent, so re-passing an already-normalised
 * canonical is safe.
 */
export function repoKey(canonical: string): string {
  return createHash("sha256").update(canonicalizeRepo(canonical)).digest("hex");
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
    canonical: row.canonical ?? undefined,
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
    // Recall-feedback signal (migration): set when this card was served into a
    // ticket that then needed rework. Read by cardsForScope to de-prioritise a
    // card that previously mis-led an agent. `?? 0` tolerates pre-migration /
    // partially-selected rows that don't carry the column.
    flaggedForReview: (row.flagged_for_review ?? 0) === 1,
  };
}

function rowToRepoSync(row: RepoSyncRow): RepoSync {
  return {
    repoKey: row.repo_key,
    canonical: row.canonical ?? undefined,
    repo: row.repo,
    syncedCommit: row.synced_commit,
    updatedAt: row.updated_at,
  };
}

// ── Upsert ────────────────────────────────────────────────────────────

export interface UpsertFileCardInput {
  readonly repoKey: string;
  /**
   * The repo's canonical identity (remote URL or path, any form). Stored —
   * after normalisation via `canonicalizeRepo` — in the `canonical` column so
   * a row can later be reverse-mapped / re-keyed. The `repoKey` above must be
   * `repoKey(canonical)`; the two are kept in sync by the CLI caller.
   */
  readonly canonical?: string;
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

  const canonical =
    input.canonical !== undefined && input.canonical.trim()
      ? canonicalizeRepo(input.canonical)
      : null;
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
           repo = ?, canonical = COALESCE(?, canonical), content_hash = ?,
           loc = ?, symbols = ?,
           synced_commit = ?, source = ?, tldr = ?, role_primary = ?,
           role_tags = ?, card_status = ?, model_status = ?,
           validated_at = ?, validation_error = ?, model = ?,
           prompt_version = ?, updated_at = ?
         WHERE repo_key = ? AND path = ?`,
      ).run(
        repo,
        canonical,
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
             (id, repo_key, canonical, repo, path, content_hash, loc, symbols,
              synced_commit, source, tldr, role_primary, role_tags,
              card_status, model_status, validated_at, validation_error,
              model, prompt_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newId,
          rk,
          canonical,
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

// ── Delete ────────────────────────────────────────────────────────────

/**
 * Hard-delete a file card by (repoKey, path): removes the `file_card` row AND
 * its `file_card_fts` entry inside ONE transaction, mirroring the upsert-txn
 * write discipline so the card table and FTS index never diverge. Used when a
 * file is deleted or renamed (the old path) so a stale card is TOMBSTONED
 * rather than left behind to mislead retrieval.
 *
 * Appends a 'file_card_deleted' event keyed by 'repo_key:path' for the audit
 * trail (mirrors the upsert / review-failed event discipline).
 *
 * Returns true when a row was removed, false when no card existed for the path
 * (a no-op delete is not an error — the caller's intent is satisfied either way).
 */
export function deleteFileCard(db: Database, rk: string, path: string): boolean {
  if (!rk) throw new Error("deleteFileCard: repoKey must be non-empty");
  const p = path.trim();
  if (!p) throw new Error("deleteFileCard: path must be non-empty");

  const ts = nowIso();
  let deleted = false;

  const tx = db.transaction(() => {
    const existing = db
      .prepare("SELECT rowid FROM file_card WHERE repo_key = ? AND path = ?")
      .get(rk, p) as { rowid: number } | undefined;
    if (!existing) return;

    // FTS first (external-content-free FTS5 table keyed by rowid), then the row.
    db.prepare("DELETE FROM file_card_fts WHERE rowid = ?").run(existing.rowid);
    db.prepare("DELETE FROM file_card WHERE rowid = ?").run(existing.rowid);

    db.prepare(
      "INSERT INTO events (lore_id, kind, ts, payload) VALUES (?, 'file_card_deleted', ?, ?)",
    ).run(`${rk}:${p}`, ts, JSON.stringify({ repoKey: rk, path: p }));
    deleted = true;
  });
  tx();
  return deleted;
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
export function setWatermark(
  db: Database,
  rk: string,
  repo: string,
  commit: string,
  canonical?: string,
): RepoSync {
  const normRepo = normaliseRepo(repo);
  if (!rk) throw new Error("setWatermark: repoKey must be non-empty");
  if (!normRepo) throw new Error("setWatermark: repo must be non-empty");
  if (!commit.trim()) throw new Error("setWatermark: commit must be non-empty");

  const canon = canonical !== undefined && canonical.trim() ? canonicalizeRepo(canonical) : null;
  const ts = nowIso();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO repo_sync (repo_key, canonical, repo, synced_commit, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(repo_key) DO UPDATE SET
         canonical = COALESCE(excluded.canonical, repo_sync.canonical),
         repo = excluded.repo,
         synced_commit = excluded.synced_commit,
         updated_at = excluded.updated_at`,
    ).run(rk, canon, normRepo, commit, ts);
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

// ── Fail-loud diagnostics (repo_key mismatch) ─────────────────────────

/** Active-card count under an exact repo_key. */
export function countActiveCards(db: Database, rk: string): number {
  const row = db
    .prepare("SELECT count(*) AS n FROM file_card WHERE repo_key = ? AND card_status = 'active'")
    .get(rk) as { n: number };
  return row.n;
}

/** A repo_key present in the store together with how many active cards it holds. */
export interface RepoKeyPresence {
  readonly repoKey: string;
  readonly count: number;
}

/**
 * Active-card counts grouped by repo_key for a given display name. Used to
 * detect the "silent 0 cards" trap: cards exist for the repo but under a
 * DIFFERENT key than the one the query resolved to.
 */
export function cardKeysForRepoName(db: Database, repo: string): RepoKeyPresence[] {
  const rows = db
    .prepare(
      `SELECT repo_key, count(*) AS n
         FROM file_card
        WHERE repo = ? AND card_status = 'active'
        GROUP BY repo_key
        ORDER BY n DESC`,
    )
    .all(normaliseRepo(repo)) as Array<{ repo_key: string; n: number }>;
  return rows.map((r) => ({ repoKey: r.repo_key, count: r.n }));
}

/**
 * FAIL LOUD, don't return an empty result silently. When the resolved
 * `rk` yields zero active cards but the store DOES hold cards for the same
 * display name under other keys, return a WARN string describing the
 * mismatch (and how to fix it). Returns null when there is genuinely
 * nothing to warn about (the key has cards, or the repo has none anywhere).
 */
export function diagnoseRepoKeyMismatch(
  db: Database,
  rk: string,
  repo: string,
  canonical: string,
): string | null {
  if (countActiveCards(db, rk) > 0) return null;
  const others = cardKeysForRepoName(db, repo).filter((k) => k.repoKey !== rk);
  if (others.length === 0) return null;
  const total = others.reduce((a, b) => a + b.count, 0);
  const keyList = others.map((o) => `${o.repoKey.slice(0, 12)}…(${o.count})`).join(", ");
  return (
    `0 cards for canonical '${canonicalizeRepo(canonical)}' (key ${rk.slice(0, 12)}…) — ` +
    `store has ${total} active card(s) for repo '${normaliseRepo(repo)}' under key(s) ${keyList}; ` +
    `canonical/key mismatch. Re-key with: ` +
    `memory cards rekey --canonical <this-canonical> --repo ${normaliseRepo(repo)}`
  );
}

// ── Migration: re-key a repo's rows to the normalised key ─────────────

export interface RekeyResult {
  readonly repo: string;
  /** The normalised canonical the rows are re-keyed to. */
  readonly canonical: string;
  /** The target key = repoKey(canonical). */
  readonly newKey: string;
  /** Provable legacy keys (with counts) migrated for this repo — scoped by
   *  computable legacy identity, never by display name. */
  readonly fromKeys: readonly RepoKeyPresence[];
  /** Number of file_card rows moved to newKey. */
  readonly cardsRekeyed: number;
  /**
   * Old rows dropped because newKey already held a card for that same path
   * (a partial re-onboard collision). The newKey row is authoritative; the
   * stale duplicate (and its FTS entry) is removed. Logged, never orphaned.
   */
  readonly collisionsDropped: number;
  /** Whether a repo_sync watermark row was moved to newKey. */
  readonly syncRekeyed: boolean;
  /** True when nothing needed moving (already on the normalised key). */
  readonly noop: boolean;
}

/**
 * The COMPUTABLE legacy repo_keys for a repo's canonical, excluding the
 * normalised `newKey` itself. Legacy rows were keyed as `sha256(rawForm)`
 * (see `legacyRepoIdentityForms`), so we hash every reconstructable form and
 * return the resulting keys. A stored row whose repo_key is in this set
 * PROVABLY belongs to this repo — it can only match if its onboard-time
 * identity canonicalises to the same repo.
 */
function legacyRepoKeys(canonicalRaw: string, newKey: string): string[] {
  const keys = new Set<string>();
  for (const form of legacyRepoIdentityForms(canonicalRaw)) {
    keys.add(createHash("sha256").update(form).digest("hex"));
  }
  keys.delete(newKey); // already-normalised rows are handled separately
  return [...keys];
}

/**
 * The legacy keys that are ACTUALLY present in the store for this repo and
 * would be migrated by `rekeyRepo` — i.e. un-migrated rows (`canonical IS
 * NULL`) whose repo_key is a provable legacy form of `canonicalRaw`. Used by
 * the `--dry-run` path so its report matches exactly what a real run moves.
 * Scoped by legacy key, NOT by display name.
 */
export function movableLegacyKeys(
  db: Database,
  repoName: string,
  canonicalRaw: string,
): RepoKeyPresence[] {
  const repo = normaliseRepo(repoName);
  const newKey = repoKey(canonicalRaw);
  const legacy = legacyRepoKeys(canonicalRaw, newKey);
  if (legacy.length === 0) return [];
  const placeholders = legacy.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT repo_key, count(*) AS n
         FROM file_card
        WHERE repo = ? AND card_status = 'active'
          AND canonical IS NULL AND repo_key IN (${placeholders})
        GROUP BY repo_key
        ORDER BY n DESC`,
    )
    .all(repo, ...legacy) as Array<{ repo_key: string; n: number }>;
  return rows.map((r) => ({ repoKey: r.repo_key, count: r.n }));
}

/**
 * Re-key a repo's LEGACY rows onto the normalised `repoKey(canonical)`. This
 * is the migration path for cards onboarded before canonicalisation existed:
 * their repo_key is an sha256 of an un-normalised URL/path that can't be
 * reversed from the hash alone.
 *
 * OWNERSHIP IS PROVEN, NEVER GUESSED (data-corruption guard):
 *   A row is migrated ONLY when it is un-migrated (`canonical IS NULL`) AND its
 *   repo_key equals `sha256(form)` for a form that canonicalises to THIS repo
 *   (see `legacyRepoIdentityForms`). We do NOT match by display name — two
 *   distinct repos can share one (`orgA/api` vs `orgB/api`), and matching by
 *   name re-keyed one repo's cards onto the other's key: silent cross-repo
 *   corruption. The legacy-key match cannot collide across distinct repos
 *   because the key is a hash of the repo's own identity.
 *
 * Guarantees:
 *   - ONE transaction — either the whole repo re-keys or none of it does.
 *   - FTS stays intact: repo_key is not an FTS column, so moving it needs
 *     no FTS change; the only FTS writes here are deletes for collision-
 *     dropped duplicates (their card row is removed too).
 *   - Path collisions under newKey are resolved by dropping the OLDER row —
 *     rows are processed newest-first (`ORDER BY updated_at DESC`), so the
 *     most recently updated card for a path survives; counted in
 *     `collisionsDropped`.
 *   - The `canonical` column is backfilled on every touched row.
 *
 * A repo with no un-migrated legacy rows is a no-op (noop=true).
 */
export function rekeyRepo(db: Database, repoName: string, canonicalRaw: string): RekeyResult {
  const repo = normaliseRepo(repoName);
  if (!repo) throw new Error("rekeyRepo: repo must be non-empty");
  if (!canonicalRaw.trim()) throw new Error("rekeyRepo: canonical must be non-empty");
  const canonical = canonicalizeRepo(canonicalRaw);
  const newKey = repoKey(canonicalRaw);

  const legacy = legacyRepoKeys(canonicalRaw, newKey);
  const fromKeys = movableLegacyKeys(db, repo, canonicalRaw);

  let cardsRekeyed = 0;
  let collisionsDropped = 0;
  let syncRekeyed = false;

  const tx = db.transaction(() => {
    // ── un-migrated file_card rows whose repo_key PROVABLY belongs to this
    // repo (a computable legacy form). Newest-first so a path collision under
    // newKey keeps the most recently updated card. NEVER matched by name. ──
    const legacyPlaceholders = legacy.map(() => "?").join(", ");
    const oldRows =
      legacy.length === 0
        ? []
        : (db
            .prepare(
              `SELECT rowid, path FROM file_card
                WHERE repo = ? AND canonical IS NULL AND repo_key IN (${legacyPlaceholders})
                ORDER BY updated_at DESC`,
            )
            .all(repo, ...legacy) as Array<{ rowid: number; path: string }>);

    const clashStmt = db.prepare("SELECT rowid FROM file_card WHERE repo_key = ? AND path = ?");
    for (const r of oldRows) {
      const clash = clashStmt.get(newKey, r.path) as { rowid: number } | undefined;
      if (clash) {
        // newKey already owns this path — drop the stale duplicate + its FTS.
        db.prepare("DELETE FROM file_card_fts WHERE rowid = ?").run(r.rowid);
        db.prepare("DELETE FROM file_card WHERE rowid = ?").run(r.rowid);
        collisionsDropped++;
      } else {
        db.prepare("UPDATE file_card SET repo_key = ?, canonical = ? WHERE rowid = ?").run(
          newKey,
          canonical,
          r.rowid,
        );
        cardsRekeyed++;
      }
    }

    // Backfill canonical on rows already under newKey.
    db.prepare(
      "UPDATE file_card SET canonical = ? WHERE repo = ? AND repo_key = ? AND (canonical IS NULL OR canonical != ?)",
    ).run(canonical, repo, newKey, canonical);

    // ── repo_sync watermark (repo_key is PRIMARY KEY). Same ownership rule as
    // cards: only migrate/drop watermarks under a PROVABLE legacy key, never by
    // display name (a shared name across repos would clobber the wrong one). ──
    const syncHasNew = db.prepare("SELECT 1 FROM repo_sync WHERE repo_key = ?").get(newKey) as
      | { 1: number }
      | undefined;
    const oldSync =
      legacy.length === 0
        ? []
        : (db
            .prepare(
              `SELECT repo_key FROM repo_sync
                WHERE repo = ? AND canonical IS NULL AND repo_key IN (${legacyPlaceholders})
                ORDER BY updated_at DESC`,
            )
            .all(repo, ...legacy) as Array<{ repo_key: string }>);
    if (oldSync.length > 0) {
      if (syncHasNew) {
        // Keep the newKey watermark; drop the stale LEGACY ones only.
        for (const s of oldSync) {
          db.prepare("DELETE FROM repo_sync WHERE repo_key = ?").run(s.repo_key);
        }
      } else {
        // Move the most recent old watermark to newKey; drop the rest.
        const keep = oldSync[0]!.repo_key;
        for (const s of oldSync.slice(1)) {
          db.prepare("DELETE FROM repo_sync WHERE repo_key = ?").run(s.repo_key);
        }
        db.prepare("UPDATE repo_sync SET repo_key = ?, canonical = ? WHERE repo_key = ?").run(
          newKey,
          canonical,
          keep,
        );
        syncRekeyed = true;
      }
    }
    // Backfill canonical on the (possibly pre-existing) newKey watermark.
    db.prepare("UPDATE repo_sync SET canonical = ? WHERE repo_key = ?").run(canonical, newKey);

    if (cardsRekeyed > 0 || collisionsDropped > 0 || syncRekeyed) {
      db.prepare(
        "INSERT INTO events (lore_id, kind, ts, payload) VALUES (?, 'repo_rekeyed', ?, ?)",
      ).run(
        newKey,
        nowIso(),
        JSON.stringify({
          repo,
          canonical,
          newKey,
          fromKeys: fromKeys.map((k) => k.repoKey),
          cardsRekeyed,
          collisionsDropped,
          syncRekeyed,
        }),
      );
    }
  });
  tx();

  return {
    repo,
    canonical,
    newKey,
    fromKeys,
    cardsRekeyed,
    collisionsDropped,
    syncRekeyed,
    noop: cardsRekeyed === 0 && collisionsDropped === 0 && !syncRekeyed,
  };
}
