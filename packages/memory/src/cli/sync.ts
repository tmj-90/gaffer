/**
 * `memory sync` — Markdown round-trip for PR-reviewable team lore.
 *
 * SQLite stays the canonical source of truth for v0.1. `.memory/<id>.md`
 * is a sync artifact: a frontmatter+body file per record, committable
 * to the repo so a team can review knowledge in pull requests. Import
 * is the inverse: parse the .md files back into the SQLite store.
 *
 * Deliberately uses a tiny YAML-shaped frontmatter parser instead of
 * pulling in a YAML dep. The frontmatter schema is flat — scalars and
 * string arrays — so this stays well-defined. Anything richer (nested
 * mappings, block scalars, anchors) is out of scope.
 */
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { Database } from "better-sqlite3";

import { exportLore, upsertLoreFromImport } from "../core/lore.js";
import { type BoundaryExportRecord, exportBoundaries, importBoundary } from "../core/boundaries.js";
import type {
  BoundaryRole,
  BoundaryStatus,
  Lore,
  LoreKind,
  LoreStatus,
  LoreConfidence,
} from "../db/types.js";
import { LORE_KINDS } from "../db/types.js";

const ALLOWED_STATUS = new Set<LoreStatus>(["draft", "active", "deprecated", "superseded"]);
const ALLOWED_CONFIDENCE = new Set<LoreConfidence>(["low", "medium", "high"]);
const ALLOWED_KIND = new Set<LoreKind>([...LORE_KINDS]);

/**
 * Lore ids are 8 lowercase chars from the Crockford-style alphabet
 * `[a-z2-9]` (see core/ids.ts). Anything else in frontmatter is a typo
 * or an attempt to inject a non-conforming key — import refuses it so a
 * stray `id: lol_abc123` doesn't become a permanent ghost record.
 */
const LORE_ID_RE = /^[a-z2-9]{8}$/;

// ── Frontmatter parser ────────────────────────────────────────────────

export interface ParsedFile {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
}

/**
 * Parse a Markdown file with leading YAML-shaped frontmatter. Supports:
 *   - opening / closing `---` fences
 *   - `key: scalar` (string, ISO date, boolean, optionally quoted)
 *   - `key:` followed by `  - item` lines for string arrays
 * Returns null when the file doesn't start with a frontmatter fence.
 */
export function parseFrontmatter(text: string): ParsedFile | null {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return null;
  const fm: Record<string, unknown> = {};
  let i = 1;
  let currentArrayKey: string | null = null;
  let closed = false;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "---") {
      closed = true;
      i++;
      break;
    }
    if (line.trim() === "") continue;
    // List item under the current key.
    if (currentArrayKey && line.startsWith("  - ")) {
      const arr = fm[currentArrayKey] as string[];
      arr.push(unquote(line.slice(4).trim()));
      continue;
    }
    // Otherwise: this is a new key. Reset array context.
    const colonAt = line.indexOf(":");
    if (colonAt < 0) continue;
    const key = line.slice(0, colonAt).trim();
    const rest = line.slice(colonAt + 1).trim();
    if (rest === "") {
      // Block scalar / array marker.
      fm[key] = [];
      currentArrayKey = key;
    } else {
      fm[key] = parseScalar(rest);
      currentArrayKey = null;
    }
  }
  if (!closed) return null;
  const body = lines.slice(i).join("\n").replace(/^\n+/, "");
  return { frontmatter: fm, body };
}

function unquote(s: string): string {
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function parseScalar(s: string): unknown {
  const v = unquote(s);
  if (v === "true") return true;
  if (v === "false") return false;
  return v;
}

// ── Frontmatter emitter ───────────────────────────────────────────────

/**
 * Serialise a Lore record as `<frontmatter>---\n\n<body>\n`. The
 * frontmatter schema is the inverse of parseFrontmatter so a round
 * trip is lossless for everything we care about.
 *
 * Field ordering is fixed for diff stability: two exports of the same
 * record produce byte-identical .md files.
 */
export function renderLoreMarkdown(lore: Lore): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`id: ${lore.id}`);
  lines.push(`title: ${yamlScalar(lore.title)}`);
  lines.push(`summary: ${yamlScalar(lore.summary)}`);
  lines.push(`status: ${lore.status}`);
  lines.push(`kind: ${lore.kind}`);
  lines.push(`confidence: ${lore.confidence}`);
  lines.push(`restricted: ${lore.restricted}`);
  if (lore.author !== undefined) lines.push(`author: ${yamlScalar(lore.author)}`);
  if (lore.team !== undefined) lines.push(`team: ${yamlScalar(lore.team)}`);
  if (lore.source !== undefined) lines.push(`source: ${lore.source}`);
  if (lore.reviewAfter !== undefined) lines.push(`reviewAfter: ${lore.reviewAfter}`);
  if (lore.supersededBy !== undefined) lines.push(`supersededBy: ${lore.supersededBy}`);
  lines.push(`createdAt: ${lore.createdAt}`);
  lines.push(`updatedAt: ${lore.updatedAt}`);
  if (lore.lastVerifiedAt !== undefined) {
    lines.push(`lastVerifiedAt: ${lore.lastVerifiedAt}`);
  }
  if (lore.repos.length > 0) {
    lines.push("repos:");
    for (const r of lore.repos) lines.push(`  - ${r}`);
  }
  if (lore.tags.length > 0) {
    lines.push("tags:");
    for (const t of lore.tags) lines.push(`  - ${t}`);
  }
  if (lore.conflictsWith && lore.conflictsWith.length > 0) {
    lines.push("conflictsWith:");
    for (const id of lore.conflictsWith) lines.push(`  - ${id}`);
  }
  lines.push("---");
  lines.push("");
  lines.push(lore.body);
  lines.push("");
  return lines.join("\n");
}

/**
 * Quote a scalar that would otherwise look like a YAML special form
 * (starts with a special char, contains a colon, etc.). Cheap and
 * conservative — quote anything with a colon or leading non-alnum.
 */
function yamlScalar(v: string): string {
  if (v === "") return '""';
  if (/[:#&*!|>'"%@`]/.test(v) || /^\s|\s$/.test(v) || /\n/.test(v)) {
    return JSON.stringify(v);
  }
  return v;
}

// ── Export ────────────────────────────────────────────────────────────

export interface ExportSyncOptions {
  readonly includeDrafts?: boolean;
  readonly includeDeprecated?: boolean;
  readonly includeSuperseded?: boolean;
  readonly includeRestricted?: boolean;
  /**
   * If true, remove existing <id>.md files in the target directory
   * BEFORE writing the new export. Only files whose name matches the
   * 8-char lore-id pattern are removed — hand-written .md files
   * (e.g. CONTRIBUTING.md) are deliberately left alone.
   */
  readonly clean?: boolean;
}

export interface ExportSyncResult {
  readonly written: ReadonlyArray<string>;
  readonly excluded: { restricted: number; drafts: number };
  /**
   * Restricted records that WERE written (because the caller opted in
   * with `includeRestricted: true`). The CLI uses this to surface a
   * security warning, since these files were also chmod'd to 0600
   * rather than the default 0644.
   */
  readonly restrictedWritten: number;
  /** Paths removed by `clean: true`. Empty when the flag is off. */
  readonly removed: ReadonlyArray<string>;
  /** Count of boundary edges written to boundaries.jsonl. */
  readonly boundariesWritten: number;
}

/**
 * Lore ids are 8 chars from the [a-z2-9] alphabet (see ids.ts). The
 * `--clean` mode only deletes files matching this exact pattern so a
 * stray hand-edited file in the directory isn't blown away.
 */
const LORE_ID_FILE_RE = /^[a-z2-9]{8}\.md$/;

/**
 * Cross-repo boundary edges round-trip through a single newline-delimited
 * JSON file (`boundaries.jsonl`) rather than one file per edge: edges are
 * small, numerous, and machine-shaped, so a single committable artifact
 * diffs cleanly and keeps the `.memory/` directory from filling with
 * tiny files. One JSON object per line; active edges only by default.
 */
export const BOUNDARIES_FILE = "boundaries.jsonl";

const ALLOWED_BOUNDARY_ROLE = new Set<BoundaryRole>(["provides", "consumes"]);
const ALLOWED_BOUNDARY_STATUS = new Set<BoundaryStatus>(["draft", "active", "deprecated"]);

/**
 * Write one `<id>.md` per record into `dir`. Filter defaults mirror
 * the JSON export — active, non-restricted only — with the same four
 * opt-ins. The directory is created (mode 0755) if missing.
 *
 * Existing files in the dir are NOT removed: callers that want a
 * deterministic mirror should clear the dir first. This avoids
 * surprising deletions when someone runs `memory sync export` against
 * a working copy.
 */
export function exportToDir(
  db: Database,
  dir: string,
  opts: ExportSyncOptions = {},
): ExportSyncResult {
  // Always count restricted / drafts that we DIDN'T export — useful
  // signal for the CLI summary so a user knows something was held back.
  const fullSet = exportLore(db, {
    includeDrafts: true,
    includeDeprecated: opts.includeDeprecated,
    includeSuperseded: opts.includeSuperseded,
    includeRestricted: true,
  });
  const filtered = fullSet.filter((r) => {
    if (r.restricted && !opts.includeRestricted) return false;
    if (r.status === "draft" && !opts.includeDrafts) return false;
    return true;
  });
  const excludedRestricted = fullSet.filter((r) => r.restricted && !opts.includeRestricted).length;
  const excludedDrafts = fullSet.filter((r) => r.status === "draft" && !opts.includeDrafts).length;
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const removed: string[] = [];
  if (opts.clean) {
    let existing: string[] = [];
    try {
      existing = readdirSync(dir);
    } catch {
      // Directory just created or unreadable — nothing to clean.
    }
    for (const name of existing) {
      if (!LORE_ID_FILE_RE.test(name)) continue;
      const path = join(dir, name);
      try {
        unlinkSync(path);
        removed.push(path);
      } catch {
        // best-effort; skip files we couldn't remove
      }
    }
  }
  const written: string[] = [];
  let restrictedWritten = 0;
  for (const lore of filtered) {
    const path = join(dir, `${lore.id}.md`);
    writeFileSync(path, renderLoreMarkdown(lore), { encoding: "utf8" });
    // Restricted records get the same 0600 lockdown as the JSON export
    // (see cmdExport in cli/index.ts). Non-restricted records stay
    // world-readable so they can be committed and reviewed normally.
    const mode = lore.restricted ? 0o600 : 0o644;
    try {
      chmodSync(path, mode);
    } catch {
      // best-effort
    }
    if (lore.restricted) restrictedWritten++;
    written.push(path);
  }
  // Boundary edges → a single boundaries.jsonl. Active edges only (same
  // PR-is-the-gate stance as lore); drafts/deprecated opt in via the
  // same flags. The file is rewritten wholesale each export so a removed
  // edge actually disappears from the artifact.
  const boundaryRecs = exportBoundaries(db, {
    includeDrafts: opts.includeDrafts,
    includeDeprecated: opts.includeDeprecated,
  });
  const boundariesPath = join(dir, BOUNDARIES_FILE);
  if (boundaryRecs.length > 0) {
    const jsonl = boundaryRecs.map((r) => JSON.stringify(r)).join("\n") + "\n";
    writeFileSync(boundariesPath, jsonl, { encoding: "utf8" });
    written.push(boundariesPath);
  } else {
    // No active edges — remove a stale artifact so it doesn't linger.
    try {
      unlinkSync(boundariesPath);
    } catch {
      // not present — fine
    }
  }
  return {
    written,
    excluded: { restricted: excludedRestricted, drafts: excludedDrafts },
    restrictedWritten,
    removed,
    boundariesWritten: boundaryRecs.length,
  };
}

/**
 * Parse + validate one boundaries.jsonl line into a BoundaryExportRecord.
 * Returns null for blank lines, unparseable JSON, or rows missing the
 * required (repo, contract, role, status) shape — a malformed line is
 * skipped, never allowed to poison the import.
 */
export function parseBoundaryLine(line: string): BoundaryExportRecord | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null) return null;
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const repo = obj["repo"];
  const contract = obj["contract"];
  const role = obj["role"];
  const status = obj["status"];
  if (typeof repo !== "string" || repo.length === 0) return null;
  if (typeof contract !== "string" || contract.length === 0) return null;
  if (typeof role !== "string" || !ALLOWED_BOUNDARY_ROLE.has(role as BoundaryRole)) {
    return null;
  }
  if (typeof status !== "string" || !ALLOWED_BOUNDARY_STATUS.has(status as BoundaryStatus)) {
    return null;
  }
  const str = (k: string): string | undefined =>
    typeof obj[k] === "string" ? (obj[k] as string) : undefined;
  return {
    id: str("id") ?? "",
    repo,
    contract,
    role: role as BoundaryRole,
    kind: str("kind"),
    status: status as BoundaryStatus,
    detail: str("detail"),
    source: str("source"),
    author: str("author"),
    createdAt: str("createdAt") ?? "",
    updatedAt: str("updatedAt") ?? "",
  };
}

// ── Import ────────────────────────────────────────────────────────────

export interface ImportSyncOptions {
  /**
   * If true, import even restricted records from the .memory/ directory.
   * Off by default — committed restricted records are a red flag, but
   * an opt-in matters for teams that have a private repo and treat the
   * git history as the security boundary.
   */
  readonly includeRestricted?: boolean;
  /**
   * If true, overwrite local records even when the local copy is newer
   * (or has the same updatedAt). Off by default — safe-import is the
   * intended behaviour, since an unconditional upsert silently clobbers
   * a teammate's later edits if you import a stale branch.
   */
  readonly force?: boolean;
  /**
   * If true, do everything except write to the DB. Used by callers
   * (`--dry-run`) that want to surface the import plan first.
   */
  readonly dryRun?: boolean;
}

export interface ImportSyncResult {
  readonly created: number;
  readonly updated: number;
  /**
   * Records whose local copy is strictly newer than the incoming file.
   * Equal timestamps fall through and re-upsert idempotently. The CLI
   * surfaces this as a hint that `--force` is needed to overwrite.
   */
  readonly skippedNewer: number;
  /**
   * Files that imported successfully but reference a `supersededBy` id
   * that doesn't exist locally (and isn't elsewhere in the batch).
   * The import still proceeds — PR review is the trust gate per the
   * docs — but the reference is dead until the target lands. Surfaced
   * in the CLI summary as a warning so the operator notices.
   */
  readonly danglingSupersededBy: ReadonlyArray<{
    file: string;
    id: string;
    supersededBy: string;
  }>;
  /**
   * Files that failed schema/id/enum validation. One entry per file;
   * the reason is shown verbatim in the CLI summary.
   */
  readonly skipped: ReadonlyArray<{ file: string; reason: string }>;
  /** Boundary edges imported from boundaries.jsonl (created + updated). */
  readonly boundariesCreated: number;
  readonly boundariesUpdated: number;
  /** True when `dryRun` was set; no DB writes happened. */
  readonly dryRun: boolean;
}

/**
 * Read every `*.md` file in `dir` and upsert each one. Files without
 * frontmatter, or with frontmatter that fails id-shape / enum / type
 * validation, are skipped with a reason rather than crashing the import
 * (or — worse — getting upserted as ghost records).
 *
 * Default mode is **safe-import**: a local record whose `updatedAt` is
 * >= the incoming file's `updatedAt` is left alone. Pass `force: true`
 * to overwrite regardless. Pass `dryRun: true` to plan without writing.
 *
 * Per the PR-is-the-review-gate decision, imports respect whatever
 * status the file declares. Restricted records are excluded by
 * default (opt-in via includeRestricted).
 */
export function importFromDir(
  db: Database,
  dir: string,
  opts: ImportSyncOptions = {},
): ImportSyncResult {
  let created = 0;
  let updated = 0;
  let skippedNewer = 0;
  const skipped: Array<{ file: string; reason: string }> = [];
  const danglingSupersededBy: Array<{
    file: string;
    id: string;
    supersededBy: string;
  }> = [];
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch (err) {
    throw new Error(
      `memory sync import: cannot read directory ${dir} — ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
  // Two-pass setup: scan the file list once to collect the set of ids
  // about to land in this batch, so a record that supersedes another
  // record in the same import isn't flagged as dangling.
  const incomingIds = new Set<string>();
  for (const file of entries) {
    const text = readFileSync(join(dir, file), "utf8");
    const fm = parseFrontmatter(text)?.frontmatter;
    if (fm && typeof fm["id"] === "string" && LORE_ID_RE.test(fm["id"])) {
      incomingIds.add(fm["id"]);
    }
  }
  for (const file of entries) {
    const path = join(dir, file);
    const text = readFileSync(path, "utf8");
    const parsed = parseFrontmatter(text);
    if (!parsed) {
      skipped.push({ file, reason: "no frontmatter" });
      continue;
    }
    const fm = parsed.frontmatter;
    const id = fm["id"];
    const title = fm["title"];
    const summary = fm["summary"];
    const status = fm["status"];
    if (typeof id !== "string" || !LORE_ID_RE.test(id)) {
      skipped.push({
        file,
        reason: `invalid id ${JSON.stringify(id)} (expected 8 chars from [a-z2-9])`,
      });
      continue;
    }
    if (typeof title !== "string" || title.length === 0) {
      skipped.push({ file, reason: "missing or invalid title" });
      continue;
    }
    if (typeof summary !== "string" || summary.length === 0) {
      skipped.push({ file, reason: "missing or invalid summary" });
      continue;
    }
    if (typeof status !== "string" || !ALLOWED_STATUS.has(status as LoreStatus)) {
      skipped.push({
        file,
        reason: `missing or invalid status (got ${JSON.stringify(status)})`,
      });
      continue;
    }
    const restrictedRaw = fm["restricted"];
    if (restrictedRaw !== undefined && typeof restrictedRaw !== "boolean") {
      skipped.push({
        file,
        reason: `invalid restricted ${JSON.stringify(restrictedRaw)} (expected boolean)`,
      });
      continue;
    }
    const restricted = restrictedRaw === true;
    if (restricted && !opts.includeRestricted) {
      skipped.push({ file, reason: "restricted (use --include-restricted to import)" });
      continue;
    }
    const confidenceRaw = fm["confidence"];
    if (
      confidenceRaw !== undefined &&
      (typeof confidenceRaw !== "string" ||
        !ALLOWED_CONFIDENCE.has(confidenceRaw as LoreConfidence))
    ) {
      skipped.push({
        file,
        reason: `invalid confidence ${JSON.stringify(confidenceRaw)} (expected low|medium|high)`,
      });
      continue;
    }
    const confidence = confidenceRaw as LoreConfidence | undefined;
    const kindRaw = fm["kind"];
    if (
      kindRaw !== undefined &&
      (typeof kindRaw !== "string" || !ALLOWED_KIND.has(kindRaw as LoreKind))
    ) {
      skipped.push({
        file,
        reason: `invalid kind ${JSON.stringify(kindRaw)} (expected ${[...ALLOWED_KIND].join("|")})`,
      });
      continue;
    }
    const kind = kindRaw as LoreKind | undefined;
    const supersededByRaw = fm["supersededBy"];
    if (
      supersededByRaw !== undefined &&
      (typeof supersededByRaw !== "string" || !LORE_ID_RE.test(supersededByRaw))
    ) {
      skipped.push({
        file,
        reason: `invalid supersededBy ${JSON.stringify(supersededByRaw)} (expected 8 chars from [a-z2-9])`,
      });
      continue;
    }
    const repos = fm["repos"];
    if (repos !== undefined && !isStringArray(repos)) {
      skipped.push({ file, reason: "invalid repos (expected list of strings)" });
      continue;
    }
    const tags = fm["tags"];
    if (tags !== undefined && !isStringArray(tags)) {
      skipped.push({ file, reason: "invalid tags (expected list of strings)" });
      continue;
    }
    const conflictsWith = fm["conflictsWith"];
    if (conflictsWith !== undefined && !isStringArray(conflictsWith)) {
      skipped.push({
        file,
        reason: "invalid conflictsWith (expected list of lore ids)",
      });
      continue;
    }
    if (isStringArray(conflictsWith) && !conflictsWith.every((cid) => LORE_ID_RE.test(cid))) {
      skipped.push({
        file,
        reason: "invalid conflictsWith id (each must be 8 chars from [a-z2-9])",
      });
      continue;
    }
    const tsCheck =
      checkTimestamp(fm, "createdAt") ??
      checkTimestamp(fm, "updatedAt") ??
      checkTimestamp(fm, "lastVerifiedAt") ??
      checkTimestamp(fm, "reviewAfter");
    if (tsCheck) {
      skipped.push({ file, reason: tsCheck });
      continue;
    }

    // Safe-import: skip only when the local record is strictly newer
    // than the incoming file. Equal timestamps fall through and re-upsert
    // — that keeps idempotent re-imports working and matches the user's
    // spec ("if incoming.updatedAt < existing.updatedAt: skip"). When
    // the incoming file omits updatedAt we have no clock to compare, so
    // we let it proceed; that matches the pre-safe-import behaviour for
    // a hand-authored file and is unsurprising.
    if (!opts.force) {
      const incomingUpdatedAt =
        typeof fm["updatedAt"] === "string" ? (fm["updatedAt"] as string) : undefined;
      const localUpdatedAt = db.prepare("SELECT updated_at FROM lore WHERE id = ?").get(id) as
        | { updated_at: string }
        | undefined;
      if (localUpdatedAt && incomingUpdatedAt && localUpdatedAt.updated_at > incomingUpdatedAt) {
        skippedNewer++;
        continue;
      }
    }

    if (opts.dryRun) {
      const exists = db.prepare("SELECT 1 FROM lore WHERE id = ?").get(id) as unknown;
      if (exists) updated++;
      else created++;
      continue;
    }

    const result = upsertLoreFromImport(db, {
      id,
      title,
      summary,
      body: parsed.body.trimEnd(),
      status: status as LoreStatus,
      author: typeof fm["author"] === "string" ? (fm["author"] as string) : undefined,
      team: typeof fm["team"] === "string" ? (fm["team"] as string) : undefined,
      kind,
      source: typeof fm["source"] === "string" ? (fm["source"] as string) : undefined,
      reviewAfter:
        typeof fm["reviewAfter"] === "string" ? (fm["reviewAfter"] as string) : undefined,
      confidence,
      repos: repos as string[] | undefined,
      tags: tags as string[] | undefined,
      restricted,
      supersededBy: supersededByRaw as string | undefined,
      conflictsWith: conflictsWith as string[] | undefined,
      createdAt: typeof fm["createdAt"] === "string" ? (fm["createdAt"] as string) : undefined,
      updatedAt: typeof fm["updatedAt"] === "string" ? (fm["updatedAt"] as string) : undefined,
      lastVerifiedAt:
        typeof fm["lastVerifiedAt"] === "string" ? (fm["lastVerifiedAt"] as string) : undefined,
    });
    if (result.created) created++;
    else updated++;
    // Dangling supersededBy: the imported record claims to be replaced
    // by a target id that is neither already in the local DB nor part
    // of this same batch. Allowed (PR review is the trust gate) but
    // surfaced so the operator notices a dead reference.
    if (
      typeof supersededByRaw === "string" &&
      !incomingIds.has(supersededByRaw) &&
      !db.prepare("SELECT 1 FROM lore WHERE id = ?").get(supersededByRaw)
    ) {
      danglingSupersededBy.push({
        file,
        id,
        supersededBy: supersededByRaw,
      });
    }
  }
  // Boundary edges from boundaries.jsonl. Keyed by (repo, contract, role)
  // inside importBoundary, so two repos' maps converge on one local edge.
  let boundariesCreated = 0;
  let boundariesUpdated = 0;
  try {
    const bpath = join(dir, BOUNDARIES_FILE);
    const btext = readFileSync(bpath, "utf8");
    for (const line of btext.split(/\r?\n/)) {
      const rec = parseBoundaryLine(line);
      if (!rec) continue;
      const outcome = importBoundary(db, rec, {
        force: opts.force,
        dryRun: opts.dryRun,
      });
      if (outcome === "created") boundariesCreated++;
      else if (outcome === "updated") boundariesUpdated++;
    }
  } catch {
    // No boundaries.jsonl in this directory — fine, most repos won't
    // have boundary edges. Only lore is required.
  }
  return {
    created,
    updated,
    skippedNewer,
    danglingSupersededBy,
    skipped,
    boundariesCreated,
    boundariesUpdated,
    dryRun: !!opts.dryRun,
  };
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

// ── Recursive cross-repo discovery (`sync pull`) ──────────────────────

export const SYNC_PULL_SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  "vendor",
  ".next",
  ".cache",
  ".turbo",
  "out",
  ".pnpm-store",
]);

/**
 * Walk `root` recursively, return absolute paths of every `.memory/`
 * directory found. Skips common heavy directories (see
 * SYNC_PULL_SKIP_DIRS) to bound the scan. Doesn't descend INTO a
 * discovered `.memory/` (its contents are records, not nested
 * caches).
 *
 * Heuristic gate: only counts a `.memory/` directory if it
 * contains at least one `<id>.md` file matching the lore-id shape.
 * Avoids false positives from unrelated tool caches that happen to
 * use the name.
 *
 * Sorts the returned list so the import order is stable across runs.
 */
export function findMemoryDirs(root: string): string[] {
  const found: string[] = [];
  function walk(dir: string): void {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SYNC_PULL_SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.name === ".memory") {
        try {
          // Count a .memory/ if it holds at least one lore <id>.md OR
          // a boundaries.jsonl — a repo may export only boundary edges
          // (no lore yet) and still belong in the cross-repo map.
          const contents = readdirSync(full);
          const hasLore = contents.some((f) => LORE_ID_FILE_RE.test(f));
          const hasBoundaries = contents.includes(BOUNDARIES_FILE);
          if (hasLore || hasBoundaries) found.push(full);
        } catch {
          // unreadable — skip
        }
        continue; // never descend into .memory itself
      }
      // Skip other hidden directories — they're either tool caches
      // (.cache, .next) or repo metadata (.git, .github). The
      // SYNC_PULL_SKIP_DIRS check above catches the known heavy
      // ones explicitly; anything else starting with "." we skip
      // conservatively.
      if (entry.name.startsWith(".")) continue;
      walk(full);
    }
  }
  walk(root);
  return found.sort();
}

function checkTimestamp(fm: Record<string, unknown>, key: string): string | undefined {
  const v = fm[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) {
    return `invalid ${key} ${JSON.stringify(v)} (expected an ISO-8601 date string)`;
  }
  return undefined;
}
