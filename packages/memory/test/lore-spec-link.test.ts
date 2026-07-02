/**
 * Structured spec provenance on lore (Spec-Driven Development, Phase 2b).
 *
 * When Dispatch freezes a spec, each clause is seeded as a gated draft lore
 * record carrying the (spec_id, clause_id) linkage so a later phase can JOIN a
 * record back to the exact clause it came from. This asserts:
 *   - migration 010 adds the two nullable columns;
 *   - suggestLore / addLore persist and round-trip specId + clauseId;
 *   - NEGATIVE CONTROL: ordinary lore (no linkage supplied) reads back with
 *     specId/clauseId undefined — the columns are NULL for the whole
 *     standalone-product corpus.
 */
import BetterSqlite3 from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";

import { addLore, getLore, suggestLore } from "../src/core/lore.js";
import { MIGRATIONS, runMigrations } from "../src/db/migrations.js";

function newInMemoryDb(): Database {
  const db = new BetterSqlite3(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

describe("lore spec-link — migration 010", () => {
  it("ships the 010-lore-spec-link migration", () => {
    expect(MIGRATIONS.some((m) => m.id === "010-lore-spec-link")).toBe(true);
  });

  it("adds nullable spec_id + clause_id columns to lore", () => {
    const db = newInMemoryDb();
    const cols = (db.prepare("PRAGMA table_info(lore)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain("spec_id");
    expect(cols).toContain("clause_id");
  });
});

describe("lore spec-link — write + read path", () => {
  let db: Database;
  beforeEach(() => {
    db = newInMemoryDb();
  });

  it("round-trips specId + clauseId through suggestLore (gated draft)", () => {
    const draft = suggestLore(db, {
      title: "Requirement — Checkout: user can pay with a saved card",
      summary: "User can pay with a saved card",
      body: "Frozen spec clause",
      kind: "requirement",
      specId: "spec-abc",
      clauseId: "clause-1",
    });
    expect(draft.status).toBe("draft");

    const read = getLore(db, draft.id);
    expect(read?.specId).toBe("spec-abc");
    expect(read?.clauseId).toBe("clause-1");
    expect(read?.kind).toBe("requirement");
    // Persisted at the storage layer too (not just the returned object).
    const row = db.prepare("SELECT spec_id, clause_id FROM lore WHERE id = ?").get(draft.id) as {
      spec_id: string;
      clause_id: string;
    };
    expect(row.spec_id).toBe("spec-abc");
    expect(row.clause_id).toBe("clause-1");
  });

  it("round-trips linkage through addLore (auto-approve/active path)", () => {
    const active = addLore(db, {
      title: "Non-goal — no crypto payments",
      summary: "No crypto payments",
      body: "Deliberately out of scope",
      kind: "non-goal",
      specId: "spec-xyz",
      clauseId: "clause-9",
    });
    const read = getLore(db, active.id);
    expect(read?.specId).toBe("spec-xyz");
    expect(read?.clauseId).toBe("clause-9");
  });

  // NEGATIVE CONTROL: lore with no spec linkage reads back undefined/NULL.
  it("leaves specId/clauseId undefined for ordinary lore", () => {
    const plain = suggestLore(db, {
      title: "A convention",
      summary: "We do it this way",
      body: "body",
      kind: "convention",
    });
    const read = getLore(db, plain.id);
    expect(read?.specId).toBeUndefined();
    expect(read?.clauseId).toBeUndefined();
    const row = db.prepare("SELECT spec_id, clause_id FROM lore WHERE id = ?").get(plain.id) as {
      spec_id: string | null;
      clause_id: string | null;
    };
    expect(row.spec_id).toBeNull();
    expect(row.clause_id).toBeNull();
  });
});
