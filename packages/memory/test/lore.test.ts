import BetterSqlite3 from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  addLore,
  approveLore,
  deleteLore,
  deprecateLore,
  exportLore,
  findPossibleDuplicates,
  getLore,
  getRejectionReason,
  listDrafts,
  listRecent,
  listRepos,
  listTags,
  pruneReadEvents,
  rejectLore,
  searchLore,
  searchLoreCount,
  supersedeLore,
  suggestLore,
  trustRankAdjustment,
  updateLore,
  verifyLore,
} from "../src/core/lore.js";
import { getString, parseArgs } from "../src/cli/args.js";
import { runMigrations } from "../src/db/migrations.js";
import type { Database } from "better-sqlite3";

function newInMemoryDb(): Database {
  const db = new BetterSqlite3(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

describe("core/lore", () => {
  let db: Database;
  beforeEach(() => {
    db = newInMemoryDb();
  });

  describe("addLore (human entry)", () => {
    it("creates an active record with sorted/deduped tags + repos", () => {
      const lore = addLore(db, {
        title: "Drop bcrypt for Argon2id",
        summary: "Platform sec ruling, Q3 2025.",
        body: "Reasoning: 72-byte truncation bug. Argon2id m=64MB, t=3, p=4.",
        repos: ["payments-svc", "auth-svc", "payments-svc"],
        tags: ["Security", "Password Hashing", "security"],
        team: "Platform",
        author: "alice@example.com",
        source: "https://example.com/adrs/014",
        confidence: "high",
      });
      expect(lore.id).toMatch(/^[a-z2-9]{8}$/);
      expect(lore.status).toBe("active");
      expect(lore.repos).toEqual(["auth-svc", "payments-svc"]);
      expect(lore.tags).toEqual(["password-hashing", "security"]);
      expect(lore.confidence).toBe("high");
      expect(lore.source).toBe("https://example.com/adrs/014");
      expect(lore.restricted).toBe(false);
    });

    it("defaults confidence to 'medium' when caller omits it", () => {
      const lore = addLore(db, { title: "t", summary: "s", body: "b" });
      expect(lore.confidence).toBe("medium");
    });

    it("emits a 'created' event row", () => {
      const lore = addLore(db, { title: "t", summary: "s", body: "b" });
      const kinds = (
        db.prepare("SELECT kind FROM events WHERE lore_id = ?").all(lore.id) as Array<{
          kind: string;
        }>
      ).map((e) => e.kind);
      expect(kinds).toEqual(["created"]);
    });
  });

  describe("suggestLore (agent entry)", () => {
    it("creates a draft record regardless of caller-provided status", () => {
      const lore = suggestLore(db, {
        title: "payments-svc rejects naive dates",
        summary: "Discovered while investigating INC-411.",
        body: "All dates at the API boundary must include tz offset.",
      });
      expect(lore.status).toBe("draft");
    });

    it("lands active immediately when the operator opts into auto-approve", () => {
      // Default (governed) stays draft…
      const draft = suggestLore(db, { title: "governed", summary: "s", body: "b" });
      expect(draft.status).toBe("draft");
      // …but an operator-enabled auto-approve (autonomous factory) lands active.
      const live = suggestLore(
        db,
        { title: "autonomous", summary: "s", body: "b" },
        { autoApprove: true },
      );
      expect(live.status).toBe("active");
    });

    it("emits a 'suggested' event so audit shows agent vs human source", () => {
      const lore = suggestLore(db, { title: "t", summary: "s", body: "b" });
      const kinds = (
        db.prepare("SELECT kind FROM events WHERE lore_id = ?").all(lore.id) as Array<{
          kind: string;
        }>
      ).map((e) => e.kind);
      expect(kinds).toEqual(["suggested"]);
    });

    it("is invisible to default search until approved", () => {
      const lore = suggestLore(db, {
        title: "X about Y",
        summary: "s",
        body: "b",
      });
      expect(searchLore(db, { query: "Y" })).toEqual([]);
      const approved = approveLore(db, lore.id);
      expect(approved?.status).toBe("active");
      const hits = searchLore(db, { query: "Y" });
      expect(hits.map((h) => h.id)).toContain(lore.id);
    });

    it("listDrafts surfaces drafts for the human reviewer", () => {
      suggestLore(db, { title: "a", summary: "s", body: "b" });
      suggestLore(db, { title: "b", summary: "s", body: "b" });
      addLore(db, { title: "c (active)", summary: "s", body: "b" });
      const drafts = listDrafts(db);
      expect(drafts.map((d) => d.title).sort()).toEqual(["a", "b"]);
    });
  });

  describe("confidence invariants", () => {
    it("agent suggestions cannot claim high confidence; clamps to medium", () => {
      const lore = suggestLore(db, {
        title: "t",
        summary: "s",
        body: "b",
        confidence: "high",
        source: "https://example.com/x",
      });
      // Even WITH a source, drafts max out at medium.
      expect(lore.confidence).toBe("medium");
    });

    it("a high-confidence claim without a source is clamped to medium", () => {
      const lore = addLore(db, {
        title: "t",
        summary: "s",
        body: "b",
        confidence: "high",
      });
      expect(lore.confidence).toBe("medium");
    });

    it("a human-added record with a source can stamp high", () => {
      const lore = addLore(db, {
        title: "t",
        summary: "s",
        body: "b",
        confidence: "high",
        source: "https://example.com/adrs/14",
      });
      expect(lore.confidence).toBe("high");
    });
  });

  describe("rejectLore (interactive triage)", () => {
    it("deletes the row, cascades repos+tags, removes FTS, emits 'rejected'", () => {
      const draft = suggestLore(db, {
        title: "speculation about widgets",
        summary: "s",
        body: "b",
        repos: ["x"],
        tags: ["y"],
      });
      expect(rejectLore(db, draft.id)).toBe(true);
      expect(getLore(db, draft.id)).toBeNull();
      expect(db.prepare("SELECT * FROM lore_repos WHERE lore_id = ?").all(draft.id)).toEqual([]);
      expect(db.prepare("SELECT * FROM lore_tags WHERE lore_id = ?").all(draft.id)).toEqual([]);
      expect(searchLore(db, { query: "widgets" })).toEqual([]);
      // Event is 'rejected', not 'deleted' — distinguishes triage from manual delete.
      const kinds = (
        db
          .prepare("SELECT kind FROM events WHERE lore_id = ? ORDER BY rowid")
          .all(draft.id) as Array<{ kind: string }>
      ).map((e) => e.kind);
      expect(kinds).toEqual(["suggested", "rejected"]);
    });

    it("refuses to reject an active record (use deprecateLore instead)", () => {
      const active = addLore(db, { title: "real rule", summary: "s", body: "b" });
      expect(rejectLore(db, active.id)).toBe(false);
      // Untouched.
      expect(getLore(db, active.id)?.status).toBe("active");
    });

    it("refuses to reject deprecated / superseded records", () => {
      const a = addLore(db, { title: "old", summary: "s", body: "b" });
      const b = addLore(db, { title: "new", summary: "s", body: "b" });
      deprecateLore(db, a.id);
      expect(rejectLore(db, a.id)).toBe(false);
      supersedeLore(db, a.id, b.id);
      expect(rejectLore(db, a.id)).toBe(false);
    });

    it("returns false for unknown id", () => {
      expect(rejectLore(db, "ghost123")).toBe(false);
    });
  });

  describe("rejectLore reason capture", () => {
    function lastRejectPayload(db: Database, id: string): string | null {
      const row = db
        .prepare(
          "SELECT payload FROM events WHERE lore_id = ? AND kind = 'rejected' ORDER BY rowid DESC LIMIT 1",
        )
        .get(id) as { payload: string | null } | undefined;
      return row?.payload ?? null;
    }
    function newDraft(): string {
      return suggestLore(db, { title: "t", summary: "s", body: "b" }).id;
    }

    it("rejectLore stores reason in event payload as JSON envelope", () => {
      const id = newDraft();
      expect(rejectLore(db, id, "because foo")).toBe(true);
      expect(lastRejectPayload(db, id)).toBe(JSON.stringify({ reason: "because foo" }));
    });

    it("rejectLore without reason leaves payload null", () => {
      const id = newDraft();
      expect(rejectLore(db, id)).toBe(true);
      expect(lastRejectPayload(db, id)).toBeNull();
    });

    it("rejectLore with empty reason writes null payload", () => {
      const id = newDraft();
      expect(rejectLore(db, id, "")).toBe(true);
      expect(lastRejectPayload(db, id)).toBeNull();
    });

    it("rejectLore with whitespace-only reason writes null payload", () => {
      const id = newDraft();
      expect(rejectLore(db, id, "   \t  \n  ")).toBe(true);
      expect(lastRejectPayload(db, id)).toBeNull();
    });

    it("rejectLore trims surrounding whitespace in reason", () => {
      const id = newDraft();
      expect(rejectLore(db, id, "  hi  ")).toBe(true);
      expect(lastRejectPayload(db, id)).toBe(JSON.stringify({ reason: "hi" }));
    });

    it("rejectLore json-escapes special characters in reason", () => {
      const id = newDraft();
      const tricky = `she said "no"\nand: \\path`;
      expect(rejectLore(db, id, tricky)).toBe(true);
      const payload = lastRejectPayload(db, id)!;
      // Round-trips cleanly via JSON.parse — no manual quote handling.
      expect(JSON.parse(payload)).toEqual({ reason: tricky });
    });
  });

  describe("getRejectionReason", () => {
    it("returns captured reason", () => {
      const id = suggestLore(db, { title: "t", summary: "s", body: "b" }).id;
      rejectLore(db, id, "wrong scope");
      expect(getRejectionReason(db, id)).toBe("wrong scope");
    });

    it("returns undefined when no reason captured", () => {
      const id = suggestLore(db, { title: "t", summary: "s", body: "b" }).id;
      rejectLore(db, id);
      expect(getRejectionReason(db, id)).toBeUndefined();
    });

    it("returns undefined for never-rejected id", () => {
      expect(getRejectionReason(db, "ghost123")).toBeUndefined();
    });

    it("returns undefined on malformed payload json", () => {
      const id = suggestLore(db, { title: "t", summary: "s", body: "b" }).id;
      rejectLore(db, id);
      // Simulate a corrupt write — replace payload with non-JSON garbage.
      db.prepare(
        "UPDATE events SET payload = '<not json>' WHERE lore_id = ? AND kind = 'rejected'",
      ).run(id);
      expect(getRejectionReason(db, id)).toBeUndefined();
    });

    it("returns undefined when payload is valid JSON but lacks a string reason", () => {
      const id = suggestLore(db, { title: "t", summary: "s", body: "b" }).id;
      rejectLore(db, id);
      db.prepare(
        "UPDATE events SET payload = '{\"otherKey\":42}' WHERE lore_id = ? AND kind = 'rejected'",
      ).run(id);
      expect(getRejectionReason(db, id)).toBeUndefined();
    });
  });

  /**
   * cmdReject is private to src/cli/index.ts; rather than spawn the
   * built binary (which would force a build per test run) we exercise
   * the same args→getString→rejectLore composition the CLI uses. AC-14
   * (bare `--reason` flag) is a contract about that composition, not
   * the rejectLore core function, so it lives here.
   */
  describe("cmdReject plumbing (parseArgs + getString + rejectLore)", () => {
    function rejectViaCliArgs(id: string, argv: string[]): boolean {
      const parsed = parseArgs(argv);
      const reason = getString(parsed.flags, "reason");
      return rejectLore(db, id, reason);
    }
    function lastRejectPayload(id: string): string | null {
      const row = db
        .prepare(
          "SELECT payload FROM events WHERE lore_id = ? AND kind = 'rejected' ORDER BY rowid DESC LIMIT 1",
        )
        .get(id) as { payload: string | null } | undefined;
      return row?.payload ?? null;
    }

    it("cmdReject plumbs --reason flag through to rejectLore", () => {
      const id = suggestLore(db, { title: "t", summary: "s", body: "b" }).id;
      expect(rejectViaCliArgs(id, ["--reason", "because X"])).toBe(true);
      expect(lastRejectPayload(id)).toBe(JSON.stringify({ reason: "because X" }));
    });

    it("cmdReject without --reason preserves null payload", () => {
      const id = suggestLore(db, { title: "t", summary: "s", body: "b" }).id;
      expect(rejectViaCliArgs(id, [])).toBe(true);
      expect(lastRejectPayload(id)).toBeNull();
    });

    it("cmdReject treats bare --reason flag as no reason", () => {
      // `--reason` with no following value (or followed by another flag)
      // becomes flags.reason = true; getString collapses that to undefined
      // so the user gets "no reason" rather than the literal string "true".
      const id = suggestLore(db, { title: "t", summary: "s", body: "b" }).id;
      expect(rejectViaCliArgs(id, ["--reason"])).toBe(true);
      expect(lastRejectPayload(id)).toBeNull();
    });
  });

  describe("approveLore", () => {
    it("returns null on unknown id", () => {
      expect(approveLore(db, "ghost")).toBeNull();
    });
    it("returns null when target isn't a draft (already active)", () => {
      const lore = addLore(db, { title: "t", summary: "s", body: "b" });
      expect(approveLore(db, lore.id)).toBeNull();
    });
  });

  describe("searchLore — public-API input validation", () => {
    it("default limit is 10 when omitted", () => {
      for (let i = 0; i < 15; i++) {
        addLore(db, { title: `record ${i}`, summary: "s", body: "b" });
      }
      const hits = searchLore(db, {});
      expect(hits.length).toBeLessThanOrEqual(10);
    });

    it("accepts integer limit in [1, 50]", () => {
      addLore(db, { title: "one", summary: "s", body: "b" });
      expect(searchLore(db, { limit: 1 })).toHaveLength(1);
      expect(searchLore(db, { limit: 50 })).toHaveLength(1);
    });

    it("rejects non-integer / out-of-range / NaN limit with a typed error", () => {
      const bad = [0, -1, 1.5, 51, 100, Number.NaN, Infinity, -Infinity];
      for (const v of bad) {
        expect(() => searchLore(db, { limit: v })).toThrow(/limit must be/);
      }
    });

    it("rejects invalid updatedAfter (catches embedder errors at the boundary)", () => {
      expect(() => searchLore(db, { updatedAfter: "yesterday" })).toThrow(
        /updatedAfter.*not a valid ISO/,
      );
      // Valid ISO shapes still pass.
      expect(() => searchLore(db, { updatedAfter: "2026-01-01T00:00:00.000Z" })).not.toThrow();
      expect(() => searchLore(db, { updatedAfter: "2026-01-01" })).not.toThrow();
    });
  });

  describe("searchLore — token-saving contract", () => {
    beforeEach(() => {
      addLore(db, {
        title: "Argon2id is the password hash default",
        summary: "Platform security ruling. Bcrypt out.",
        body: "Use m=64MB, t=3, p=4.",
        repos: ["payments-svc"],
        tags: ["security", "passwords"],
        source: "https://example.com/adrs/014",
        confidence: "high",
      });
      addLore(db, {
        title: "Database migrations style guide",
        summary: "Always idempotent, always reversible.",
        body: "We use Liquibase format, change-sets numbered.",
        repos: ["payments-svc", "billing-svc"],
        tags: ["db", "conventions"],
      });
      addLore(db, {
        title: "Restricted: incident response key contacts",
        summary: "On-call only.",
        body: "Rotation lives in PagerDuty.",
        repos: ["secops"],
        tags: ["security"],
        restricted: true,
      });
    });

    it("returns the LoreSummary projection — body deliberately absent", () => {
      const [hit] = searchLore(db, { query: "Argon2id" });
      expect(hit).toBeTruthy();
      expect((hit as unknown as { body?: string }).body).toBeUndefined();
      expect(hit!.source).toBe("https://example.com/adrs/014");
      expect(hit!.confidence).toBe("high");
    });

    it("excludes drafts by default", () => {
      suggestLore(db, {
        title: "Argon2id v2",
        summary: "newer settings",
        body: "b",
      });
      const hits = searchLore(db, { query: "Argon2id" });
      expect(hits.every((h) => h.status === "active")).toBe(true);
    });

    it("excludes deprecated by default; includes when flagged", () => {
      const lore = addLore(db, {
        title: "Old migration policy",
        summary: "s",
        body: "b",
      });
      deprecateLore(db, lore.id);
      // OR-mode means other beforeEach records sharing tokens ("migration")
      // may surface — the contract being tested is that the deprecated
      // record's id is excluded, not that the result is empty.
      const hits = searchLore(db, { query: "Old migration policy" });
      expect(hits.map((h) => h.id)).not.toContain(lore.id);
      const incl = searchLore(db, {
        query: "Old migration policy",
        includeDeprecated: true,
      });
      expect(incl.map((h) => h.id)).toContain(lore.id);
      expect(incl.find((h) => h.id === lore.id)!.status).toBe("deprecated");
    });

    it("excludes superseded by default", () => {
      const a = addLore(db, { title: "Vermilion zeppelin original", summary: "s", body: "b" });
      const b = addLore(db, { title: "Vermilion zeppelin replacement", summary: "s", body: "b" });
      supersedeLore(db, a.id, b.id);
      const hits = searchLore(db, { query: "Vermilion zeppelin" });
      expect(hits.map((h) => h.id)).toEqual([b.id]);
    });

    it("includes superseded when explicitly opted in", () => {
      const a = addLore(db, { title: "Cerulean dirigible original", summary: "s", body: "b" });
      const b = addLore(db, { title: "Cerulean dirigible replacement", summary: "s", body: "b" });
      supersedeLore(db, a.id, b.id);
      const hits = searchLore(db, {
        query: "Cerulean dirigible",
        includeSuperseded: true,
      });
      const ids = hits.map((h) => h.id).sort();
      expect(ids).toEqual([a.id, b.id].sort());
      const old = hits.find((h) => h.id === a.id);
      expect(old?.status).toBe("superseded");
    });

    it("excludes restricted by default", () => {
      const hits = searchLore(db, { query: "incident" });
      expect(hits.every((h) => h.restricted === false)).toBe(true);
    });

    it("returns restricted when explicitly opted in", () => {
      const hits = searchLore(db, {
        query: "incident",
        includeRestricted: true,
      });
      expect(hits.some((h) => h.restricted)).toBe(true);
    });

    it("repo filter narrows to scope", () => {
      const billing = searchLore(db, {
        query: "migration",
        repo: "billing-svc",
      });
      expect(billing.length).toBe(1);
      expect(billing[0]!.repos).toContain("billing-svc");
    });

    it("limit > 50 throws (was: silent clamp; reviewer asked for fail-fast on the public API)", () => {
      for (let i = 0; i < 60; i++) {
        addLore(db, { title: `entry-${i}`, summary: "s", body: "b" });
      }
      expect(() => searchLore(db, { limit: 100 })).toThrow(/limit must be/);
    });
  });

  describe("searchLore — trust-aware ranking", () => {
    it("promotes a sourced/high-confidence record over a sourceless near-tie", () => {
      // Two records with the same matching token in the title so bm25 is
      // ~equal; trust signals should break the tie toward the trusted one.
      const trusted = addLore(db, {
        title: "Kafka retry policy",
        summary: "s",
        body: "b",
        source: "https://example.com/adr/1",
        confidence: "high",
      });
      const untrusted = addLore(db, {
        title: "Kafka retry policy",
        summary: "s",
        body: "b",
        confidence: "low",
      });
      const hits = searchLore(db, { query: "kafka retry policy" });
      const ids = hits.map((h) => h.id);
      expect(ids.indexOf(trusted.id)).toBeLessThan(ids.indexOf(untrusted.id));
      expect(ids).toContain(untrusted.id); // demoted, not dropped
    });

    it("demotes a stale record below a fresh near-tie", () => {
      const fresh = addLore(db, {
        title: "Webhook backoff convention",
        summary: "s",
        body: "b",
      });
      const stale = addLore(db, {
        title: "Webhook backoff convention",
        summary: "s",
        body: "b",
        reviewAfter: "2000-01-01T00:00:00.000Z", // long past → stale
      });
      const hits = searchLore(db, { query: "webhook backoff convention" });
      const ids = hits.map((h) => h.id);
      expect(ids.indexOf(fresh.id)).toBeLessThan(ids.indexOf(stale.id));
      expect(hits.find((h) => h.id === stale.id)!.stale).toBe(true);
    });

    it("ranks the most-trusted record first when several share the query token", () => {
      // Same matching token, ascending trust: sourceless-low, sourceless-medium,
      // sourced-high. The sourced-high record should lead.
      addLore(db, { title: "cache invalidation low", summary: "s", body: "b", confidence: "low" });
      addLore(db, { title: "cache invalidation medium", summary: "s", body: "b" });
      const best = addLore(db, {
        title: "cache invalidation high",
        summary: "s",
        body: "b",
        source: "https://example.com/c",
        confidence: "high",
      });
      const hits = searchLore(db, { query: "cache invalidation" });
      expect(hits[0]!.id).toBe(best.id);
    });

    it("a non-FTS (no query) listing is NOT trust-reranked — pure recency", () => {
      // Without a query, order is updated_at desc regardless of trust.
      const older = addLore(db, {
        title: "older high",
        summary: "s",
        body: "b",
        source: "https://example.com/o",
        confidence: "high",
      });
      // Backdate the high-trust record so recency is unambiguous (same-ms
      // inserts would otherwise tie and the order would be arbitrary).
      db.prepare("UPDATE lore SET updated_at = ? WHERE id = ?").run(
        "2000-01-01T00:00:00.000Z",
        older.id,
      );
      const newer = addLore(db, { title: "newer low", summary: "s", body: "b", confidence: "low" });
      const hits = searchLore(db, { includeRestricted: true });
      // newer first despite being lower trust (no query → recency only),
      // and the backdated high-trust record sorts last.
      expect(hits[0]!.id).toBe(newer.id);
      expect(hits[hits.length - 1]!.id).toBe(older.id);
    });

    it("does not override a clearly stronger lexical match", () => {
      // The exact-title match (strong bm25) should still win even though
      // it's low-trust, because the trust delta is small relative to a
      // big relevance gap.
      const exact = addLore(db, {
        title: "Idempotency keys on payment intents",
        summary: "s",
        body: "b",
        confidence: "low",
      });
      addLore(db, {
        title: "Idempotency overview",
        summary: "s",
        body: "b",
        source: "https://example.com/adr/2",
        confidence: "high",
      });
      const [first] = searchLore(db, {
        query: "idempotency keys on payment intents",
      });
      expect(first!.id).toBe(exact.id);
    });
  });

  describe("trustRankAdjustment (pure)", () => {
    const base = {
      source: "https://example.com/1",
      confidence: "medium" as const,
      review_after: null,
    };
    it("is 0 for a sourced, medium-confidence, fresh record", () => {
      expect(trustRankAdjustment(base)).toBe(0);
    });
    it("is positive for high confidence (promote)", () => {
      expect(trustRankAdjustment({ ...base, confidence: "high" })).toBeGreaterThan(0);
    });
    it("is negative for low confidence and for no source (demote)", () => {
      expect(trustRankAdjustment({ ...base, confidence: "low" })).toBeLessThan(0);
      expect(trustRankAdjustment({ ...base, source: null })).toBeLessThan(0);
    });
    it("treats a lapsed review_after as stale (demote)", () => {
      expect(
        trustRankAdjustment({ ...base, review_after: "2000-01-01T00:00:00.000Z" }),
      ).toBeLessThan(0);
    });
    it("clamps the combined swing to ±0.5 so it can't flip a clear relevance gap", () => {
      const worst = trustRankAdjustment({
        source: null,
        confidence: "low",
        review_after: "2000-01-01T00:00:00.000Z",
      });
      expect(worst).toBeGreaterThanOrEqual(-0.5);
    });
  });

  describe("searchLoreCount", () => {
    it("counts all matches ignoring limit; matches searchLore filters", () => {
      for (let i = 0; i < 12; i++) {
        addLore(db, { title: `widget tracker ${i}`, summary: "s", body: "b" });
      }
      const hits = searchLore(db, { query: "widget tracker", limit: 5 });
      expect(hits.length).toBe(5);
      expect(searchLoreCount(db, { query: "widget tracker", limit: 5 })).toBe(12);
    });

    it("respects status + restricted filters like searchLore", () => {
      addLore(db, { title: "alpha gizmo", summary: "s", body: "b" });
      addLore(db, {
        title: "alpha gizmo restricted",
        summary: "s",
        body: "b",
        restricted: true,
      });
      suggestLore(db, { title: "alpha gizmo draft", summary: "s", body: "b" });
      expect(searchLoreCount(db, { query: "alpha gizmo" })).toBe(1);
      expect(searchLoreCount(db, { query: "alpha gizmo", includeRestricted: true })).toBe(2);
      expect(searchLoreCount(db, { query: "alpha gizmo", includeDrafts: true })).toBe(2);
    });

    it("does not record read events (a count is not a read)", () => {
      addLore(db, { title: "countable record", summary: "s", body: "b" });
      searchLoreCount(db, { query: "countable" });
      const reads = (
        db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'read'").get() as { n: number }
      ).n;
      expect(reads).toBe(0);
    });
  });

  describe("pruneReadEvents", () => {
    function countEvents(kind?: string): number {
      const sql = kind
        ? "SELECT COUNT(*) AS n FROM events WHERE kind = ?"
        : "SELECT COUNT(*) AS n FROM events";
      const row = (kind ? db.prepare(sql).get(kind) : db.prepare(sql).get()) as { n: number };
      return row.n;
    }

    it("deletes only old 'read' events; keeps fresh reads and all lifecycle events", () => {
      const lore = addLore(db, { title: "tracked", summary: "s", body: "b" });
      const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
      const recent = new Date(Date.now() - 1 * 86_400_000).toISOString();
      const ins = db.prepare("INSERT INTO events (lore_id, kind, ts) VALUES (?, ?, ?)");
      ins.run(lore.id, "read", old);
      ins.run(lore.id, "read", old);
      ins.run(lore.id, "read", recent);
      // A lifecycle event with an OLD ts must survive — only 'read' is pruned.
      ins.run(lore.id, "approved", old);

      const deleted = pruneReadEvents(db, 90);
      expect(deleted).toBe(2);
      expect(countEvents("read")).toBe(1); // the recent read stays
      expect(countEvents("approved")).toBe(1); // lifecycle untouched
      // 'created' from addLore also survives.
      expect(countEvents("created")).toBe(1);
    });

    it("returns 0 when nothing is old enough", () => {
      const lore = addLore(db, { title: "x", summary: "s", body: "b" });
      db.prepare("INSERT INTO events (lore_id, kind, ts) VALUES (?, 'read', ?)").run(
        lore.id,
        new Date().toISOString(),
      );
      expect(pruneReadEvents(db, 90)).toBe(0);
    });
  });

  describe("staleness", () => {
    it("flags results whose review_after is in the past", () => {
      addLore(db, {
        title: "Old rule still hanging around",
        summary: "s",
        body: "b",
        reviewAfter: "2020-01-01",
      });
      const [hit] = searchLore(db, { query: "Old rule" });
      expect(hit!.stale).toBe(true);
    });
    it("does not flag fresh records (review_after in the future)", () => {
      addLore(db, {
        title: "Fresh rule",
        summary: "s",
        body: "b",
        reviewAfter: "2099-12-31",
      });
      const [hit] = searchLore(db, { query: "Fresh" });
      expect(hit!.stale).toBe(false);
    });
    it("does not flag when no review_after is set", () => {
      addLore(db, { title: "No expiry", summary: "s", body: "b" });
      const [hit] = searchLore(db, { query: "expiry" });
      expect(hit!.stale).toBe(false);
    });
  });

  describe("supersedeLore", () => {
    it("links the old record forward", () => {
      const a = addLore(db, { title: "Old", summary: "s", body: "b" });
      const b = addLore(db, { title: "New", summary: "s", body: "b" });
      const updated = supersedeLore(db, a.id, b.id);
      expect(updated?.status).toBe("superseded");
      expect(updated?.supersededBy).toBe(b.id);
    });
    it("rejects same-id supersede", () => {
      const a = addLore(db, { title: "X", summary: "s", body: "b" });
      expect(supersedeLore(db, a.id, a.id)).toBeNull();
    });
    it("rejects supersede with a non-existent replacement id", () => {
      const a = addLore(db, { title: "X", summary: "s", body: "b" });
      expect(supersedeLore(db, a.id, "nope1234")).toBeNull();
      // Original record should be untouched (still active).
      expect(getLore(db, a.id)?.status).toBe("active");
    });
    it("rejects supersede when replacement is already deprecated / superseded", () => {
      const a = addLore(db, { title: "A", summary: "s", body: "b" });
      const b = addLore(db, { title: "B", summary: "s", body: "b" });
      deprecateLore(db, b.id);
      expect(supersedeLore(db, a.id, b.id)).toBeNull();
      expect(getLore(db, a.id)?.status).toBe("active");
    });
    it("emits a 'superseded' event with the target id in payload", () => {
      const a = addLore(db, { title: "Old", summary: "s", body: "b" });
      const b = addLore(db, { title: "New", summary: "s", body: "b" });
      supersedeLore(db, a.id, b.id);
      const ev = db
        .prepare("SELECT kind, payload FROM events WHERE lore_id = ? AND kind = 'superseded'")
        .get(a.id) as { kind: string; payload: string };
      expect(ev.kind).toBe("superseded");
      expect(JSON.parse(ev.payload)).toEqual({ supersededBy: b.id });
    });
  });

  describe("verifyLore + deleteLore", () => {
    it("verifyLore bumps last_verified_at + emits event", () => {
      const lore = addLore(db, { title: "t", summary: "s", body: "b" });
      const verified = verifyLore(db, lore.id);
      expect(verified?.lastVerifiedAt).toBeDefined();
      const kinds = (
        db
          .prepare("SELECT kind FROM events WHERE lore_id = ? ORDER BY rowid")
          .all(lore.id) as Array<{ kind: string }>
      ).map((e) => e.kind);
      expect(kinds).toContain("verified");
    });

    it("verifyLore clears staleness by pushing review_after forward when lapsed", () => {
      const lore = addLore(db, {
        title: "old rule",
        summary: "s",
        body: "b",
        reviewAfter: "2020-01-01",
      });
      const before = searchLore(db, { query: "old rule" })[0];
      expect(before?.stale).toBe(true);
      const verified = verifyLore(db, lore.id);
      // Default forward push gives us a future date.
      expect(verified?.reviewAfter).toBeDefined();
      expect(Date.parse(verified!.reviewAfter!)).toBeGreaterThan(Date.now());
      const after = searchLore(db, { query: "old rule" })[0];
      expect(after?.stale).toBe(false);
    });

    it("verifyLore accepts an explicit nextReviewAfter override", () => {
      const lore = addLore(db, { title: "x", summary: "s", body: "b" });
      const verified = verifyLore(db, lore.id, "2099-12-31");
      expect(verified?.reviewAfter).toBe("2099-12-31");
    });

    it("verifyLore rejects an invalid nextReviewAfter", () => {
      const lore = addLore(db, { title: "x", summary: "s", body: "b" });
      expect(() => verifyLore(db, lore.id, "garbage")).toThrow(/nextReviewAfter/);
    });

    it("deleteLore cascades repos + tags + removes from FTS", () => {
      const lore = addLore(db, {
        title: "t",
        summary: "s",
        body: "b",
        repos: ["x"],
        tags: ["y"],
      });
      expect(deleteLore(db, lore.id)).toBe(true);
      expect(getLore(db, lore.id)).toBeNull();
      expect(db.prepare("SELECT * FROM lore_repos WHERE lore_id = ?").all(lore.id)).toEqual([]);
      expect(db.prepare("SELECT * FROM lore_tags WHERE lore_id = ?").all(lore.id)).toEqual([]);
      expect(searchLore(db, { query: lore.title })).toEqual([]);
    });
  });

  describe("updateLore", () => {
    it("partial-updates only the fields provided", () => {
      const a = addLore(db, {
        title: "Original",
        summary: "old summary",
        body: "old body",
        repos: ["one"],
        tags: ["old-tag"],
      });
      const updated = updateLore(db, a.id, {
        summary: "new summary",
        tags: ["new-tag", "another"],
      });
      expect(updated?.title).toBe("Original");
      expect(updated?.summary).toBe("new summary");
      expect(updated?.body).toBe("old body");
      // Tags replaced (not merged).
      expect(updated?.tags).toEqual(["another", "new-tag"]);
      // Repos untouched.
      expect(updated?.repos).toEqual(["one"]);
    });

    it("reindexes FTS when title/summary/body changes", () => {
      const a = addLore(db, {
        title: "Aardvark policy",
        summary: "s",
        body: "b",
      });
      expect(searchLore(db, { query: "Aardvark" })).toHaveLength(1);
      updateLore(db, a.id, { title: "Buffalo policy" });
      expect(searchLore(db, { query: "Aardvark" })).toEqual([]);
      expect(searchLore(db, { query: "Buffalo" })).toHaveLength(1);
    });

    it("emits an 'updated' event", () => {
      const a = addLore(db, { title: "t", summary: "s", body: "b" });
      updateLore(db, a.id, { summary: "new" });
      const kinds = (
        db.prepare("SELECT kind FROM events WHERE lore_id = ? ORDER BY rowid").all(a.id) as Array<{
          kind: string;
        }>
      ).map((e) => e.kind);
      expect(kinds).toContain("updated");
    });

    it("re-clamps confidence on update (sourceless → high downgraded)", () => {
      const a = addLore(db, {
        title: "t",
        summary: "s",
        body: "b",
        source: "https://x.example",
        confidence: "high",
      });
      expect(a.confidence).toBe("high");
      // Remove the source — confidence should fall.
      const updated = updateLore(db, a.id, { source: "" });
      expect(updated?.confidence).toBe("medium");
    });

    it("returns null for unknown id", () => {
      expect(updateLore(db, "ghost", { title: "x" })).toBeNull();
    });
  });

  describe("source URL validation", () => {
    it("addLore rejects a non-URL source", () => {
      expect(() =>
        addLore(db, {
          title: "t",
          summary: "s",
          body: "b",
          source: "ADR-014",
        }),
      ).toThrow(/source/);
    });
    it("addLore rejects a non-http URL", () => {
      expect(() =>
        addLore(db, {
          title: "t",
          summary: "s",
          body: "b",
          source: "javascript:alert(1)",
        }),
      ).toThrow(/source/);
    });
    it("addLore accepts an https URL", () => {
      const lore = addLore(db, {
        title: "t",
        summary: "s",
        body: "b",
        source: "https://example.com/adrs/14",
      });
      expect(lore.source).toBe("https://example.com/adrs/14");
    });
    it("updateLore can clear the source by passing empty string", () => {
      const a = addLore(db, {
        title: "t",
        summary: "s",
        body: "b",
        source: "https://example.com/x",
        confidence: "high",
      });
      const updated = updateLore(db, a.id, { source: "" });
      expect(updated?.source).toBeUndefined();
      // And confidence drops because no source.
      expect(updated?.confidence).toBe("medium");
    });
  });

  describe("FTS — technical identifiers (coding-domain tokens)", () => {
    /**
     * Coding lore is full of hyphenated service names, version-numbered
     * algorithms, camelCase API symbols, and weird identifier casing.
     * The FTS5 tokenizer (porter + unicode61) is generally good but
     * these specific shapes are worth exercising once.
     */
    beforeEach(() => {
      addLore(db, {
        title: "payments-svc rejects naive dates",
        summary: "All inbound API dates must include timezone offsets.",
        body: "We discovered this in INC-411; payments-svc validation rejects.",
        repos: ["payments-svc"],
        tags: ["dates", "api"],
      });
      addLore(db, {
        title: "Argon2id is the password hash default",
        summary: "Platform sec ruling. m=64MB, t=3, p=4.",
        body: "Use Argon2id; legacy bcrypt records migrate on next login.",
        tags: ["security"],
      });
    });

    it("finds the hyphenated service name 'payments-svc'", () => {
      const hits = searchLore(db, { query: "payments-svc" });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.repos).toContain("payments-svc");
    });

    it("finds 'Argon2id' regardless of case", () => {
      const upper = searchLore(db, { query: "Argon2id" });
      const lower = searchLore(db, { query: "argon2id" });
      expect(upper.length).toBeGreaterThan(0);
      expect(lower.length).toBeGreaterThan(0);
      expect(upper[0]!.id).toBe(lower[0]!.id);
    });

    it("finds 'bcrypt' even though the title talks about Argon2id", () => {
      const hits = searchLore(db, { query: "bcrypt" });
      expect(hits.length).toBeGreaterThan(0);
    });

    it("repo filter accepts the canonical repo name", () => {
      const hits = searchLore(db, { query: "dates", repo: "payments-svc" });
      expect(hits.length).toBe(1);
    });
  });

  describe("reviewAfter date validation", () => {
    it("addLore rejects an invalid ISO date for reviewAfter", () => {
      expect(() =>
        addLore(db, {
          title: "t",
          summary: "s",
          body: "b",
          reviewAfter: "not-a-date",
        }),
      ).toThrow(/reviewAfter/);
    });
    it("updateLore rejects an invalid ISO date for reviewAfter", () => {
      const a = addLore(db, { title: "t", summary: "s", body: "b" });
      expect(() => updateLore(db, a.id, { reviewAfter: "garbage" })).toThrow(/reviewAfter/);
    });
  });

  describe("findPossibleDuplicates", () => {
    it("returns near-duplicates by title token overlap", () => {
      const existing = addLore(db, {
        title: "Dates must include timezone offsets",
        summary: "Existing rule.",
        body: "b",
        repos: ["payments-svc"],
        tags: ["dates"],
      });
      const fresh = suggestLore(db, {
        title: "API dates need timezone offset",
        summary: "Same idea, drafted again.",
        body: "b",
        repos: ["payments-svc"],
        tags: ["dates"],
      });
      const { duplicates, restrictedDuplicateCount } = findPossibleDuplicates(db, {
        id: fresh.id,
        title: "API dates need timezone offset",
        repos: ["payments-svc"],
        tags: ["dates"],
      });
      expect(duplicates.map((d) => d.id)).toContain(existing.id);
      expect(restrictedDuplicateCount).toBe(0);
    });

    it("populates a `reason` field summarising matched signals", () => {
      const existing = addLore(db, {
        title: "Vermilion zeppelin altitude policy",
        summary: "s",
        body: "b",
        repos: ["aviation-svc"],
        tags: ["safety"],
      });
      const fresh = suggestLore(db, {
        title: "Vermilion zeppelin altitude policy new",
        summary: "s",
        body: "b",
        repos: ["aviation-svc"],
        tags: ["safety"],
      });
      const { duplicates } = findPossibleDuplicates(db, {
        id: fresh.id,
        title: "Vermilion zeppelin altitude policy new",
        repos: ["aviation-svc"],
        tags: ["safety"],
      });
      const hit = duplicates.find((d) => d.id === existing.id);
      expect(hit?.reason).toContain("similar-title");
      expect(hit?.reason).toContain("shared-repo:aviation-svc");
      expect(hit?.reason).toContain("shared-tag:safety");
    });

    it("returns the empty result when title has fewer than two meaningful tokens", () => {
      addLore(db, {
        title: "Things",
        summary: "s",
        body: "b",
      });
      expect(findPossibleDuplicates(db, { id: "xxxxxxxx", title: "x" })).toEqual({
        duplicates: [],
        restrictedDuplicateCount: 0,
      });
    });

    it("excludes the given id (no self-match for the just-inserted record)", () => {
      const lore = suggestLore(db, {
        title: "Argon2id password hashing default",
        summary: "s",
        body: "b",
      });
      const { duplicates } = findPossibleDuplicates(db, {
        id: lore.id,
        title: "Argon2id password hashing default",
      });
      expect(duplicates.map((d) => d.id)).not.toContain(lore.id);
    });

    it("by default hides restricted titles but reports them in restrictedDuplicateCount", () => {
      addLore(db, {
        title: "Restricted runbook rotate platinum keys",
        summary: "s",
        body: "b",
        restricted: true,
      });
      const draft = suggestLore(db, {
        title: "Rotate platinum keys policy",
        summary: "s",
        body: "b",
      });
      const { duplicates, restrictedDuplicateCount } = findPossibleDuplicates(db, {
        id: draft.id,
        title: "Rotate platinum keys policy",
      });
      expect(duplicates.every((d) => d.restricted === false)).toBe(true);
      expect(restrictedDuplicateCount).toBe(1);
    });

    it("surfaces restricted titles when allowRestricted: true", () => {
      const restricted = addLore(db, {
        title: "Restricted runbook rotate gold keys",
        summary: "s",
        body: "b",
        restricted: true,
      });
      const draft = suggestLore(db, {
        title: "Rotate gold keys policy",
        summary: "s",
        body: "b",
      });
      const { duplicates, restrictedDuplicateCount } = findPossibleDuplicates(
        db,
        { id: draft.id, title: "Rotate gold keys policy" },
        { allowRestricted: true },
      );
      expect(duplicates.map((d) => d.id)).toContain(restricted.id);
      expect(restrictedDuplicateCount).toBe(1);
    });

    it("excludes deprecated and superseded records", () => {
      const a = addLore(db, {
        title: "Deprecated bcrypt password policy",
        summary: "s",
        body: "b",
      });
      const b = addLore(db, {
        title: "Old superseded bcrypt password rule",
        summary: "s",
        body: "b",
      });
      const c = addLore(db, {
        title: "Replacement bcrypt password rule",
        summary: "s",
        body: "b",
      });
      deprecateLore(db, a.id);
      supersedeLore(db, b.id, c.id);
      const draft = suggestLore(db, {
        title: "New bcrypt password idea",
        summary: "s",
        body: "b",
      });
      const { duplicates } = findPossibleDuplicates(db, {
        id: draft.id,
        title: "New bcrypt password idea",
      });
      const ids = duplicates.map((d) => d.id);
      expect(ids).not.toContain(a.id);
      expect(ids).not.toContain(b.id);
      // c (the active replacement) is fair game.
      expect(ids).toContain(c.id);
    });

    it("ranks shared-repo/tag overlap above pure-FTS matches", () => {
      // Two existing records with similar titles. One shares the draft's
      // repo, the other doesn't. Both should be candidates; the
      // repo-overlap one should come first.
      const sharesRepo = addLore(db, {
        title: "Cerulean kite altitude policy",
        summary: "s",
        body: "b",
        repos: ["aviation-svc"],
      });
      addLore(db, {
        title: "Cerulean kite altitude policy archive",
        summary: "s",
        body: "b",
        repos: ["other-svc"],
      });
      const draft = suggestLore(db, {
        title: "Cerulean kite altitude policy new",
        summary: "s",
        body: "b",
        repos: ["aviation-svc"],
      });
      const { duplicates } = findPossibleDuplicates(db, {
        id: draft.id,
        title: "Cerulean kite altitude policy new",
        repos: ["aviation-svc"],
      });
      expect(duplicates.length).toBeGreaterThanOrEqual(1);
      expect(duplicates[0]!.id).toBe(sharesRepo.id);
    });

    it("returns the empty result when no candidates match", () => {
      addLore(db, {
        title: "Completely unrelated subject matter here",
        summary: "s",
        body: "b",
      });
      expect(
        findPossibleDuplicates(db, {
          id: "xxxxxxxx",
          title: "Magenta dirigible policy",
        }),
      ).toEqual({ duplicates: [], restrictedDuplicateCount: 0 });
    });
  });

  describe("searchLore ranking — column weights + prefix + multi-tag", () => {
    /**
     * The column weights (title=3, summary=2, body=1) mean a hit in the
     * title outranks a hit in the body all else equal. Exercise with two
     * records that swap which column contains the query term.
     */
    it("ranks title hits above body hits for the same query", () => {
      const titleHit = addLore(db, {
        title: "Argon2id is the password hash default",
        summary: "Platform sec ruling.",
        body: "Use m=64MB.",
      });
      addLore(db, {
        title: "Migration style guide",
        summary: "Liquibase format.",
        body: "We migrated from bcrypt to argon2id last year.",
      });
      const hits = searchLore(db, { query: "argon2id" });
      expect(hits.length).toBeGreaterThanOrEqual(2);
      expect(hits[0]!.id).toBe(titleHit.id);
    });

    it("prefix mode matches tokens of 3+ chars as prefixes", () => {
      addLore(db, {
        title: "API dates must include timezone offsets",
        summary: "s",
        body: "b",
      });
      // Exact-match mode should not find 'timez' (no such token).
      expect(searchLore(db, { query: "timez" })).toHaveLength(0);
      // Prefix mode should.
      expect(searchLore(db, { query: "timez", prefix: true }).length).toBeGreaterThan(0);
    });

    it("multi-token queries use OR — records matching ANY token surface", () => {
      // Real dogfood: 5 queries returned 0 hits because FTS5 default
      // is AND and no single record contained EVERY token. Switching
      // to OR means partial matches surface; bm25 ranks them.
      const kafka = addLore(db, {
        title: "Kafka retention is 24 hours",
        summary: "s",
        body: "topics retain 24h or compacted",
      });
      const auth = addLore(db, {
        title: "JWT bearer tokens for entity-registry",
        summary: "s",
        body: "auth uses JWT and API keys",
      });
      // No record contains BOTH "deployment" and "kafka". With AND
      // semantics this would return 0. With OR, the kafka record
      // surfaces on the "kafka" token alone.
      const hits = searchLore(db, { query: "deployment kafka" });
      expect(hits.map((h) => h.id)).toContain(kafka.id);
      expect(hits.map((h) => h.id)).not.toContain(auth.id);
    });

    it("multi-token: records matching MORE tokens rank above records matching FEWER (bm25 effect)", () => {
      const both = addLore(db, {
        title: "Argon2id password hashing policy",
        summary: "argon2id is the platform default",
        body: "use m=64MB; bcrypt out.",
      });
      const onlyPassword = addLore(db, {
        title: "Password reset emails",
        summary: "transactional flow",
        body: "send via SES; tokens single-use.",
      });
      const onlyArgon = addLore(db, {
        title: "Argon2id parameter tuning",
        summary: "memory-hard config",
        body: "m=64MB, t=3, p=4 is the standard.",
      });
      const hits = searchLore(db, { query: "argon2id password" });
      // All three surface (OR mode); the record containing BOTH
      // tokens ranks first via bm25.
      expect(hits.length).toBeGreaterThanOrEqual(3);
      expect(hits[0]!.id).toBe(both.id);
      // The two single-match records both appear, order between
      // them depends on column weights but not asserted here.
      const ids = hits.map((h) => h.id);
      expect(ids).toContain(onlyPassword.id);
      expect(ids).toContain(onlyArgon.id);
    });

    it("prefix mode leaves <3-char tokens as exact-match (no slow 1-char prefix)", () => {
      addLore(db, {
        title: "AB convention example",
        summary: "s",
        body: "b",
      });
      // 'ab' is 2 chars — still exact, hits the record.
      const exact = searchLore(db, { query: "ab", prefix: true });
      expect(exact.length).toBeGreaterThan(0);
    });

    it("tag accepts a string array — ANY-of semantics", () => {
      const a = addLore(db, {
        title: "auth ruling",
        summary: "s",
        body: "b",
        tags: ["security"],
      });
      const b = addLore(db, {
        title: "db ruling",
        summary: "s",
        body: "b",
        tags: ["db"],
      });
      const c = addLore(db, {
        title: "frontend ruling",
        summary: "s",
        body: "b",
        tags: ["frontend"],
      });
      const hits = searchLore(db, { tag: ["security", "db"] });
      const ids = hits.map((h) => h.id);
      expect(ids).toContain(a.id);
      expect(ids).toContain(b.id);
      expect(ids).not.toContain(c.id);
    });

    it("single-tag string still works (back-compat)", () => {
      addLore(db, {
        title: "x",
        summary: "s",
        body: "b",
        tags: ["security"],
      });
      const hits = searchLore(db, { tag: "security" });
      expect(hits.length).toBe(1);
    });
  });

  describe("searchLore — batched repo/tag hydration (N+1 guard)", () => {
    it("hydrates 10 results' repos+tags in two queries, not 2*N", () => {
      // Seed 10 active records, each with a couple of repos + tags.
      for (let i = 0; i < 10; i++) {
        addLore(db, {
          title: `Topic ${i} hashing convention`,
          summary: "s",
          body: "B",
          repos: [`svc-${i % 3}`, "shared-svc"],
          tags: ["security", `topic-${i}`],
        });
      }
      // Wrap prepare/all to count SELECTs against the lore_repos /
      // lore_tags side tables. The N+1 regression would push this to
      // 2*10 = 20; the batched path should issue 1 per side table.
      let sideTableQueryCount = 0;
      const origPrepare = db.prepare.bind(db);
      type Stmt = ReturnType<typeof origPrepare>;
      (db as unknown as { prepare: (sql: string) => Stmt }).prepare = (sql: string): Stmt => {
        const stmt = origPrepare(sql);
        if (/FROM\s+lore_(repos|tags)\b/i.test(sql)) {
          const origAll = stmt.all.bind(stmt);
          stmt.all = ((...args: unknown[]) => {
            sideTableQueryCount++;
            return origAll(...args);
          }) as typeof stmt.all;
        }
        return stmt;
      };
      try {
        const hits = searchLore(db, { query: "hashing convention", limit: 10 });
        expect(hits).toHaveLength(10);
        for (const h of hits) {
          expect(h.repos.length).toBeGreaterThan(0);
          expect(h.tags.length).toBeGreaterThan(0);
        }
        // 2 batched queries total — one against lore_repos, one against
        // lore_tags. The previous N+1 path would have issued 20.
        expect(sideTableQueryCount).toBe(2);
      } finally {
        (db as unknown as { prepare: typeof origPrepare }).prepare = origPrepare;
      }
    });
  });

  describe("conflict surfacing in searchLore", () => {
    /**
     * Two active records sharing a repo and a tag are flagged in each
     * other's `possibleConflicts` array. The intent is to make a "two
     * authoritative-looking records disagree" situation visible to the
     * agent without an extra round trip.
     */
    it("flags two active records sharing repo + tag", () => {
      const a = addLore(db, {
        title: "Password hash policy A",
        summary: "Use Argon2id",
        body: "B",
        repos: ["auth-svc"],
        tags: ["security"],
      });
      const b = addLore(db, {
        title: "Password hash policy B",
        summary: "Use scrypt",
        body: "B",
        repos: ["auth-svc"],
        tags: ["security"],
      });
      const hits = searchLore(db, { query: "password hash policy" });
      const ha = hits.find((h) => h.id === a.id);
      const hb = hits.find((h) => h.id === b.id);
      expect(ha?.possibleConflicts).toContain(b.id);
      expect(hb?.possibleConflicts).toContain(a.id);
    });

    it("does not flag when only the repo overlaps", () => {
      addLore(db, {
        title: "Migration policy",
        summary: "x",
        body: "B",
        repos: ["billing-svc"],
        tags: ["migrations"],
      });
      addLore(db, {
        title: "Migration testing checklist",
        summary: "x",
        body: "B",
        repos: ["billing-svc"],
        tags: ["testing"], // different tag
      });
      const hits = searchLore(db, { query: "migration" });
      for (const h of hits) {
        expect(h.possibleConflicts ?? []).toEqual([]);
      }
    });

    it("does not flag when only the tag overlaps", () => {
      addLore(db, {
        title: "Cookie policy A",
        summary: "x",
        body: "B",
        repos: ["frontend"],
        tags: ["security"],
      });
      addLore(db, {
        title: "Cookie policy B",
        summary: "x",
        body: "B",
        repos: ["api"], // different repo
        tags: ["security"],
      });
      const hits = searchLore(db, { query: "cookie policy" });
      for (const h of hits) {
        expect(h.possibleConflicts ?? []).toEqual([]);
      }
    });

    it("does not flag drafts, deprecated, or superseded records", () => {
      const active = addLore(db, {
        title: "Active webhook policy",
        summary: "x",
        body: "B",
        repos: ["payments-svc"],
        tags: ["webhooks"],
      });
      const deprecated = addLore(db, {
        title: "Old webhook policy",
        summary: "x",
        body: "B",
        repos: ["payments-svc"],
        tags: ["webhooks"],
      });
      deprecateLore(db, deprecated.id);
      const hits = searchLore(db, {
        query: "webhook policy",
        includeDeprecated: true,
      });
      const ha = hits.find((h) => h.id === active.id);
      // deprecated co-result shouldn't trigger a conflict
      expect(ha?.possibleConflicts ?? []).toEqual([]);
    });

    it("populates possibleConflicts for a 3-way overlap correctly", () => {
      const a = addLore(db, {
        title: "Caching policy A",
        summary: "x",
        body: "B",
        repos: ["api"],
        tags: ["caching"],
      });
      const b = addLore(db, {
        title: "Caching policy B",
        summary: "x",
        body: "B",
        repos: ["api"],
        tags: ["caching"],
      });
      const c = addLore(db, {
        title: "Caching policy C",
        summary: "x",
        body: "B",
        repos: ["api"],
        tags: ["caching"],
      });
      const hits = searchLore(db, { query: "caching policy" });
      const ha = hits.find((h) => h.id === a.id);
      const hb = hits.find((h) => h.id === b.id);
      const hc = hits.find((h) => h.id === c.id);
      // Each should list the other two.
      expect([...(ha?.possibleConflicts ?? [])].sort()).toEqual([b.id, c.id].sort());
      expect([...(hb?.possibleConflicts ?? [])].sort()).toEqual([a.id, c.id].sort());
      expect([...(hc?.possibleConflicts ?? [])].sort()).toEqual([a.id, b.id].sort());
    });

    it("does not flag a single result with no other co-results", () => {
      addLore(db, {
        title: "Lonely policy",
        summary: "x",
        body: "B",
        repos: ["solo"],
        tags: ["solo"],
      });
      const hits = searchLore(db, { query: "Lonely policy" });
      expect(hits[0]?.possibleConflicts ?? []).toEqual([]);
    });
  });

  describe("exportLore", () => {
    /**
     * Round-trip-ish coverage: the export should reflect the same
     * default-safe lifecycle filter as search (active + non-restricted),
     * round-trip the full Lore shape (including body), and provide a
     * stable ordering so two exports of the same DB diff cleanly.
     */
    it("defaults to active + non-restricted only", () => {
      const active = addLore(db, { title: "active rule", summary: "s", body: "B" });
      const draft = suggestLore(db, { title: "draft rule", summary: "s", body: "B" });
      const deprecated = addLore(db, {
        title: "old rule",
        summary: "s",
        body: "B",
      });
      deprecateLore(db, deprecated.id);
      const restricted = addLore(db, {
        title: "restricted rule",
        summary: "s",
        body: "B",
        restricted: true,
      });
      const recs = exportLore(db);
      const ids = recs.map((r) => r.id);
      expect(ids).toContain(active.id);
      expect(ids).not.toContain(draft.id);
      expect(ids).not.toContain(deprecated.id);
      expect(ids).not.toContain(restricted.id);
    });

    it("includes the body — full Lore, not a brief summary", () => {
      addLore(db, {
        title: "round-trip body test",
        summary: "s",
        body: "BODY-MARKER-12345",
      });
      const [rec] = exportLore(db);
      expect(rec?.body).toBe("BODY-MARKER-12345");
    });

    it("honours each opt-in flag independently", () => {
      const a = addLore(db, { title: "a", summary: "s", body: "B" });
      const drafted = suggestLore(db, { title: "b draft", summary: "s", body: "B" });
      const dep = addLore(db, { title: "c dep", summary: "s", body: "B" });
      deprecateLore(db, dep.id);
      const sup1 = addLore(db, { title: "d sup-old", summary: "s", body: "B" });
      const sup2 = addLore(db, { title: "e sup-new", summary: "s", body: "B" });
      supersedeLore(db, sup1.id, sup2.id);
      const r = addLore(db, {
        title: "f restricted",
        summary: "s",
        body: "B",
        restricted: true,
      });

      expect(
        exportLore(db)
          .map((x) => x.id)
          .sort(),
      ).toEqual([a.id, sup2.id].sort());
      expect(exportLore(db, { includeDrafts: true }).map((x) => x.id)).toContain(drafted.id);
      expect(exportLore(db, { includeDeprecated: true }).map((x) => x.id)).toContain(dep.id);
      expect(exportLore(db, { includeSuperseded: true }).map((x) => x.id)).toContain(sup1.id);
      expect(exportLore(db, { includeRestricted: true }).map((x) => x.id)).toContain(r.id);
    });

    it("produces stable ordering: updated_at desc, id asc tiebreak", async () => {
      const a = addLore(db, { title: "a", summary: "s", body: "B" });
      const b = addLore(db, { title: "b", summary: "s", body: "B" });
      const c = addLore(db, { title: "c", summary: "s", body: "B" });
      // Ensure the next mutation gets a later ISO millisecond stamp.
      await new Promise((r) => setTimeout(r, 5));
      updateLore(db, b.id, { summary: "s2" });
      const ids = exportLore(db).map((r) => r.id);
      expect(ids[0]).toBe(b.id);
      expect(ids.slice(1).sort()).toEqual([a.id, c.id].sort());
    });

    it("falls back to id-asc tiebreak when updated_at is identical", () => {
      // Same insert tick: updated_at collides at ms precision, so ordering
      // must be deterministic via the id-ASC tiebreak. We can't predict
      // the random ids, but the export's id order should be ascending.
      const ids = [
        addLore(db, { title: "x", summary: "s", body: "B" }).id,
        addLore(db, { title: "y", summary: "s", body: "B" }).id,
        addLore(db, { title: "z", summary: "s", body: "B" }).id,
      ];
      // If timestamps collide (likely in a fast loop), all three share an
      // updated_at; if they don't, the test still passes because we only
      // assert determinism, not a specific order.
      const exportedIds = exportLore(db).map((r) => r.id);
      // The set of returned ids matches the inserted set.
      expect(new Set(exportedIds)).toEqual(new Set(ids));
      // And a second export gives the identical ordering — that's the
      // determinism guarantee.
      const exportedIdsAgain = exportLore(db).map((r) => r.id);
      expect(exportedIdsAgain).toEqual(exportedIds);
    });

    it("returns repos + tags joined per record", () => {
      addLore(db, {
        title: "with-meta",
        summary: "s",
        body: "B",
        repos: ["payments-svc", "auth-svc"],
        tags: ["security", "passwords"],
      });
      const [rec] = exportLore(db);
      expect(rec?.repos).toEqual(["auth-svc", "payments-svc"]);
      expect(rec?.tags).toEqual(["passwords", "security"]);
    });
  });

  describe("listTags + listRepos + listRecent", () => {
    it("listTags / listRepos are sorted + deduplicated", () => {
      addLore(db, {
        title: "a",
        summary: "s",
        body: "b",
        repos: ["alpha"],
        tags: ["one", "two"],
      });
      addLore(db, {
        title: "b",
        summary: "s",
        body: "b",
        repos: ["alpha", "beta"],
        tags: ["two", "three"],
      });
      expect(listRepos(db)).toEqual(["alpha", "beta"]);
      expect(listTags(db)).toEqual(["one", "three", "two"]);
    });
    it("listRecent returns all lifecycle states for browsing", () => {
      addLore(db, { title: "active one", summary: "s", body: "b" });
      const drafted = suggestLore(db, {
        title: "draft one",
        summary: "s",
        body: "b",
      });
      const dep = addLore(db, {
        title: "to deprecate",
        summary: "s",
        body: "b",
      });
      deprecateLore(db, dep.id);
      const all = listRecent(db);
      const titles = all.map((l) => l.title).sort();
      expect(titles).toContain("active one");
      expect(titles).toContain("draft one");
      expect(titles).toContain("to deprecate");
      expect(all.find((l) => l.id === drafted.id)?.status).toBe("draft");
    });
  });
});
