import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { migrate } from "../src/db/connection.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";
import { EVIDENCE_TYPES } from "../src/domain/types.js";

/**
 * MEMORY ATTRIBUTION (v27→v28): `memory_primed` was in EVIDENCE_TYPES but not in the
 * evidence table's CHECK, so the runner's per-delivery `wg attach-evidence --type
 * memory_primed` write was refused by SQLite on every real DB (and `|| true` hid it).
 */
describe("evidence_type CHECK accepts memory_primed", () => {
  it("a fresh DB accepts every EVIDENCE_TYPES value (CHECK and app enum agree)", () => {
    const db = new Database(":memory:");
    migrate(db);
    db.prepare(
      "INSERT INTO tickets (id, number, title, status) VALUES ('t1', 1, 't', 'ready')",
    ).run();
    for (const [i, type] of EVIDENCE_TYPES.entries()) {
      expect(() =>
        db
          .prepare(
            "INSERT INTO evidence (id, ticket_id, evidence_type, summary, created_by) VALUES (?, 't1', ?, 's', 'x')",
          )
          .run(`e${i}`, type),
      ).not.toThrow();
    }
    db.close();
  });

  it("rebuilds a v27 evidence table without data loss and then accepts memory_primed", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db); // a current schema…
    // …then hand-roll the v27 evidence table (CHECK without memory_primed) with a row.
    db.exec(`
      DROP TABLE evidence;
      CREATE TABLE evidence (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        ac_id TEXT REFERENCES acceptance_criteria(id) ON DELETE CASCADE,
        repo_id TEXT REFERENCES repositories(id) ON DELETE SET NULL,
        decision_id TEXT REFERENCES decisions(id) ON DELETE SET NULL,
        evidence_type TEXT NOT NULL CHECK (evidence_type IN (
          'test_output','coverage_report','commit','branch','pull_request','diff_summary',
          'screenshot','log','manual_note','ci_run','static_analysis','lore_record'
        )),
        summary TEXT NOT NULL, uri TEXT, payload_json TEXT, created_by TEXT NOT NULL,
        recorded_by_actor_type TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    db.prepare("UPDATE schema_meta SET value = '27' WHERE key = 'schema_version'").run();
    db.prepare(
      "INSERT INTO tickets (id, number, title, status) VALUES ('t1', 1, 't', 'ready')",
    ).run();
    db.prepare(
      "INSERT INTO evidence (id, ticket_id, evidence_type, summary, created_by, recorded_by_actor_type, created_at) " +
        "VALUES ('old', 't1', 'test_output', 'tests pass', 'runner', 'system', '2026-01-01T00:00:00.000Z')",
    ).run();
    const insertPrimed = (): unknown =>
      db
        .prepare(
          "INSERT INTO evidence (id, ticket_id, evidence_type, summary, created_by) VALUES ('mp', 't1', 'memory_primed', 'cards', 'runner')",
        )
        .run();
    expect(insertPrimed).toThrow(/CHECK constraint failed/);

    migrate(db);

    expect(
      db
        .prepare(
          "SELECT evidence_type, summary, created_by, recorded_by_actor_type, created_at FROM evidence WHERE id = 'old'",
        )
        .get(),
    ).toEqual({
      evidence_type: "test_output",
      summary: "tests pass",
      created_by: "runner",
      recorded_by_actor_type: "system",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    expect(insertPrimed).not.toThrow();
    const idx = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'evidence'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(idx).toEqual(
      expect.arrayContaining(["idx_evidence_ticket", "idx_evidence_ac", "idx_evidence_type"]),
    );
    // The cascade from tickets still holds on the rebuilt table.
    db.prepare("DELETE FROM tickets WHERE id = 't1'").run();
    expect((db.prepare("SELECT COUNT(*) AS n FROM evidence").get() as { n: number }).n).toBe(0);
    const ver = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as {
      value: string;
    };
    expect(Number(ver.value)).toBe(SCHEMA_VERSION);
    expect((db.pragma("foreign_key_check") as unknown[]).length).toBe(0);
    db.close();
  });
});
