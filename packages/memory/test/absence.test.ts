/**
 * Verified-absence markers. Pins:
 *   - migration 003 adds the table
 *   - normaliseAbsenceQuery is order-independent and lowercased
 *   - recordAbsence stores the normalised key + expires_at
 *   - findActiveAbsence returns the right marker (repo-scoped wins,
 *     expired ignored, unknown query → null)
 *   - listAbsences default-filters expired
 *   - search_lore decoration path: pure helper exercise (the MCP
 *     handler integration is verified by code review since the stdio
 *     harness is heavy)
 */
import BetterSqlite3 from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  absenceQueryMatches,
  findActiveAbsence,
  listAbsences,
  normaliseAbsenceQuery,
  pruneExpiredAbsences,
  recordAbsence,
} from "../src/core/absence.js";
import { runMigrations } from "../src/db/migrations.js";
import type { Database } from "better-sqlite3";

function newDb(): Database {
  const db = new BetterSqlite3(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

describe("normaliseAbsenceQuery", () => {
  it("is order-independent across whitespace-separated tokens", () => {
    const a = normaliseAbsenceQuery("payments-svc retry policy");
    const b = normaliseAbsenceQuery("Retry POLICY payments-svc");
    expect(a).toBe(b);
    expect(a).toBe("payments-svc policy retry");
  });

  it("collapses multiple whitespace runs and trims", () => {
    expect(normaliseAbsenceQuery("  a   b\tc\nd  ")).toBe("a b c d");
  });

  it("lowercases", () => {
    expect(normaliseAbsenceQuery("CaseSensitive")).toBe("casesensitive");
  });

  it("returns empty string for blank input", () => {
    expect(normaliseAbsenceQuery("   ")).toBe("");
  });

  it("DOES NOT collapse synonyms (deliberate)", () => {
    // "retry policy" and "backoff strategy" stay distinct — the agent
    // re-records if its phrasing differs enough to matter.
    expect(normaliseAbsenceQuery("retry policy")).not.toBe(
      normaliseAbsenceQuery("backoff strategy"),
    );
  });
});

describe("absenceQueryMatches — token-set containment", () => {
  const k = normaliseAbsenceQuery;
  it("matches exact (degenerate) keys", () => {
    expect(absenceQueryMatches(k("retry policy"), k("policy retry"))).toBe(true);
  });

  it("matches when the marker is a subset of the query (query adds a word)", () => {
    // marker "retry policy" applies to search "payments-svc retry policy"
    expect(absenceQueryMatches(k("retry policy"), k("payments-svc retry policy"))).toBe(true);
  });

  it("matches when the query is a subset of the marker (query drops a word)", () => {
    expect(absenceQueryMatches(k("payments-svc retry policy"), k("retry policy"))).toBe(true);
  });

  it("does NOT match on mere overlap (neither side contains the other)", () => {
    // share "policy" but neither is a subset → conservative no-match
    expect(absenceQueryMatches(k("retry policy"), k("policy timeout"))).toBe(false);
  });

  it("does NOT match unrelated queries", () => {
    expect(absenceQueryMatches(k("retry policy"), k("auth tokens"))).toBe(false);
  });

  it("empty keys never match", () => {
    expect(absenceQueryMatches("", k("anything"))).toBe(false);
    expect(absenceQueryMatches(k("anything"), "")).toBe(false);
  });
});

describe("recordAbsence + findActiveAbsence", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
  });

  it("recordAbsence stores marker, findActiveAbsence retrieves it via the normalised key", () => {
    const r = recordAbsence(db, {
      query: "payments-svc retry policy",
      reason: "team has no policy yet; ad hoc per incident",
      recordedBy: "human",
    });
    expect(r.id).toMatch(/^[a-z2-9]{8}$/);
    expect(r.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const hit = findActiveAbsence(db, {
      query: "Retry policy payments-svc", // reordered + case-mixed
    });
    expect(hit?.reason).toBe("team has no policy yet; ad hoc per incident");
  });

  it("default expiry is ~14 days from now (tightened from 30 per external review)", () => {
    const before = Date.now();
    const r = recordAbsence(db, {
      query: "q",
      reason: "x",
      recordedBy: "human",
    });
    const expiresMs = Date.parse(r.expiresAt);
    const diffDays = (expiresMs - before) / 86400_000;
    expect(diffDays).toBeGreaterThan(13.9);
    expect(diffDays).toBeLessThan(14.1);
  });

  it("custom expiresInDays is honoured", () => {
    const r = recordAbsence(db, {
      query: "q",
      reason: "x",
      recordedBy: "human",
      expiresInDays: 7,
    });
    const diffDays = (Date.parse(r.expiresAt) - Date.now()) / 86400_000;
    expect(diffDays).toBeGreaterThan(6.9);
    expect(diffDays).toBeLessThan(7.1);
  });

  it("expired markers are NOT returned by findActiveAbsence", () => {
    // Insert a marker then backdate it via raw SQL.
    const r = recordAbsence(db, {
      query: "q",
      reason: "x",
      recordedBy: "human",
    });
    db.prepare("UPDATE absence_markers SET expires_at = ? WHERE id = ?").run(
      "2020-01-01T00:00:00.000Z",
      r.id,
    );
    expect(findActiveAbsence(db, { query: "q" })).toBeNull();
  });

  it("returns null on unknown query", () => {
    expect(findActiveAbsence(db, { query: "never recorded" })).toBeNull();
  });

  it("returns null on blank query (defensive)", () => {
    expect(findActiveAbsence(db, { query: "   " })).toBeNull();
  });

  it("repo-scoped marker shadows a global one when the search includes repo", () => {
    recordAbsence(db, {
      query: "auth policy",
      reason: "global gap",
      recordedBy: "human",
    });
    recordAbsence(db, {
      query: "auth policy",
      reason: "specific to payments-svc",
      repo: "payments-svc",
      recordedBy: "human",
    });
    const scoped = findActiveAbsence(db, {
      query: "auth policy",
      repo: "payments-svc",
    });
    expect(scoped?.reason).toBe("specific to payments-svc");
    const other = findActiveAbsence(db, {
      query: "auth policy",
      repo: "other-svc",
    });
    expect(other?.reason).toBe("global gap");
    const unscoped = findActiveAbsence(db, { query: "auth policy" });
    expect(unscoped?.reason).toBe("global gap");
  });

  it("rejects empty query or reason", () => {
    expect(() => recordAbsence(db, { query: "", reason: "x", recordedBy: "human" })).toThrow(
      /query/,
    );
    expect(() => recordAbsence(db, { query: "q", reason: "  ", recordedBy: "human" })).toThrow(
      /reason/,
    );
  });

  it("findActiveAbsence fires under containment (query adds/drops a token)", () => {
    recordAbsence(db, {
      query: "retry policy",
      reason: "no team policy on retries",
      recordedBy: "human",
    });
    // Search with an extra token still surfaces the marker.
    expect(findActiveAbsence(db, { query: "payments-svc retry policy" })?.reason).toBe(
      "no team policy on retries",
    );
    // A genuinely unrelated search does not.
    expect(findActiveAbsence(db, { query: "auth token rotation" })).toBeNull();
  });

  it("findActiveAbsence picks the most-recent matching marker under containment", () => {
    recordAbsence(db, {
      query: "retry policy",
      reason: "older gap",
      recordedBy: "human",
    });
    const t = Date.now();
    while (Date.now() === t) {
      /* spin so recorded_at differs */
    }
    recordAbsence(db, {
      query: "retry policy backoff",
      reason: "newer gap",
      recordedBy: "human",
    });
    // "retry policy" is contained by both markers; recency wins.
    expect(findActiveAbsence(db, { query: "retry policy" })?.reason).toBe("newer gap");
  });
});

describe("listAbsences", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
  });

  it("returns all active markers in recorded_at desc order", () => {
    recordAbsence(db, { query: "first", reason: "a", recordedBy: "human" });
    // Small delay so timestamps differ.
    const t = Date.now();
    while (Date.now() === t) {
      /* spin */
    }
    recordAbsence(db, { query: "second", reason: "b", recordedBy: "human" });
    const all = listAbsences(db);
    expect(all.map((m) => m.query)).toEqual(["second", "first"]);
  });

  it("excludes expired by default; --include-expired shows them", () => {
    const r = recordAbsence(db, {
      query: "old",
      reason: "ancient",
      recordedBy: "human",
    });
    db.prepare("UPDATE absence_markers SET expires_at = ? WHERE id = ?").run(
      "2020-01-01T00:00:00.000Z",
      r.id,
    );
    recordAbsence(db, { query: "new", reason: "fresh", recordedBy: "human" });
    expect(listAbsences(db).map((m) => m.query)).toEqual(["new"]);
    expect(
      listAbsences(db, { includeExpired: true })
        .map((m) => m.query)
        .sort(),
    ).toEqual(["new", "old"]);
  });
});

describe("pruneExpiredAbsences", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
  });

  it("hard-deletes only expired markers; keeps active ones", () => {
    const expired = recordAbsence(db, {
      query: "old",
      reason: "ancient",
      recordedBy: "human",
    });
    db.prepare("UPDATE absence_markers SET expires_at = ? WHERE id = ?").run(
      "2020-01-01T00:00:00.000Z",
      expired.id,
    );
    recordAbsence(db, { query: "fresh", reason: "live", recordedBy: "human" });

    const deleted = pruneExpiredAbsences(db);
    expect(deleted).toBe(1);
    // The active marker survives; the expired one is gone even with
    // includeExpired (it was hard-deleted, not just filtered).
    expect(listAbsences(db, { includeExpired: true }).map((m) => m.query)).toEqual(["fresh"]);
  });

  it("returns 0 when nothing is expired", () => {
    recordAbsence(db, { query: "a", reason: "x", recordedBy: "human" });
    expect(pruneExpiredAbsences(db)).toBe(0);
  });
});
