import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { migrate } from "../src/db/connection.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";

/**
 * BBT-001 additive migration (v8 → v9): an existing DB whose tickets table predates
 * the independent-testing lane must upgrade cleanly — the status CHECK widens to
 * accept `in_testing` and the two new columns (can_be_tested / test_contract) are
 * added and backfilled — without touching pre-existing rows.
 */
describe("BBT-001: additive migration (v8 → v9)", () => {
  it("upgrades a simulated v8 DB without data loss and enables the in_testing lane", () => {
    // A v8-shaped tickets table: it lists 'ready_for_merge' and carries
    // last_review_feedback, but its status CHECK omits 'in_testing' and it has no
    // can_be_tested / test_contract columns.
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE tickets (
        id TEXT PRIMARY KEY, number INTEGER UNIQUE, title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN (
          'draft','refining','ready','claimed','in_progress',
          'blocked','in_review','ready_for_merge','done','failed','cancelled')),
        priority INTEGER NOT NULL DEFAULT 0,
        risk_level TEXT NOT NULL DEFAULT 'medium',
        policy_pack TEXT NOT NULL DEFAULT 'solo_loose',
        source TEXT, created_by TEXT, reviewer TEXT, branch_name TEXT, pr_url TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0, row_version INTEGER NOT NULL DEFAULT 0,
        scheduled_after TEXT, due_at TEXT, bootstrap INTEGER NOT NULL DEFAULT 0,
        last_review_feedback TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    db.prepare("INSERT INTO schema_meta(key,value) VALUES ('schema_version','8')").run();
    db.prepare(
      "INSERT INTO tickets (id, number, title, status, last_review_feedback) " +
        "VALUES ('legacy-1', 1, 'old ticket', 'ready_for_merge', '{\"reason\":\"x\",\"at\":\"t\"}')",
    ).run();

    // Run the real migration.
    migrate(db);

    // Pre-existing data preserved, including the v8 last_review_feedback column.
    const legacy = db.prepare("SELECT * FROM tickets WHERE id = 'legacy-1'").get() as {
      title: string;
      status: string;
      can_be_tested: number;
      test_contract: string | null;
      last_review_feedback: string | null;
    };
    expect(legacy.title).toBe("old ticket");
    expect(legacy.status).toBe("ready_for_merge");
    expect(legacy.last_review_feedback).toContain("reason");
    // Backfilled column defaults.
    expect(legacy.can_be_tested).toBe(0);
    expect(legacy.test_contract).toBeNull();

    // Version stamped to current.
    const ver = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as {
      value: string;
    };
    expect(Number(ver.value)).toBe(SCHEMA_VERSION);

    // The widened CHECK now accepts an in_testing ticket, and the new columns work.
    db.prepare(
      "INSERT INTO tickets (id, number, title, status, can_be_tested, test_contract) " +
        "VALUES ('t2', 2, 'new', 'in_testing', 1, '{\"run_command\":\"go test\"}')",
    ).run();
    const fresh = db.prepare("SELECT status, can_be_tested FROM tickets WHERE id='t2'").get() as {
      status: string;
      can_be_tested: number;
    };
    expect(fresh.status).toBe("in_testing");
    expect(fresh.can_be_tested).toBe(1);

    db.close();
  });

  it("re-running migrate() on an already-current DB is a no-op (idempotent)", () => {
    const db = new Database(":memory:");
    migrate(db);
    migrate(db); // must not throw or duplicate-rebuild.
    // in_testing is accepted; the new columns exist.
    db.prepare(
      "INSERT INTO tickets (id, number, title, status, can_be_tested) " +
        "VALUES ('a', 1, 't', 'in_testing', 1)",
    ).run();
    const row = db.prepare("SELECT status FROM tickets WHERE id='a'").get() as { status: string };
    expect(row.status).toBe("in_testing");
    db.close();
  });
});
