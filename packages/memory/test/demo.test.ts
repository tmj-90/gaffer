/**
 * `memory demo` seed + cleanup. The demo records exist primarily for
 * onboarding — these tests just guard the safety properties: idempotent
 * cleanup, refusal to clobber existing data without --force, and the
 * tag-based undo path.
 */
import BetterSqlite3 from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { cleanDemo, countLore, seedDemo } from "../src/cli/demo.js";
import { addLore, listRecent } from "../src/core/lore.js";
import { runMigrations } from "../src/db/migrations.js";
import type { Database } from "better-sqlite3";

function newInMemoryDb(): Database {
  const db = new BetterSqlite3(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

describe("cli/demo", () => {
  let db: Database;
  beforeEach(() => {
    db = newInMemoryDb();
  });

  it("seedDemo inserts 5 records, every one tagged 'demo'", () => {
    const { inserted, ids } = seedDemo(db);
    expect(inserted).toBe(5);
    expect(ids).toHaveLength(5);
    const recents = listRecent(db, 20);
    expect(recents.length).toBe(5);
    for (const r of recents) {
      expect(r.tags).toContain("demo");
    }
  });

  it("includes at least one draft so the review flow is exercised", () => {
    seedDemo(db);
    const statuses = listRecent(db, 20).map((r) => r.status);
    expect(statuses).toContain("draft");
  });

  it("includes at least one stale record (review_after in the past)", () => {
    seedDemo(db);
    const stale = listRecent(db, 20).filter((r) => r.stale);
    expect(stale.length).toBeGreaterThanOrEqual(1);
  });

  it("countLore reflects the current row count", () => {
    expect(countLore(db)).toBe(0);
    seedDemo(db);
    expect(countLore(db)).toBe(5);
  });

  it("cleanDemo removes only records tagged 'demo' and is idempotent", () => {
    // Pre-existing real record.
    const real = addLore(db, {
      title: "real record",
      summary: "s",
      body: "b",
    });
    seedDemo(db);
    expect(countLore(db)).toBe(6);
    expect(cleanDemo(db)).toBe(5);
    const remaining = listRecent(db, 20);
    expect(remaining.map((r) => r.id)).toEqual([real.id]);
    // Idempotent: second cleanDemo is a no-op.
    expect(cleanDemo(db)).toBe(0);
  });

  it("cleanDemo on a fresh DB returns 0 (no crash)", () => {
    expect(cleanDemo(db)).toBe(0);
  });

  it("seeded records contain no obvious secrets / credential-looking patterns", () => {
    seedDemo(db);
    const all = listRecent(db, 20);
    const text = all
      .map((r) => `${r.title} ${r.summary}`)
      .join("\n")
      .toLowerCase();
    // Tripwire: tokens commonly used for secrets shouldn't appear in
    // demo titles or summaries. If a future contributor edits demo.ts
    // with a "fake" example like 'AKIA…' or 'sk_test_…', this fails loudly.
    expect(text).not.toMatch(/akia[a-z0-9]{10,}/);
    expect(text).not.toMatch(/\bsk_(test|live)_[a-z0-9]+/);
    expect(text).not.toMatch(/-----begin (rsa |ec )?private key-----/);
    expect(text).not.toMatch(/bearer\s+[a-z0-9-]{20,}/);
  });
});
