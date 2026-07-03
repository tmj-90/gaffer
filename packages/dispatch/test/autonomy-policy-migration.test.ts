import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { migrate } from "../src/db/connection.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";

/**
 * Graduated Autonomy additive migration (v18 → v19): a pre-Phase-3 DB gains the new
 * standalone `autonomy_policy` table via CREATE TABLE IF NOT EXISTS — no ADD COLUMN
 * migration, no touch to any existing table. SECURITY: an unmigrated DB simply has no
 * table (and no rows), so enforcement falls back to the env flag — byte-identical to
 * today.
 */
describe("GRADUATED-AUTONOMY: additive migration (v18 → v19)", () => {
  it("bumps SCHEMA_VERSION and creates autonomy_policy on a fresh DB", () => {
    const db = new Database(":memory:");
    migrate(db);

    const ver = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as {
      value: string;
    };
    expect(Number(ver.value)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(19);

    const tbl = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='autonomy_policy'")
      .get();
    expect(tbl).toBeTruthy();
    db.close();
  });

  it("upgrades a simulated v18 DB (no autonomy_policy) without touching existing data", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE repositories (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, local_path TEXT, remote_url TEXT,
        default_branch TEXT NOT NULL DEFAULT 'main', stack TEXT,
        risk_level TEXT NOT NULL DEFAULT 'medium', test_command TEXT, lint_command TEXT,
        coverage_command TEXT, hidden INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    db.prepare("INSERT INTO schema_meta(key,value) VALUES ('schema_version','18')").run();
    db.prepare("INSERT INTO repositories (id, name) VALUES ('repo-1', 'svc')").run();

    migrate(db);

    // Existing repo untouched.
    const repo = db.prepare("SELECT name FROM repositories WHERE id='repo-1'").get() as {
      name: string;
    };
    expect(repo.name).toBe("svc");

    // The new table exists and enforces its UNIQUE (repo_id, risk_level, gate).
    db.prepare(
      `INSERT INTO autonomy_policy (id, repo_id, risk_level, gate, mode)
       VALUES ('p1', 'repo-1', 'low', 'approve', 'auto')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO autonomy_policy (id, repo_id, risk_level, gate, mode)
           VALUES ('p2', 'repo-1', 'low', 'approve', 'off')`,
        )
        .run(),
    ).toThrow();

    // CHECK constraints reject a bad gate / mode / risk.
    expect(() =>
      db
        .prepare(
          `INSERT INTO autonomy_policy (id, repo_id, risk_level, gate, mode)
           VALUES ('p3', 'repo-1', 'low', 'bogus', 'auto')`,
        )
        .run(),
    ).toThrow();

    db.close();
  });

  it("re-running migrate() is a no-op (idempotent) and CASCADE-deletes with the repo", () => {
    const db = new Database(":memory:");
    migrate(db);
    migrate(db); // must not throw.
    db.prepare("INSERT INTO repositories (id, name) VALUES ('r', 'svc')").run();
    db.prepare(
      `INSERT INTO autonomy_policy (id, repo_id, risk_level, gate, mode)
       VALUES ('p', 'r', 'low', 'approve', 'auto')`,
    ).run();
    db.prepare("DELETE FROM repositories WHERE id='r'").run();
    const n = db.prepare("SELECT COUNT(*) AS n FROM autonomy_policy WHERE repo_id='r'").get() as {
      n: number;
    };
    expect(n.n).toBe(0);
    db.close();
  });
});
