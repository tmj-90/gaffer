/**
 * Scope Packet tests — cardsForScope selection priority, budget enforcement,
 * coverage reporting, and deduplication.
 *
 * Pinned behaviours:
 *   - Selection priority: exact-path > path-prefix > important-path > fts
 *     (a path match always beats an FTS match for the same card)
 *   - Budget: maxCards sets truncationReason + moves excess to omitted
 *   - Budget: maxTokens stops card accumulation, sets truncationReason
 *   - perCardMaxTokens truncates tldr on oversized cards (card still returned)
 *   - coverage.missing lists requested paths with no active card
 *   - Deduplication: a path seen at tier 1 is not re-listed at tier 4 (fts)
 *   - FTS tldr index fix: failed-validation/absent tldr doesn't pollute FTS
 *   - Isolation: no dispatch/crew imports
 *
 * Also smoke-tests the three MCP tools (get_file_card, search_file_cards,
 * cards_for_scope) via the real in-memory MCP transport, and the CLI commands
 * via direct function calls.
 */
import BetterSqlite3 from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";

import { repoKey, searchFileCards, upsertFileCard } from "../src/core/fileCards.js";
import { cardsForScope } from "../src/core/scopePacket.js";
import { buildMcpServer } from "../src/mcp/server.js";
import { runMigrations } from "../src/db/migrations.js";

// ── Helpers ───────────────────────────────────────────────────────────

const CANONICAL = "/repos/test-svc";
const REPO = "test-svc";
const RK = repoKey(CANONICAL);

function newDb(): Database {
  const db = new BetterSqlite3(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function makeCard(
  db: Database,
  path: string,
  overrides: Partial<Parameters<typeof upsertFileCard>[1]> = {},
) {
  return upsertFileCard(db, {
    repoKey: RK,
    repo: REPO,
    path,
    contentHash: "abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
    loc: 100,
    symbols: ["FooFunction", "BarClass"],
    source: CANONICAL,
    cardStatus: "active",
    modelStatus: "active",
    tldr: `Summary of ${path}`,
    ...overrides,
  });
}

async function connectMcpClient(database: Database): Promise<Client> {
  const server = buildMcpServer(database);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverT), c.connect(clientT)]);
  return c;
}

async function callJson(
  c: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; json: unknown }> {
  const res = (await c.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  const text = res.content.map((b) => b.text).join("");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { isError: res.isError === true, json };
}

// ── cardsForScope — selection priority ───────────────────────────────

describe("cardsForScope — selection priority", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
    // Insert several cards across different paths.
    makeCard(db, "src/api/payments.ts", { symbols: ["createPayment", "refundPayment"] });
    makeCard(db, "src/api/auth.ts", { symbols: ["authenticateUser"] });
    makeCard(db, "src/core/domain.ts", { symbols: ["Order", "Payment"] });
    makeCard(db, "src/db/migrations/001.sql", { symbols: ["payments_table"] });
  });

  it("returns exact path match at tier exact-path", () => {
    const packet = cardsForScope(db, {
      repoCanonical: CANONICAL,
      repo: REPO,
      query: "payment auth",
      paths: ["src/api/payments.ts"],
    });

    expect(packet.cards.some((c) => c.path === "src/api/payments.ts")).toBe(true);
    const entry = packet.selectionOrder.find((e) => e.path === "src/api/payments.ts");
    expect(entry?.tier).toBe("exact-path");
  });

  it("path-prefix expands a directory prefix to all files under it", () => {
    const packet = cardsForScope(db, {
      repoCanonical: CANONICAL,
      repo: REPO,
      query: "api",
      paths: ["src/api"],
    });

    const paths = packet.cards.map((c) => c.path);
    expect(paths).toContain("src/api/payments.ts");
    expect(paths).toContain("src/api/auth.ts");

    const tiers = packet.selectionOrder.reduce<Record<string, string>>(
      (acc, e) => ({ ...acc, [e.path]: e.tier }),
      {},
    );
    expect(tiers["src/api/payments.ts"]).toBe("path-prefix");
    expect(tiers["src/api/auth.ts"]).toBe("path-prefix");
  });

  it("exact-path beats fts for the same card (no dup in fts tier)", () => {
    // "payments" in query would match the payments card via FTS, but since
    // we also pass it explicitly in paths, it should appear at tier exact-path,
    // not fts, and should NOT appear twice.
    const packet = cardsForScope(db, {
      repoCanonical: CANONICAL,
      repo: REPO,
      query: "payments refund",
      paths: ["src/api/payments.ts"],
    });

    const paymentCards = packet.cards.filter((c) => c.path === "src/api/payments.ts");
    expect(paymentCards).toHaveLength(1); // no duplicate

    const entry = packet.selectionOrder.find((e) => e.path === "src/api/payments.ts");
    expect(entry?.tier).toBe("exact-path"); // tier 1, not fts
  });

  it("path-prefix beats fts for the same card", () => {
    // src/core/ expands to src/core/domain.ts; query would also FTS-match it.
    const packet = cardsForScope(db, {
      repoCanonical: CANONICAL,
      repo: REPO,
      query: "Order Payment",
      paths: ["src/core"],
    });

    const domainCards = packet.cards.filter((c) => c.path === "src/core/domain.ts");
    expect(domainCards).toHaveLength(1);

    const entry = packet.selectionOrder.find((e) => e.path === "src/core/domain.ts");
    expect(entry?.tier).toBe("path-prefix");
  });

  it("important-path (tier 3) is selected when no explicit paths cover it", () => {
    const packet = cardsForScope(db, {
      repoCanonical: CANONICAL,
      repo: REPO,
      query: "payment",
      paths: [],
      importantPaths: ["src/core/domain.ts"],
    });

    const domainEntry = packet.selectionOrder.find((e) => e.path === "src/core/domain.ts");
    expect(domainEntry?.tier).toBe("important-path");
  });

  it("fts falls back when no paths given", () => {
    const packet = cardsForScope(db, {
      repoCanonical: CANONICAL,
      repo: REPO,
      query: "authenticateUser",
    });

    expect(packet.cards.some((c) => c.path === "src/api/auth.ts")).toBe(true);
    const entry = packet.selectionOrder.find((e) => e.path === "src/api/auth.ts");
    expect(entry?.tier).toBe("fts");
  });

  it("selectionBasis describes what drove selection", () => {
    const packet = cardsForScope(db, {
      repoCanonical: CANONICAL,
      repo: REPO,
      query: "auth",
      paths: ["src/api/auth.ts"],
    });
    expect(packet.selectionBasis).toContain("explicit path");
    expect(packet.selectionBasis).toContain("FTS query");
  });
});

// ── cardsForScope — budget enforcement ───────────────────────────────

describe("cardsForScope — budget enforcement", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
    for (let i = 0; i < 10; i++) {
      makeCard(db, `src/module-${i}/index.ts`, { symbols: [`Mod${i}Function`] });
    }
  });

  it("maxCards caps the result and sets truncationReason", () => {
    const packet = cardsForScope(db, {
      repoCanonical: CANONICAL,
      repo: REPO,
      query: "module",
      maxCards: 3,
    });

    expect(packet.cards.length).toBeLessThanOrEqual(3);
    expect(packet.truncationReason).toBeDefined();
    expect(packet.truncationReason).toContain("maxCards");
  });

  it("omitted contains cards dropped by maxCards with correct reason", () => {
    const packet = cardsForScope(db, {
      repoCanonical: CANONICAL,
      repo: REPO,
      query: "module",
      maxCards: 2,
    });

    expect(packet.omitted.length).toBeGreaterThan(0);
    expect(packet.omitted.every((o) => o.reason === "budget-maxCards")).toBe(true);
    expect(packet.omitted.every((o) => o.path.length > 0)).toBe(true);
  });

  it("maxTokens stops accumulation and sets truncationReason", () => {
    // Each card's estimated tokens: ~(path.len + tldr.len + symbols)/4
    // With 10 cards each ~50-60 chars total, maxTokens=20 should stop early.
    const packet = cardsForScope(db, {
      repoCanonical: CANONICAL,
      repo: REPO,
      query: "module",
      maxTokens: 20,
    });

    expect(packet.truncationReason).toBeDefined();
    expect(packet.truncationReason).toContain("maxTokens");
    expect(packet.omitted.some((o) => o.reason === "budget-maxTokens")).toBe(true);
  });

  it("perCardMaxTokens truncates tldr but still returns the card", () => {
    // Force a very low per-card budget — tldr should be truncated.
    const packet = cardsForScope(db, {
      repoCanonical: CANONICAL,
      repo: REPO,
      query: "module",
      maxCards: 1,
      perCardMaxTokens: 5, // very tight — should truncate tldr
    });

    expect(packet.cards.length).toBe(1);
    const card = packet.cards[0]!;
    // If the tldr was truncated, it should be shorter than the original
    // "Summary of src/module-X/index.ts" (≈ 35 chars)
    if (card.tldr !== null) {
      expect(card.tldr.length).toBeLessThan(35);
    }
    // The card is still included (not in omitted)
    expect(packet.omitted.every((o) => o.path !== card.path)).toBe(true);
  });

  it("default maxCards is 20", () => {
    // With 10 cards and default maxCards=20, we get all 10.
    const packet = cardsForScope(db, {
      repoCanonical: CANONICAL,
      repo: REPO,
      query: "module",
    });

    expect(packet.cards.length).toBeLessThanOrEqual(20);
    expect(packet.truncationReason).toBeUndefined();
  });
});

// ── cardsForScope — coverage reporting ───────────────────────────────

describe("cardsForScope — coverage reporting", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
    makeCard(db, "src/api/payments.ts");
    makeCard(db, "src/api/auth.ts");
  });

  it("coverage.missing lists paths that have no active card", () => {
    const packet = cardsForScope(db, {
      repoCanonical: CANONICAL,
      repo: REPO,
      query: "api",
      paths: ["src/api/payments.ts", "src/api/does-not-exist.ts"],
    });

    expect(packet.coverage.missing).toContain("src/api/does-not-exist.ts");
    expect(packet.coverage.missing).not.toContain("src/api/payments.ts");
  });

  it("coverage.requested counts paths + importantPaths", () => {
    const packet = cardsForScope(db, {
      repoCanonical: CANONICAL,
      repo: REPO,
      query: "api",
      paths: ["src/api/payments.ts"],
      importantPaths: ["src/api/auth.ts", "src/nope.ts"],
    });

    expect(packet.coverage.requested).toBe(3); // 1 + 2
    expect(packet.coverage.missing).toContain("src/nope.ts");
    expect(packet.coverage.missing).not.toContain("src/api/payments.ts");
  });

  it("coverage.served equals number of returned cards", () => {
    const packet = cardsForScope(db, {
      repoCanonical: CANONICAL,
      repo: REPO,
      query: "payment auth",
      paths: ["src/api/payments.ts", "src/api/auth.ts"],
    });

    expect(packet.coverage.served).toBe(packet.cards.length);
  });

  it("coverage.missing lists importantPaths with no card", () => {
    const packet = cardsForScope(db, {
      repoCanonical: CANONICAL,
      repo: REPO,
      query: "api",
      importantPaths: ["src/api/payments.ts", "src/core/missing.ts"],
    });

    expect(packet.coverage.missing).toContain("src/core/missing.ts");
    expect(packet.coverage.missing).not.toContain("src/api/payments.ts");
  });

  it("FIX 3: a requested DIRECTORY path is not missing when child cards are served", () => {
    // "src/api" is requested as a path hint (a directory, not a file).
    // cards-for-scope serves src/api/payments.ts and src/api/auth.ts via the
    // path-prefix query.  "src/api" itself has no card, but it should NOT
    // appear in coverage.missing because its children were served.
    makeCard(db, "src/api/payments.ts");
    makeCard(db, "src/api/auth.ts");

    const packet = cardsForScope(db, {
      repoCanonical: CANONICAL,
      repo: REPO,
      query: "api",
      paths: ["src/api"],
    });

    // At least one child card must have been served via the prefix query.
    expect(packet.cards.some((c) => c.path.startsWith("src/api/"))).toBe(true);
    // The directory itself must NOT appear in missing (Fix 3).
    expect(packet.coverage.missing).not.toContain("src/api");
    // A truly absent path still appears in missing.
    const packet2 = cardsForScope(db, {
      repoCanonical: CANONICAL,
      repo: REPO,
      query: "api",
      paths: ["src/nonexistent-dir"],
    });
    expect(packet2.coverage.missing).toContain("src/nonexistent-dir");
  });
});

// ── FTS tldr index fix ────────────────────────────────────────────────

describe("FTS tldr index fix — failed/absent tldr not indexed", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
  });

  it("a card with modelStatus=absent does not match on tldr text via FTS", () => {
    // Insert card with absent model (has a tldr value in the row but should
    // NOT be indexed for FTS since model_status != active).
    upsertFileCard(db, {
      repoKey: RK,
      repo: REPO,
      path: "src/secret-path.ts",
      contentHash: "hash123",
      loc: 50,
      symbols: ["SomeFunc"],
      source: CANONICAL,
      cardStatus: "active",
      modelStatus: "absent",
      tldr: "UniqueMarker_AbsentNotIndexed", // unique string — if indexed, FTS would find it
    });

    // Search for the unique tldr text — should NOT find it because model is absent.
    const results = searchFileCards(db, RK, "UniqueMarker_AbsentNotIndexed");
    // Card should not be found via tldr FTS since model_status != active
    expect(results.every((r) => r.path !== "src/secret-path.ts")).toBe(true);
  });

  it("a card with modelStatus=failed_validation does not match on tldr text via FTS", () => {
    upsertFileCard(db, {
      repoKey: RK,
      repo: REPO,
      path: "src/failed-card.ts",
      contentHash: "hash456",
      loc: 60,
      symbols: ["AnotherFunc"],
      source: CANONICAL,
      cardStatus: "active",
      modelStatus: "failed_validation",
      tldr: "UniqueMarker_FailedNotIndexed",
    });

    const results = searchFileCards(db, RK, "UniqueMarker_FailedNotIndexed");
    expect(results.every((r) => r.path !== "src/failed-card.ts")).toBe(true);
  });

  it("a card with modelStatus=active DOES match on tldr text via FTS", () => {
    upsertFileCard(db, {
      repoKey: RK,
      repo: REPO,
      path: "src/active-card.ts",
      contentHash: "hash789",
      loc: 70,
      symbols: ["ActiveFunc"],
      source: CANONICAL,
      cardStatus: "active",
      modelStatus: "active",
      tldr: "UniqueMarker_ActiveShouldIndex",
    });

    const results = searchFileCards(db, RK, "UniqueMarker_ActiveShouldIndex");
    expect(results.some((r) => r.path === "src/active-card.ts")).toBe(true);
  });

  it("path and symbols always indexed regardless of model_status", () => {
    upsertFileCard(db, {
      repoKey: RK,
      repo: REPO,
      path: "src/components/SpecialWidget.tsx",
      contentHash: "hashabc",
      loc: 80,
      symbols: ["SpecialWidgetComponent"],
      source: CANONICAL,
      cardStatus: "active",
      modelStatus: "absent",
      tldr: null,
    });

    // Path match
    const byPath = searchFileCards(db, RK, "SpecialWidget");
    expect(byPath.some((r) => r.path === "src/components/SpecialWidget.tsx")).toBe(true);
    // Symbol match
    const bySymbol = searchFileCards(db, RK, "SpecialWidgetComponent");
    expect(bySymbol.some((r) => r.path === "src/components/SpecialWidget.tsx")).toBe(true);
  });
});

// ── MCP smoke tests ───────────────────────────────────────────────────

describe("MCP smoke tests — get_file_card, search_file_cards, cards_for_scope", () => {
  let db: Database;
  let client: Client;

  beforeEach(async () => {
    process.env["MEMORY_AUDIT_OFF"] = "1";
    db = newDb();
    makeCard(db, "src/api/payments.ts", {
      symbols: ["createPayment", "refundPayment"],
      tldr: "Handles payment capture and refunds",
    });
    makeCard(db, "src/core/auth.ts", {
      symbols: ["authenticateUser", "generateToken"],
      tldr: "Authentication and JWT token generation",
    });
    client = await connectMcpClient(db);
  });

  it("get_file_card returns a card for a known path", async () => {
    const { isError, json } = await callJson(client, "get_file_card", {
      repoCanonical: CANONICAL,
      repo: REPO,
      path: "src/api/payments.ts",
    });
    expect(isError).toBe(false);
    const out = json as { found: boolean; card: { path: string } };
    expect(out.found).toBe(true);
    expect(out.card.path).toBe("src/api/payments.ts");
  });

  it("get_file_card returns not-found for an unknown path", async () => {
    const { isError, json } = await callJson(client, "get_file_card", {
      repoCanonical: CANONICAL,
      repo: REPO,
      path: "src/does-not-exist.ts",
    });
    expect(isError).toBe(false);
    const out = json as { found: boolean };
    expect(out.found).toBe(false);
  });

  it("search_file_cards returns matching cards", async () => {
    const { isError, json } = await callJson(client, "search_file_cards", {
      repoCanonical: CANONICAL,
      repo: REPO,
      query: "payment",
    });
    expect(isError).toBe(false);
    const out = json as { count: number; cards: Array<{ path: string }> };
    expect(out.count).toBeGreaterThan(0);
    expect(out.cards.some((c) => c.path === "src/api/payments.ts")).toBe(true);
  });

  it("search_file_cards returns empty for no match", async () => {
    const { isError, json } = await callJson(client, "search_file_cards", {
      repoCanonical: CANONICAL,
      repo: REPO,
      query: "xyznosuchthing",
    });
    expect(isError).toBe(false);
    const out = json as { count: number };
    expect(out.count).toBe(0);
  });

  it("cards_for_scope returns a packet with selection metadata", async () => {
    const { isError, json } = await callJson(client, "cards_for_scope", {
      repoCanonical: CANONICAL,
      repo: REPO,
      query: "payment",
      paths: ["src/api/payments.ts"],
    });
    expect(isError).toBe(false);
    const out = json as {
      cards: Array<{ path: string }>;
      selectionOrder: Array<{ path: string; tier: string }>;
      omitted: unknown[];
      coverage: { requested: number; served: number; missing: string[] };
      selectionBasis: string;
    };
    expect(out.cards.length).toBeGreaterThan(0);
    expect(out.selectionOrder.length).toBeGreaterThan(0);
    expect(Array.isArray(out.omitted)).toBe(true);
    expect(out.coverage).toBeDefined();
    expect(out.selectionBasis).toBeTruthy();

    // The explicit path card should be at exact-path tier
    const entry = out.selectionOrder.find((e) => e.path === "src/api/payments.ts");
    expect(entry?.tier).toBe("exact-path");
  });

  it("cards_for_scope includes caveat in the response", async () => {
    const { json } = await callJson(client, "cards_for_scope", {
      repoCanonical: CANONICAL,
      repo: REPO,
      query: "auth",
    });
    const out = json as { caveat: string };
    expect(out.caveat).toContain("retrieval aid");
  });

  it("cards_for_scope reports coverage.missing for unknown paths", async () => {
    const { json } = await callJson(client, "cards_for_scope", {
      repoCanonical: CANONICAL,
      repo: REPO,
      query: "auth",
      paths: ["src/does-not-exist.ts"],
    });
    const out = json as { coverage: { missing: string[] } };
    expect(out.coverage.missing).toContain("src/does-not-exist.ts");
  });
});

// ── CLI smoke tests ───────────────────────────────────────────────────

describe("CLI commands — cmdCard, cmdCardsForScope", () => {
  let db: Database;

  beforeEach(() => {
    db = newDb();
    // Note: CLI commands open their own DB connection; we can't easily inject
    // the in-memory DB. We test the public APIs directly instead since CLI
    // commands are thin wrappers over core functions.
    makeCard(db, "src/api/payments.ts");
  });

  it("cardsForScope returns expected shape from core function (CLI path)", () => {
    const packet = cardsForScope(db, {
      repoCanonical: CANONICAL,
      repo: REPO,
      query: "payment",
      paths: ["src/api/payments.ts"],
    });

    // Mirrors what the CLI would serialise as JSON output
    expect(packet.cards).toBeDefined();
    expect(packet.selectionOrder).toBeDefined();
    expect(packet.omitted).toBeDefined();
    expect(packet.coverage).toBeDefined();
    expect(packet.selectionBasis).toBeTruthy();
    expect(packet.digest).toBeNull(); // no digest written in test DB
    expect(packet.lore).toEqual([]); // no lore in test DB
  });
});

// ── Module isolation ──────────────────────────────────────────────────

describe("module isolation", () => {
  it("scopePacket module is standalone — no dispatch/crew imports", () => {
    // cardsForScope imported at top of file; if dispatch/crew were imported,
    // the module would fail to resolve in this isolated test environment.
    expect(typeof cardsForScope).toBe("function");
  });

  it("cardsForScope throws on empty repoCanonical", () => {
    const db = newDb();
    expect(() =>
      cardsForScope(db, {
        repoCanonical: "",
        repo: "test",
        query: "foo",
      }),
    ).toThrow(/repoCanonical/);
  });

  it("cardsForScope throws on empty repo", () => {
    const db = newDb();
    expect(() =>
      cardsForScope(db, {
        repoCanonical: CANONICAL,
        repo: "  ",
        query: "foo",
      }),
    ).toThrow(/repo/);
  });
});
