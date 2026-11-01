/**
 * Exploratory finding testspeed/TS-3: every open of a current DB (each `wg` call)
 * re-ran SCHEMA_SQL, 67 CREATE ... IF NOT EXISTS statements, as a self-heal for a
 * dropped table or index. It now checks sqlite_master first and runs them only when
 * an object is missing. These tests pin the equivalence that relies on, and that
 * the self-heal and real migrations still happen.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { migrate, openDatabase, schemaObjectNames } from "../src/db/connection.js";
import { SCHEMA_SQL, SCHEMA_VERSION } from "../src/db/schema.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function dbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-fast-open-"));
  dirs.push(dir);
  return join(dir, "d.sqlite");
}
const statements = SCHEMA_SQL.replace(/--[^\n]*/g, "")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);
const objects = (db: Database.Database): string[] =>
  db
    .prepare("SELECT type || ' ' || name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
    .pluck()
    .all() as string[];

describe("testspeed/TS-3: a current DB opens without re-running SCHEMA_SQL", () => {
  it("SCHEMA_SQL is only CREATE ... IF NOT EXISTS of uniquely named tables and indexes", () => {
    for (const s of statements) {
      expect(s).toMatch(/^CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+\w+\s/i);
    }
    const names = schemaObjectNames();
    expect(names).toHaveLength(statements.length);
    expect(new Set(names).size).toBe(names.length);
  });

  it("names exactly the objects a fresh DB gets", () => {
    const db = openDatabase(dbFile());
    expect(objects(db).sort()).toEqual([...schemaObjectNames()].sort());
    db.close();
  });

  it("does not execute SCHEMA_SQL on a current, complete DB", () => {
    const file = dbFile();
    openDatabase(file).close();
    const db = new Database(file);
    const exec = vi.spyOn(db, "exec");
    migrate(db);
    expect(exec).not.toHaveBeenCalled();
    db.close();
  });

  it("still recreates a dropped index or table on open (the self-heal)", () => {
    const file = dbFile();
    const first = openDatabase(file);
    const before = objects(first).sort();
    const index = schemaObjectNames()
      .find((o) => o.startsWith("index "))!
      .slice(6);
    first.exec(`DROP INDEX ${index}`);
    first.exec("DROP TABLE IF EXISTS club");
    expect(objects(first)).not.toContain(`index ${index}`);
    first.close();

    const again = openDatabase(file);
    expect(objects(again).sort()).toEqual(before);
    expect(
      again.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").pluck().get(),
    ).toBe(String(SCHEMA_VERSION));
    again.close();
  });

  it("an older stamp still migrates", () => {
    const file = dbFile();
    openDatabase(file).close();
    const raw = new Database(file);
    raw
      .prepare("UPDATE schema_meta SET value = ? WHERE key = 'schema_version'")
      .run(String(SCHEMA_VERSION - 1));
    const exec = vi.spyOn(raw, "exec");
    migrate(raw);
    expect(exec).toHaveBeenCalled();
    expect(
      raw.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").pluck().get(),
    ).toBe(String(SCHEMA_VERSION));
    raw.close();
  });
});
