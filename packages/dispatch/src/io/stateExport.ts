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
import type { Db } from "../db/connection.js";
import { migrate } from "../db/connection.js";
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
 * Every other table in SCHEMA_SQL carries durable board state and IS included.
 * The drift guard in state-export.test.ts enforces that any future durable table
 * is consciously added here or excluded with a reason.
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
  "external_refs",
  // Self-referential within tickets (already present by here).
  "ticket_dependencies",
  // FAILURE-DIAGNOSIS: the append-only rework failure trail (FK to tickets). Durable
  // board diagnostics — the "why did #N fail" history is exactly the kind of asset
  // the README promises you carry between machines, so it IS part of the bundle.
  "rework_attempts",
  // GRADUATED-AUTONOMY (Spec 2, Phase 3): the per-(repo × risk × gate) autonomy
  // enablement + its evidence snapshot (FK to repositories, so it sorts after that
  // root). A durable, security-relevant operator decision worth carrying between
  // machines (and auditable), so it IS part of the bundle.
  "autonomy_policy",
] as const;

export type ExportTable = (typeof EXPORT_TABLES)[number];

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
  work_events: "id",
  external_refs: "id",
  ticket_dependencies: "ticket_id, depends_on_ticket_id",
  rework_attempts: "id",
  autonomy_policy: "id",
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
    | { value: string }
    | undefined;
  if (!row) return SCHEMA_VERSION;
  const parsed = Number(row.value);
  return Number.isFinite(parsed) ? parsed : SCHEMA_VERSION;
}

/**
 * Serialise the whole factory board to a deterministic {@link StateBundle}. Two
 * exports of the same DB produce byte-identical JSON (when `now` is pinned):
 * tables are emitted in a fixed order and rows are ordered by primary key.
 */
export function exportState(db: Db, opts: ExportStateOptions = {}): StateBundle {
  const tables: Record<string, TableRows> = {};
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
    schema_version: readSchemaVersion(db),
    exported_at: opts.now ?? new Date().toISOString(),
    tables,
  };
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
 * Build an `INSERT INTO <table>(cols...) VALUES(?...)` for the given row's column
 * set. Column names come from the bundle row keys; values are bound as parameters
 * (never interpolated), so a malicious value cannot inject SQL. Unknown columns
 * (e.g. a bundle from a newer minor that added a column) would surface as a clear
 * SQLite "no column named" error rather than silent data loss.
 */
function insertRow(db: Db, table: string, row: Record<string, unknown>): void {
  const cols = Object.keys(row);
  if (cols.length === 0) return;
  const placeholders = cols.map(() => "?").join(", ");
  const colList = cols.map((c) => `"${c}"`).join(", ");
  const values = cols.map((c) => row[c] as never);
  db.prepare(`INSERT INTO ${table}(${colList}) VALUES (${placeholders})`).run(...values);
}

/**
 * Load a validated {@link StateBundle} into `db`, which MUST be a Dispatch DB
 * whose schema has been applied (call {@link migrate} / open via the normal path
 * first). Refuses a non-empty DB unless `force` is set; with `force` it clears
 * every export table first. All inserts run in ONE transaction in FK-safe order,
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
        "Pass force to replace its contents.",
      { existingRows: existing },
    );
  }

  const byTable: Record<string, number> = {};
  let rowsInserted = 0;

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
        const rows = bundle.tables[table] ?? [];
        let n = 0;
        for (const row of rows) {
          insertRow(db, table, row as Record<string, unknown>);
          n++;
        }
        byTable[table] = n;
        rowsInserted += n;
      }
    });
    tx();
  } finally {
    if (fkWasOn) db.pragma("foreign_keys = ON");
  }

  // A foreign_keys=OFF bulk load can leave a dangling reference if the bundle is
  // internally inconsistent. Verify integrity AFTER the load so a corrupt bundle
  // is reported rather than silently accepted. A self-consistent export always
  // passes (every child's parent was exported alongside it).
  const violations = db.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new DispatchError(
      "INCONSISTENT_BUNDLE",
      `Imported bundle has ${violations.length} dangling foreign-key reference(s); ` +
        "the source export was internally inconsistent.",
      { violations: violations.length },
    );
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
