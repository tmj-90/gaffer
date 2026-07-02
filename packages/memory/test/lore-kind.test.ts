/**
 * Lore `kind` — the product-intent classifier (Track 1c).
 *
 * Asserts:
 *   - writes default to 'other' and round-trip a valid enum value through
 *     getLore + searchLore + updateLore;
 *   - the write path validates against the closed enum (bad kind throws);
 *   - migration 009 back-fills existing rows: tag-named kinds migrate to the
 *     closest enum value (highest intent wins), everything else stays 'other'.
 */
import BetterSqlite3 from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";

import { addLore, getLore, searchLore, suggestLore, updateLore } from "../src/core/lore.js";
import { MIGRATIONS, runMigrations } from "../src/db/migrations.js";
import { LORE_KINDS, PRODUCT_INTENT_KINDS } from "../src/db/types.js";

function newInMemoryDb(): Database {
  const db = new BetterSqlite3(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

describe("lore kind — write + read path", () => {
  let db: Database;
  beforeEach(() => {
    db = newInMemoryDb();
  });

  it("defaults kind to 'other' when the caller omits it", () => {
    const lore = addLore(db, { title: "t", summary: "s", body: "b" });
    expect(lore.kind).toBe("other");
    expect(getLore(db, lore.id)!.kind).toBe("other");
  });

  it("persists and returns a valid product-intent kind", () => {
    const lore = suggestLore(db, {
      title: "Event-sourcing over CRUD",
      summary: "Chosen for auditability of billing changes.",
      body: "Rationale: immutable ledger of every state transition.",
      kind: "decision",
      tags: ["billing"],
    });
    expect(lore.kind).toBe("decision");
    // Surfaces on the search summary so a consumer can filter without get_lore.
    const [hit] = searchLore(db, { tag: "billing", includeDrafts: true });
    expect(hit!.kind).toBe("decision");
  });

  it("re-classifies a record via updateLore", () => {
    const lore = addLore(db, { title: "t", summary: "s", body: "b", kind: "gotcha" });
    const updated = updateLore(db, lore.id, { kind: "non-goal" });
    expect(updated!.kind).toBe("non-goal");
  });

  it("rejects a kind outside the closed enum at the write boundary", () => {
    expect(() =>
      // @ts-expect-error — deliberately invalid kind
      addLore(db, { title: "t", summary: "s", body: "b", kind: "epic" }),
    ).toThrow(/kind/);
  });

  it("exposes the enum + the product-intent subset", () => {
    expect(LORE_KINDS).toContain("other");
    expect(PRODUCT_INTENT_KINDS).toEqual(["decision", "requirement", "non-goal"]);
  });
});

describe("migration 009 — back-fill kind from existing tags", () => {
  /**
   * Build a DB at the pre-009 schema by applying every migration EXCEPT the last
   * (009), so we can seed rows the old way and then run 009's back-fill.
   */
  function preKindDb(): Database {
    const db = new BetterSqlite3(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(
      `CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`,
    );
    const insert = db.prepare("INSERT INTO migrations (id, applied_at) VALUES (?, ?)");
    for (const m of MIGRATIONS.slice(0, -1)) {
      m.up(db);
      insert.run(m.id, new Date().toISOString());
    }
    return db;
  }

  function seedLore(db: Database, id: string, tags: string[]): void {
    const ts = new Date().toISOString();
    db.prepare(
      `INSERT INTO lore (id, title, summary, body, status, confidence, restricted, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', 'medium', 0, ?, ?)`,
    ).run(id, `title-${id}`, "s", "b", ts, ts);
    const tagIns = db.prepare("INSERT INTO lore_tags (lore_id, tag) VALUES (?, ?)");
    for (const t of tags) tagIns.run(id, t);
  }

  function kindOf(db: Database, id: string): string {
    return (db.prepare("SELECT kind FROM lore WHERE id = ?").get(id) as { kind: string }).kind;
  }

  it("maps tag-named kinds to the enum and leaves the rest 'other'", () => {
    const db = preKindDb();
    seedLore(db, "aaaa1111", ["decision"]);
    seedLore(db, "bbbb2222", ["requirements"]);
    seedLore(db, "cccc3333", ["non-goals"]);
    seedLore(db, "dddd4444", ["conventions"]);
    seedLore(db, "eeee5555", ["gotcha"]);
    seedLore(db, "ffff6666", ["random", "unrelated"]);
    // A record tagged both 'decision' and 'convention' — higher intent wins.
    seedLore(db, "gggg7777", ["convention", "decision"]);

    const m009 = MIGRATIONS[MIGRATIONS.length - 1]!;
    expect(m009.id).toBe("009-lore-kind");
    m009.up(db);

    expect(kindOf(db, "aaaa1111")).toBe("decision");
    expect(kindOf(db, "bbbb2222")).toBe("requirement");
    expect(kindOf(db, "cccc3333")).toBe("non-goal");
    expect(kindOf(db, "dddd4444")).toBe("convention");
    expect(kindOf(db, "eeee5555")).toBe("gotcha");
    expect(kindOf(db, "ffff6666")).toBe("other");
    expect(kindOf(db, "gggg7777")).toBe("decision");
  });
});
