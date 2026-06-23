/**
 * Boundaries — the cross-repo interaction map. Pins:
 *   - migration 004 adds the table
 *   - normaliseContract joins camelCase / kebab / snake / spaced spellings
 *   - declare (add=active / suggest=draft), the draft trust gate, upsert
 *     on the (repo, contract, role) key
 *   - findDependents splits providers vs consumers (the impact query)
 *   - approve / reject / deprecate lifecycle
 *   - export/import round-trip converges two repos' edges on one row
 */
import BetterSqlite3 from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  addBoundary,
  approveBoundary,
  deprecateBoundary,
  exportBoundaries,
  findDependents,
  importBoundary,
  listBoundaries,
  listBoundaryDrafts,
  listContracts,
  normaliseContract,
  rejectBoundary,
  suggestBoundary,
} from "../src/core/boundaries.js";
import { runMigrations } from "../src/db/migrations.js";
import type { Database } from "better-sqlite3";

function newDb(): Database {
  const db = new BetterSqlite3(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

describe("normaliseContract", () => {
  it("converges camelCase, PascalCase, kebab, snake, and spaced spellings", () => {
    const want = "order-submitted";
    expect(normaliseContract("OrderSubmitted")).toBe(want);
    expect(normaliseContract("orderSubmitted")).toBe(want);
    expect(normaliseContract("order-submitted")).toBe(want);
    expect(normaliseContract("order_submitted")).toBe(want);
    expect(normaliseContract("  Order Submitted  ")).toBe(want);
  });

  it("handles acronym runs (HTTPServer → http-server)", () => {
    expect(normaliseContract("HTTPServer")).toBe("http-server");
  });

  it("preserves path-like and dotted contract names", () => {
    expect(normaliseContract("POST /v1/orders")).toBe("post-/v1/orders");
    expect(normaliseContract("orders.submitted")).toBe("orders.submitted");
  });
});

describe("declareBoundary (add / suggest) + trust gate", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
  });

  it("addBoundary lands active and visible; suggestBoundary lands draft and hidden", () => {
    const active = addBoundary(db, {
      repo: "orders-svc",
      contract: "OrderSubmitted",
      role: "provides",
    });
    expect(active.status).toBe("active");
    expect(active.contract).toBe("order-submitted");

    const draft = suggestBoundary(db, {
      repo: "reporting-svc",
      contract: "order-submitted",
      role: "consumes",
    });
    expect(draft.status).toBe("draft");

    // Default map shows only the active edge.
    const visible = listBoundaries(db);
    expect(visible.map((b) => b.id)).toEqual([active.id]);
    // Draft surfaces only with includeDrafts.
    expect(
      listBoundaries(db, { includeDrafts: true })
        .map((b) => b.id)
        .sort(),
    ).toEqual([active.id, draft.id].sort());
  });

  it("re-declaring the same (repo, contract, role) upserts in place, not duplicates", () => {
    const a = addBoundary(db, {
      repo: "orders-svc",
      contract: "order-submitted",
      role: "provides",
      detail: "v1",
    });
    const b = addBoundary(db, {
      repo: "orders-svc",
      contract: "OrderSubmitted", // different spelling, same normalised key
      role: "provides",
      detail: "v2",
    });
    expect(b.id).toBe(a.id);
    expect(b.detail).toBe("v2");
    expect(listBoundaries(db)).toHaveLength(1);
  });

  it("a human re-declaring an agent's draft edge promotes it to active", () => {
    const draft = suggestBoundary(db, {
      repo: "svc",
      contract: "c",
      role: "consumes",
    });
    expect(draft.status).toBe("draft");
    const promoted = addBoundary(db, {
      repo: "svc",
      contract: "c",
      role: "consumes",
    });
    expect(promoted.id).toBe(draft.id);
    expect(promoted.status).toBe("active");
  });

  it("an agent re-declaring an active edge never demotes it", () => {
    const active = addBoundary(db, { repo: "svc", contract: "c", role: "provides" });
    const again = suggestBoundary(db, { repo: "svc", contract: "c", role: "provides" });
    expect(again.id).toBe(active.id);
    expect(again.status).toBe("active");
  });

  it("an agent re-declaring an active edge CANNOT mutate its content (trust gate)", () => {
    // Security regression: a draft re-declare of a human-ratified edge
    // must be a no-op, not an in-place overwrite of detail/source/kind.
    const active = addBoundary(db, {
      repo: "svc",
      contract: "c",
      role: "provides",
      kind: "event",
      detail: "human-approved detail",
      source: "https://example.com/legit",
    });
    const attempt = suggestBoundary(db, {
      repo: "svc",
      contract: "c",
      role: "provides",
      kind: "rpc",
      detail: "agent-injected detail",
      source: "https://attacker.example/evil",
    });
    expect(attempt.id).toBe(active.id);
    expect(attempt.status).toBe("active");
    // Every field is the human's original — none of the agent's values landed.
    expect(attempt.detail).toBe("human-approved detail");
    expect(attempt.source).toBe("https://example.com/legit");
    expect(attempt.kind).toBe("event");
    // And the stored row matches (no silent UPDATE happened).
    const stored = listBoundaries(db)[0]!;
    expect(stored.source).toBe("https://example.com/legit");
  });

  it("an agent re-declaring a deprecated edge cannot resurrect or mutate it", () => {
    const e = addBoundary(db, { repo: "svc", contract: "c", role: "consumes", detail: "orig" });
    deprecateBoundary(db, e.id);
    const attempt = suggestBoundary(db, {
      repo: "svc",
      contract: "c",
      role: "consumes",
      detail: "agent change",
    });
    expect(attempt.status).toBe("deprecated");
    expect(attempt.detail).toBe("orig");
  });

  it("an agent CAN still refresh its own still-draft edge", () => {
    const draft = suggestBoundary(db, {
      repo: "svc",
      contract: "c",
      role: "provides",
      detail: "first",
    });
    const updated = suggestBoundary(db, {
      repo: "svc",
      contract: "c",
      role: "provides",
      detail: "sharpened",
    });
    expect(updated.id).toBe(draft.id);
    expect(updated.status).toBe("draft");
    expect(updated.detail).toBe("sharpened");
  });

  it("a human (addBoundary) CAN update an active edge's content and promote a draft", () => {
    const draft = suggestBoundary(db, {
      repo: "svc",
      contract: "c",
      role: "provides",
      detail: "draft detail",
    });
    const promoted = addBoundary(db, {
      repo: "svc",
      contract: "c",
      role: "provides",
      detail: "human detail",
    });
    expect(promoted.id).toBe(draft.id);
    expect(promoted.status).toBe("active");
    expect(promoted.detail).toBe("human detail");
  });

  it("rejects an unknown role and empty repo/contract", () => {
    expect(() => addBoundary(db, { repo: "svc", contract: "c", role: "uses" as never })).toThrow(
      /role/,
    );
    expect(() => addBoundary(db, { repo: "", contract: "c", role: "provides" })).toThrow(/repo/);
    expect(() => addBoundary(db, { repo: "svc", contract: "  ", role: "provides" })).toThrow(
      /contract/,
    );
  });
});

describe("findDependents (the impact query)", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
    addBoundary(db, { repo: "orders-svc", contract: "OrderSubmitted", role: "provides" });
    addBoundary(db, { repo: "reporting-svc", contract: "order-submitted", role: "consumes" });
    addBoundary(db, { repo: "billing-svc", contract: "order_submitted", role: "consumes" });
  });

  it("splits providers from consumers regardless of contract spelling", () => {
    const r = findDependents(db, "Order Submitted");
    expect(r.contract).toBe("order-submitted");
    expect(r.providers.map((b) => b.repo)).toEqual(["orders-svc"]);
    expect(r.consumers.map((b) => b.repo).sort()).toEqual(["billing-svc", "reporting-svc"]);
  });

  it("excludes draft edges by default; includes with includeDrafts", () => {
    suggestBoundary(db, { repo: "analytics-svc", contract: "order-submitted", role: "consumes" });
    expect(findDependents(db, "order-submitted").consumers).toHaveLength(2);
    expect(findDependents(db, "order-submitted", { includeDrafts: true }).consumers).toHaveLength(
      3,
    );
  });

  it("returns empty arrays for an unknown contract", () => {
    const r = findDependents(db, "never-declared");
    expect(r.providers).toEqual([]);
    expect(r.consumers).toEqual([]);
  });

  it("listContracts returns distinct normalised names", () => {
    expect(listContracts(db)).toEqual(["order-submitted"]);
  });
});

describe("boundary lifecycle (approve / reject / deprecate)", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
  });

  it("approve promotes a draft; reject drops a draft; both refuse non-drafts", () => {
    const draft = suggestBoundary(db, { repo: "svc", contract: "c", role: "provides" });
    expect(listBoundaryDrafts(db)).toHaveLength(1);
    const approved = approveBoundary(db, draft.id);
    expect(approved?.status).toBe("active");
    // Re-approving an active edge is a no-op (null).
    expect(approveBoundary(db, draft.id)).toBeNull();
    // Reject refuses an active edge.
    expect(rejectBoundary(db, draft.id)).toBe(false);

    const draft2 = suggestBoundary(db, { repo: "svc2", contract: "c2", role: "consumes" });
    expect(rejectBoundary(db, draft2.id)).toBe(true);
    expect(listBoundaries(db, { includeDrafts: true }).map((b) => b.id)).toEqual([draft.id]);
  });

  it("deprecate retires an edge — hidden from default, visible with flag", () => {
    const edge = addBoundary(db, { repo: "svc", contract: "c", role: "provides" });
    expect(deprecateBoundary(db, edge.id)?.status).toBe("deprecated");
    expect(listBoundaries(db)).toHaveLength(0);
    expect(listBoundaries(db, { includeDeprecated: true }).map((b) => b.id)).toEqual([edge.id]);
  });
});

describe("export / import round-trip (cross-repo convergence)", () => {
  it("two repos' edges for one contract converge on a single local row, keyed by (repo, contract, role)", () => {
    const orders = newDb();
    addBoundary(orders, {
      repo: "orders-svc",
      contract: "OrderSubmitted",
      role: "provides",
      detail: "v2",
    });

    const reporting = newDb();
    addBoundary(reporting, {
      repo: "reporting-svc",
      contract: "order-submitted",
      role: "consumes",
    });

    const central = newDb();
    for (const rec of exportBoundaries(orders)) importBoundary(central, rec);
    for (const rec of exportBoundaries(reporting)) importBoundary(central, rec);

    const r = findDependents(central, "order-submitted");
    expect(r.providers.map((b) => b.repo)).toEqual(["orders-svc"]);
    expect(r.consumers.map((b) => b.repo)).toEqual(["reporting-svc"]);
    // Re-importing the same edge updates in place — no duplicate row.
    for (const rec of exportBoundaries(orders)) importBoundary(central, rec);
    expect(listBoundaries(central)).toHaveLength(2);
  });

  it("importBoundary is safe (keeps a strictly-newer local edge unless force)", () => {
    const central = newDb();
    const local = addBoundary(central, {
      repo: "svc",
      contract: "c",
      role: "provides",
      detail: "local-newer",
    });
    // Incoming record with an older updatedAt.
    const stale = {
      id: local.id,
      repo: "svc",
      contract: "c",
      role: "provides" as const,
      status: "active" as const,
      detail: "incoming-older",
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
    };
    expect(importBoundary(central, stale)).toBe("skipped");
    expect(findDependents(central, "c").providers[0]!.detail).toBe("local-newer");
    // force overrides.
    expect(importBoundary(central, stale, { force: true })).toBe("updated");
    expect(findDependents(central, "c").providers[0]!.detail).toBe("incoming-older");
  });

  it("importBoundary skips malformed records", () => {
    const db = newDb();
    expect(
      importBoundary(db, {
        id: "",
        repo: "",
        contract: "c",
        role: "provides",
        status: "active",
        createdAt: "",
        updatedAt: "",
      }),
    ).toBe("skipped");
  });

  it("mints a fresh id when the incoming id is malformed or collides", () => {
    const central = newDb();
    // Pre-existing edge with id "aaaa2222".
    const seed = addBoundary(central, { repo: "x", contract: "seed", role: "provides" });
    // Incoming record with a malformed id → should still import (new id).
    expect(
      importBoundary(central, {
        id: "NOT-A-VALID-ID",
        repo: "svc",
        contract: "c",
        role: "consumes",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe("created");
    const edge = findDependents(central, "c").consumers[0]!;
    expect(edge.id).toMatch(/^[a-z2-9]{8}$/);
    expect(edge.id).not.toBe(seed.id);
  });
});

describe("boundary events + edge cases", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
  });

  it("emits boundary lifecycle events into the shared events table", () => {
    const draft = suggestBoundary(db, { repo: "svc", contract: "c", role: "provides" });
    approveBoundary(db, draft.id);
    const active = addBoundary(db, { repo: "svc2", contract: "c2", role: "consumes" });
    deprecateBoundary(db, active.id);
    const kinds = (
      db
        .prepare("SELECT kind FROM events WHERE lore_id IN (?, ?) ORDER BY rowid")
        .all(draft.id, active.id) as Array<{ kind: string }>
    ).map((r) => r.kind);
    expect(kinds).toContain("boundary_suggested");
    expect(kinds).toContain("boundary_approved");
    expect(kinds).toContain("boundary_declared");
    expect(kinds).toContain("boundary_deprecated");
  });

  it("normalises the repo (trim) but keeps it case-sensitive", () => {
    const e = addBoundary(db, { repo: "  Orders-SVC  ", contract: "c", role: "provides" });
    expect(e.repo).toBe("Orders-SVC");
  });

  it("treats provides and consumes from the same repo as distinct edges", () => {
    addBoundary(db, { repo: "gateway", contract: "events", role: "provides" });
    addBoundary(db, { repo: "gateway", contract: "events", role: "consumes" });
    const r = findDependents(db, "events");
    expect(r.providers).toHaveLength(1);
    expect(r.consumers).toHaveLength(1);
  });

  it("listContracts excludes draft-only contracts unless includeDrafts", () => {
    addBoundary(db, { repo: "a", contract: "active-one", role: "provides" });
    suggestBoundary(db, { repo: "b", contract: "draft-only", role: "consumes" });
    expect(listContracts(db)).toEqual(["active-one"]);
    expect(listContracts(db, { includeDrafts: true }).sort()).toEqual(["active-one", "draft-only"]);
  });

  it("listBoundaries filters by repo and role", () => {
    addBoundary(db, { repo: "a", contract: "c1", role: "provides" });
    addBoundary(db, { repo: "a", contract: "c2", role: "consumes" });
    addBoundary(db, { repo: "b", contract: "c3", role: "provides" });
    expect(listBoundaries(db, { repo: "a" })).toHaveLength(2);
    expect(listBoundaries(db, { role: "provides" })).toHaveLength(2);
    expect(listBoundaries(db, { repo: "a", role: "consumes" })).toHaveLength(1);
  });

  it("approveBoundary / deprecateBoundary / rejectBoundary return null/false on unknown id", () => {
    expect(approveBoundary(db, "zzzzzzzz")).toBeNull();
    expect(deprecateBoundary(db, "zzzzzzzz")).toBeNull();
    expect(rejectBoundary(db, "zzzzzzzz")).toBe(false);
  });
});
