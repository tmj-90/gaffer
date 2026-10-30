import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../src/db/connection.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";

// ---------------------------------------------------------------------------
// migrate() under concurrency.
//
// open-always-writes: a DB already at SCHEMA_VERSION must open without taking the
// write lock, so a long writer elsewhere can't turn every read-only open (each `wg`
// call, MCP server, API start) into SQLITE_BUSY after busy_timeout.
//
// migrate-concurrent-race: processes that open an OLDER DB at the same instant
// after an upgrade must serialise on one IMMEDIATE migration — no "duplicate column
// name" from racing ALTERs, no SQLITE_BUSY from a deferred rebuild, and the final
// schema identical to a fresh DB's.
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-migrate-"));
  dirs.push(dir);
  return dir;
}

/** sqlite_master DDL, normalised and sorted by name, for shape comparison. */
function ddlOf(file: string): string[] {
  const raw = new Database(file, { readonly: true });
  try {
    return (
      raw
        .prepare(
          "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all() as Array<{ type: string; name: string; sql: string }>
    ).map((r) => `${r.type} ${r.name}: ${r.sql.replace(/\s+/g, " ").replace(/"/g, "")}`);
  } finally {
    raw.close();
  }
}

/**
 * Build an older-version DB: a current DB with `tickets.acceptance` dropped and the
 * stamp rolled back to 25; for "v24" also narrow the paused_deliveries.reason CHECK
 * (which forces a table rebuild on migrate).
 */
function olderDb(file: string, mode: "v25" | "v24"): void {
  openDatabase(file).close();
  const raw = new Database(file);
  raw.pragma("foreign_keys = OFF");
  raw.exec("ALTER TABLE tickets DROP COLUMN acceptance");
  if (mode === "v24") {
    const { sql } = raw
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'paused_deliveries'")
      .get() as { sql: string };
    const narrowed = sql
      .replace(",'timeout'", "")
      .replace(/CREATE TABLE "?paused_deliveries"?/, "CREATE TABLE pd_old");
    expect(narrowed).not.toBe(sql);
    raw.exec(narrowed);
    raw.exec("DROP TABLE paused_deliveries");
    raw.exec("ALTER TABLE pd_old RENAME TO paused_deliveries");
  }
  raw
    .prepare("UPDATE schema_meta SET value = ? WHERE key = 'schema_version'")
    .run(mode === "v24" ? "24" : "25");
  raw.close();
}

function stampOf(file: string): number {
  const raw = new Database(file, { readonly: true });
  try {
    const row = raw.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    return Number(row.value);
  } finally {
    raw.close();
  }
}

describe("open-always-writes: opening a current DB takes no write lock", () => {
  it("openDatabase + a read succeed at once while another connection holds BEGIN IMMEDIATE", () => {
    const file = join(tempDir(), "w.sqlite");
    openDatabase(file).close();

    const holder = new Database(file);
    holder.exec("BEGIN IMMEDIATE");
    try {
      const t0 = Date.now();
      const db = openDatabase(file);
      const n = (db.prepare("SELECT COUNT(*) AS n FROM tickets").get() as { n: number }).n;
      db.close();
      expect(n).toBe(0);
      expect(Date.now() - t0).toBeLessThan(500);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
  });

  it("an older-stamped DB still migrates and is re-stamped", () => {
    const file = join(tempDir(), "old.sqlite");
    olderDb(file, "v24");
    const db = openDatabase(file);
    const cols = (db.prepare("PRAGMA table_info(tickets)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    db.close();
    expect(cols).toContain("acceptance");
    expect(stampOf(file)).toBe(SCHEMA_VERSION);
  });

  it("a failed migration step rolls the whole migration back", () => {
    const file = join(tempDir(), "bad.sqlite");
    olderDb(file, "v25");
    // Leave a view referencing the column the migration is about to add under a name
    // it must create: the CREATE fails, and nothing of the half-migration survives.
    const raw = new Database(file);
    raw.exec("DROP TABLE ticket_dependencies");
    raw.exec("CREATE VIEW ticket_dependencies AS SELECT 1 AS x");
    raw.close();
    expect(() => openDatabase(file)).toThrow();
    expect(stampOf(file)).toBe(25);
    const check = new Database(file, { readonly: true });
    const cols = (check.prepare("PRAGMA table_info(tickets)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    check.close();
    expect(cols).not.toContain("acceptance");
  });
});

/** Spawn `n` node processes that all call openDatabase(file) at the same instant. */
async function raceOpen(file: string, n: number): Promise<string[]> {
  const dir = tempDir();
  const child = join(dir, "child.mts");
  const connection = resolve(__dirname, "../src/db/connection.ts");
  writeFileSync(
    child,
    `import { openDatabase } from ${JSON.stringify(connection)};
const [file, at] = process.argv.slice(2);
while (Date.now() < Number(at)) {}
try { openDatabase(file).close(); console.log("ok"); }
catch (e) { console.log("FAIL " + (e.code ?? "") + " " + String(e.message).split("\\n")[0]); }
`,
  );
  // Leave room for every child to boot tsx before the common start time.
  const at = Date.now() + 4000;
  const runs = Array.from(
    { length: n },
    () =>
      new Promise<string>((done) => {
        const p = spawn(process.execPath, ["--import", "tsx", child, file, String(at)], {
          cwd: resolve(__dirname, ".."),
        });
        let out = "";
        p.stdout.on("data", (d: Buffer) => (out += d.toString()));
        p.stderr.on("data", (d: Buffer) => (out += d.toString()));
        p.on("close", () => done(out.trim()));
      }),
  );
  return Promise.all(runs);
}

describe("migrate-concurrent-race: processes opening an older DB together", () => {
  for (const mode of ["v25", "v24"] as const) {
    it(`all succeed and end with the schema a lone migration gives (${mode} fixture)`, async () => {
      const dir = tempDir();
      // Reference: the same fixture migrated by ONE process. (A fresh DB's DDL text
      // differs only in column order: ALTER ... ADD COLUMN appends.)
      const serial = join(dir, "serial.sqlite");
      olderDb(serial, mode);
      openDatabase(serial).close();
      const file = join(dir, `${mode}.sqlite`);
      olderDb(file, mode);

      const results = await raceOpen(file, 6);
      expect(results).toEqual(Array(6).fill("ok"));
      expect(stampOf(file)).toBe(SCHEMA_VERSION);
      expect(ddlOf(file)).toEqual(ddlOf(serial));
    }, 60_000);
  }
});
