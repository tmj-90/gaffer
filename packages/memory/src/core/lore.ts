import type { Database } from "better-sqlite3";

import type {
  AddLoreInput,
  Lore,
  LoreConfidence,
  LoreKind,
  LoreRow,
  LoreStatus,
  LoreSummary,
  SearchOptions,
  UpdateLoreInput,
} from "../db/types.js";
import { LORE_KINDS } from "../db/types.js";
import { newLoreId } from "./ids.js";

const LORE_KIND_SET = new Set<string>(LORE_KINDS);

/**
 * Validate a caller-supplied lore `kind` at the write boundary. Returns the
 * default ('other') when omitted; throws on any value outside the closed enum
 * so an invalid kind fails fast with a typed message rather than tripping the
 * SQLite CHECK constraint deep in native code.
 */
function normaliseKind(kind: LoreKind | undefined): LoreKind {
  if (kind === undefined) return "other";
  if (!LORE_KIND_SET.has(kind)) {
    throw new Error(`kind: '${kind}' is not one of ${LORE_KINDS.join(", ")}`);
  }
  return kind;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normaliseTag(t: string): string {
  return t.trim().toLowerCase().replace(/\s+/g, "-");
}

function normaliseRepo(r: string): string {
  return r.trim();
}

function isStale(reviewAfter: string | null): boolean {
  if (!reviewAfter) return false;
  const t = Date.parse(reviewAfter);
  if (Number.isNaN(t)) return false;
  return t < Date.now();
}

/**
 * Validate ISO-8601 date strings at write boundaries. Catches the
 * "new Date('nonsense').getTime() === NaN" footgun that previously
 * disabled staleness silently.
 */
function assertIsoDate(value: string | undefined, field: string): void {
  if (value === undefined) return;
  const t = Date.parse(value);
  if (Number.isNaN(t)) {
    throw new Error(`${field}: '${value}' is not a valid ISO-8601 date`);
  }
}

/**
 * Search-limit validator for the public library API. Returns the
 * default (10) when undefined; throws on NaN / non-integer / out of
 * the [1, 50] range. The MCP zod schema and the CLI flag parser both
 * gate this upstream, but `searchLore` is exported so an embedder
 * could call it directly — better to fail fast with a typed message
 * than pass garbage to better-sqlite3 and watch it bind NaN into a
 * LIMIT clause and surface a "datatype mismatch" deep in native code.
 */
const SEARCH_LIMIT_DEFAULT = 10;
const SEARCH_LIMIT_MAX = 50;
function normaliseLimit(v: number | undefined): number {
  if (v === undefined) return SEARCH_LIMIT_DEFAULT;
  if (!Number.isInteger(v) || v < 1 || v > SEARCH_LIMIT_MAX) {
    throw new Error(
      `limit must be an integer between 1 and ${SEARCH_LIMIT_MAX} (got ${JSON.stringify(v)})`,
    );
  }
  return v;
}

/**
 * `source` must be a real http(s) URL. The README is explicit about
 * this — sources are PR / ADR / incident permalinks, not free-text
 * shorthand. Keeps the trust signal honest (a real URL can be checked).
 * An empty string is treated as "clear the source" (used by updateLore).
 */
function assertHttpUrl(value: string | undefined, field: string): void {
  if (value === undefined || value === "") return;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${field}: '${value}' is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${field}: '${value}' must be an http(s) URL (got ${parsed.protocol})`);
  }
}

/**
 * R20 — when verifyLore runs on a record whose review_after has lapsed,
 * push the date this many days forward so the record is no longer
 * flagged stale. Callers can pass a custom date to override.
 */
const VERIFY_DEFAULT_FORWARD_DAYS = 90;

function rowToLore(row: LoreRow, repos: string[], tags: string[]): Lore {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    body: row.body,
    author: row.author ?? undefined,
    team: row.team ?? undefined,
    status: row.status,
    kind: row.kind ?? "other",
    source: row.source ?? undefined,
    reviewAfter: row.review_after ?? undefined,
    confidence: row.confidence,
    supersededBy: row.superseded_by ?? undefined,
    restricted: row.restricted === 1,
    repos,
    tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastVerifiedAt: row.last_verified_at ?? undefined,
    conflictsWith: parseConflictsWith(row.conflicts_with),
  };
}

/**
 * Decode the `conflicts_with` storage column into the public
 * `Lore.conflictsWith` shape. Storage is one of:
 *
 *   - `NULL` → `undefined` (the record isn't a counter-record)
 *   - JSON-encoded `string[]` with at least one id → frozen
 *     `ReadonlyArray<string>` of those ids
 *
 * The empty array `"[]"` is not a representable on-disk state — callers
 * either store NULL (no conflict) or a non-empty array. A defensive
 * `[]` payload (e.g. from a hand-edit) still maps to `undefined` so
 * downstream consumers can rely on `conflictsWith === undefined`
 * meaning "this record makes no counter-claim".
 *
 * Anything that fails to parse cleanly (corrupt JSON, non-array,
 * non-string elements) also degrades to `undefined`. We don't surface
 * a parse error because a corrupted column is not a caller-actionable
 * failure mode and we don't want every consumer to wrap reads in
 * try/catch for an unreachable case (mirrors the `getRejectionReason`
 * decision in Epic 2).
 */
function parseConflictsWith(raw: string | null): ReadonlyArray<string> | undefined {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    if (!parsed.every((x) => typeof x === "string")) return undefined;
    return Object.freeze([...(parsed as string[])]);
  } catch {
    return undefined;
  }
}

function rowToSummary(row: LoreRow, repos: string[], tags: string[], score?: number): LoreSummary {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    author: row.author ?? undefined,
    team: row.team ?? undefined,
    status: row.status,
    kind: row.kind ?? "other",
    source: row.source ?? undefined,
    confidence: row.confidence,
    restricted: row.restricted === 1,
    repos,
    tags,
    updatedAt: row.updated_at,
    lastVerifiedAt: row.last_verified_at ?? undefined,
    stale: isStale(row.review_after),
    score,
    conflictsWith: parseConflictsWith(row.conflicts_with),
  };
}

function reposOf(db: Database, id: string): string[] {
  return (
    db.prepare("SELECT repo FROM lore_repos WHERE lore_id = ? ORDER BY repo").all(id) as Array<{
      repo: string;
    }>
  ).map((r) => r.repo);
}

function tagsOf(db: Database, id: string): string[] {
  return (
    db.prepare("SELECT tag FROM lore_tags WHERE lore_id = ? ORDER BY tag").all(id) as Array<{
      tag: string;
    }>
  ).map((r) => r.tag);
}

/**
 * Batched repo lookup for hot loops (searchLore, findPossibleDuplicates,
 * listDrafts, exportLore). Returns a Map<id, repos[]> so callers can
 * substitute for `reposOf(db, row.id)` without changing call shape.
 *
 * The N+1 hand-rolled equivalent (`reposOf` once per row) was the
 * dominant latency on agent search calls; one IN-clause query is
 * dramatically cheaper. Per-id arrays come out sorted alphabetically
 * because the result is ordered by (lore_id, repo).
 *
 * Pre-fills every requested id with `[]` so callers don't have to
 * branch on missing keys; an id with no repos still produces an empty
 * array, matching the per-id helper's behaviour.
 */
function reposByIds(db: Database, ids: ReadonlyArray<string>): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (ids.length === 0) return map;
  for (const id of ids) map.set(id, []);
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT lore_id, repo FROM lore_repos
       WHERE lore_id IN (${placeholders})
       ORDER BY lore_id, repo`,
    )
    .all(...ids) as Array<{ lore_id: string; repo: string }>;
  for (const r of rows) {
    map.get(r.lore_id)!.push(r.repo);
  }
  return map;
}

function tagsByIds(db: Database, ids: ReadonlyArray<string>): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (ids.length === 0) return map;
  for (const id of ids) map.set(id, []);
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT lore_id, tag FROM lore_tags
       WHERE lore_id IN (${placeholders})
       ORDER BY lore_id, tag`,
    )
    .all(...ids) as Array<{ lore_id: string; tag: string }>;
  for (const r of rows) {
    map.get(r.lore_id)!.push(r.tag);
  }
  return map;
}

/**
 * Confidence invariants (R2 review):
 *   - A record without a `source` can never be `high` confidence. If a
 *     caller asks for `high` without a source, clamp down to `medium`.
 *     This stops well-meaning humans (and rubber-stamping reviewers)
 *     from creating un-anchored "authoritative" rules.
 *   - When status=draft (suggestLore path) the caller's max claim is
 *     `medium`. Only a human, via `addLore` or `approveLore`-then-update,
 *     can stamp `high`.
 */
export function clampConfidence(
  requested: LoreConfidence | undefined,
  hasSource: boolean,
  status: LoreStatus,
): LoreConfidence {
  let c: LoreConfidence = requested ?? "medium";
  if (status === "draft" && c === "high") c = "medium";
  if (c === "high" && !hasSource) c = "medium";
  return c;
}

/**
 * Internal insert path shared by addLore (status='active') and
 * suggestLore (status='draft'). Callers pick the lifecycle default;
 * everything else is symmetric.
 */
function insertLore(db: Database, input: AddLoreInput, status: LoreStatus): Lore {
  const id = newLoreId();
  const ts = nowIso();
  const repos = Array.from(new Set((input.repos ?? []).map(normaliseRepo).filter(Boolean))).sort();
  const tags = Array.from(new Set((input.tags ?? []).map(normaliseTag).filter(Boolean))).sort();
  const confidence = clampConfidence(input.confidence, !!input.source, status);
  const kind = normaliseKind(input.kind);
  assertIsoDate(input.reviewAfter, "reviewAfter");
  assertHttpUrl(input.source, "source");
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO lore (
          id, title, summary, body, author, team,
          status, kind, source, review_after, confidence,
          superseded_by, restricted,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.title,
        input.summary,
        input.body,
        input.author ?? null,
        input.team ?? null,
        status,
        kind,
        input.source ?? null,
        input.reviewAfter ?? null,
        confidence,
        null,
        input.restricted ? 1 : 0,
        ts,
        ts,
      );
    const rowid = Number(info.lastInsertRowid);
    db.prepare("INSERT INTO lore_fts(rowid, title, summary, body) VALUES (?, ?, ?, ?)").run(
      rowid,
      input.title,
      input.summary,
      input.body,
    );
    const repoStmt = db.prepare("INSERT OR IGNORE INTO lore_repos (lore_id, repo) VALUES (?, ?)");
    for (const r of repos) repoStmt.run(id, r);
    const tagStmt = db.prepare("INSERT OR IGNORE INTO lore_tags (lore_id, tag) VALUES (?, ?)");
    for (const t of tags) tagStmt.run(id, t);
    db.prepare("INSERT INTO events (lore_id, kind, ts) VALUES (?, ?, ?)").run(
      id,
      status === "draft" ? "suggested" : "created",
      ts,
    );
  });
  tx();
  return rowToLore(db.prepare("SELECT * FROM lore WHERE id = ?").get(id) as LoreRow, repos, tags);
}

/** Human-authored entry. Defaults to `status: 'active'`. */
export function addLore(db: Database, input: AddLoreInput): Lore {
  return insertLore(db, input, "active");
}

/**
 * Shape used by `memory sync import`: a full Lore record reconstructed
 * from a Markdown file's frontmatter. Differs from AddLoreInput in
 * three ways:
 *
 *   - `id` is REQUIRED — the .md file's id is the round-trip key. We
 *     never allocate a new id during import.
 *   - `status` is REQUIRED and authoritative. The PR review is the
 *     trust gate; whatever the file says wins.
 *   - `createdAt` / `updatedAt` are optional but, when present,
 *     preserved (so two exports of the same DB diff cleanly).
 *
 * Confidence is still clamped (no `high` without a source) — that's a
 * core invariant, not a stylistic choice.
 */
export interface ImportLoreInput {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly status: LoreStatus;
  readonly author?: string;
  readonly team?: string;
  readonly kind?: LoreKind;
  readonly source?: string;
  readonly reviewAfter?: string;
  readonly confidence?: LoreConfidence;
  readonly repos?: ReadonlyArray<string>;
  readonly tags?: ReadonlyArray<string>;
  readonly restricted?: boolean;
  readonly supersededBy?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly lastVerifiedAt?: string;
  /**
   * Round-trip support for counter-records. Storage column accepts NULL
   * (record makes no counter-claim) or a JSON id array. An empty array
   * is normalised to NULL on write so the on-disk invariant
   * "NULL or non-empty array" holds.
   */
  readonly conflictsWith?: ReadonlyArray<string>;
}

export interface ImportResult {
  readonly id: string;
  readonly created: boolean;
}

/**
 * Upsert a single record by id, used by `memory sync import`. Creates
 * a new row when the id is unknown; otherwise updates every field
 * (status included — unlike `updateLore`, which deliberately refuses
 * status changes because the interactive paths go through
 * approve/deprecate/supersede). The PR is the lifecycle gate for sync,
 * so `import` is the one place we let status move freely.
 *
 * Confidence still clamps via `clampConfidence` (no `high` without a
 * source; no `high` on a draft). FTS is reindexed. The events row uses
 * `imported` so the audit trail distinguishes sync from interactive
 * authorship.
 */
export function upsertLoreFromImport(db: Database, input: ImportLoreInput): ImportResult {
  assertIsoDate(input.reviewAfter, "reviewAfter");
  assertIsoDate(input.createdAt, "createdAt");
  assertIsoDate(input.updatedAt, "updatedAt");
  assertIsoDate(input.lastVerifiedAt, "lastVerifiedAt");
  assertHttpUrl(input.source, "source");

  const repos = Array.from(new Set((input.repos ?? []).map(normaliseRepo).filter(Boolean))).sort();
  const tags = Array.from(new Set((input.tags ?? []).map(normaliseTag).filter(Boolean))).sort();
  const confidence = clampConfidence(input.confidence, !!input.source, input.status);
  const kind = normaliseKind(input.kind);
  const nowTs = nowIso();
  const createdAt = input.createdAt ?? nowTs;
  const updatedAt = input.updatedAt ?? nowTs;

  const existing = db.prepare("SELECT rowid FROM lore WHERE id = ?").get(input.id) as
    | { rowid: number }
    | undefined;
  const isCreate = !existing;

  const conflictsWith =
    input.conflictsWith && input.conflictsWith.length > 0
      ? JSON.stringify([...input.conflictsWith])
      : null;
  const tx = db.transaction(() => {
    if (isCreate) {
      const info = db
        .prepare(
          `INSERT INTO lore (
            id, title, summary, body, author, team,
            status, kind, source, review_after, confidence,
            superseded_by, restricted,
            created_at, updated_at, last_verified_at,
            conflicts_with
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.title,
          input.summary,
          input.body,
          input.author ?? null,
          input.team ?? null,
          input.status,
          kind,
          input.source ?? null,
          input.reviewAfter ?? null,
          confidence,
          input.supersededBy ?? null,
          input.restricted ? 1 : 0,
          createdAt,
          updatedAt,
          input.lastVerifiedAt ?? null,
          conflictsWith,
        );
      const rowid = Number(info.lastInsertRowid);
      db.prepare("INSERT INTO lore_fts(rowid, title, summary, body) VALUES (?, ?, ?, ?)").run(
        rowid,
        input.title,
        input.summary,
        input.body,
      );
    } else {
      db.prepare(
        `UPDATE lore SET
           title = ?, summary = ?, body = ?,
           author = ?, team = ?, status = ?, kind = ?,
           source = ?, review_after = ?, confidence = ?,
           superseded_by = ?, restricted = ?,
           updated_at = ?, last_verified_at = ?,
           conflicts_with = ?
         WHERE id = ?`,
      ).run(
        input.title,
        input.summary,
        input.body,
        input.author ?? null,
        input.team ?? null,
        input.status,
        kind,
        input.source ?? null,
        input.reviewAfter ?? null,
        confidence,
        input.supersededBy ?? null,
        input.restricted ? 1 : 0,
        updatedAt,
        input.lastVerifiedAt ?? null,
        conflictsWith,
        input.id,
      );
      const rowid = (
        db.prepare("SELECT rowid FROM lore WHERE id = ?").get(input.id) as {
          rowid: number;
        }
      ).rowid;
      db.prepare("DELETE FROM lore_fts WHERE rowid = ?").run(rowid);
      db.prepare("INSERT INTO lore_fts(rowid, title, summary, body) VALUES (?, ?, ?, ?)").run(
        rowid,
        input.title,
        input.summary,
        input.body,
      );
    }
    // Replace repos + tags atomically.
    db.prepare("DELETE FROM lore_repos WHERE lore_id = ?").run(input.id);
    const repoIns = db.prepare("INSERT INTO lore_repos (lore_id, repo) VALUES (?, ?)");
    for (const r of repos) repoIns.run(input.id, r);
    db.prepare("DELETE FROM lore_tags WHERE lore_id = ?").run(input.id);
    const tagIns = db.prepare("INSERT INTO lore_tags (lore_id, tag) VALUES (?, ?)");
    for (const t of tags) tagIns.run(input.id, t);
    db.prepare("INSERT INTO events (lore_id, kind, ts) VALUES (?, 'imported', ?)").run(
      input.id,
      nowTs,
    );
  });
  tx();
  return { id: input.id, created: isCreate };
}

/**
 * Agent-authored entry. Lands as `status: 'draft'` by default — hidden from
 * default search until a human runs `memory approve <id>`; agents cannot
 * promote their own records. When the OPERATOR opts into auto-approve (the
 * server passes `autoApprove`, e.g. an autonomous factory run with
 * LORE_AUTO_APPROVE=1), the entry lands `active` immediately — that's the
 * operator trusting agent writes, not the agent self-promoting. Governed
 * (draft) stays the default, so the standalone product is unchanged.
 */
export function suggestLore(
  db: Database,
  input: AddLoreInput,
  opts?: { autoApprove?: boolean },
): Lore {
  return insertLore(db, input, opts?.autoApprove ? "active" : "draft");
}

/**
 * Input for `reportConflict`: an agent has observed something in code
 * that contradicts a canonical (active) record and wants to surface
 * the disagreement for human triage. ALWAYS creates a DRAFT counter-
 * record; NEVER mutates the original. See ADR-003.
 */
export interface ReportConflictInput {
  /** ID of the canonical record being challenged. Must exist + be active + not restricted. */
  readonly existingId: string;
  /** Human-readable description of the contradiction. Becomes the counter's summary + body intro. 1..800 chars. */
  readonly observation: string;
  readonly source?: string;
  readonly repos?: ReadonlyArray<string>;
  readonly tags?: ReadonlyArray<string>;
}

/**
 * Reason a `reportConflict` call refused. Each value is distinct so
 * the MCP layer can audit-log the cause without leaking the original
 * record's contents.
 */
export type ReportConflictRefusal =
  | "unknown_existing_id"
  | "non_active_existing_record"
  | "restricted_existing_record"
  | "empty_observation"
  | "observation_too_long";

export class ReportConflictError extends Error {
  readonly reason: ReportConflictRefusal;
  constructor(reason: ReportConflictRefusal, message: string) {
    super(message);
    this.name = "ReportConflictError";
    this.reason = reason;
  }
}

const REPORT_CONFLICT_OBSERVATION_MAX = 800;
const REPORT_CONFLICT_TITLE_FRAGMENT_MAX = 60;

/**
 * Create a DRAFT counter-record challenging an existing active lore
 * record. The new draft carries `conflictsWith = [existingId]` and the
 * existing record receives a `conflict_reported` event keyed to it
 * (with payload `{counterDraftId}`) so the audit chain shows the
 * record has been challenged. The original lore row is NEVER UPDATEd —
 * that one-way link is the trust-model boundary that keeps agents
 * from silently mutating canonical knowledge. See ADR-003.
 *
 * Throws `ReportConflictError` (with a specific `reason`) when the
 * existing record is unknown, not active, or restricted; the MCP layer
 * uses the `reason` to audit-log the refusal without leaking the
 * original record's fields.
 *
 * Idempotency: deliberately not deduped. Two agents flagging the same
 * record produce two distinct drafts; the reviewer triages them via
 * the existing review/reject flow.
 */
export function reportConflict(db: Database, input: ReportConflictInput): Lore {
  const observation = input.observation;
  if (typeof observation !== "string" || observation.trim().length === 0) {
    throw new ReportConflictError(
      "empty_observation",
      "reportConflict: observation must be a non-empty string",
    );
  }
  if (observation.length > REPORT_CONFLICT_OBSERVATION_MAX) {
    throw new ReportConflictError(
      "observation_too_long",
      `reportConflict: observation ${observation.length} chars exceeds cap ${REPORT_CONFLICT_OBSERVATION_MAX}`,
    );
  }
  const existing = db
    .prepare("SELECT status, restricted FROM lore WHERE id = ?")
    .get(input.existingId) as { status: LoreStatus; restricted: 0 | 1 } | undefined;
  if (!existing) {
    throw new ReportConflictError(
      "unknown_existing_id",
      `reportConflict: existingId '${input.existingId}' not found`,
    );
  }
  if (existing.status !== "active") {
    throw new ReportConflictError(
      "non_active_existing_record",
      `reportConflict: existing record '${input.existingId}' is ${existing.status}, not active`,
    );
  }
  if (existing.restricted === 1) {
    // Refusal text deliberately does NOT echo the record's title — the
    // MCP layer is the env-gated boundary, and the core helper must
    // never be an oracle for restricted-record metadata.
    throw new ReportConflictError(
      "restricted_existing_record",
      `reportConflict: existing record '${input.existingId}' is restricted`,
    );
  }

  // Derive the counter-record's title from the observation: a short,
  // human-readable fragment so reviewers see WHAT is being challenged
  // at a glance without opening the body. Always prefixed
  // `[conflict-report]` so the queue surface is obvious.
  const trimmedObs = observation.trim();
  const titleFragment =
    trimmedObs.length > REPORT_CONFLICT_TITLE_FRAGMENT_MAX
      ? trimmedObs.slice(0, REPORT_CONFLICT_TITLE_FRAGMENT_MAX - 1) + "…"
      : trimmedObs;
  const title = `[conflict-report] ${titleFragment}`;
  // Summary is the trimmed observation as-is (it's already bounded);
  // body adds a footer pointing at the challenged record so reviewers
  // can jump straight to it via `memory show <existingId>`.
  const summary = trimmedObs;
  const body =
    trimmedObs +
    "\n\n---\n" +
    `Counter-claim against \`${input.existingId}\`. ` +
    `Approve to make this disagreement canonical; reject if the original record is right; ` +
    `or use \`memory supersede\` / \`memory update\` to resolve.\n`;
  const tags = ["conflict-report", ...(input.tags ?? [])];

  // Wrap insertLore + conflicts_with write + event emit in a single
  // transaction so a partial counter-record (without the link) can
  // never become visible.
  let draft!: Lore;
  const tx = db.transaction(() => {
    draft = insertLore(
      db,
      {
        title,
        summary,
        body,
        source: input.source,
        repos: input.repos,
        tags,
        author: "agent",
      },
      "draft",
    );
    db.prepare("UPDATE lore SET conflicts_with = ? WHERE id = ?").run(
      JSON.stringify([input.existingId]),
      draft.id,
    );
    db.prepare(
      "INSERT INTO events (lore_id, kind, ts, payload) VALUES (?, 'conflict_reported', ?, ?)",
    ).run(input.existingId, nowIso(), JSON.stringify({ counterDraftId: draft.id }));
  });
  tx();

  // Re-fetch so the returned Lore reflects the post-UPDATE
  // conflicts_with field (insertLore returned the row before the
  // UPDATE landed).
  return getLore(db, draft.id)!;
}

export function getLore(db: Database, id: string): Lore | null {
  const row = db.prepare("SELECT * FROM lore WHERE id = ?").get(id) as LoreRow | undefined;
  if (!row) return null;
  recordRead(db, [id], "get");
  return rowToLore(row, reposOf(db, id), tagsOf(db, id));
}

/**
 * Record one `read` event per id so `memory stats` can show what's
 * pulling weight. Opt-out via either env var so test suites and
 * privacy-conscious users get a clean store:
 *
 *   - `MEMORY_NO_TELEMETRY=1` — the deliberate "I don't want this"
 *     toggle, surfaced in `memory doctor`.
 *   - `MEMORY_AUDIT_OFF=1` — already set by test setup to silence
 *     the audit log; reuse it so test runs also skip read events.
 *
 * Local-only. The `events` table is the existing audit ledger; the
 * 'read' kind is additive. No new schema, no network call.
 */
function recordRead(db: Database, ids: ReadonlyArray<string>, via: "search" | "get"): void {
  if (ids.length === 0) return;
  if (process.env["MEMORY_NO_TELEMETRY"]) return;
  if (process.env["MEMORY_AUDIT_OFF"]) return;
  const ts = nowIso();
  const payload = JSON.stringify({ via });
  const stmt = db.prepare(
    "INSERT INTO events (lore_id, kind, ts, payload) VALUES (?, 'read', ?, ?)",
  );
  const insertMany = db.transaction((rows: ReadonlyArray<string>) => {
    for (const id of rows) stmt.run(id, ts, payload);
  });
  insertMany(ids);
}

/** Promote draft → active. Returns null on unknown id or non-draft status. */
export function approveLore(db: Database, id: string): Lore | null {
  const ts = nowIso();
  const r = db
    .prepare("UPDATE lore SET status = 'active', updated_at = ? WHERE id = ? AND status = 'draft'")
    .run(ts, id);
  if (r.changes === 0) return null;
  db.prepare("INSERT INTO events (lore_id, kind, ts) VALUES (?, 'approved', ?)").run(id, ts);
  return getLore(db, id);
}

/** Mark deprecated — stays findable only with `includeDeprecated`. */
export function deprecateLore(db: Database, id: string): Lore | null {
  const ts = nowIso();
  const r = db
    .prepare("UPDATE lore SET status = 'deprecated', updated_at = ? WHERE id = ?")
    .run(ts, id);
  if (r.changes === 0) return null;
  db.prepare("INSERT INTO events (lore_id, kind, ts) VALUES (?, 'deprecated', ?)").run(id, ts);
  return getLore(db, id);
}

/**
 * Mark `oldId` as superseded by `newId`. Old record → status='superseded'
 * + supersededBy=newId. New record is left as-is (typically already active).
 *
 * Validates: oldId exists, newId exists, oldId !== newId, and newId
 * itself is not a tombstone (deprecated / superseded). Returns null
 * on any failure rather than throwing — the CLI surfaces a single
 * explanatory message rather than an unhandled error.
 */
export function supersedeLore(db: Database, oldId: string, newId: string): Lore | null {
  if (oldId === newId) return null;
  const replacement = db.prepare("SELECT id, status FROM lore WHERE id = ?").get(newId) as
    | { id: string; status: LoreStatus }
    | undefined;
  if (!replacement) return null;
  if (replacement.status === "deprecated" || replacement.status === "superseded") {
    return null;
  }
  const ts = nowIso();
  const r = db
    .prepare(
      "UPDATE lore SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?",
    )
    .run(newId, ts, oldId);
  if (r.changes === 0) return null;
  db.prepare("INSERT INTO events (lore_id, kind, ts, payload) VALUES (?, 'superseded', ?, ?)").run(
    oldId,
    ts,
    JSON.stringify({ supersededBy: newId }),
  );
  return getLore(db, oldId);
}

/**
 * Bump `last_verified_at` AND, if `review_after` has lapsed, push it
 * VERIFY_DEFAULT_FORWARD_DAYS days into the future so the record clears
 * the `stale: true` flag. Callers can override by passing an explicit
 * `nextReviewAfter`. Pass `null` to leave `review_after` untouched even
 * if it's lapsed (rare, but useful for "yes I checked, the warning is
 * still right" cases).
 */
export function verifyLore(db: Database, id: string, nextReviewAfter?: string | null): Lore | null {
  const current = db.prepare("SELECT review_after FROM lore WHERE id = ?").get(id) as
    | { review_after: string | null }
    | undefined;
  if (!current) return null;

  const ts = nowIso();
  let newReview: string | null = current.review_after;
  if (nextReviewAfter === null) {
    // Explicit "leave alone" — keep whatever's there.
    newReview = current.review_after;
  } else if (typeof nextReviewAfter === "string") {
    assertIsoDate(nextReviewAfter, "nextReviewAfter");
    newReview = nextReviewAfter;
  } else if (isStale(current.review_after)) {
    // Default: lapsed → forward N days. Fresh review_after is left alone.
    const forward = new Date(Date.now() + VERIFY_DEFAULT_FORWARD_DAYS * 86_400_000);
    newReview = forward.toISOString();
  }

  const r = db
    .prepare("UPDATE lore SET last_verified_at = ?, review_after = ?, updated_at = ? WHERE id = ?")
    .run(ts, newReview, ts, id);
  if (r.changes === 0) return null;
  db.prepare("INSERT INTO events (lore_id, kind, ts, payload) VALUES (?, 'verified', ?, ?)").run(
    id,
    ts,
    JSON.stringify({ reviewAfter: newReview }),
  );
  return getLore(db, id);
}

/**
 * Partial update — title / summary / body / metadata. Use for fixing
 * an agent's draft text before approval, or correcting an active
 * record. Status transitions go through approve/deprecate/supersede,
 * not this. Tags and repos when present REPLACE the existing set.
 *
 * Confidence invariants still apply: clampConfidence enforces the
 * "agent draft can't claim high" / "sourceless can't be high" rules
 * even via update (status comes from the current row).
 */
export function updateLore(db: Database, id: string, input: UpdateLoreInput): Lore | null {
  const current = db.prepare("SELECT * FROM lore WHERE id = ?").get(id) as LoreRow | undefined;
  if (!current) return null;

  assertIsoDate(input.reviewAfter === null ? undefined : input.reviewAfter, "reviewAfter");
  assertHttpUrl(input.source, "source");

  // Resolve final values, falling back to current row when not provided.
  const title = input.title ?? current.title;
  const summary = input.summary ?? current.summary;
  const body = input.body ?? current.body;
  const author = input.author !== undefined ? input.author : current.author;
  const team = input.team !== undefined ? input.team : current.team;
  // Empty string is the explicit "clear the source" signal (since the
  // `source: undefined` case means "no change"). NULL in storage; the
  // confidence re-clamp will catch any high→medium fallout.
  const source =
    input.source === "" ? null : input.source !== undefined ? input.source : current.source;
  const reviewAfter =
    input.reviewAfter === null
      ? null
      : input.reviewAfter !== undefined
        ? input.reviewAfter
        : current.review_after;
  const restricted =
    input.restricted !== undefined ? (input.restricted ? 1 : 0) : current.restricted;
  const kind = input.kind !== undefined ? normaliseKind(input.kind) : (current.kind ?? "other");
  // Confidence: caller's claim, but re-clamped given (possibly new) source + current status.
  const confidence = clampConfidence(
    input.confidence ?? current.confidence,
    !!source,
    current.status,
  );

  const ts = nowIso();
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE lore SET
        title = ?, summary = ?, body = ?,
        author = ?, team = ?, source = ?,
        review_after = ?, confidence = ?, restricted = ?,
        kind = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      title,
      summary,
      body,
      author,
      team,
      source,
      reviewAfter,
      confidence,
      restricted,
      kind,
      ts,
      id,
    );
    // If any of title/summary/body changed, reindex FTS for this row.
    if (input.title !== undefined || input.summary !== undefined || input.body !== undefined) {
      // Need the rowid for FTS — fetch via a join since `lore.id` is a
      // separate string id from the implicit rowid.
      const rowid = (
        db.prepare("SELECT rowid FROM lore WHERE id = ?").get(id) as {
          rowid: number;
        }
      ).rowid;
      db.prepare("DELETE FROM lore_fts WHERE rowid = ?").run(rowid);
      db.prepare("INSERT INTO lore_fts(rowid, title, summary, body) VALUES (?, ?, ?, ?)").run(
        rowid,
        title,
        summary,
        body,
      );
    }
    if (input.repos !== undefined) {
      const repos = Array.from(new Set(input.repos.map(normaliseRepo).filter(Boolean))).sort();
      db.prepare("DELETE FROM lore_repos WHERE lore_id = ?").run(id);
      const ins = db.prepare("INSERT INTO lore_repos (lore_id, repo) VALUES (?, ?)");
      for (const r of repos) ins.run(id, r);
    }
    if (input.tags !== undefined) {
      const tags = Array.from(new Set(input.tags.map(normaliseTag).filter(Boolean))).sort();
      db.prepare("DELETE FROM lore_tags WHERE lore_id = ?").run(id);
      const ins = db.prepare("INSERT INTO lore_tags (lore_id, tag) VALUES (?, ?)");
      for (const t of tags) ins.run(id, t);
    }
    db.prepare("INSERT INTO events (lore_id, kind, ts) VALUES (?, 'updated', ?)").run(id, ts);
  });
  tx();
  return getLore(db, id);
}

/**
 * Reject a draft. Hard-deletes the row + cascades repos/tags, but emits
 * a `rejected` event (not `deleted`) so the audit chain shows the human
 * triage decision distinct from a manual `memory delete`. Refuses to act
 * on non-drafts — promoted records get `deprecateLore` / `supersedeLore`
 * instead.
 *
 * The optional `reason` closes the feedback loop on agent-suggested
 * drafts: when present and non-empty (after `.trim()`), it lands on the
 * `rejected` event payload as `JSON.stringify({ reason })`. Empty,
 * whitespace-only, or omitted reasons leave `payload = NULL` so the
 * absence of a reason is distinguishable from `{ reason: "" }`. Read
 * back with `getRejectionReason(db, id)`.
 *
 * Returns true on success, false if the id doesn't exist or isn't a draft.
 */
export function rejectLore(db: Database, id: string, reason?: string): boolean {
  const ts = nowIso();
  const row = db.prepare("SELECT rowid, status FROM lore WHERE id = ?").get(id) as
    | { rowid: number; status: LoreStatus }
    | undefined;
  if (!row) return false;
  if (row.status !== "draft") return false;
  const trimmed = reason?.trim();
  const payload = trimmed ? JSON.stringify({ reason: trimmed }) : null;
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM lore_fts WHERE rowid = ?").run(row.rowid);
    db.prepare("DELETE FROM lore WHERE id = ?").run(id);
    db.prepare("INSERT INTO events (lore_id, kind, ts, payload) VALUES (?, 'rejected', ?, ?)").run(
      id,
      ts,
      payload,
    );
  });
  tx();
  return true;
}

/**
 * Read the reason captured on the most recent `rejected` event for `id`.
 * Returns `undefined` when the rejection had no reason (NULL payload),
 * when the id was never rejected, or when the payload is unreadable
 * (deliberately swallowed — a corrupt event row from an external write
 * is not a caller-actionable error, and we don't want every caller of
 * this helper to wrap it in try/catch for an unreachable case).
 *
 * "Most recent" is well-defined because `events.rowid` is
 * `INTEGER PRIMARY KEY AUTOINCREMENT` (monotonic across the table) and
 * the standard reject path hard-deletes the lore row before re-suggest
 * is even possible — so a given id can only carry one `rejected` event
 * under normal use. The `ORDER BY rowid DESC LIMIT 1` is the
 * defensive shape for any future workflow that allows id reuse.
 */
export function getRejectionReason(db: Database, id: string): string | undefined {
  const row = db
    .prepare(
      "SELECT payload FROM events WHERE lore_id = ? AND kind = 'rejected' ORDER BY rowid DESC LIMIT 1",
    )
    .get(id) as { payload: string | null } | undefined;
  if (!row || row.payload === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(row.payload);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "reason" in parsed &&
      typeof (parsed as { reason: unknown }).reason === "string"
    ) {
      return (parsed as { reason: string }).reason;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function deleteLore(db: Database, id: string): boolean {
  const ts = nowIso();
  const row = db.prepare("SELECT rowid FROM lore WHERE id = ?").get(id) as
    | { rowid: number }
    | undefined;
  if (!row) return false;
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM lore_fts WHERE rowid = ?").run(row.rowid);
    db.prepare("DELETE FROM lore WHERE id = ?").run(id);
    db.prepare("INSERT INTO events (lore_id, kind, ts) VALUES (?, 'deleted', ?)").run(id, ts);
  });
  tx();
  return true;
}

/**
 * Trust-ranking knobs (see `trustRankAdjustment`). These are MULTIPLIERS
 * on a row's relevance magnitude (|bm25|), not additive constants, so
 * the adjustment scales with each row's own relevance and behaves the
 * same whether bm25 scores are ~1e-6 (tiny corpus, where IDF collapses)
 * or ~-17 (realistic corpus). A fixed additive delta would dominate on a
 * tiny corpus and vanish on a large one; a multiplier is scale-free.
 *
 * The summed delta is clamped to ±RANK_MAX_SWING. At ±0.5 trust can
 * shift effective relevance by at most half: it reorders genuine
 * near-ties (within a ~3× relevance band) and rescues a buried
 * high-trust record, but can NEVER flip a clearly stronger lexical
 * match. Mirrors the trust signals the README tells the agent to prefer:
 * active + sourced + medium/high confidence + fresh.
 */
const RANK_STALE_PENALTY = 0.25;
const RANK_NO_SOURCE_PENALTY = 0.1;
const RANK_LOW_CONFIDENCE_PENALTY = 0.15;
const RANK_HIGH_CONFIDENCE_BONUS = 0.15;
const RANK_MAX_SWING = 0.5;

/**
 * Candidate pool size for trust re-ranking. We over-fetch by bm25 up to
 * this many rows, re-rank in TS, then slice to the caller's `limit`. The
 * pool is larger than the public limit cap (50) so a high-trust record
 * that bm25 buried just past the limit can still surface. Bounded so the
 * extra hydration cost stays small.
 */
const RANK_CANDIDATE_POOL = 60;

/**
 * Per-row trust delta (a signed fraction, clamped to ±RANK_MAX_SWING)
 * applied multiplicatively to the row's relevance magnitude before
 * sorting — POSITIVE promotes, NEGATIVE demotes. Pure and exported so
 * the ranking contract can be unit-tested without a populated FTS index.
 *
 *   - stale (review_after lapsed): demote
 *   - no source: mild demote
 *   - low confidence: mild demote; high confidence: mild promote
 */
export function trustRankAdjustment(row: {
  readonly source: string | null;
  readonly confidence: LoreConfidence;
  readonly review_after: string | null;
}): number {
  let adj = 0;
  if (isStale(row.review_after)) adj -= RANK_STALE_PENALTY;
  if (!row.source) adj -= RANK_NO_SOURCE_PENALTY;
  if (row.confidence === "low") adj -= RANK_LOW_CONFIDENCE_PENALTY;
  else if (row.confidence === "high") adj += RANK_HIGH_CONFIDENCE_BONUS;
  return Math.max(-RANK_MAX_SWING, Math.min(RANK_MAX_SWING, adj));
}

/**
 * Shared filter/clause builder for `searchLore` and `searchLoreCount`.
 * Returns the FROM fragment, the WHERE clause, the bound params (FTS
 * MATCH param first when a query is present), and whether FTS is active.
 * Centralised so the count query can't drift from the result query.
 */
function buildSearchClauses(opts: SearchOptions): {
  from: string;
  where: string;
  params: Array<string | number>;
  hasFts: boolean;
} {
  if (opts.updatedAfter !== undefined) {
    assertIsoDate(opts.updatedAfter, "updatedAfter");
  }
  const allowedStatuses: LoreStatus[] = ["active"];
  if (opts.includeDrafts) allowedStatuses.push("draft");
  if (opts.includeDeprecated) allowedStatuses.push("deprecated");
  if (opts.includeSuperseded) allowedStatuses.push("superseded");

  const filters: string[] = [];
  const params: Array<string | number> = [];

  const hasFts = !!opts.query && opts.query.trim().length > 0;
  const from = hasFts ? `lore l JOIN lore_fts fts ON fts.rowid = l.rowid` : `lore l`;
  if (hasFts) {
    filters.push("lore_fts MATCH ?");
    params.push(toFtsQuery(opts.query!.trim(), !!opts.prefix));
  }
  filters.push(`l.status IN (${allowedStatuses.map(() => "?").join(",")})`);
  params.push(...allowedStatuses);
  if (!opts.includeRestricted) {
    filters.push("l.restricted = 0");
  }
  if (opts.repo) {
    filters.push(`l.id IN (SELECT lore_id FROM lore_repos WHERE repo = ?)`);
    params.push(opts.repo);
  }
  if (opts.tag !== undefined) {
    const tagList = Array.isArray(opts.tag) ? opts.tag : [opts.tag];
    const normalised = Array.from(
      new Set(tagList.map((t) => normaliseTag(t as string)).filter(Boolean)),
    );
    if (normalised.length === 1) {
      filters.push(`l.id IN (SELECT lore_id FROM lore_tags WHERE tag = ?)`);
      params.push(normalised[0]!);
    } else if (normalised.length > 1) {
      const placeholders = normalised.map(() => "?").join(",");
      filters.push(`l.id IN (SELECT lore_id FROM lore_tags WHERE tag IN (${placeholders}))`);
      params.push(...normalised);
    }
  }
  if (opts.updatedAfter) {
    filters.push("l.updated_at >= ?");
    params.push(opts.updatedAfter);
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  return { from, where, params, hasFts };
}

/**
 * Count of records matching the same filters `searchLore` would apply,
 * ignoring `limit`. Used by the MCP/CLI layers to tell the caller when a
 * result set was truncated ("showing 10 of 23") so it can narrow rather
 * than wrongly conclude the team has nothing more. Cheap COUNT(*); no
 * read events recorded (a count is not a read of any record).
 */
export function searchLoreCount(db: Database, opts: SearchOptions = {}): number {
  const { from, where, params } = buildSearchClauses(opts);
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${from} ${where}`).get(...params) as {
    n: number;
  };
  return row.n;
}

/**
 * FTS-backed search. Default behaviour (designed for token efficiency
 * and agent trust):
 *
 *   - Only `status='active'` records are returned. Drafts (agent-
 *     suggested but un-approved), deprecated, and superseded records
 *     are hidden unless their respective `include*` flag is set.
 *   - `restricted` records are excluded unless `includeRestricted`.
 *   - Returns `LoreSummary` (no body). Use `get_lore(id)` to fetch the
 *     full body on demand. This is the token-saving contract.
 *   - Stale records (review_after in the past) DO appear but each
 *     result is flagged `stale: true` so the agent can warn the user.
 *
 * Ranking: when `query` is set, bm25 relevance ADJUSTED by trust signals
 * (see `trustRankAdjustment`) — we over-fetch a candidate pool, re-rank,
 * then slice to `limit`, so a high-trust record bm25 buried just past the
 * limit can still surface and a stale/low-trust record can't crowd out a
 * better-trusted near-tie. Without a query, plain `updated_at` desc.
 */
export function searchLore(db: Database, opts: SearchOptions = {}): LoreSummary[] {
  // Public-API hardening — CLI and MCP both validate before we get
  // here, but the library entry point is also exported (see src/index.ts)
  // so an embedder calling searchLore directly could otherwise pass
  // NaN / -1 / 1e100 / "not a number". better-sqlite3 binds the value
  // into the LIMIT clause and you get a confusing "datatype mismatch"
  // deep in native code. Surface a clear error at the boundary.
  const limit = normaliseLimit(opts.limit);
  const { from, where, params, hasFts } = buildSearchClauses(opts);

  // bm25 column weights: title is the strongest authority signal,
  // summary is curated short-form, body is the long tail. Heavier
  // weight = more contribution to relevance for matches in that column.
  // Order matches the FTS table definition (title, summary, body).
  const select = hasFts ? `l.*, bm25(lore_fts, 3.0, 2.0, 1.0) AS score` : `l.*, NULL AS score`;
  // When FTS is active we over-fetch a candidate pool ordered by raw
  // bm25, then trust-re-rank in TS. Without FTS the recency order is the
  // intended final order, so fetch exactly `limit`.
  const fetchLimit = hasFts ? Math.max(limit, RANK_CANDIDATE_POOL) : limit;
  const orderBy = hasFts ? "ORDER BY score ASC, l.updated_at DESC" : "ORDER BY l.updated_at DESC";
  const sql = `
    SELECT ${select}
    FROM ${from}
    ${where}
    ${orderBy}
    LIMIT ${fetchLimit}
  `;
  let rows = db.prepare(sql).all(...params) as Array<LoreRow & { score: number | null }>;

  if (hasFts) {
    // Stable re-rank by trust-adjusted bm25. bm25 is NEGATIVE (more
    // negative = more relevant; SQL sorted ASC). We scale each row's
    // score by (1 + adj) where adj ∈ [-0.5, 0.5]: a promoted row's
    // negative score gets MORE negative (ranks earlier), a demoted row's
    // gets LESS negative. Because the multiplier is bounded to [0.5,
    // 1.5], a reorder can only happen inside a ~3× relevance band, so
    // trust breaks near-ties and rescues buried high-trust records but
    // never overrides a clearly stronger lexical match. V8's Array.sort
    // is stable; updated_at desc is the explicit tiebreak for true ties.
    rows = rows
      .map((row) => ({
        row,
        adjusted: (row.score ?? 0) * (1 + trustRankAdjustment(row)),
      }))
      .sort((a, b) => {
        if (a.adjusted !== b.adjusted) return a.adjusted - b.adjusted;
        return a.row.updated_at < b.row.updated_at ? 1 : -1;
      })
      .map((s) => s.row);
  }
  // Slice to the caller's limit BEFORE hydrating / recording reads, so we
  // don't pay to hydrate pool rows that didn't make the cut and don't
  // record a "read" of a record we never returned.
  rows = rows.slice(0, limit);

  const ids = rows.map((r) => r.id);
  const repoMap = reposByIds(db, ids);
  const tagMap = tagsByIds(db, ids);
  const summaries = rows.map((row) =>
    rowToSummary(row, repoMap.get(row.id) ?? [], tagMap.get(row.id) ?? [], row.score ?? undefined),
  );
  recordRead(db, ids, "search");
  return annotatePossibleConflicts(summaries);
}

/**
 * Pairwise overlap detection within a single search response.
 *
 * Two records are surfaced as possible-conflicts when ALL of:
 *   - both are `active` (drafts / deprecated / superseded are not
 *     authoritative — flagging them muddies the signal),
 *   - they share at least one repo,
 *   - they share at least one tag.
 *
 * This is a HEURISTIC, not contradiction detection: two records in the
 * same scope can be complementary just as easily as they can disagree.
 * The flag is a "read both" prompt, not authority. The id sets are
 * populated on each side; ordering is preserved so the agent / CLI can
 * render them deterministically. We don't mutate the input summaries —
 * `LoreSummary` is readonly — we return new objects with
 * `possibleConflicts` populated when non-empty.
 */
function annotatePossibleConflicts(summaries: LoreSummary[]): LoreSummary[] {
  if (summaries.length < 2) return summaries;
  const overlaps = new Map<string, string[]>();
  for (let i = 0; i < summaries.length; i++) {
    const a = summaries[i]!;
    if (a.status !== "active") continue;
    for (let j = i + 1; j < summaries.length; j++) {
      const b = summaries[j]!;
      if (b.status !== "active") continue;
      if (!hasIntersection(a.repos, b.repos)) continue;
      if (!hasIntersection(a.tags, b.tags)) continue;
      if (!overlaps.has(a.id)) overlaps.set(a.id, []);
      if (!overlaps.has(b.id)) overlaps.set(b.id, []);
      overlaps.get(a.id)!.push(b.id);
      overlaps.get(b.id)!.push(a.id);
    }
  }
  if (overlaps.size === 0) return summaries;
  return summaries.map((s) => {
    const c = overlaps.get(s.id);
    return c && c.length > 0 ? { ...s, possibleConflicts: c } : s;
  });
}

function hasIntersection(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const set = new Set(a);
  for (const x of b) if (set.has(x)) return true;
  return false;
}

/**
 * Translate a free-text query into an FTS5 MATCH expression.
 * Split on whitespace, drop empties, quote each term — stops users
 * accidentally tripping FTS operators (NEAR, OR, AND, ", :, etc.).
 *
 * **OR-mode, ranked by bm25.** FTS5 defaults to AND across tokens, which
 * makes multi-word queries brittle (real dogfood: 5 queries against a
 * fresh corpus returned 0 hits because no record contained EVERY token).
 * We join with explicit `OR` so a query of N tokens surfaces records
 * matching any subset; bm25 ranking then puts records matching MORE
 * tokens (and matching them in higher-weighted columns — see column
 * weights at search-site `bm25(lore_fts, 3.0, 2.0, 1.0)`) at the top.
 * Net behaviour: "deployment kafka" surfaces Kafka-only records when
 * nothing matches both, but Kafka-and-deployment records (if any
 * existed) would still rank first.
 *
 * When `prefix` is true, every quoted token of length ≥ 3 is suffixed
 * with `*` so it matches as a prefix ("timez" → "timezone"). Tokens
 * shorter than 3 chars stay exact-match because a 1–2 char prefix is
 * usually meaningless and slow.
 */
function toFtsQuery(input: string, prefix: boolean): string {
  const parts = input
    .split(/\s+/)
    .map((p) => p.replace(/"/g, ""))
    .filter(Boolean);
  if (parts.length === 0) return '""';
  const tokens = parts.map((p) => (prefix && p.length >= 3 ? `"${p}"*` : `"${p}"`));
  // One token: no operator needed (FTS5 happy with bare quoted term).
  // Multiple tokens: explicit OR so partial matches surface; bm25
  // does the ranking work.
  return tokens.length === 1 ? tokens[0]! : tokens.join(" OR ");
}

export interface PossibleDuplicate extends LoreSummary {
  /**
   * Human-readable signal summary explaining why this record was surfaced
   * as a duplicate candidate ("similar-title; shared-repo:payments-svc"
   * etc). Hint-grade; the reviewer makes the call.
   */
  readonly reason: string;
}

export interface PossibleDuplicateResult {
  /**
   * Records the caller is allowed to see. By default this excludes
   * restricted records; pass `allowRestricted: true` to include them
   * (the MCP layer wires this to MEMORY_ALLOW_RESTRICTED_MCP).
   */
  readonly duplicates: PossibleDuplicate[];
  /**
   * Count of matching restricted records — always populated, regardless
   * of whether they ended up in `duplicates`. Lets the agent / CLI say
   * "and N more we're not showing you" without leaking titles.
   */
  readonly restrictedDuplicateCount: number;
}

/**
 * Reviewer aid for suggest_lore: given a record's title (+ optional repo/tag
 * scope), return up to `limit` existing records that look similar — so the
 * agent's response (and the human reviewer) can spot near-duplicates before
 * they accumulate. Hints only: never blocks a suggestion.
 *
 * Ranking: FTS bm25 on title tokens, with a small overlap bonus for records
 * sharing any of the requested repos or tags. The bonus is deliberately
 * coarse — it's a hint, not authoritative.
 *
 * Scope:
 *   - Considers `active` + `draft` records (not deprecated / superseded —
 *     those are tombstones; the reviewer doesn't need to know about them).
 *   - Excludes the just-inserted record itself (caller passes its id).
 *   - Restricted records are excluded from `duplicates` by default but
 *     counted in `restrictedDuplicateCount`. Pass `allowRestricted: true`
 *     (the MCP server wires this to MEMORY_ALLOW_RESTRICTED_MCP) to include
 *     restricted titles in `duplicates` instead.
 *
 * Returns an empty result when the title is too short for meaningful
 * matching (< 2 tokens of length ≥ 3) rather than guessing.
 */
export function findPossibleDuplicates(
  db: Database,
  input: {
    id: string;
    title: string;
    repos?: ReadonlyArray<string>;
    tags?: ReadonlyArray<string>;
  },
  options: { allowRestricted?: boolean; limit?: number } = {},
): PossibleDuplicateResult {
  const empty: PossibleDuplicateResult = {
    duplicates: [],
    restrictedDuplicateCount: 0,
  };
  const tokens = tokenizeTitleForDuplicates(input.title);
  if (tokens.length < 2) return empty;
  const limit = options.limit ?? 3;
  const allowRestricted = options.allowRestricted ?? false;
  // OR the tokens so we surface any partial overlap. FTS5 OR is the default
  // join, but spell it out for clarity. Note we DON'T filter restricted at
  // the SQL level — we need to count restricted matches even when we don't
  // surface them.
  const ftsQuery = tokens.map((t) => `"${t}"`).join(" OR ");
  const rows = db
    .prepare(
      `SELECT l.*, bm25(lore_fts) AS score
       FROM lore l JOIN lore_fts fts ON fts.rowid = l.rowid
       WHERE lore_fts MATCH ?
         AND l.id != ?
         AND l.status IN ('active', 'draft')
       ORDER BY score ASC
       LIMIT 40`,
    )
    .all(ftsQuery, input.id) as Array<LoreRow & { score: number }>;

  const wantRepos = new Set((input.repos ?? []).map(normaliseRepo).filter(Boolean));
  const wantTags = new Set((input.tags ?? []).map(normaliseTag).filter(Boolean));

  let restrictedDuplicateCount = 0;
  type Scored = {
    row: LoreRow & { score: number };
    repos: string[];
    tags: string[];
    sharedRepos: string[];
    sharedTags: string[];
    overlap: number;
  };
  // Pre-filter to the rows we'll actually score, then batch-hydrate
  // their repos/tags in two queries instead of 2*N.
  const visible = rows.filter((row) => {
    if (row.restricted === 1) {
      restrictedDuplicateCount++;
      return allowRestricted;
    }
    return true;
  });
  const visibleIds = visible.map((r) => r.id);
  const dupRepoMap = reposByIds(db, visibleIds);
  const dupTagMap = tagsByIds(db, visibleIds);
  const scored: Scored[] = visible.map((row) => {
    const repos = dupRepoMap.get(row.id) ?? [];
    const tags = dupTagMap.get(row.id) ?? [];
    const sharedRepos = repos.filter((r) => wantRepos.has(r));
    const sharedTags = tags.filter((t) => wantTags.has(t));
    return {
      row,
      repos,
      tags,
      sharedRepos,
      sharedTags,
      overlap: sharedRepos.length + sharedTags.length,
    };
  });
  scored.sort((a, b) => {
    if (a.overlap !== b.overlap) return b.overlap - a.overlap;
    return a.row.score - b.row.score;
  });
  const duplicates: PossibleDuplicate[] = scored.slice(0, limit).map((s) => {
    const summary = rowToSummary(s.row, s.repos, s.tags, s.row.score);
    const signals: string[] = ["similar-title"];
    if (s.sharedRepos.length > 0) {
      signals.push(`shared-repo:${s.sharedRepos.join(",")}`);
    }
    if (s.sharedTags.length > 0) {
      signals.push(`shared-tag:${s.sharedTags.join(",")}`);
    }
    return { ...summary, reason: signals.join("; ") };
  });
  return { duplicates, restrictedDuplicateCount };
}

/**
 * Title tokenizer for duplicate detection: lowercase, split on non-alnum,
 * drop tokens shorter than 3 chars (too noisy: "a", "is", "to"), dedupe,
 * cap at 6 tokens so the FTS query stays cheap.
 */
function tokenizeTitleForDuplicates(title: string): string[] {
  return Array.from(
    new Set(
      title
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3),
    ),
  ).slice(0, 6);
}

/**
 * Recent lore across all lifecycle states (active + draft + deprecated),
 * freshest first. Used by `memory list` for at-a-glance browse.
 */
export function listRecent(db: Database, limit = 20): LoreSummary[] {
  return searchLore(db, {
    limit,
    includeRestricted: true,
    includeDrafts: true,
    includeDeprecated: true,
  });
}

/** Drafts awaiting human review. Surfaced by `memory review`. */
export function listDrafts(db: Database): LoreSummary[] {
  const rows = db
    .prepare("SELECT *, NULL AS score FROM lore WHERE status = 'draft' ORDER BY created_at DESC")
    .all() as Array<LoreRow & { score: null }>;
  const ids = rows.map((r) => r.id);
  const repoMap = reposByIds(db, ids);
  const tagMap = tagsByIds(db, ids);
  return rows.map((r) => rowToSummary(r, repoMap.get(r.id) ?? [], tagMap.get(r.id) ?? []));
}

/**
 * Bulk export — full Lore records (body included). Caller-controlled
 * lifecycle filter, mirroring `searchLore` semantics: defaults to active +
 * non-restricted; opt in to each other class explicitly. Stable ordering
 * (updated_at desc, id asc tiebreak) so two exports of the same DB diff
 * cleanly.
 *
 * NOT exposed via MCP — this is a CLI-only path. The agent gets brief
 * summaries via search and the body of one record at a time via get;
 * bulk extraction is a human operation.
 */
export function exportLore(
  db: Database,
  opts: {
    includeDrafts?: boolean;
    includeDeprecated?: boolean;
    includeSuperseded?: boolean;
    includeRestricted?: boolean;
  } = {},
): Lore[] {
  const allowedStatuses: LoreStatus[] = ["active"];
  if (opts.includeDrafts) allowedStatuses.push("draft");
  if (opts.includeDeprecated) allowedStatuses.push("deprecated");
  if (opts.includeSuperseded) allowedStatuses.push("superseded");

  const filters: string[] = [`status IN (${allowedStatuses.map(() => "?").join(",")})`];
  const params: Array<string | number> = [...allowedStatuses];
  if (!opts.includeRestricted) {
    filters.push("restricted = 0");
  }
  const sql = `
    SELECT * FROM lore
    WHERE ${filters.join(" AND ")}
    ORDER BY updated_at DESC, id ASC
  `;
  const rows = db.prepare(sql).all(...params) as LoreRow[];
  const ids = rows.map((r) => r.id);
  const repoMap = reposByIds(db, ids);
  const tagMap = tagsByIds(db, ids);
  return rows.map((row) => rowToLore(row, repoMap.get(row.id) ?? [], tagMap.get(row.id) ?? []));
}

/**
 * Delete `read` audit events older than `olderThanDays`. Read events are
 * emitted one-per-result on every search/get (see `recordRead`), so on a
 * busy multi-agent install the `events` table grows without bound — these
 * rows are the dominant churn. Pruning keeps the local DB from being a
 * slow leak while preserving the lifecycle events (`created`, `approved`,
 * `rejected`, …) that form the audit chain: only `kind = 'read'` is
 * touched. Returns the number of rows deleted.
 *
 * `stats` windows are bounded (default 90-day citation window), so
 * pruning reads older than that window doesn't lose anything `stats`
 * would have shown.
 */
export function pruneReadEvents(db: Database, olderThanDays: number): number {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
  const info = db.prepare("DELETE FROM events WHERE kind = 'read' AND ts < ?").run(cutoff);
  return info.changes;
}

export function listTags(db: Database): string[] {
  return (
    db.prepare("SELECT DISTINCT tag FROM lore_tags ORDER BY tag").all() as Array<{ tag: string }>
  ).map((r) => r.tag);
}

export function listRepos(db: Database): string[] {
  return (
    db.prepare("SELECT DISTINCT repo FROM lore_repos ORDER BY repo").all() as Array<{
      repo: string;
    }>
  ).map((r) => r.repo);
}
