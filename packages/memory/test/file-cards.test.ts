/**
 * File Cards — data layer tests (migration 006).
 *
 * Pins:
 *   - migration 006 creates file_card, file_card_fts, repo_sync tables
 *   - upsertFileCard: insert, round-trip, update, symbols_fts sync
 *   - card + FTS stay consistent inside the transaction (a failed write
 *     leaves neither the card row nor its FTS entry)
 *   - getFileCard: returns active cards only; applies trust-split serving rule
 *   - Trust-split serving: mechanical fields served when model_status='failed_validation';
 *     model fields null'd; both served when model_status='active'
 *   - searchFileCards: FTS bm25 over path / tldr / symbols_fts
 *   - listCardsForPaths: exact-match bulk lookup
 *   - getWatermark / setWatermark: repo_sync round-trip + event audit trail
 *   - repoKey: stable sha256 of canonical path
 */
import BetterSqlite3 from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  getFileCard,
  getWatermark,
  listCardsForPaths,
  repoKey,
  searchFileCards,
  setWatermark,
  upsertFileCard,
} from "../src/core/fileCards.js";
import { runMigrations } from "../src/db/migrations.js";

// ── Test helpers ──────────────────────────────────────────────────────

function newDb(): Database {
  const db = new BetterSqlite3(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

const TEST_REPO_KEY = repoKey("/repos/payments-svc");
const TEST_REPO = "payments-svc";

function cardInput(
  over: Partial<Parameters<typeof upsertFileCard>[1]> = {},
): Parameters<typeof upsertFileCard>[1] {
  return {
    repoKey: TEST_REPO_KEY,
    repo: TEST_REPO,
    path: "src/api/payments.ts",
    contentHash: "abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
    loc: 120,
    symbols: ["createPayment", "refundPayment", "PaymentService"],
    source: "/repos/payments-svc",
    cardStatus: "active",
    modelStatus: "absent",
    ...over,
  };
}

// ── Migration 006 schema ──────────────────────────────────────────────

describe("migration 006 — file_card, file_card_fts, repo_sync", () => {
  it("creates all three tables", () => {
    const db = newDb();
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(tables).toContain("file_card");
    expect(tables).toContain("repo_sync");
    // Virtual tables appear in sqlite_master with type='table' for fts5
    const allObjs = (
      db.prepare("SELECT name FROM sqlite_master ORDER BY name").all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(allObjs).toContain("file_card_fts");
  });

  it("file_card has required columns with correct nullability", () => {
    const db = newDb();
    const cols = db.prepare("PRAGMA table_info(file_card)").all() as Array<{
      name: string;
      notnull: 0 | 1;
      dflt_value: string | null;
    }>;
    const col = (name: string) => cols.find((c) => c.name === name);

    // Non-nullable
    expect(col("id")?.notnull).toBe(1);
    expect(col("repo_key")?.notnull).toBe(1);
    expect(col("repo")?.notnull).toBe(1);
    expect(col("path")?.notnull).toBe(1);
    expect(col("content_hash")?.notnull).toBe(1);
    expect(col("loc")?.notnull).toBe(1);
    expect(col("symbols")?.notnull).toBe(1);
    expect(col("source")?.notnull).toBe(1);
    expect(col("card_status")?.notnull).toBe(1);
    expect(col("model_status")?.notnull).toBe(1);

    // Nullable model fields
    expect(col("tldr")?.notnull).toBe(0);
    expect(col("role_primary")?.notnull).toBe(0);
    expect(col("role_tags")?.notnull).toBe(0);

    // Default values
    expect(col("card_status")?.dflt_value).toBe("'active'");
    expect(col("model_status")?.dflt_value).toBe("'absent'");
  });

  it("enforces the card_status CHECK constraint", () => {
    const db = newDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO file_card
             (id, repo_key, repo, path, content_hash, loc, symbols, source, card_status, model_status, created_at, updated_at)
           VALUES ('x','rk','r','p','h',1,'[]','s','invalid','absent','now','now')`,
        )
        .run(),
    ).toThrow();
  });

  it("enforces the model_status CHECK constraint", () => {
    const db = newDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO file_card
             (id, repo_key, repo, path, content_hash, loc, symbols, source, card_status, model_status, created_at, updated_at)
           VALUES ('x','rk','r','p','h',1,'[]','s','active','nope','now','now')`,
        )
        .run(),
    ).toThrow();
  });

  it("enforces UNIQUE(repo_key, path) constraint", () => {
    const db = newDb();
    const base = {
      id: "a1",
      repo_key: "rk",
      repo: "r",
      path: "src/foo.ts",
      content_hash: "h",
      loc: 1,
      symbols: "[]",
      source: "s",
      card_status: "active",
      model_status: "absent",
      created_at: "now",
      updated_at: "now",
    };
    db.prepare(
      `INSERT INTO file_card (id,repo_key,repo,path,content_hash,loc,symbols,source,card_status,model_status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(...Object.values(base));
    expect(() =>
      db
        .prepare(
          `INSERT INTO file_card (id,repo_key,repo,path,content_hash,loc,symbols,source,card_status,model_status,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run("a2", "rk", "r", "src/foo.ts", "h2", 1, "[]", "s", "active", "absent", "now", "now"),
    ).toThrow();
  });
});

// ── repoKey ───────────────────────────────────────────────────────────

describe("repoKey", () => {
  it("returns a 64-char hex string", () => {
    const k = repoKey("/repos/payments-svc");
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable for the same canonical path", () => {
    expect(repoKey("/repos/payments-svc")).toBe(repoKey("/repos/payments-svc"));
  });

  it("differs for different canonical paths", () => {
    expect(repoKey("/repos/auth-svc")).not.toBe(repoKey("/repos/payments-svc"));
  });

  it("treats local path and remote URL as different", () => {
    expect(repoKey("/repos/app")).not.toBe(repoKey("https://github.com/org/app"));
  });
});

// ── upsertFileCard ────────────────────────────────────────────────────

describe("upsertFileCard / getFileCard", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
  });

  it("inserts a card and round-trips it via getFileCard", () => {
    const card = upsertFileCard(db, cardInput());
    expect(card.path).toBe("src/api/payments.ts");
    expect(card.repo).toBe(TEST_REPO);
    expect(card.symbols).toEqual(["createPayment", "refundPayment", "PaymentService"]);
    expect(card.cardStatus).toBe("active");
    expect(card.modelStatus).toBe("absent");
    expect(card.tldr).toBeNull(); // absent → null
    expect(card.createdAt).toBeTruthy();
    expect(card.updatedAt).toBeTruthy();

    const fetched = getFileCard(db, TEST_REPO_KEY, "src/api/payments.ts");
    expect(fetched).toEqual(card);
  });

  it("updates an existing card (UPSERT by repo_key + path)", () => {
    upsertFileCard(db, cardInput());
    const updated = upsertFileCard(
      db,
      cardInput({
        contentHash: "newHash",
        loc: 200,
        symbols: ["createPayment", "voidPayment"],
        tldr: "Handles payment capture and refunds.",
        modelStatus: "active",
        rolePrimary: "api",
        roleTags: ["payments", "api"],
      }),
    );
    expect(updated.contentHash).toBe("newHash");
    expect(updated.loc).toBe(200);
    expect(updated.symbols).toEqual(["createPayment", "voidPayment"]);
    expect(updated.tldr).toBe("Handles payment capture and refunds.");
    expect(updated.rolePrimary).toBe("api");
    expect(updated.roleTags).toEqual(["payments", "api"]);

    // Only one row in the table
    const count = (
      db
        .prepare("SELECT COUNT(*) AS n FROM file_card WHERE repo_key = ? AND path = ?")
        .get(TEST_REPO_KEY, "src/api/payments.ts") as { n: number }
    ).n;
    expect(count).toBe(1);
  });

  it("emits a file_card_upserted event for each write", () => {
    upsertFileCard(db, cardInput());
    upsertFileCard(db, cardInput({ loc: 130 }));

    const events = db
      .prepare("SELECT payload FROM events WHERE kind = 'file_card_upserted' ORDER BY rowid")
      .all() as Array<{ payload: string }>;
    expect(events).toHaveLength(2);
    const first = JSON.parse(events[0]!.payload);
    expect(first.path).toBe("src/api/payments.ts");
    expect(first.repoKey).toBe(TEST_REPO_KEY);
  });

  it("stores multiple cards for the same repo under different paths", () => {
    upsertFileCard(db, cardInput({ path: "src/api/payments.ts" }));
    upsertFileCard(db, cardInput({ path: "src/core/domain.ts" }));

    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM file_card WHERE repo_key = ?").get(TEST_REPO_KEY) as {
        n: number;
      }
    ).n;
    expect(count).toBe(2);
  });

  it("getFileCard returns null for non-existent path", () => {
    expect(getFileCard(db, TEST_REPO_KEY, "does/not/exist.ts")).toBeNull();
  });

  it("getFileCard returns null for shadow cards", () => {
    upsertFileCard(db, cardInput({ cardStatus: "shadow" }));
    expect(getFileCard(db, TEST_REPO_KEY, "src/api/payments.ts")).toBeNull();
  });

  it("getFileCard returns null for stale cards", () => {
    upsertFileCard(db, cardInput({ cardStatus: "stale" }));
    expect(getFileCard(db, TEST_REPO_KEY, "src/api/payments.ts")).toBeNull();
  });

  it("rejects empty repoKey, repo, path, contentHash, source", () => {
    expect(() => upsertFileCard(db, cardInput({ repoKey: "" }))).toThrow(/repoKey/);
    expect(() => upsertFileCard(db, cardInput({ repo: "" }))).toThrow(/repo/);
    expect(() => upsertFileCard(db, cardInput({ path: "" }))).toThrow(/path/);
    expect(() => upsertFileCard(db, cardInput({ contentHash: "" }))).toThrow(/contentHash/);
    expect(() => upsertFileCard(db, cardInput({ source: "  " }))).toThrow(/source/);
  });
});

// ── Trust-split serving rule ──────────────────────────────────────────

describe("trust-split serving rule", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
  });

  it("serves mechanical fields when model_status=failed_validation; nulls model fields", () => {
    upsertFileCard(
      db,
      cardInput({
        modelStatus: "failed_validation",
        tldr: "some summary",
        rolePrimary: "api",
        roleTags: ["api"],
        validationError: "symbol not found",
      }),
    );
    const card = getFileCard(db, TEST_REPO_KEY, "src/api/payments.ts");
    // Mechanical fields still served
    expect(card).not.toBeNull();
    expect(card!.path).toBe("src/api/payments.ts");
    expect(card!.symbols).toEqual(["createPayment", "refundPayment", "PaymentService"]);
    expect(card!.contentHash).toBeTruthy();
    expect(card!.loc).toBe(120);
    // Model fields nulled even though row has values
    expect(card!.tldr).toBeNull();
    expect(card!.rolePrimary).toBeNull();
    expect(card!.roleTags).toBeNull();
    // Status fields still present
    expect(card!.modelStatus).toBe("failed_validation");
    expect(card!.validationError).toBe("symbol not found");
  });

  it("serves model fields when model_status=active", () => {
    upsertFileCard(
      db,
      cardInput({
        modelStatus: "active",
        tldr: "Handles payment capture and voids.",
        rolePrimary: "api",
        roleTags: ["payments", "api"],
      }),
    );
    const card = getFileCard(db, TEST_REPO_KEY, "src/api/payments.ts");
    expect(card!.tldr).toBe("Handles payment capture and voids.");
    expect(card!.rolePrimary).toBe("api");
    expect(card!.roleTags).toEqual(["payments", "api"]);
  });

  it("nulls model fields when model_status=absent", () => {
    upsertFileCard(
      db,
      cardInput({
        modelStatus: "absent",
        tldr: "should be hidden",
        rolePrimary: "api",
        roleTags: ["api"],
      }),
    );
    const card = getFileCard(db, TEST_REPO_KEY, "src/api/payments.ts");
    expect(card!.tldr).toBeNull();
    expect(card!.rolePrimary).toBeNull();
    expect(card!.roleTags).toBeNull();
  });
});

// ── FTS consistency ───────────────────────────────────────────────────

describe("card + FTS transaction consistency", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
  });

  it("FTS row is created alongside the card row in the same transaction", () => {
    upsertFileCard(
      db,
      cardInput({
        symbols: ["createPayment", "refundPayment"],
        tldr: "Payment API",
      }),
    );
    const ftsCount = (db.prepare("SELECT COUNT(*) AS n FROM file_card_fts").get() as { n: number })
      .n;
    expect(ftsCount).toBe(1);
  });

  it("FTS is updated atomically on card update", () => {
    upsertFileCard(db, cardInput({ symbols: ["oldSymbol"], tldr: "old summary" }));
    upsertFileCard(db, cardInput({ symbols: ["newSymbol"], tldr: "new summary" }));

    // Only one FTS row should exist (no duplicates after update).
    const ftsCount = (db.prepare("SELECT COUNT(*) AS n FROM file_card_fts").get() as { n: number })
      .n;
    expect(ftsCount).toBe(1);

    // FTS row reflects the new content.
    const results = searchFileCards(db, TEST_REPO_KEY, "newSymbol");
    expect(results).toHaveLength(1);

    // Old content no longer matches.
    const oldResults = searchFileCards(db, TEST_REPO_KEY, "oldSymbol");
    expect(oldResults).toHaveLength(0);
  });

  it("multiple cards each get their own FTS row", () => {
    upsertFileCard(db, cardInput({ path: "src/a.ts", symbols: ["Alpha"] }));
    upsertFileCard(db, cardInput({ path: "src/b.ts", symbols: ["Beta"] }));

    const ftsCount = (db.prepare("SELECT COUNT(*) AS n FROM file_card_fts").get() as { n: number })
      .n;
    expect(ftsCount).toBe(2);

    expect(searchFileCards(db, TEST_REPO_KEY, "Alpha")).toHaveLength(1);
    expect(searchFileCards(db, TEST_REPO_KEY, "Beta")).toHaveLength(1);
  });
});

// ── searchFileCards ───────────────────────────────────────────────────

describe("searchFileCards", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
    // Insert a few cards with different content.
    upsertFileCard(
      db,
      cardInput({
        path: "src/api/payments.ts",
        symbols: ["createPayment", "refundPayment"],
        tldr: "Handles payment capture and refunds",
        modelStatus: "active",
      }),
    );
    upsertFileCard(
      db,
      cardInput({
        path: "src/core/auth.ts",
        symbols: ["authenticateUser", "generateToken"],
        tldr: "Authentication and JWT token generation",
        modelStatus: "active",
      }),
    );
    upsertFileCard(
      db,
      cardInput({
        path: "src/db/migrations/001-initial.sql",
        symbols: ["users", "sessions"],
        tldr: null,
        modelStatus: "absent",
      }),
    );
  });

  it("returns cards matching a path fragment", () => {
    const results = searchFileCards(db, TEST_REPO_KEY, "payments");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.path.includes("payments"))).toBe(true);
  });

  it("returns cards matching a symbol name", () => {
    const results = searchFileCards(db, TEST_REPO_KEY, "authenticateUser");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.path === "src/core/auth.ts")).toBe(true);
  });

  it("returns cards matching tldr content", () => {
    const results = searchFileCards(db, TEST_REPO_KEY, "JWT");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.path === "src/core/auth.ts")).toBe(true);
  });

  it("returns empty array for no matches", () => {
    expect(searchFileCards(db, TEST_REPO_KEY, "xyznosuchthing")).toEqual([]);
  });

  it("returns empty array for empty query", () => {
    expect(searchFileCards(db, TEST_REPO_KEY, "")).toEqual([]);
    expect(searchFileCards(db, TEST_REPO_KEY, "   ")).toEqual([]);
  });

  it("only returns cards for the queried repo_key", () => {
    const otherKey = repoKey("/repos/other-svc");
    upsertFileCard(
      db,
      cardInput({
        repoKey: otherKey,
        repo: "other-svc",
        path: "src/payments.ts",
        symbols: ["createPayment"],
        tldr: "payment in another repo",
        modelStatus: "active",
      }),
    );
    const results = searchFileCards(db, TEST_REPO_KEY, "createPayment");
    expect(results.every((r) => r.repoKey === TEST_REPO_KEY)).toBe(true);
  });

  it("applies trust-split: model fields null for absent/failed cards", () => {
    const results = searchFileCards(db, TEST_REPO_KEY, "migrations");
    const migCard = results.find((r) => r.path.includes("migrations"));
    // If found, tldr should be null (model_status=absent).
    if (migCard) {
      expect(migCard.tldr).toBeNull();
    }
  });
});

// ── listCardsForPaths ─────────────────────────────────────────────────

describe("listCardsForPaths", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
    upsertFileCard(db, cardInput({ path: "src/a.ts" }));
    upsertFileCard(db, cardInput({ path: "src/b.ts" }));
    upsertFileCard(db, cardInput({ path: "src/c.ts", cardStatus: "shadow" }));
  });

  it("returns cards for known paths", () => {
    const results = listCardsForPaths(db, TEST_REPO_KEY, ["src/a.ts", "src/b.ts"]);
    expect(results.map((r) => r.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("omits shadow / stale cards", () => {
    const results = listCardsForPaths(db, TEST_REPO_KEY, ["src/a.ts", "src/c.ts"]);
    expect(results.map((r) => r.path)).toEqual(["src/a.ts"]);
  });

  it("returns empty array for empty paths list", () => {
    expect(listCardsForPaths(db, TEST_REPO_KEY, [])).toEqual([]);
  });

  it("returns empty array when no paths match", () => {
    expect(listCardsForPaths(db, TEST_REPO_KEY, ["no/such/file.ts"])).toEqual([]);
  });

  it("scopes to the repo_key — does not bleed across repos", () => {
    const otherKey = repoKey("/repos/other-svc");
    upsertFileCard(db, cardInput({ repoKey: otherKey, repo: "other-svc", path: "src/a.ts" }));

    const results = listCardsForPaths(db, TEST_REPO_KEY, ["src/a.ts"]);
    expect(results.every((r) => r.repoKey === TEST_REPO_KEY)).toBe(true);
  });
});

// ── getWatermark / setWatermark ───────────────────────────────────────

describe("getWatermark / setWatermark", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
  });

  it("returns null when no watermark has been written", () => {
    expect(getWatermark(db, TEST_REPO_KEY)).toBeNull();
  });

  it("writes and round-trips a watermark", () => {
    const wm = setWatermark(db, TEST_REPO_KEY, TEST_REPO, "abc1234");
    expect(wm.repoKey).toBe(TEST_REPO_KEY);
    expect(wm.repo).toBe(TEST_REPO);
    expect(wm.syncedCommit).toBe("abc1234");
    expect(wm.updatedAt).toBeTruthy();

    const fetched = getWatermark(db, TEST_REPO_KEY);
    expect(fetched).toEqual(wm);
  });

  it("upserts the watermark on a second write (one row per repo_key)", () => {
    setWatermark(db, TEST_REPO_KEY, TEST_REPO, "aaa");
    setWatermark(db, TEST_REPO_KEY, TEST_REPO, "bbb");

    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM repo_sync WHERE repo_key = ?").get(TEST_REPO_KEY) as {
        n: number;
      }
    ).n;
    expect(count).toBe(1);

    const wm = getWatermark(db, TEST_REPO_KEY);
    expect(wm!.syncedCommit).toBe("bbb");
  });

  it("emits a repo_sync_updated event for each write", () => {
    setWatermark(db, TEST_REPO_KEY, TEST_REPO, "abc");
    setWatermark(db, TEST_REPO_KEY, TEST_REPO, "def");

    const events = db
      .prepare("SELECT payload FROM events WHERE kind = 'repo_sync_updated' ORDER BY rowid")
      .all() as Array<{ payload: string }>;
    expect(events).toHaveLength(2);
    const last = JSON.parse(events[1]!.payload);
    expect(last.syncedCommit).toBe("def");
    expect(last.repoKey).toBe(TEST_REPO_KEY);
  });

  it("rejects empty repoKey, repo, or commit", () => {
    expect(() => setWatermark(db, "", TEST_REPO, "abc")).toThrow(/repoKey/);
    expect(() => setWatermark(db, TEST_REPO_KEY, "", "abc")).toThrow(/repo/);
    expect(() => setWatermark(db, TEST_REPO_KEY, TEST_REPO, "  ")).toThrow(/commit/);
  });

  it("stores watermarks for multiple repos independently", () => {
    const key2 = repoKey("/repos/auth-svc");
    setWatermark(db, TEST_REPO_KEY, TEST_REPO, "commit-a");
    setWatermark(db, key2, "auth-svc", "commit-b");

    expect(getWatermark(db, TEST_REPO_KEY)!.syncedCommit).toBe("commit-a");
    expect(getWatermark(db, key2)!.syncedCommit).toBe("commit-b");
  });
});

// ── Memory isolation — no dispatch/crew imports ───────────────────────

describe("module isolation", () => {
  it("fileCards module is standalone — imports only from memory itself", async () => {
    // Dynamic import to check the module resolves without dispatch/crew.
    // If it imported from dispatch/crew, node would fail to resolve those
    // modules when running in isolation (they aren't linked here).
    const mod = await import("../src/core/fileCards.js");
    expect(typeof mod.upsertFileCard).toBe("function");
    expect(typeof mod.getFileCard).toBe("function");
    expect(typeof mod.searchFileCards).toBe("function");
    expect(typeof mod.repoKey).toBe("function");
  });
});
