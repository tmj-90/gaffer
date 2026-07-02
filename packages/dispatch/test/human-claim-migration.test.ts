import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { migrate } from "../src/db/connection.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";

/**
 * TRACK-2b additive migration (v13 → v14): an existing DB whose tickets table
 * predates the human-claim lane must upgrade cleanly — the `human_owner` column is
 * ALTERed in and backfills NULL (agent-shaped work) on pre-existing rows, with no
 * table rebuild and no data loss.
 */
describe("TRACK-2b: additive migration (v13 → v14) adds human_owner", () => {
  it("upgrades a simulated v13 DB, adds human_owner NULL, and preserves rows", () => {
    // A v13-shaped tickets table: full column set THROUGH test_contract, no human_owner.
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE tickets (
        id TEXT PRIMARY KEY, number INTEGER UNIQUE, title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN (
          'draft','refining','ready','claimed','in_progress',
          'blocked','in_review','in_testing','ready_for_merge','done','failed','cancelled','paused')),
        priority INTEGER NOT NULL DEFAULT 0,
        risk_level TEXT NOT NULL DEFAULT 'medium',
        policy_pack TEXT NOT NULL DEFAULT 'solo_loose',
        source TEXT, created_by TEXT, reviewer TEXT, branch_name TEXT, pr_url TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0, row_version INTEGER NOT NULL DEFAULT 0,
        scheduled_after TEXT, due_at TEXT, bootstrap INTEGER NOT NULL DEFAULT 0,
        last_review_feedback TEXT, can_be_tested INTEGER NOT NULL DEFAULT 0, test_contract TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    db.prepare("INSERT INTO schema_meta(key,value) VALUES ('schema_version','13')").run();
    db.prepare(
      "INSERT INTO tickets (id, number, title, status) VALUES ('legacy-1', 1, 'old ticket', 'ready')",
    ).run();

    migrate(db);

    // The column now exists and backfilled NULL on the pre-existing row.
    const cols = (db.prepare("PRAGMA table_info(tickets)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain("human_owner");
    const legacy = db.prepare("SELECT * FROM tickets WHERE id = 'legacy-1'").get() as {
      title: string;
      status: string;
      human_owner: string | null;
    };
    expect(legacy.title).toBe("old ticket");
    expect(legacy.status).toBe("ready");
    expect(legacy.human_owner).toBeNull();

    // Version stamped to current, and the migration is idempotent (re-run is a no-op).
    const ver = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as {
      value: string;
    };
    expect(Number(ver.value)).toBe(SCHEMA_VERSION);
    expect(() => migrate(db)).not.toThrow();
  });
});

/**
 * TRACK-2b additive migration (v15 → v16): an existing DB whose tickets table
 * predates the durable delivered-by-hand marker must upgrade cleanly — the
 * `human_delivered` column is ALTERed in and backfills NULL (agent-delivered) on
 * pre-existing rows, with no table rebuild and no data loss.
 */
describe("TRACK-2b: additive migration (v15 → v16) adds human_delivered", () => {
  it("upgrades a simulated v15 DB, adds human_delivered NULL, and preserves rows", () => {
    // A v15-shaped tickets table: full column set THROUGH delivery_budget_usd,
    // no human_delivered.
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE tickets (
        id TEXT PRIMARY KEY, number INTEGER UNIQUE, title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN (
          'draft','refining','ready','claimed','in_progress',
          'blocked','in_review','in_testing','ready_for_merge','done','failed','cancelled','paused')),
        priority INTEGER NOT NULL DEFAULT 0,
        risk_level TEXT NOT NULL DEFAULT 'medium',
        policy_pack TEXT NOT NULL DEFAULT 'solo_loose',
        source TEXT, created_by TEXT, reviewer TEXT, branch_name TEXT, pr_url TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0, row_version INTEGER NOT NULL DEFAULT 0,
        scheduled_after TEXT, due_at TEXT, bootstrap INTEGER NOT NULL DEFAULT 0,
        last_review_feedback TEXT, can_be_tested INTEGER NOT NULL DEFAULT 0, test_contract TEXT,
        human_owner TEXT, delivery_budget_usd REAL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    db.prepare("INSERT INTO schema_meta(key,value) VALUES ('schema_version','15')").run();
    db.prepare(
      "INSERT INTO tickets (id, number, title, status) VALUES ('legacy-2', 1, 'old ticket', 'in_review')",
    ).run();

    migrate(db);

    // The column now exists and backfilled NULL on the pre-existing row.
    const cols = (db.prepare("PRAGMA table_info(tickets)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain("human_delivered");
    const legacy = db.prepare("SELECT * FROM tickets WHERE id = 'legacy-2'").get() as {
      title: string;
      status: string;
      human_delivered: string | null;
    };
    expect(legacy.title).toBe("old ticket");
    expect(legacy.status).toBe("in_review");
    expect(legacy.human_delivered).toBeNull();

    // Version stamped to current, and the migration is idempotent (re-run is a no-op).
    const ver = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as {
      value: string;
    };
    expect(Number(ver.value)).toBe(SCHEMA_VERSION);
    expect(() => migrate(db)).not.toThrow();
  });
});
