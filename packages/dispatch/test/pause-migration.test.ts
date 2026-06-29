import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { migrate } from "../src/db/connection.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";

/**
 * PAUSE-ON-CAP additive migration (v11 → v12): an existing DB whose tickets table
 * predates the pause-on-cap lane must upgrade cleanly — the status CHECK widens to
 * accept `paused` and the new `paused_deliveries` table is created — without
 * touching pre-existing rows.
 */
describe("PAUSE-ON-CAP: additive migration (v11 → v12)", () => {
  it("upgrades a simulated v11 DB without data loss and enables the paused status", () => {
    // A v11-shaped tickets table: it lists 'in_testing' and carries the full v9
    // column set, but its status CHECK omits 'paused'.
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE tickets (
        id TEXT PRIMARY KEY, number INTEGER UNIQUE, title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN (
          'draft','refining','ready','claimed','in_progress',
          'blocked','in_review','in_testing','ready_for_merge','done','failed','cancelled')),
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
    db.prepare("INSERT INTO schema_meta(key,value) VALUES ('schema_version','11')").run();
    db.prepare(
      "INSERT INTO tickets (id, number, title, status, can_be_tested) " +
        "VALUES ('legacy-1', 1, 'old ticket', 'in_review', 1)",
    ).run();

    migrate(db);

    // Pre-existing data preserved through the table rebuild.
    const legacy = db.prepare("SELECT * FROM tickets WHERE id = 'legacy-1'").get() as {
      title: string;
      status: string;
      can_be_tested: number;
    };
    expect(legacy.title).toBe("old ticket");
    expect(legacy.status).toBe("in_review");
    expect(legacy.can_be_tested).toBe(1);

    // Version stamped to current.
    const ver = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as {
      value: string;
    };
    expect(Number(ver.value)).toBe(SCHEMA_VERSION);

    // The widened CHECK now accepts a paused ticket.
    db.prepare(
      "INSERT INTO tickets (id, number, title, status) VALUES ('t2', 2, 'new', 'paused')",
    ).run();
    const fresh = db.prepare("SELECT status FROM tickets WHERE id='t2'").get() as {
      status: string;
    };
    expect(fresh.status).toBe("paused");

    // The new paused_deliveries table exists and is keyed 1:1 on the ticket.
    db.prepare(
      "INSERT INTO paused_deliveries (ticket_id, reason, attempt) VALUES ('t2', 'cap_hit', 1)",
    ).run();
    const pd = db
      .prepare("SELECT reason, resume_requested FROM paused_deliveries WHERE ticket_id='t2'")
      .get() as {
      reason: string;
      resume_requested: number;
    };
    expect(pd.reason).toBe("cap_hit");
    expect(pd.resume_requested).toBe(0);

    db.close();
  });

  it("re-running migrate() on an already-current DB is a no-op (idempotent)", () => {
    const db = new Database(":memory:");
    migrate(db);
    migrate(db); // must not throw or duplicate-rebuild.
    db.prepare(
      "INSERT INTO tickets (id, number, title, status) VALUES ('a', 1, 't', 'paused')",
    ).run();
    const row = db.prepare("SELECT status FROM tickets WHERE id='a'").get() as { status: string };
    expect(row.status).toBe("paused");
    db.close();
  });

  it("the paused_deliveries row CASCADE-deletes with its ticket", () => {
    const db = new Database(":memory:");
    migrate(db);
    db.prepare(
      "INSERT INTO tickets (id, number, title, status) VALUES ('z', 9, 't', 'paused')",
    ).run();
    db.prepare(
      "INSERT INTO paused_deliveries (ticket_id, reason) VALUES ('z', 'budget_cap')",
    ).run();
    db.prepare("DELETE FROM tickets WHERE id='z'").run();
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM paused_deliveries WHERE ticket_id='z'")
      .get() as {
      n: number;
    };
    expect(count.n).toBe(0);
    db.close();
  });
});
