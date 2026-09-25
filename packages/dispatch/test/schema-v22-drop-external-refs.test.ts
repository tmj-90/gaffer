// v21→v22: the `external_refs` table was created by every schema version since v1
// and never written by any code path. The migration drops it from an existing DB
// and the fresh schema no longer creates it; the state-export bundle follows.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { migrate } from "../src/db/connection.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";
import { EXPORT_TABLES } from "../src/io/stateExport.js";

const hasTable = (db: InstanceType<typeof Database>, name: string): boolean =>
  db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) !==
  undefined;

describe("schema v22 — external_refs is dropped", () => {
  it("drops the table from a v21 DB that still carries it and stamps the current version", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO schema_meta(key,value) VALUES ('schema_version','21')").run();
    db.exec(
      "CREATE TABLE external_refs (id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, provider TEXT NOT NULL)",
    );
    expect(hasTable(db, "external_refs")).toBe(true);

    migrate(db);

    expect(hasTable(db, "external_refs")).toBe(false);
    const version = db
      .prepare("SELECT value FROM schema_meta WHERE key='schema_version'")
      .get() as { value: string };
    expect(Number(version.value)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(22);
    // Re-running the migration is a no-op (idempotent DROP IF EXISTS).
    expect(() => migrate(db)).not.toThrow();
  });

  it("a fresh DB never creates it and the export bundle no longer lists it", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(hasTable(db, "external_refs")).toBe(false);
    expect((EXPORT_TABLES as readonly string[]).includes("external_refs")).toBe(false);
  });
});
