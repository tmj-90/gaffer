/**
 * Repo Understanding — the digest + feature ledger spine (migration 005).
 * Pins:
 *   - migration 005 creates repo_digest + feature (with scope_node column)
 *   - digest upsert: one-per-repo, supersede-in-place, audit trail kept
 *   - getDigest round-trips; null on unknown repo
 *   - addFeature: defaults backlog, accepts optional scope_node, onboard
 *     can land shipped directly
 *   - repo-level AND node-level features (with / without scope_node)
 *   - advanceFeature: legal forward transitions; illegal rejected (no mutation)
 *   - listFeatures filtered by status and by scope_node (incl. null = repo-level)
 */
import BetterSqlite3 from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  addFeature,
  advanceFeature,
  AdvanceFeatureError,
  getDigest,
  getFeature,
  isLegalFeatureTransition,
  listFeatures,
  upsertDigest,
} from "../src/core/repoUnderstanding.js";
import { runMigrations } from "../src/db/migrations.js";

function newDb(): Database {
  const db = new BetterSqlite3(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function digestInput(over: Partial<Parameters<typeof upsertDigest>[1]> = {}) {
  return {
    repo: "payments-svc",
    overview: "Handles payment capture and refunds.",
    structure: "src/api — HTTP; src/core — domain; src/db — sqlite.",
    conventions: "TS strict; zod at boundaries; never log PANs.",
    stack: "TypeScript, Fastify, SQLite",
    source: "onboard",
    ...over,
  };
}

describe("migration 005 — repo_digest + feature schema", () => {
  it("creates repo_digest and feature tables", () => {
    const db = newDb();
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(tables).toContain("repo_digest");
    expect(tables).toContain("feature");
  });

  it("feature carries a nullable scope_node column", () => {
    const db = newDb();
    const cols = db.prepare("PRAGMA table_info(feature)").all() as Array<{
      name: string;
      notnull: 0 | 1;
    }>;
    const scopeNode = cols.find((c) => c.name === "scope_node");
    expect(scopeNode).toBeDefined();
    expect(scopeNode!.notnull).toBe(0);
  });
});

describe("upsertDigest / getDigest", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
  });

  it("writes a digest and getDigest round-trips it", () => {
    const written = upsertDigest(db, digestInput());
    expect(written.repo).toBe("payments-svc");
    expect(written.overview).toContain("payment capture");
    expect(written.source).toBe("onboard");
    expect(written.updatedAt).toBeTruthy();

    const read = getDigest(db, "payments-svc");
    expect(read).toEqual(written);
  });

  it("returns null for a repo with no digest", () => {
    expect(getDigest(db, "nope")).toBeNull();
  });

  it("keeps exactly one digest per repo (supersede in place)", () => {
    upsertDigest(db, digestInput());
    upsertDigest(db, digestInput({ overview: "Rewritten overview.", source: "merge:#42" }));
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM repo_digest WHERE repo = ?").get("payments-svc") as {
        n: number;
      }
    ).n;
    expect(count).toBe(1);
    const read = getDigest(db, "payments-svc");
    expect(read!.overview).toBe("Rewritten overview.");
    expect(read!.source).toBe("merge:#42");
  });

  it("keeps an audit trail — one digest_updated event per write", () => {
    upsertDigest(db, digestInput());
    upsertDigest(db, digestInput({ source: "merge:#7" }));
    upsertDigest(db, digestInput({ source: "manual" }));
    const events = db
      .prepare(
        "SELECT payload FROM events WHERE lore_id = ? AND kind = 'digest_updated' ORDER BY rowid",
      )
      .all("payments-svc") as Array<{ payload: string }>;
    expect(events).toHaveLength(3);
    const first = JSON.parse(events[0]!.payload);
    expect(first.source).toBe("onboard");
    expect(first.superseded).toBe(false);
    const second = JSON.parse(events[1]!.payload);
    expect(second.superseded).toBe(true);
  });

  it("trims the repo key and rejects empty repo / source", () => {
    const d = upsertDigest(db, digestInput({ repo: "  spaced  " }));
    expect(d.repo).toBe("spaced");
    expect(getDigest(db, "spaced")).not.toBeNull();
    expect(() => upsertDigest(db, digestInput({ repo: "   " }))).toThrow(/repo must be non-empty/);
    expect(() => upsertDigest(db, digestInput({ source: "  " }))).toThrow(
      /source must be non-empty/,
    );
  });

  it("advances updated_at on a re-write", async () => {
    const first = upsertDigest(db, digestInput());
    await new Promise((r) => setTimeout(r, 5));
    const second = upsertDigest(db, digestInput({ overview: "newer" }));
    expect(second.updatedAt >= first.updatedAt).toBe(true);
  });
});

describe("addFeature — repo-level and node-level", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
  });

  it("defaults to backlog and lands repo-level (no scope_node)", () => {
    const f = addFeature(db, {
      repo: "payments-svc",
      name: "Refund flow",
      summary: "Issue partial + full refunds.",
    });
    expect(f.status).toBe("backlog");
    expect(f.scopeNode).toBeUndefined();
    expect(getFeature(db, f.id)).toEqual(f);
  });

  it("accepts an optional scope_node (node-level feature)", () => {
    const f = addFeature(db, {
      repo: "payments-svc",
      scopeNode: "auth",
      name: "MFA challenge",
      summary: "Step-up auth on high-value refunds.",
    });
    expect(f.scopeNode).toBe("auth");
    expect(getFeature(db, f.id)!.scopeNode).toBe("auth");
  });

  it("treats a whitespace-only scope_node as repo-level", () => {
    const f = addFeature(db, {
      repo: "payments-svc",
      scopeNode: "   ",
      name: "X",
      summary: "y",
    });
    expect(f.scopeNode).toBeUndefined();
  });

  it("can inventory a feature straight as shipped (onboard)", () => {
    const f = addFeature(db, {
      repo: "payments-svc",
      name: "Capture",
      summary: "Already built.",
      status: "shipped",
      provenance: "onboard-inventory",
    });
    expect(f.status).toBe("shipped");
    expect(f.provenance).toBe("onboard-inventory");
  });

  it("records a feature_added event with the initial status + node", () => {
    const f = addFeature(db, {
      repo: "payments-svc",
      scopeNode: "auth",
      name: "X",
      summary: "y",
      status: "building",
    });
    const ev = db
      .prepare("SELECT payload FROM events WHERE lore_id = ? AND kind = 'feature_added'")
      .get(f.id) as { payload: string };
    const payload = JSON.parse(ev.payload);
    expect(payload.status).toBe("building");
    expect(payload.scopeNode).toBe("auth");
  });

  it("rejects empty repo / name", () => {
    expect(() => addFeature(db, { repo: "  ", name: "X", summary: "y" })).toThrow(
      /repo must be non-empty/,
    );
    expect(() => addFeature(db, { repo: "r", name: "  ", summary: "y" })).toThrow(
      /name must be non-empty/,
    );
  });
});

describe("advanceFeature — lifecycle transitions", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
  });

  it("allows backlog → building → shipped", () => {
    const f = addFeature(db, { repo: "r", name: "X", summary: "y" });
    const building = advanceFeature(db, f.id, "building");
    expect(building.status).toBe("building");
    const shipped = advanceFeature(db, f.id, "shipped");
    expect(shipped.status).toBe("shipped");
  });

  it("allows the direct backlog → shipped jump", () => {
    const f = addFeature(db, { repo: "r", name: "X", summary: "y" });
    const shipped = advanceFeature(db, f.id, "shipped");
    expect(shipped.status).toBe("shipped");
  });

  it("rejects shipped → backlog and leaves the row unchanged", () => {
    const f = addFeature(db, {
      repo: "r",
      name: "X",
      summary: "y",
      status: "shipped",
    });
    expect(() => advanceFeature(db, f.id, "backlog")).toThrowError(AdvanceFeatureError);
    expect(getFeature(db, f.id)!.status).toBe("shipped");
  });

  it("rejects building → backlog and same-state advances", () => {
    const f = addFeature(db, {
      repo: "r",
      name: "X",
      summary: "y",
      status: "building",
    });
    expect(() => advanceFeature(db, f.id, "backlog")).toThrow(/not a legal transition/);
    expect(() => advanceFeature(db, f.id, "building")).toThrow(/not a legal transition/);
  });

  it("throws unknown_id for a missing feature", () => {
    try {
      advanceFeature(db, "missing00", "shipped");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AdvanceFeatureError);
      expect((err as AdvanceFeatureError).reason).toBe("unknown_id");
    }
  });

  it("carries reason='illegal_transition' on a backward move", () => {
    const f = addFeature(db, {
      repo: "r",
      name: "X",
      summary: "y",
      status: "shipped",
    });
    try {
      advanceFeature(db, f.id, "backlog");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as AdvanceFeatureError).reason).toBe("illegal_transition");
    }
  });

  it("records a feature_advanced event with from/to", () => {
    const f = addFeature(db, { repo: "r", name: "X", summary: "y" });
    advanceFeature(db, f.id, "building");
    const ev = db
      .prepare("SELECT payload FROM events WHERE lore_id = ? AND kind = 'feature_advanced'")
      .get(f.id) as { payload: string };
    const payload = JSON.parse(ev.payload);
    expect(payload.from).toBe("backlog");
    expect(payload.to).toBe("building");
  });

  it("isLegalFeatureTransition matches the enforced rules", () => {
    expect(isLegalFeatureTransition("backlog", "building")).toBe(true);
    expect(isLegalFeatureTransition("backlog", "shipped")).toBe(true);
    expect(isLegalFeatureTransition("building", "shipped")).toBe(true);
    expect(isLegalFeatureTransition("shipped", "backlog")).toBe(false);
    expect(isLegalFeatureTransition("building", "backlog")).toBe(false);
    expect(isLegalFeatureTransition("backlog", "backlog")).toBe(false);
  });
});

describe("listFeatures — repo / status / scope_node filters", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
    // Repo-level features
    addFeature(db, { repo: "app", name: "Repo backlog", summary: "s" });
    addFeature(db, {
      repo: "app",
      name: "Repo shipped",
      summary: "s",
      status: "shipped",
    });
    // Node-level features on 'auth'
    addFeature(db, {
      repo: "app",
      scopeNode: "auth",
      name: "Auth backlog",
      summary: "s",
    });
    addFeature(db, {
      repo: "app",
      scopeNode: "auth",
      name: "Auth shipped",
      summary: "s",
      status: "shipped",
    });
    // Node-level on a different node
    addFeature(db, {
      repo: "app",
      scopeNode: "billing",
      name: "Billing building",
      summary: "s",
      status: "building",
    });
    // A different repo — must never leak in
    addFeature(db, { repo: "other", name: "Other", summary: "s" });
  });

  it("scopes to the repo and excludes other repos", () => {
    const all = listFeatures(db, "app");
    expect(all).toHaveLength(5);
    expect(all.every((f) => f.repo === "app")).toBe(true);
  });

  it("filters by status", () => {
    const shipped = listFeatures(db, "app", { status: "shipped" });
    expect(shipped.map((f) => f.name).sort()).toEqual(["Auth shipped", "Repo shipped"]);
    const backlog = listFeatures(db, "app", { status: "backlog" });
    expect(backlog.map((f) => f.name).sort()).toEqual(["Auth backlog", "Repo backlog"]);
  });

  it("filters to a single scope-node", () => {
    const auth = listFeatures(db, "app", { scopeNode: "auth" });
    expect(auth.map((f) => f.name).sort()).toEqual(["Auth backlog", "Auth shipped"]);
    expect(auth.every((f) => f.scopeNode === "auth")).toBe(true);
  });

  it("scopeNode: null lists only repo-level features", () => {
    const repoLevel = listFeatures(db, "app", { scopeNode: null });
    expect(repoLevel.map((f) => f.name).sort()).toEqual(["Repo backlog", "Repo shipped"]);
    expect(repoLevel.every((f) => f.scopeNode === undefined)).toBe(true);
  });

  it("combines status + scope_node filters", () => {
    const authShipped = listFeatures(db, "app", {
      scopeNode: "auth",
      status: "shipped",
    });
    expect(authShipped).toHaveLength(1);
    expect(authShipped[0]!.name).toBe("Auth shipped");
  });

  it("orders by lifecycle (backlog → building → shipped) then name", () => {
    const all = listFeatures(db, "app");
    const statuses = all.map((f) => f.status);
    const rank = { backlog: 0, building: 1, shipped: 2 } as const;
    for (let i = 1; i < statuses.length; i++) {
      expect(rank[statuses[i]!]).toBeGreaterThanOrEqual(rank[statuses[i - 1]!]);
    }
  });

  it("returns [] for a repo with no features", () => {
    expect(listFeatures(db, "empty-repo")).toEqual([]);
  });
});
