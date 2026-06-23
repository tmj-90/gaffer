/**
 * Connection-level guarantees from openDb. The important one is
 * busy_timeout: memory's premise is multiple agents + the CLI sharing
 * one DB, and without a busy timeout a concurrent writer gets SQLITE_BUSY
 * straight back. Pin the pragma so a refactor can't silently drop it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb } from "../src/db/index.js";
import { DatabaseTooNewError } from "../src/db/migrations.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memory-db-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("openDb connection pragmas", () => {
  it("sets a non-zero busy_timeout so concurrent writers wait instead of failing", () => {
    const db = openDb(join(dir, "lore.db"));
    const timeout = db.pragma("busy_timeout", { simple: true });
    expect(timeout).toBe(5000);
    db.close();
  });

  it("enables WAL journal mode", () => {
    const db = openDb(join(dir, "lore.db"));
    const mode = db.pragma("journal_mode", { simple: true });
    expect(String(mode).toLowerCase()).toBe("wal");
    db.close();
  });

  it("enforces foreign keys", () => {
    const db = openDb(join(dir, "lore.db"));
    const fk = db.pragma("foreign_keys", { simple: true });
    expect(fk).toBe(1);
    db.close();
  });
});

describe("migration version ceiling", () => {
  it("opens a DB this binary fully knows", () => {
    const path = join(dir, "lore.db");
    openDb(path).close();
    expect(() => openDb(path).close()).not.toThrow();
  });

  it("refuses a DB carrying a migration this binary doesn't ship", () => {
    const path = join(dir, "lore.db");
    // Open once so the schema + migrations table exist, then simulate a
    // newer memory having applied a migration this build doesn't know.
    openDb(path).close();
    const raw = new BetterSqlite3(path);
    raw
      .prepare("INSERT INTO migrations (id, applied_at) VALUES (?, ?)")
      .run("999-from-the-future", new Date().toISOString());
    raw.close();

    expect(() => openDb(path)).toThrow(DatabaseTooNewError);
    try {
      openDb(path);
    } catch (err) {
      expect(err).toBeInstanceOf(DatabaseTooNewError);
      expect((err as DatabaseTooNewError).code).toBe("MEMORY_DB_TOO_NEW");
      expect((err as DatabaseTooNewError).unknownMigrations).toContain("999-from-the-future");
      // Message must point the user at the upgrade, not at "corrupt file".
      expect((err as Error).message).toMatch(/npm i -g memory-mcp@latest/);
    }
  });
});
