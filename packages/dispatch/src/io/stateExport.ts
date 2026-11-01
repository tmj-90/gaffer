/**
 * Dispatch state export/import (H5 portability).
 *
 * The README sells the factory as "an asset you own and carry between machines",
 * but only `.memory/` was portable. This module makes the *board* portable too:
 * it serialises the whole `dispatch.sqlite` — tickets, epics, scope graph,
 * acceptance criteria, repos, ticket↔repo links, decisions, reviews/evidence,
 * work_events and the trust/claim history — into a single deterministic JSON
 * bundle, and re-creates that board into a fresh DB.
 *
 * Mirrors memory's sync model (see packages/memory/src/cli/sync.ts):
 *  - SQLite stays the source of truth; the bundle is a committable artifact.
 *  - Stable ordering (by primary key) so two exports of one DB are byte-identical.
 *  - Versioned: the bundle records both a `format_version` (this serialiser's
 *    contract) and the DB's `schema_version`, and import refuses a bundle whose
 *    schema_version this build cannot satisfy.
 *
 * It is PURE DATA: no network, no secrets minting. The one hash-bearing column
 * (`ticket_claims.claim_token_hash`) is carried as-is — it is already a hash, and
 * round-tripping it preserves the claim/trust history. No new secret is exposed.
 */
import type { Statement } from "better-sqlite3";

import type { Db } from "../db/connection.js";
import { backfillEventChain, EVENT_CHAIN_GENESIS, verifyEventChain } from "../events/eventChain.js";
import { EVENT_CHAIN_SCHEMA_VERSION, migrate, openDatabase } from "../db/connection.js";
import { SCHEMA_VERSION } from "../db/schema.js";
import { DispatchError } from "../util/errors.js";

/**
 * Bundle format contract version. Bumped when the SHAPE of the bundle changes
 * (a table added/removed from {@link EXPORT_TABLES}, or the envelope changes) in
 * a way an older importer could not read. Distinct from `schema_version`, which
 * tracks the SQLite schema itself.
 */
export const STATE_FORMAT_VERSION = 1;

/**
 * Every durable board/epic/scope/review/trust table, in FK-safe dependency order
 * (parents before children) so an importer can insert straight down the list with
 * foreign keys ON. The order is also the export order, but export ordering doesn't
 * matter for correctness — only import does.
 *
 * EXCLUDED:
 *  - `schema_meta`: pure metadata (only the `schema_version` row in practice),
 *    captured by the bundle's top-level `schema_version` field and re-stamped by
 *    {@link migrate} on import — re-inserting it would be redundant and could
 *    fight the importer's own version stamp.
 *  - `runs`: the run-activity registry (schema_version 10) is machine-local
 *    control-plane data — its rows carry this machine's pids and
 *    `$GAFFER_DATA/runs/<id>.log` paths and have no FK to the board. They are
 *    meaningless on another machine (and a `running` row imported with a foreign
 *    pid would actively mislead the stale-run sweep), so run history is NOT part
 *    of the portable board bundle.
 *
 *  - `api_principals`: machine-local CREDENTIALS (token hashes bound to actor
 *    identities). A board bundle must never carry access material; an importing
 *    factory mints its own principals.
 *
 * Those three are {@link EXCLUDED_TABLES}, with their reasons. Every other table in
 * SCHEMA_SQL carries durable board state and IS included (`plan_sessions` and
 * `paused_deliveries` were left out while this comment said otherwise: exploratory
 * finding api/F2). The drift guard in state-export.test.ts reads both lists: a table in
 * neither fails it, and every exported table must round-trip seeded rows.
 */
export const EXPORT_TABLES = [
  // Roots (no FK dependencies).
  "tickets",
  "repositories",
  "decisions",
  "agents",
  "scope_nodes",
  // Spec-Driven Development: frozen statements of product intent. Standalone (no
  // FK — target_repo/scope_node_id are soft references), and a durable, portable
  // asset the operator carries between machines, so it IS part of the bundle.
  "specs",
  // PLANNER CONVERSATIONS (exploratory finding api/F2): the plan-build sessions (brief,
  // messages, the proposed plan, target repo/scope). Standalone (no FK: a session
  // outlives its epic) and the operator's own planning history, so it travels with the
  // board; a restore that dropped them lost every planner session.
  "plan_sessions",
  // First-level children.
  "acceptance_criteria",
  "ticket_required_capabilities",
  "agent_capabilities",
  "ticket_claims",
  "ticket_repos",
  "ticket_repo_delivery",
  "ticket_scope_nodes",
  "scope_edges",
  "scope_repos",
  "ticket_decisions",
  // Depends on tickets + acceptance_criteria + repositories + decisions.
  "evidence",
  // Free-standing audit tables (no FK, but logically late).
  "work_events",
  // Self-referential within tickets (already present by here).
  "ticket_dependencies",
  // FAILURE-DIAGNOSIS: the append-only rework failure trail (FK to tickets). Durable
  // board diagnostics — the "why did #N fail" history is exactly the kind of asset
  // the README promises you carry between machines, so it IS part of the bundle.
  "rework_attempts",
  // PAUSE-ON-CAP (exploratory finding api/F2): the resume context of a delivery paused in
  // place (FK to tickets). A `paused` ticket without its row can neither resume nor be
  // continued, so the row travels with its ticket. Its worktree path is this machine's;
  // on another machine the resume finds no worktree and the delivery starts over, which
  // is still better than a paused ticket nothing can move.
  "paused_deliveries",
  // GRADUATED-AUTONOMY (Spec 2, Phase 3): the per-(repo × risk × gate) autonomy
  // enablement + its evidence snapshot (FK to repositories, so it sorts after that
  // root). A durable, security-relevant operator decision worth carrying between
  // machines (and auditable), so it IS part of the bundle.
  "autonomy_policy",
  // SQUAD (v27): the operator's club identity (one row, no FK). The team name and
  // kit are part of the factory the operator carries between machines.
  "club",
] as const;

export type ExportTable = (typeof EXPORT_TABLES)[number];

/**
 * The tables deliberately NOT carried, each with its reason (see the comment above
 * {@link EXPORT_TABLES}). `dispatch export` names them, so "the whole board" is honest
 * about what it leaves out, and the drift guard requires every live table to be in one
 * of the two lists.
 */
export const EXCLUDED_TABLES: Readonly<Record<string, string>> = {
  schema_meta: "metadata: the bundle's schema_version; migrate() re-stamps it on import",
  runs: "machine-local run registry: this machine's pids and log paths",
  api_principals: "machine-local credentials: an importing factory mints its own",
};

/**
 * The ORDER BY clause (primary-key columns) used to make each table's rows
 * deterministic. Composite-key tables order by every key column so the output is
 * stable regardless of SQLite's physical row order.
 */
const TABLE_ORDER_BY: Record<ExportTable, string> = {
  tickets: "id",
  repositories: "id",
  decisions: "id",
  agents: "id",
  scope_nodes: "id",
  specs: "id",
  plan_sessions: "id",
  acceptance_criteria: "id",
  ticket_required_capabilities: "ticket_id, capability",
  agent_capabilities: "agent_id, capability",
  ticket_claims: "id",
  ticket_repos: "ticket_id, repo_id",
  ticket_repo_delivery: "ticket_id, repo_id",
  ticket_scope_nodes: "ticket_id, scope_node_id",
  scope_edges: "id",
  scope_repos: "id",
  ticket_decisions: "ticket_id, decision_id, relation",
  evidence: "id",
  // The event log's ORDER is its meaning: the hash chain, every timeline, the stream
  // cursor and the cycle-time rollups all read work_events in rowid (insertion)
  // order, and ids are random UUIDs. Export in rowid order; import inserts rows in
  // bundle order (see orderEventsForImport), so the restored rowids follow it.
  work_events: "rowid",
  ticket_dependencies: "ticket_id, depends_on_ticket_id",
  rework_attempts: "id",
  paused_deliveries: "ticket_id",
  autonomy_policy: "id",
  club: "id",
};

/** A single table's rows, each row a column→value map (SQLite scalar values). */
export type TableRows = ReadonlyArray<Readonly<Record<string, unknown>>>;

/** The portable bundle: a versioned envelope around every exported table. */
export interface StateBundle {
  /** {@link STATE_FORMAT_VERSION} the bundle was written with. */
  readonly format_version: number;
  /** The DB's `schema_version` at export time (see schema.ts). */
  readonly schema_version: number;
  /** ISO-8601 instant the export ran. Informational; not used for ordering. */
  readonly exported_at: string;
  /** One key per {@link EXPORT_TABLES} table, value = its ordered rows. */
  readonly tables: Readonly<Record<string, TableRows>>;
}

/** Options for {@link exportState}. */
export interface ExportStateOptions {
  /** Override the export timestamp (tests pin this for determinism checks). */
  readonly now?: string;
}

/**
 * Read the DB's stamped `schema_version`. Returns {@link SCHEMA_VERSION} (this
 * build's) when the row is absent — a freshly-migrated DB always has it, so the
 * fallback only matters for a hand-rolled fixture.
 */
function readSchemaVersion(db: Db): number {
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as
    { value: string } | undefined;
  if (!row) return SCHEMA_VERSION;
  const parsed = Number(row.value);
  return Number.isFinite(parsed) ? parsed : SCHEMA_VERSION;
}

/**
 * Serialise the whole factory board to a deterministic {@link StateBundle}. Two
 * exports of the same DB produce byte-identical JSON (when `now` is pinned):
 * tables are emitted in a fixed order and rows are ordered by primary key.
 *
 * Every table (and the schema version) is read inside ONE read transaction, so the
 * bundle is a single consistent snapshot of the board even while another process is
 * writing. Before this, each table was read in its own implicit transaction: a writer
 * that created an epic between the `tickets` read and the `ticket_dependencies` read
 * left the export with dependency rows whose tickets it never saw, and the importer
 * rejected the untouched file (the third external review's restore finding). Under
 * WAL a read transaction sees the database as of its first read and writers carry on
 * unblocked; under a rollback journal the shared lock held for the transaction makes
 * writers wait. A deferred transaction takes no write lock either way.
 */
export function exportState(db: Db, opts: ExportStateOptions = {}): StateBundle {
  const snapshot = db.transaction((): StateBundle => {
    const tables: Record<string, TableRows> = {};
    // Read the version first: it is the read that starts the snapshot under WAL.
    const schemaVersion = readSchemaVersion(db);
    for (const table of EXPORT_TABLES) {
      const orderBy = TABLE_ORDER_BY[table];
      // Table/column identifiers are compile-time constants from EXPORT_TABLES /
      // TABLE_ORDER_BY — never user input — so this interpolation is safe.
      const rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all() as Array<
        Record<string, unknown>
      >;
      tables[table] = rows;
    }
    return {
      format_version: STATE_FORMAT_VERSION,
      schema_version: schemaVersion,
      exported_at: opts.now ?? new Date().toISOString(),
      tables,
    };
  });
  // Already inside a caller's transaction, better-sqlite3 nests this as a savepoint,
  // which reads the caller's (equally consistent) view.
  return snapshot.deferred();
}

/** What {@link verifyBundleRestores} established about a bundle. */
export interface BundleVerification {
  /** Total rows the bundle restored into the scratch database. */
  readonly rowsRestored: number;
  /** Per-table restored-row counts. */
  readonly byTable: Readonly<Record<string, number>>;
}

/**
 * What to do next. A retry fixes a snapshot torn by something outside the read
 * transaction; when the same check fails again, the source rows themselves are
 * inconsistent and a retry will never produce a backup that restores.
 */
const RETRY_HINT =
  "Run the export again; if it fails the same way, the source database itself fails " +
  "this check (e.g. `PRAGMA foreign_key_check` reports rows) and needs repairing before " +
  "it can be backed up.";

/**
 * Prove a bundle restores before anyone relies on it: load it into a scratch
 * in-memory database with the importer itself (the same envelope, event-chain and
 * foreign-key checks `dispatch import` runs) and confirm every row landed. Throws an
 * INCONSISTENT_BUNDLE {@link DispatchError} naming what failed otherwise.
 *
 * `dispatch export` calls this before it writes or reports anything, so a bundle the
 * importer would reject is never reported as a successful backup while the operator
 * still has the source database to take another copy from.
 */
export function verifyBundleRestores(bundle: StateBundle): BundleVerification {
  const scratch = openDatabase(":memory:");
  try {
    let result: ImportStateResult;
    try {
      result = importState(scratch, bundle);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const code = err instanceof DispatchError ? err.code : "INTERNAL_ERROR";
      throw new DispatchError(
        "INCONSISTENT_BUNDLE",
        `Export failed its restore check, so it was not written: ${reason} ` +
          `The source database is unchanged. ${RETRY_HINT}`,
        { stage: "export-verify", cause: code },
      );
    }
    for (const table of EXPORT_TABLES) {
      const expected = (bundle.tables[table] ?? []).length;
      const restored = result.byTable[table] ?? 0;
      if (restored !== expected) {
        throw new DispatchError(
          "INCONSISTENT_BUNDLE",
          `Export failed its restore check, so it was not written: ${table} restored ` +
            `${restored} of ${expected} row(s). The source database is unchanged. ${RETRY_HINT}`,
          { stage: "export-verify", table, expected, restored },
        );
      }
    }
    return { rowsRestored: result.rowsInserted, byTable: result.byTable };
  } finally {
    scratch.close();
  }
}

/** Serialise a bundle to a stable, pretty-printed JSON string (2-space indent). */
export function serializeBundle(bundle: StateBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

// ── Import ────────────────────────────────────────────────────────────────

/** Options for {@link importState}. */
export interface ImportStateOptions {
  /**
   * Replace the contents of a NON-EMPTY target DB. Off by default: importing into
   * a populated board would silently clobber/merge it, so the importer refuses
   * unless the caller explicitly opts in. With `force`, every export table is
   * cleared first, then the bundle is loaded.
   */
  readonly force?: boolean;
}

/** Result of {@link importState}: per-table inserted-row counts. */
export interface ImportStateResult {
  readonly formatVersion: number;
  readonly schemaVersion: number;
  /** Total rows inserted across all tables. */
  readonly rowsInserted: number;
  /** Per-table inserted-row counts, keyed by table name. */
  readonly byTable: Readonly<Record<string, number>>;
}

/** Type guard: a parsed value is a plausible {@link StateBundle} envelope. */
function isBundleShape(value: unknown): value is StateBundle {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["format_version"] === "number" &&
    typeof v["schema_version"] === "number" &&
    typeof v["tables"] === "object" &&
    v["tables"] !== null
  );
}

/**
 * Validate the bundle envelope and its version compatibility. Throws a
 * {@link DispatchError} with a clear message on any mismatch:
 *  - a malformed envelope (missing/!typed fields);
 *  - an unknown `format_version` (newer than this serialiser understands);
 *  - a `schema_version` newer than this build's {@link SCHEMA_VERSION}.
 *
 * An OLDER schema_version is accepted: {@link migrate} brings the fresh DB up to
 * the current schema, and the bundle's rows slot into the (additively) compatible
 * tables — exactly how memory tolerates older artifacts.
 */
export function validateBundle(value: unknown): StateBundle {
  if (!isBundleShape(value)) {
    throw new DispatchError(
      "VALIDATION_ERROR",
      "Not a Dispatch state bundle: expected an object with numeric format_version, " +
        "numeric schema_version and a tables object.",
    );
  }
  if (value.format_version > STATE_FORMAT_VERSION) {
    throw new DispatchError(
      "INCOMPATIBLE_BUNDLE",
      `This bundle's format_version (${value.format_version}) is newer than this build ` +
        `understands (${STATE_FORMAT_VERSION}). Upgrade Dispatch to import it.`,
      { found: value.format_version, supported: STATE_FORMAT_VERSION },
    );
  }
  if (value.schema_version > SCHEMA_VERSION) {
    throw new DispatchError(
      "INCOMPATIBLE_BUNDLE",
      `This bundle's schema_version (${value.schema_version}) is newer than this build ` +
        `supports (${SCHEMA_VERSION}). Upgrade Dispatch to import it.`,
      { found: value.schema_version, supported: SCHEMA_VERSION },
    );
  }
  return value;
}

/** Count rows across every export table — used for the non-empty-DB guard. */
function countExistingRows(db: Db): number {
  let total = 0;
  for (const table of EXPORT_TABLES) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    total += row.n;
  }
  return total;
}

/**
 * Put a bundle's `work_events` rows into their original insertion order before
 * they are inserted (insert order becomes the restored rowid order).
 *
 * A chained bundle (every row hashed) carries its own order: each row's `prev_hash`
 * names its predecessor, so walk the links from genesis. This also restores bundles
 * written before the export ordered by rowid (they listed events in random UUID
 * order). A fork, a gap or a missing link means the bundle was edited: refuse it.
 *
 * A pre-chain bundle (schema_version below {@link EVENT_CHAIN_SCHEMA_VERSION}, no
 * hashes) has no links; best effort is a stable sort by `created_at`. A chained-era
 * bundle with unhashed rows is refused: the hashes were stripped, and re-chaining
 * them here would launder an edit into a log that verifies clean.
 */
function orderEventsForImport(
  rows: ReadonlyArray<Record<string, unknown>>,
  schemaVersion: number,
): Array<Record<string, unknown>> {
  const hashed = (r: Record<string, unknown>): boolean =>
    typeof r.hash === "string" && typeof r.prev_hash === "string";
  const nHashed = rows.filter(hashed).length;
  if (rows.length === 0) return [];

  if (nHashed === 0 && schemaVersion < EVENT_CHAIN_SCHEMA_VERSION) {
    return rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => {
        const ca = String(a.row.created_at ?? "");
        const cb = String(b.row.created_at ?? "");
        return ca < cb ? -1 : ca > cb ? 1 : a.index - b.index;
      })
      .map((e) => e.row);
  }
  if (nHashed !== rows.length) {
    throw new DispatchError(
      "INCONSISTENT_BUNDLE",
      `Bundle has ${rows.length - nHashed} work_events row(s) with no hash although it was ` +
        `written at schema_version ${schemaVersion} (hash-chained since ` +
        `${EVENT_CHAIN_SCHEMA_VERSION}); its event log was altered — nothing was changed.`,
      { unhashed: rows.length - nHashed },
    );
  }

  const byPrev = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const prev = row.prev_hash as string;
    if (byPrev.has(prev)) {
      throw new DispatchError(
        "INCONSISTENT_BUNDLE",
        "Bundle's event log forks (two events claim the same predecessor) — nothing was changed.",
        { prev_hash: prev },
      );
    }
    byPrev.set(prev, row);
  }
  const ordered: Array<Record<string, unknown>> = [];
  let cursor = EVENT_CHAIN_GENESIS;
  for (let next = byPrev.get(cursor); next; next = byPrev.get(cursor)) {
    ordered.push(next);
    cursor = next.hash as string;
  }
  if (ordered.length !== rows.length) {
    throw new DispatchError(
      "INCONSISTENT_BUNDLE",
      `Bundle's event log chain links only ${ordered.length} of ${rows.length} events from ` +
        "genesis; it was edited or truncated — nothing was changed.",
      { linked: ordered.length, total: rows.length },
    );
  }
  return ordered;
}

/**
 * Build an `INSERT INTO <table>(cols...) VALUES(?...)` for the given row's column
 * set. Column names come from the bundle row keys; values are bound as parameters
 * (never interpolated), so a malicious value cannot inject SQL. Unknown columns
 * (e.g. a bundle from a newer minor that added a column) would surface as a clear
 * SQLite "no column named" error rather than silent data loss.
 */
function insertRow(
  db: Db,
  table: string,
  row: Record<string, unknown>,
  cache: Map<string, Statement<unknown[]>>,
): void {
  const cols = Object.keys(row);
  if (cols.length === 0) return;
  // Rows of one table almost always share a column set: prepare each shape once
  // (a restore, and the export's restore check, insert every row of the board).
  const key = `${table}\u0000${cols.join("\u0000")}`;
  let stmt = cache.get(key);
  if (!stmt) {
    const placeholders = cols.map(() => "?").join(", ");
    const colList = cols.map((c) => `"${c}"`).join(", ");
    stmt = db.prepare(`INSERT INTO ${table}(${colList}) VALUES (${placeholders})`);
    cache.set(key, stmt);
  }
  stmt.run(...cols.map((c) => row[c]));
}

/**
 * Load a validated {@link StateBundle} into `db`, which MUST be a Dispatch DB
 * whose schema has been applied (call {@link migrate} / open via the normal path
 * first). Refuses a non-empty DB unless `force` is set; with `force` it clears
 * every export table first. All inserts AND the integrity check run in ONE
 * transaction in FK-safe order — an inconsistent bundle is rejected before commit,
 * so the destination (including a force-cleared one) is never left half-restored.
 * so a failure rolls the whole import back and the DB is never left half-loaded.
 */
export function importState(
  db: Db,
  bundle: StateBundle,
  opts: ImportStateOptions = {},
): ImportStateResult {
  // Re-validate the envelope + version even when handed an in-memory bundle, so a
  // tampered/too-new bundle is rejected on every entry path (not just the JSON one).
  validateBundle(bundle);
  const existing = countExistingRows(db);
  if (existing > 0 && !opts.force) {
    throw new DispatchError(
      "DB_NOT_EMPTY",
      `Refusing to import into a non-empty Dispatch database (${existing} existing rows). ` +
        "Pass --force to replace its contents.",
      { existingRows: existing },
    );
  }

  const byTable: Record<string, number> = {};
  let rowsInserted = 0;
  const statements = new Map<string, Statement<unknown[]>>();

  // One transaction with foreign_keys OFF for the load: rows arrive in FK-safe
  // order, but toggling FK enforcement off for a bulk restore is the documented
  // SQLite pattern (and matches connection.ts's table-rebuild migrations). It is
  // restored to its prior state in the finally block.
  const fkWasOn = (db.pragma("foreign_keys", { simple: true }) as number) === 1;
  if (fkWasOn) db.pragma("foreign_keys = OFF");
  try {
    const tx = db.transaction(() => {
      if (opts.force) {
        // Clear in REVERSE dependency order so children go before parents.
        for (let i = EXPORT_TABLES.length - 1; i >= 0; i--) {
          db.exec(`DELETE FROM ${EXPORT_TABLES[i]}`);
        }
      }
      for (const table of EXPORT_TABLES) {
        const raw = (bundle.tables[table] ?? []) as ReadonlyArray<Record<string, unknown>>;
        const rows =
          table === "work_events" ? orderEventsForImport(raw, bundle.schema_version) : raw;
        let n = 0;
        for (const row of rows) {
          insertRow(db, table, row, statements);
          n++;
        }
        byTable[table] = n;
        rowsInserted += n;
      }
      // A bundle written before v23 carries no event hashes: chain the restored
      // log now so `dispatch events verify` passes on the imported board. A
      // chained-era bundle keeps the hashes it carried (orderEventsForImport has
      // already refused one with unhashed rows) and is never re-chained.
      if (bundle.schema_version < EVENT_CHAIN_SCHEMA_VERSION) backfillEventChain(db);
      // The restored log must verify: a bundle whose rows were edited (content no
      // longer matches its hash) is rejected and the whole import rolls back.
      const chain = verifyEventChain(db);
      if (!chain.ok) {
        throw new DispatchError(
          "INCONSISTENT_BUNDLE",
          `Bundle's event log fails verification at event ${chain.brokenEventId} ` +
            `(${chain.reason}) — it was altered after export; nothing was changed.`,
          { brokenEventId: chain.brokenEventId, reason: chain.reason },
        );
      }
      // A foreign_keys=OFF bulk load can leave a dangling reference if the bundle is
      // internally inconsistent. Verify integrity INSIDE the transaction, before it
      // commits: throwing here rolls the whole load back, so a rejected bundle leaves
      // the destination exactly as it was — under `force` too, where the prior rows
      // were deleted at the top of this same transaction. (Checking after the commit
      // reported INCONSISTENT_BUNDLE with the original data already gone and the
      // inconsistent rows already in place — the external review's restore finding.)
      // `PRAGMA foreign_key_check` works with enforcement OFF. A self-consistent export
      // always passes (every child's parent was exported alongside it).
      const violations = db.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) {
        throw new DispatchError(
          "INCONSISTENT_BUNDLE",
          `Imported bundle has ${violations.length} dangling foreign-key reference(s); ` +
            "the source export was internally inconsistent — nothing was changed.",
          { violations: violations.length },
        );
      }
    });
    tx();
  } finally {
    if (fkWasOn) db.pragma("foreign_keys = ON");
  }

  return {
    formatVersion: bundle.format_version,
    schemaVersion: bundle.schema_version,
    rowsInserted,
    byTable,
  };
}

/**
 * Convenience: parse a JSON string, validate the envelope + version, and import.
 * Used by the CLI so the command body stays small. `db` must already have its
 * schema applied.
 */
export function importStateFromJson(
  db: Db,
  json: string,
  opts: ImportStateOptions = {},
): ImportStateResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new DispatchError("VALIDATION_ERROR", `Invalid JSON bundle: ${reason}`);
  }
  // validateBundle narrows the parsed value to StateBundle; importState re-runs
  // it (cheap) so every entry path enforces the same version guard.
  const bundle = validateBundle(parsed);
  return importState(db, bundle, opts);
}

// Re-export so callers that import the module get the schema reference too.
export { migrate, SCHEMA_VERSION };
