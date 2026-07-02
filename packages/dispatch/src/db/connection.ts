import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

export type Db = Database.Database;

/**
 * Thrown when the database on disk records a `schema_version` NEWER than this
 * build understands — i.e. it was written by a newer Dispatch. Refusing to
 * open is deliberate: Dispatch is designed to be shared (CLI + MCP server +
 * REST API all pointing at one SQLite file), so an older binary that silently
 * wrote against a schema it doesn't understand could corrupt newer data.
 * Distinguished by `code` so entry points print the remediation rather than a
 * raw stack.
 */
export class DatabaseTooNewError extends Error {
  readonly code = "DISPATCH_DB_TOO_NEW";
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(
      "this Dispatch database was written by a newer version of Dispatch.\n" +
        `  On-disk schema_version is ${found}; this build supports up to ${supported}.\n` +
        "  Upgrade Dispatch before opening it:\n" +
        "    npm i -g dispatch@latest\n" +
        "  (Refusing to open — an older schema could corrupt newer data.)",
    );
    this.name = "DatabaseTooNewError";
  }
}

/** Thrown when the DB file can't be opened; carries an actionable diagnostic. */
export class DatabaseOpenError extends Error {
  readonly code = "DISPATCH_DB_OPEN_FAILED";
  constructor(
    readonly path: string,
    readonly causedBy: unknown,
  ) {
    const reason = causedBy instanceof Error ? causedBy.message : String(causedBy);
    super(
      `could not open the Dispatch database at ${path}\n` +
        `  reason: ${reason}\n` +
        "  • If another process holds a write lock, close it and relaunch.\n" +
        "  • If the file is corrupt, restore a backup or point --db / DISPATCH_DB elsewhere.\n" +
        "  • Check the directory is writable and you have free disk space.",
    );
    this.name = "DatabaseOpenError";
  }
}

const BUSY_TIMEOUT_MS = 5000;

/**
 * Open (creating if needed) a Dispatch SQLite database and ensure the schema
 * is applied.
 *
 * Defensive posture mirrors the rest of the suite:
 *  - parent directory is created if missing (mode 0700);
 *  - a freshly-created DB file is locked down to mode 0600 (owner only);
 *  - WAL journalling so the CLI/API can read while the MCP server writes;
 *  - `busy_timeout` so a concurrent writer waits for the lock instead of
 *    failing immediately with SQLITE_BUSY (multiple agents share one DB);
 *  - foreign keys ON.
 *
 * On any failure to open the file an actionable {@link DatabaseOpenError} is
 * thrown instead of a raw better-sqlite3 stack. Pass `:memory:` for tests.
 */
export function openDatabase(path: string): Db {
  let fresh = false;
  if (path !== ":memory:") {
    const dir = dirname(path);
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    fresh = !existsSync(path);
  }

  let db: Db;
  try {
    db = new Database(path);
  } catch (err) {
    throw new DatabaseOpenError(path, err);
  }

  if (fresh) {
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best-effort lockdown on platforms that support it.
    }
  }

  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

/**
 * Apply the schema and stamp the version. Safe to call repeatedly. Refuses
 * (via {@link DatabaseTooNewError}) any DB whose recorded `schema_version`
 * exceeds {@link SCHEMA_VERSION} — checked BEFORE applying schema SQL so a
 * newer DB is never touched by an older build.
 */
export function migrate(db: Db): void {
  // schema_meta may not exist on a brand-new DB; create it first so the guard
  // can read any stamped version without a "no such table" error.
  db.exec("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  if (row) {
    const found = Number(row.value);
    if (Number.isFinite(found) && found > SCHEMA_VERSION) {
      throw new DatabaseTooNewError(found, SCHEMA_VERSION);
    }
  }
  // Bring an existing ticket_repos up to the v3 shape BEFORE applying SCHEMA_SQL:
  // the schema creates an index on the new `access` column, which would fail if
  // the column were still missing. On a fresh DB ticket_repos doesn't exist yet,
  // so this is a no-op and SCHEMA_SQL creates the full v3 table.
  alterTicketReposToV3(db);
  // WG-005 (v3→v4): the new ticket_repo_delivery table is created idempotently by
  // SCHEMA_SQL's CREATE TABLE IF NOT EXISTS — a brand-new table, not an altered one,
  // so (unlike ticket_repos in v2→v3) no ADD COLUMN migration is needed.
  //
  // EP-001 (v4→v5): two additive migrations for an EXISTING DB, run BEFORE
  // SCHEMA_SQL so a migrated DB ends up byte-identical to a fresh one:
  //  - tickets gains a `bootstrap` column (CREATE TABLE IF NOT EXISTS won't add
  //    a column to an existing tickets table, so it must be ALTERed in);
  //  - scope_nodes' type CHECK is widened to allow 'epic' (a CHECK can't be
  //    altered in place, so the table is rebuilt). The new ticket_dependencies
  //    table is created by SCHEMA_SQL's CREATE TABLE IF NOT EXISTS — no ALTER.
  // All three are no-ops on a fresh DB. Applying SCHEMA_SQL below then brings a
  // v4 DB up to v5; the version stamp is updated after.
  alterTicketsAddBootstrap(db);
  widenScopeNodeTypeCheckForEpic(db);
  // WG-006 (v5→v6): repositories gains a `hidden` column. CREATE TABLE IF NOT
  // EXISTS won't add a column to an existing repositories table, so it must be
  // ALTERed in. No-op on a fresh DB (table absent — SCHEMA_SQL creates it).
  alterRepositoriesAddHidden(db);
  // (v6→v7): widen the `tickets.status` CHECK to allow the new `ready_for_merge`
  // status (approved-and-merging, between in_review and done). SQLite cannot ALTER
  // a CHECK in place, so an existing table whose CHECK omits it is rebuilt via the
  // supported recipe. Must run BEFORE SCHEMA_SQL so its CREATE INDEX statements
  // re-attach to the rebuilt table. No-op on a fresh DB.
  widenTicketStatusCheckForReadyForMerge(db);
  // WG-049 (v7→v8): tickets gains a `last_review_feedback` column (JSON review
  // rejection feedback). CREATE TABLE IF NOT EXISTS won't add a column to an
  // existing tickets table, so it must be ALTERed in. Runs AFTER the v6→v7 rebuild
  // so it backfills the rebuilt table too. No-op on a fresh DB (table absent —
  // SCHEMA_SQL creates the column).
  alterTicketsAddLastReviewFeedback(db);
  // BBT-001 (v8→v9): the independent black-box testing lane.
  //  - widen the `tickets.status` CHECK to allow the new `in_testing` status
  //    (between in_review and ready_for_merge). SQLite cannot ALTER a CHECK in
  //    place, so a genuine prior-version table is rebuilt via the supported recipe.
  //    Must run BEFORE SCHEMA_SQL so its CREATE INDEX statements re-attach.
  //  - add the `can_be_tested` + `test_contract` columns to an EXISTING tickets
  //    table (CREATE TABLE IF NOT EXISTS won't add columns), AFTER the rebuild so
  //    the rebuilt table is backfilled too. Both are no-ops on a fresh DB.
  widenTicketStatusCheckForInTesting(db);
  alterTicketsAddTestingColumns(db);
  // PAUSE-ON-CAP (v11→v12): widen the `tickets.status` CHECK to allow the new
  // `paused` status (an in-flight delivery paused on a turn/budget cap, its worktree
  // kept alive). SQLite cannot ALTER a CHECK in place, so a genuine prior-version
  // table is rebuilt via the supported recipe. Must run BEFORE SCHEMA_SQL so its
  // CREATE INDEX statements re-attach to the rebuilt table. No-op on a fresh DB and
  // on a table whose CHECK already lists 'paused'. The new `paused_deliveries` table
  // is created by SCHEMA_SQL's CREATE TABLE IF NOT EXISTS — no ADD COLUMN migration.
  widenTicketStatusCheckForPaused(db);
  // RUN-ACTIVITY (v9→v10): the `runs` control-plane registry. A brand-new
  // standalone table created idempotently by SCHEMA_SQL's CREATE TABLE IF NOT
  // EXISTS (like ticket_dependencies / ticket_repo_delivery), so — having no
  // columns added to a pre-existing table — it needs no ADD COLUMN migration.
  //
  // H9 (v10→v11): the `plan_sessions` durable plan-build chat table. Also a
  // brand-new standalone table with no FKs to other tables, created idempotently
  // by SCHEMA_SQL's CREATE TABLE IF NOT EXISTS — no ADD COLUMN migration needed.
  //
  // FAILURE-DIAGNOSIS (v12→v13): the `rework_attempts` failure-trail table. A
  // brand-new standalone table (FK to tickets, CASCADE) created idempotently by
  // SCHEMA_SQL's CREATE TABLE IF NOT EXISTS — no ADD COLUMN migration needed.
  //
  // TRACK-2b (v13→v14): add the `human_owner` column to an EXISTING tickets table.
  // CREATE TABLE IF NOT EXISTS won't add a column, so it must be ALTERed in. No CHECK
  // widening is needed (it is a free TEXT marker), so this is a plain additive ALTER —
  // no table rebuild. No-op on a fresh DB (table absent — SCHEMA_SQL creates it). Runs
  // AFTER every prior tickets rebuild so the rebuilt table is backfilled too.
  alterTicketsAddHumanOwner(db);
  // TRACK-3a (v14→v15): add the per-ticket `delivery_budget_usd` column to an
  // EXISTING tickets table. A plain additive ALTER (no CHECK to widen). No-op on a
  // fresh DB (SCHEMA_SQL creates it) and idempotent on an already-migrated one. Runs
  // AFTER every prior tickets rebuild so the rebuilt table is backfilled too.
  alterTicketsAddDeliveryBudget(db);
  db.exec(SCHEMA_SQL);
  db.prepare(
    "INSERT INTO schema_meta(key, value) VALUES ('schema_version', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(SCHEMA_VERSION));
}

/**
 * WG-002 additive migration: bring an EXISTING `ticket_repos` table up to the v3
 * shape by adding the explicit access-boundary columns. `CREATE TABLE IF NOT
 * EXISTS` in SCHEMA_SQL is a no-op for a table that already exists, so columns
 * must be added here. Idempotent: each ADD COLUMN is skipped when the column is
 * already present (detected via `PRAGMA table_info`). Existing rows inherit the
 * column defaults (access='write', relation='confirmed', source='manual'), which
 * is exactly the WG-002 backfill — a pre-v3 ticket_repos row is a manually-linked
 * confirmed write repo. Fresh DBs already have these columns from SCHEMA_SQL, so
 * this loop is a complete no-op for them.
 */
function alterTicketReposToV3(db: Db): void {
  const info = db.prepare("PRAGMA table_info(ticket_repos)").all() as Array<{ name: string }>;
  // Table absent on a fresh DB — SCHEMA_SQL will create it with the v3 columns.
  if (info.length === 0) return;
  const cols = new Set(info.map((c) => c.name));
  const additions: Array<{ name: string; ddl: string }> = [
    {
      name: "access",
      ddl: "ALTER TABLE ticket_repos ADD COLUMN access TEXT NOT NULL DEFAULT 'write' CHECK (access IN ('write','read','test','none'))",
    },
    {
      name: "relation",
      ddl: "ALTER TABLE ticket_repos ADD COLUMN relation TEXT NOT NULL DEFAULT 'confirmed' CHECK (relation IN ('confirmed','suggested','rejected','context_only','implicit_single_repo'))",
    },
    {
      name: "source",
      ddl: "ALTER TABLE ticket_repos ADD COLUMN source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','scope_inferred','agent_suggested','memory','codeowners','mono_fallback'))",
    },
    { name: "confidence", ddl: "ALTER TABLE ticket_repos ADD COLUMN confidence REAL" },
    { name: "reasons_json", ddl: "ALTER TABLE ticket_repos ADD COLUMN reasons_json TEXT" },
  ];
  for (const { name, ddl } of additions) {
    if (!cols.has(name)) db.exec(ddl);
  }
}

/**
 * EP-001 additive migration (v4→v5): add the `bootstrap` column to an EXISTING
 * `tickets` table. `CREATE TABLE IF NOT EXISTS` in SCHEMA_SQL is a no-op for an
 * existing table, so the column must be added here. Idempotent: skipped when the
 * column already exists (detected via `PRAGMA table_info`). Existing rows inherit
 * the default (0 ⇒ not a bootstrap ticket), which is exactly the backfill. On a
 * fresh DB `tickets` doesn't exist yet, so this is a no-op and SCHEMA_SQL creates
 * the table with the column.
 */
function alterTicketsAddBootstrap(db: Db): void {
  const info = db.prepare("PRAGMA table_info(tickets)").all() as Array<{ name: string }>;
  if (info.length === 0) return; // fresh DB — SCHEMA_SQL creates the column.
  const cols = new Set(info.map((c) => c.name));
  if (!cols.has("bootstrap")) {
    db.exec("ALTER TABLE tickets ADD COLUMN bootstrap INTEGER NOT NULL DEFAULT 0");
  }
}

/**
 * WG-049 additive migration (v7→v8): add the `last_review_feedback` column to an
 * EXISTING `tickets` table. `CREATE TABLE IF NOT EXISTS` in SCHEMA_SQL is a no-op
 * for an existing table, so the column must be added here. Idempotent: skipped
 * when the column already exists (detected via `PRAGMA table_info`). Existing rows
 * inherit the default (NULL ⇒ no outstanding rejection), which is exactly the
 * backfill — pre-v8 tickets carried no review feedback. On a fresh DB `tickets`
 * doesn't exist yet, so this is a no-op and SCHEMA_SQL creates the column.
 */
function alterTicketsAddLastReviewFeedback(db: Db): void {
  const info = db.prepare("PRAGMA table_info(tickets)").all() as Array<{ name: string }>;
  if (info.length === 0) return; // fresh DB — SCHEMA_SQL creates the column.
  const cols = new Set(info.map((c) => c.name));
  if (!cols.has("last_review_feedback")) {
    db.exec("ALTER TABLE tickets ADD COLUMN last_review_feedback TEXT");
  }
}

/**
 * TRACK-2b additive migration (v13→v14): add the `human_owner` column to an
 * EXISTING `tickets` table. `CREATE TABLE IF NOT EXISTS` in SCHEMA_SQL is a no-op
 * for an existing table, so the column must be added here. Idempotent: skipped when
 * the column already exists (detected via `PRAGMA table_info`). Existing rows inherit
 * the default (NULL ⇒ agent-shaped work), which is exactly the backfill — pre-v14
 * tickets are all claimable by the factory. On a fresh DB `tickets` doesn't exist yet,
 * so this is a no-op and SCHEMA_SQL creates the column.
 */
function alterTicketsAddHumanOwner(db: Db): void {
  const info = db.prepare("PRAGMA table_info(tickets)").all() as Array<{ name: string }>;
  if (info.length === 0) return; // fresh DB — SCHEMA_SQL creates the column.
  const cols = new Set(info.map((c) => c.name));
  if (!cols.has("human_owner")) {
    db.exec("ALTER TABLE tickets ADD COLUMN human_owner TEXT");
  }
}

/**
 * TRACK-3a additive migration (v14→v15): add the `delivery_budget_usd` column to an
 * EXISTING `tickets` table (the per-ticket USD delivery-budget ceiling). Like
 * `human_owner`, `CREATE TABLE IF NOT EXISTS` won't add a column to an existing
 * table, so it must be ALTERed in. Idempotent (skipped when the column already
 * exists). Existing rows inherit the default (NULL ⇒ no per-ticket ceiling), which
 * is the backfill — pre-v15 tickets fall back to the factory-wide env budget. No
 * CHECK to widen, so this is a plain additive ALTER — no table rebuild.
 */
function alterTicketsAddDeliveryBudget(db: Db): void {
  const info = db.prepare("PRAGMA table_info(tickets)").all() as Array<{ name: string }>;
  if (info.length === 0) return; // fresh DB — SCHEMA_SQL creates the column.
  const cols = new Set(info.map((c) => c.name));
  if (!cols.has("delivery_budget_usd")) {
    db.exec("ALTER TABLE tickets ADD COLUMN delivery_budget_usd REAL");
  }
}

/**
 * WG-006 additive migration (v5→v6): add the `hidden` column to an EXISTING
 * `repositories` table. `CREATE TABLE IF NOT EXISTS` in SCHEMA_SQL is a no-op for
 * an existing table, so the column must be added here. Idempotent: skipped when the
 * column already exists (detected via `PRAGMA table_info`). Existing rows inherit
 * the default (0 ⇒ visible), which is exactly the backfill — pre-v6 repos were
 * never hidden. On a fresh DB `repositories` doesn't exist yet, so this is a no-op
 * and SCHEMA_SQL creates the table with the column.
 */
function alterRepositoriesAddHidden(db: Db): void {
  const info = db.prepare("PRAGMA table_info(repositories)").all() as Array<{ name: string }>;
  if (info.length === 0) return; // fresh DB — SCHEMA_SQL creates the column.
  const cols = new Set(info.map((c) => c.name));
  if (!cols.has("hidden")) {
    db.exec("ALTER TABLE repositories ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0");
  }
}

/**
 * EP-001 additive migration (v4→v5): widen the `scope_nodes.type` CHECK to allow
 * the new `epic` node type. SQLite cannot ALTER a CHECK constraint in place, so an
 * existing table whose CHECK omits 'epic' is rebuilt via the supported 12-step
 * recipe (create the widened table, copy rows, drop the old, rename, restore
 * indexes). Idempotent + safe:
 *  - no-op on a fresh DB (table absent — SCHEMA_SQL creates the widened version);
 *  - no-op when the table's existing CHECK already permits 'epic' (detected by
 *    inspecting the stored DDL in sqlite_master), so re-running migrate() is free.
 * Runs inside the caller's migrate(); foreign_keys is toggled off for the swap as
 * the SQLite docs require, then restored.
 */
function widenScopeNodeTypeCheckForEpic(db: Db): void {
  const ddlRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'scope_nodes'")
    .get() as { sql: string } | undefined;
  // Table absent (fresh DB) — SCHEMA_SQL will create it with 'epic' allowed.
  if (!ddlRow) return;
  // Already widened (fresh-created or previously migrated) — nothing to do.
  if (ddlRow.sql.includes("'epic'")) return;

  // The widened table definition. Kept in lockstep with SCHEMA_SQL's scope_nodes.
  const newTableDdl = `
    CREATE TABLE scope_nodes_new (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      type          TEXT NOT NULL CHECK (type IN (
        'factory','domain','product','capability','system','service','library','external_dependency','epic'
      )),
      description   TEXT,
      risk_level    TEXT NOT NULL DEFAULT 'medium' CHECK (risk_level IN ('low','medium','high','critical')),
      owner         TEXT,
      tags_json     TEXT,
      lore_tags_json TEXT,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`;

  // PRAGMA foreign_keys must be toggled OUTSIDE the transaction — SQLite
  // silently ignores PRAGMA statements inside a transaction. The table-swap DDL
  // itself (create/copy/drop/rename/reindex) runs atomically inside the
  // transaction so a crash between DROP and RENAME can never permanently lose
  // the table (FIX 2: atomic DDL rebuild).
  const fkWasOn = (db.pragma("foreign_keys", { simple: true }) as number) === 1;
  if (fkWasOn) db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec("DROP TABLE IF EXISTS scope_nodes_new");
      db.exec(newTableDdl);
      db.exec(
        `INSERT INTO scope_nodes_new
           (id, name, type, description, risk_level, owner, tags_json, lore_tags_json, created_at, updated_at)
         SELECT id, name, type, description, risk_level, owner, tags_json, lore_tags_json, created_at, updated_at
         FROM scope_nodes`,
      );
      db.exec("DROP TABLE scope_nodes");
      db.exec("ALTER TABLE scope_nodes_new RENAME TO scope_nodes");
      // Restore the indexes SCHEMA_SQL declares on scope_nodes (idempotent re-creation
      // by SCHEMA_SQL afterwards is harmless, but recreate here so the table is
      // immediately complete).
      db.exec("CREATE INDEX IF NOT EXISTS idx_scope_nodes_type ON scope_nodes(type)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_scope_nodes_name ON scope_nodes(name)");
    })();
  } finally {
    if (fkWasOn) db.pragma("foreign_keys = ON");
  }
}

/**
 * (v6→v7): widen the `tickets.status` CHECK to allow the new `ready_for_merge`
 * status. SQLite cannot ALTER a CHECK constraint in place, so an existing table
 * whose CHECK omits it is rebuilt via the supported 12-step recipe (create the
 * widened table, copy rows preserving ids so child FKs stay valid, drop the old,
 * rename, restore indexes). Idempotent + safe:
 *  - no-op on a fresh DB (table absent — SCHEMA_SQL creates the widened version);
 *  - no-op when the existing CHECK already permits 'ready_for_merge' (detected by
 *    inspecting the stored DDL), so re-running migrate() is free.
 * foreign_keys is toggled off for the swap as the SQLite docs require, then
 * restored. Rows are copied by id, so every child table's FK still resolves.
 */
function widenTicketStatusCheckForReadyForMerge(db: Db): void {
  const ddlRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tickets'")
    .get() as { sql: string } | undefined;
  // Table absent (fresh DB) — SCHEMA_SQL will create it with the status allowed.
  if (!ddlRow) return;
  // Already widened (fresh-created or previously migrated) — nothing to do.
  if (ddlRow.sql.includes("'ready_for_merge'")) return;
  // Only a real prior-version dispatch `tickets` table needs the rebuild: it
  // carries a status CHECK that lists 'in_review' but not 'ready_for_merge'. A
  // hand-rolled minimal fixture with no status CHECK at all doesn't constrain the
  // status, so it accepts the new value with no rebuild — skip it (rebuilding a
  // table missing NOT NULL columns like `title` would fail). The other ALTERs in
  // migrate() already brought a genuine table up to the full column set.
  if (!ddlRow.sql.includes("'in_review'")) return;
  // A pre-v6 `tickets` table may be missing later columns (number, bootstrap, …):
  // those are added by the ALTERs in migrate() AHEAD of this call, except on a
  // hand-rolled minimal fixture. Copy only the columns the existing table actually
  // has (intersected with the new table's) so the rebuild never references a column
  // that isn't there; the remaining columns inherit the new table's defaults.
  const existingCols = new Set(
    (db.prepare("PRAGMA table_info(tickets)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  const NEW_COLS = [
    "id",
    "number",
    "title",
    "description",
    "status",
    "priority",
    "risk_level",
    "policy_pack",
    "source",
    "created_by",
    "reviewer",
    "branch_name",
    "pr_url",
    "attempt_count",
    "row_version",
    "scheduled_after",
    "due_at",
    "bootstrap",
    "created_at",
    "updated_at",
  ];
  const copyCols = NEW_COLS.filter((c) => existingCols.has(c));
  const copyList = copyCols.join(", ");

  // The widened table definition. Kept in lockstep with SCHEMA_SQL's tickets.
  const newTableDdl = `
    CREATE TABLE tickets_new (
      id            TEXT PRIMARY KEY,
      number        INTEGER UNIQUE,
      title         TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL CHECK (status IN (
        'draft','refining','ready','claimed','in_progress',
        'blocked','in_review','ready_for_merge','done','failed','cancelled'
      )),
      priority      INTEGER NOT NULL DEFAULT 0,
      risk_level    TEXT NOT NULL DEFAULT 'medium' CHECK (risk_level IN ('low','medium','high','critical')),
      policy_pack   TEXT NOT NULL DEFAULT 'solo_loose',
      source        TEXT,
      created_by    TEXT,
      reviewer      TEXT,
      branch_name   TEXT,
      pr_url        TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      row_version   INTEGER NOT NULL DEFAULT 0,
      scheduled_after TEXT,
      due_at        TEXT,
      bootstrap     INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`;

  // PRAGMA foreign_keys must be toggled OUTSIDE the transaction — SQLite
  // silently ignores PRAGMA statements inside a transaction. The table-swap DDL
  // itself runs atomically inside the transaction so a crash between DROP and
  // RENAME can never permanently lose the table (FIX 2: atomic DDL rebuild).
  const fkWasOn = (db.pragma("foreign_keys", { simple: true }) as number) === 1;
  if (fkWasOn) db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec("DROP TABLE IF EXISTS tickets_new");
      db.exec(newTableDdl);
      db.exec(
        `INSERT INTO tickets_new (${copyList})
         SELECT ${copyList} FROM tickets`,
      );
      db.exec("DROP TABLE tickets");
      db.exec("ALTER TABLE tickets_new RENAME TO tickets");
      // Restore the indexes SCHEMA_SQL declares on tickets (it also re-creates them
      // idempotently afterwards, but recreate here so the table is immediately complete).
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_tickets_status_priority ON tickets(status, priority DESC, created_at ASC)",
      );
      db.exec("CREATE INDEX IF NOT EXISTS idx_tickets_risk ON tickets(risk_level)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_tickets_policy_pack ON tickets(policy_pack)");
    })();
  } finally {
    if (fkWasOn) db.pragma("foreign_keys = ON");
  }
}

/**
 * BBT-001 additive migration (v8→v9): widen the `tickets.status` CHECK to allow
 * the new `in_testing` status (the independent black-box testing lane, between
 * in_review and ready_for_merge). SQLite cannot ALTER a CHECK in place, so an
 * existing table whose CHECK omits it is rebuilt via the supported recipe (create
 * the widened table, copy rows preserving ids so child FKs stay valid, drop the
 * old, rename, restore indexes). Idempotent + safe:
 *  - no-op on a fresh DB (table absent — SCHEMA_SQL creates the widened version);
 *  - no-op when the existing CHECK already permits 'in_testing';
 *  - no-op on a hand-rolled minimal fixture with no status CHECK at all (rebuilding
 *    a table missing NOT NULL columns like `title` would fail) — detected by the
 *    absence of 'ready_for_merge' in the CHECK (a genuine v7+ table lists it).
 * foreign_keys is toggled off for the swap as the SQLite docs require, then
 * restored. Rows are copied by id, so every child table's FK still resolves. By
 * v8 a genuine table carries the full v8 column set, so all of them are copied.
 */
function widenTicketStatusCheckForInTesting(db: Db): void {
  const ddlRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tickets'")
    .get() as { sql: string } | undefined;
  // Table absent (fresh DB) — SCHEMA_SQL will create it with the status allowed.
  if (!ddlRow) return;
  // Already widened (fresh-created or previously migrated) — nothing to do.
  if (ddlRow.sql.includes("'in_testing'")) return;
  // Only a genuine v7+ `tickets` table needs the rebuild: it carries a status
  // CHECK that already lists 'ready_for_merge'. A hand-rolled fixture without that
  // (or with no status CHECK at all) does not constrain the status, so it accepts
  // the new value with no rebuild — skip it.
  if (!ddlRow.sql.includes("'ready_for_merge'")) return;

  // Copy only the columns the existing table actually has (intersected with the
  // new table's) so the rebuild never references a missing column; the rest inherit
  // the new table's defaults.
  const existingCols = new Set(
    (db.prepare("PRAGMA table_info(tickets)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  const NEW_COLS = [
    "id",
    "number",
    "title",
    "description",
    "status",
    "priority",
    "risk_level",
    "policy_pack",
    "source",
    "created_by",
    "reviewer",
    "branch_name",
    "pr_url",
    "attempt_count",
    "row_version",
    "scheduled_after",
    "due_at",
    "bootstrap",
    "last_review_feedback",
    "created_at",
    "updated_at",
  ];
  const copyCols = NEW_COLS.filter((c) => existingCols.has(c));
  const copyList = copyCols.join(", ");

  // The widened table definition. Kept in lockstep with SCHEMA_SQL's tickets, but
  // WITHOUT the v9 can_be_tested/test_contract columns: those are added by the
  // ALTER that runs right after this rebuild, exactly as on a real upgrade.
  const newTableDdl = `
    CREATE TABLE tickets_new (
      id            TEXT PRIMARY KEY,
      number        INTEGER UNIQUE,
      title         TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL CHECK (status IN (
        'draft','refining','ready','claimed','in_progress',
        'blocked','in_review','in_testing','ready_for_merge','done','failed','cancelled'
      )),
      priority      INTEGER NOT NULL DEFAULT 0,
      risk_level    TEXT NOT NULL DEFAULT 'medium' CHECK (risk_level IN ('low','medium','high','critical')),
      policy_pack   TEXT NOT NULL DEFAULT 'solo_loose',
      source        TEXT,
      created_by    TEXT,
      reviewer      TEXT,
      branch_name   TEXT,
      pr_url        TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      row_version   INTEGER NOT NULL DEFAULT 0,
      scheduled_after TEXT,
      due_at        TEXT,
      bootstrap     INTEGER NOT NULL DEFAULT 0,
      last_review_feedback TEXT,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`;

  // PRAGMA foreign_keys must be toggled OUTSIDE the transaction — SQLite
  // silently ignores PRAGMA statements inside a transaction. The table-swap DDL
  // itself runs atomically inside the transaction so a crash between DROP and
  // RENAME can never permanently lose the table (FIX 2: atomic DDL rebuild).
  const fkWasOn = (db.pragma("foreign_keys", { simple: true }) as number) === 1;
  if (fkWasOn) db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec("DROP TABLE IF EXISTS tickets_new");
      db.exec(newTableDdl);
      db.exec(
        `INSERT INTO tickets_new (${copyList})
         SELECT ${copyList} FROM tickets`,
      );
      db.exec("DROP TABLE tickets");
      db.exec("ALTER TABLE tickets_new RENAME TO tickets");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_tickets_status_priority ON tickets(status, priority DESC, created_at ASC)",
      );
      db.exec("CREATE INDEX IF NOT EXISTS idx_tickets_risk ON tickets(risk_level)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_tickets_policy_pack ON tickets(policy_pack)");
    })();
  } finally {
    if (fkWasOn) db.pragma("foreign_keys = ON");
  }
}

/**
 * BBT-001 additive migration (v8→v9): add the `can_be_tested` + `test_contract`
 * columns to an EXISTING `tickets` table. `CREATE TABLE IF NOT EXISTS` in
 * SCHEMA_SQL is a no-op for an existing table, so the columns must be added here.
 * Idempotent: each ADD COLUMN is skipped when the column is already present
 * (detected via `PRAGMA table_info`). Existing rows inherit the defaults
 * (can_be_tested = 0 ⇒ not testable, test_contract = NULL ⇒ no contract), which is
 * exactly the backfill. On a fresh DB `tickets` doesn't exist yet, so this is a
 * no-op and SCHEMA_SQL creates the columns.
 */
function alterTicketsAddTestingColumns(db: Db): void {
  const info = db.prepare("PRAGMA table_info(tickets)").all() as Array<{ name: string }>;
  if (info.length === 0) return; // fresh DB — SCHEMA_SQL creates the columns.
  const cols = new Set(info.map((c) => c.name));
  if (!cols.has("can_be_tested")) {
    db.exec("ALTER TABLE tickets ADD COLUMN can_be_tested INTEGER NOT NULL DEFAULT 0");
  }
  if (!cols.has("test_contract")) {
    db.exec("ALTER TABLE tickets ADD COLUMN test_contract TEXT");
  }
}

/**
 * PAUSE-ON-CAP migration (v11→v12): widen the `tickets.status` CHECK to allow the
 * new `paused` status (an in-flight delivery paused on a turn/budget cap). SQLite
 * cannot ALTER a CHECK in place, so an existing table whose CHECK omits it is
 * rebuilt via the supported recipe (create the widened table, copy rows preserving
 * ids so child FKs stay valid, drop the old, rename, restore indexes). Idempotent +
 * safe:
 *  - no-op on a fresh DB (table absent — SCHEMA_SQL creates the widened version);
 *  - no-op when the existing CHECK already permits 'paused';
 *  - no-op on a hand-rolled minimal fixture with no status CHECK (detected by the
 *    absence of 'in_testing' in the CHECK — a genuine v9+ table lists it).
 * foreign_keys is toggled off for the swap as the SQLite docs require, then restored.
 * By v11 a genuine table carries the full column set (through test_contract), so all
 * of them are copied.
 */
function widenTicketStatusCheckForPaused(db: Db): void {
  const ddlRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tickets'")
    .get() as { sql: string } | undefined;
  // Table absent (fresh DB) — SCHEMA_SQL will create it with the status allowed.
  if (!ddlRow) return;
  // Already widened (fresh-created or previously migrated) — nothing to do.
  if (ddlRow.sql.includes("'paused'")) return;
  // Only a genuine v9+ `tickets` table needs the rebuild: it carries a status CHECK
  // that already lists 'in_testing'. A hand-rolled fixture without that (or with no
  // status CHECK at all) does not constrain the status, so it accepts the new value
  // with no rebuild — skip it (rebuilding a table missing NOT NULL columns fails).
  if (!ddlRow.sql.includes("'in_testing'")) return;

  // Copy only the columns the existing table actually has (intersected with the new
  // table's) so the rebuild never references a missing column; the rest inherit the
  // new table's defaults.
  const existingCols = new Set(
    (db.prepare("PRAGMA table_info(tickets)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  const NEW_COLS = [
    "id",
    "number",
    "title",
    "description",
    "status",
    "priority",
    "risk_level",
    "policy_pack",
    "source",
    "created_by",
    "reviewer",
    "branch_name",
    "pr_url",
    "attempt_count",
    "row_version",
    "scheduled_after",
    "due_at",
    "bootstrap",
    "last_review_feedback",
    "can_be_tested",
    "test_contract",
    "created_at",
    "updated_at",
  ];
  const copyCols = NEW_COLS.filter((c) => existingCols.has(c));
  const copyList = copyCols.join(", ");

  // The widened table definition. Kept in lockstep with SCHEMA_SQL's tickets.
  const newTableDdl = `
    CREATE TABLE tickets_new (
      id            TEXT PRIMARY KEY,
      number        INTEGER UNIQUE,
      title         TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL CHECK (status IN (
        'draft','refining','ready','claimed','in_progress',
        'blocked','in_review','in_testing','ready_for_merge','done','failed','cancelled','paused'
      )),
      priority      INTEGER NOT NULL DEFAULT 0,
      risk_level    TEXT NOT NULL DEFAULT 'medium' CHECK (risk_level IN ('low','medium','high','critical')),
      policy_pack   TEXT NOT NULL DEFAULT 'solo_loose',
      source        TEXT,
      created_by    TEXT,
      reviewer      TEXT,
      branch_name   TEXT,
      pr_url        TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      row_version   INTEGER NOT NULL DEFAULT 0,
      scheduled_after TEXT,
      due_at        TEXT,
      bootstrap     INTEGER NOT NULL DEFAULT 0,
      last_review_feedback TEXT,
      can_be_tested INTEGER NOT NULL DEFAULT 0,
      test_contract TEXT,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`;

  // PRAGMA foreign_keys must be toggled OUTSIDE the transaction — SQLite
  // silently ignores PRAGMA statements inside a transaction. The table-swap DDL
  // itself runs atomically inside the transaction so a crash between DROP and
  // RENAME can never permanently lose the table (FIX 2: atomic DDL rebuild).
  const fkWasOn = (db.pragma("foreign_keys", { simple: true }) as number) === 1;
  if (fkWasOn) db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec("DROP TABLE IF EXISTS tickets_new");
      db.exec(newTableDdl);
      db.exec(
        `INSERT INTO tickets_new (${copyList})
         SELECT ${copyList} FROM tickets`,
      );
      db.exec("DROP TABLE tickets");
      db.exec("ALTER TABLE tickets_new RENAME TO tickets");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_tickets_status_priority ON tickets(status, priority DESC, created_at ASC)",
      );
      db.exec("CREATE INDEX IF NOT EXISTS idx_tickets_risk ON tickets(risk_level)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_tickets_policy_pack ON tickets(policy_pack)");
    })();
  } finally {
    if (fkWasOn) db.pragma("foreign_keys = ON");
  }
}

/**
 * Run `fn` inside an IMMEDIATE transaction (`BEGIN IMMEDIATE`).
 *
 * better-sqlite3's `db.transaction(fn)` defaults to a DEFERRED transaction,
 * which acquires no write lock until the first write statement runs. Under
 * `GAFFER_CONCURRENCY>1`, two worker processes can both open a read snapshot,
 * then race to UPGRADE to a write lock. SQLite does NOT run the `busy_timeout`
 * busy handler on a deferred write-lock upgrade — it fails the upgrade
 * immediately with `SQLITE_BUSY_SNAPSHOT` ("database is locked") rather than
 * waiting, because waiting could deadlock. The result is spurious
 * `SQLITE_BUSY` throws from otherwise-correct read-modify-write bookkeeping.
 *
 * `.immediate()` issues `BEGIN IMMEDIATE`, which acquires the write lock up
 * front. Because there is no snapshot to invalidate, `busy_timeout` DOES apply:
 * a concurrent writer waits for the lock (up to {@link BUSY_TIMEOUT_MS}) instead
 * of failing. The transaction still rolls back atomically on any error, so the
 * fail-safe guarantee (no partial or cross-ticket write) is preserved.
 */
export function inTransaction<T>(db: Db, fn: () => T): T {
  // `.immediate` is the IMMEDIATE-mode variant of the transaction function;
  // invoking it BEGINs IMMEDIATE and runs `fn` to completion, returning its value.
  return db.transaction(fn).immediate();
}
