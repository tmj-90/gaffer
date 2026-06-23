/**
 * Epic 3 (init-2026-05-17-001) — team-ratified disagreement primitive.
 *
 * Pins the contract:
 *   - migration 002 adds nullable conflicts_with column, idempotent
 *   - reportConflict creates a DRAFT counter and emits an event on the
 *     ORIGINAL — never mutates it
 *   - refusals (unknown / non-active / restricted / empty / too-long)
 *     each surface a typed ReportConflictError with a stable `reason`
 *   - searchLore + getLore hydrate conflictsWith on counter-records;
 *     plain records have conflictsWith === undefined (not [])
 *   - approveLore preserves conflictsWith
 *   - sync round-trip preserves conflictsWith
 *   - orthogonal to the runtime possibleConflicts heuristic
 */
import BetterSqlite3 from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addLore,
  approveLore,
  deprecateLore,
  getLore,
  reportConflict,
  ReportConflictError,
  searchLore,
  suggestLore,
  supersedeLore,
  upsertLoreFromImport,
} from "../src/core/lore.js";
import {
  exportToDir,
  importFromDir,
  parseFrontmatter,
  renderLoreMarkdown,
} from "../src/cli/sync.js";
import { renderFull, renderSummary } from "../src/cli/format.js";
import { MIGRATIONS, runMigrations } from "../src/db/migrations.js";
import type { Database } from "better-sqlite3";

function newInMemoryDb(): Database {
  const db = new BetterSqlite3(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

describe("migration 002 adds conflicts_with column nullable and is idempotent on populated DB", () => {
  it("appends as migration id '002-conflicts-with'", () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect(ids).toContain("002-conflicts-with");
    expect(ids.indexOf("002-conflicts-with")).toBeGreaterThan(ids.indexOf("001-initial-schema"));
  });

  it("adds a nullable TEXT column and leaves existing rows with conflicts_with NULL", () => {
    const db = new BetterSqlite3(":memory:");
    db.pragma("foreign_keys = ON");
    // Run only the first migration manually so we can seed rows pre-002.
    const m1 = MIGRATIONS.find((m) => m.id === "001-initial-schema")!;
    m1.up(db);
    // Insert a row via the raw schema (no conflicts_with column yet).
    db.prepare(
      "INSERT INTO lore (id, title, summary, body, status, confidence, restricted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "abcd2345",
      "pre-002 row",
      "s",
      "b",
      "active",
      "medium",
      0,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
    // Now apply migration 002.
    const m2 = MIGRATIONS.find((m) => m.id === "002-conflicts-with")!;
    m2.up(db);
    const row = db.prepare("SELECT conflicts_with FROM lore WHERE id = ?").get("abcd2345") as {
      conflicts_with: string | null;
    };
    expect(row.conflicts_with).toBeNull();
  });

  it("runMigrations is idempotent — running twice yields the same applied row count", () => {
    const db = newInMemoryDb();
    const applied = db.prepare("SELECT COUNT(*) AS n FROM migrations").get() as { n: number };
    runMigrations(db);
    const reapplied = db.prepare("SELECT COUNT(*) AS n FROM migrations").get() as { n: number };
    expect(reapplied.n).toBe(applied.n);
  });
});

describe("reportConflict", () => {
  let db: Database;
  beforeEach(() => {
    db = newInMemoryDb();
  });

  function seedActive(overrides: { restricted?: boolean } = {}): string {
    return addLore(db, {
      title: "Argon2id for password hashing",
      summary: "Platform sec ruling.",
      body: "Use m=64MB, t=3, p=4.",
      repos: ["auth-svc"],
      tags: ["security"],
      restricted: overrides.restricted ?? false,
    }).id;
  }

  describe("reportConflict creates a draft counter-record with prefix, tag, and conflictsWith populated", () => {
    it("draft has prefixed title, conflict-report tag, conflictsWith=[existingId]", () => {
      const existingId = seedActive();
      const counter = reportConflict(db, {
        existingId,
        observation:
          "Auth-svc code now uses scrypt — see commit deadbeef. Argon2id rule is out-of-date.",
      });
      expect(counter.status).toBe("draft");
      expect(counter.title.startsWith("[conflict-report] ")).toBe(true);
      expect(counter.tags).toContain("conflict-report");
      expect(counter.conflictsWith).toEqual([existingId]);
    });

    it("counter inherits repos/source/tags when provided", () => {
      const existingId = seedActive();
      const counter = reportConflict(db, {
        existingId,
        observation: "see commit",
        source: "https://example.com/c/abc",
        repos: ["auth-svc"],
        tags: ["security"],
      });
      expect(counter.repos).toContain("auth-svc");
      expect(counter.tags).toContain("conflict-report");
      expect(counter.tags).toContain("security");
      expect(counter.source).toBe("https://example.com/c/abc");
    });
  });

  describe("reportConflict emits conflict_reported event on the ORIGINAL record with counterDraftId payload", () => {
    it("exactly one event row on the original; payload references the new draft", () => {
      const existingId = seedActive();
      const counter = reportConflict(db, {
        existingId,
        observation: "contradicting evidence",
      });
      const events = db
        .prepare(
          "SELECT kind, payload FROM events WHERE lore_id = ? AND kind = 'conflict_reported'",
        )
        .all(existingId) as Array<{ kind: string; payload: string | null }>;
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload!)).toEqual({
        counterDraftId: counter.id,
      });
      // None against the new draft.
      const counterEvents = db
        .prepare("SELECT kind FROM events WHERE lore_id = ? AND kind = 'conflict_reported'")
        .all(counter.id);
      expect(counterEvents).toEqual([]);
    });
  });

  describe("reportConflict refuses unknown existingId and writes nothing", () => {
    it("throws ReportConflictError reason=unknown_existing_id; no draft + no event", () => {
      const before = (db.prepare("SELECT COUNT(*) AS n FROM lore").get() as { n: number }).n;
      expect(() => reportConflict(db, { existingId: "zzzzzzzz", observation: "x" })).toThrow(
        ReportConflictError,
      );
      try {
        reportConflict(db, { existingId: "zzzzzzzz", observation: "x" });
      } catch (e) {
        expect((e as ReportConflictError).reason).toBe("unknown_existing_id");
      }
      const after = (db.prepare("SELECT COUNT(*) AS n FROM lore").get() as { n: number }).n;
      expect(after).toBe(before);
      const ev = db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'conflict_reported'")
        .get() as { n: number };
      expect(ev.n).toBe(0);
    });
  });

  describe("reportConflict refuses non-active existing record across all three statuses", () => {
    it("draft / deprecated / superseded all refuse with reason=non_active_existing_record", () => {
      const draft = suggestLore(db, { title: "t", summary: "s", body: "b" }).id;
      const a = seedActive();
      seedActive();
      deprecateLore(db, a);
      const c = seedActive();
      const d = seedActive();
      supersedeLore(db, c, d);
      for (const id of [draft, a, c]) {
        try {
          reportConflict(db, { existingId: id, observation: "x" });
          throw new Error(`should have refused for id ${id}`);
        } catch (e) {
          expect(e).toBeInstanceOf(ReportConflictError);
          expect((e as ReportConflictError).reason).toBe("non_active_existing_record");
        }
      }
    });
  });

  describe("reportConflict refuses restricted existing record and refusal does not leak title", () => {
    it("restricted=true → reason=restricted_existing_record; error message doesn't echo title/summary/body", () => {
      const secret = addLore(db, {
        title: "INTERNAL: secret cred rotation procedure",
        summary: "very sensitive",
        body: "do not leak",
        restricted: true,
      }).id;
      try {
        reportConflict(db, {
          existingId: secret,
          observation: "challenging this",
        });
        throw new Error("should have refused");
      } catch (e) {
        expect(e).toBeInstanceOf(ReportConflictError);
        expect((e as ReportConflictError).reason).toBe("restricted_existing_record");
        // Crucial: refusal text only contains the id, never the title/summary/body.
        const msg = (e as Error).message;
        expect(msg).toContain(secret);
        expect(msg).not.toContain("INTERNAL");
        expect(msg).not.toContain("secret cred rotation");
        expect(msg).not.toContain("very sensitive");
        expect(msg).not.toContain("do not leak");
      }
    });
  });

  describe("reportConflict rejects empty observation and observation over 800 chars", () => {
    it("empty string + whitespace-only + over-cap all refuse", () => {
      const existingId = seedActive();
      for (const bad of ["", "   ", "\t\n"]) {
        try {
          reportConflict(db, { existingId, observation: bad });
          throw new Error(`should have refused for ${JSON.stringify(bad)}`);
        } catch (e) {
          expect(e).toBeInstanceOf(ReportConflictError);
          expect((e as ReportConflictError).reason).toBe("empty_observation");
        }
      }
      try {
        reportConflict(db, {
          existingId,
          observation: "a".repeat(801),
        });
        throw new Error("should have refused too-long");
      } catch (e) {
        expect(e).toBeInstanceOf(ReportConflictError);
        expect((e as ReportConflictError).reason).toBe("observation_too_long");
      }
    });
  });

  describe("searchLore and getLore hydrate conflictsWith on counter-records and leave plain records undefined", () => {
    it("conflictsWith is [existingId] on counter; undefined on plain", () => {
      const existingId = seedActive();
      const counter = reportConflict(db, {
        existingId,
        observation: "the code disagrees with the rule",
      });
      const fullCounter = getLore(db, counter.id);
      expect(fullCounter?.conflictsWith).toEqual([existingId]);
      const fullPlain = getLore(db, existingId);
      // Plain record never got a counter-claim of its own.
      expect(fullPlain?.conflictsWith).toBeUndefined();
      // Search surface: include drafts so we can see the counter.
      const hits = searchLore(db, {
        query: "code disagrees",
        includeDrafts: true,
      });
      const counterHit = hits.find((h) => h.id === counter.id);
      expect(counterHit?.conflictsWith).toEqual([existingId]);
      const plainHits = searchLore(db, { query: "argon" });
      const plainHit = plainHits.find((h) => h.id === existingId);
      expect(plainHit?.conflictsWith).toBeUndefined();
    });
  });

  describe("approveLore on counter-draft preserves conflictsWith through to active search hits", () => {
    it("approve does not strip the counter link", () => {
      const existingId = seedActive();
      const counter = reportConflict(db, {
        existingId,
        observation: "the code disagrees",
      });
      const approved = approveLore(db, counter.id);
      expect(approved?.status).toBe("active");
      expect(approved?.conflictsWith).toEqual([existingId]);
      // Default search (no includeDrafts needed; now active).
      const hits = searchLore(db, { query: "code disagrees" });
      const hit = hits.find((h) => h.id === counter.id);
      expect(hit?.conflictsWith).toEqual([existingId]);
    });
  });

  describe("reportConflict never mutates the original record across repeated invocations", () => {
    it("original row stays byte-identical after 5 conflict reports", () => {
      const existingId = seedActive();
      const before = db.prepare("SELECT * FROM lore WHERE id = ?").get(existingId);
      for (let i = 0; i < 5; i++) {
        reportConflict(db, {
          existingId,
          observation: `observation #${i}`,
        });
      }
      const after = db.prepare("SELECT * FROM lore WHERE id = ?").get(existingId);
      expect(after).toEqual(before);
    });
  });

  describe("repeat conflict reports against the same existingId create independent drafts and independent events", () => {
    it("no server-side dedup; reviewer triages", () => {
      const existingId = seedActive();
      const a = reportConflict(db, { existingId, observation: "obs 1" });
      const b = reportConflict(db, { existingId, observation: "obs 2" });
      expect(a.id).not.toBe(b.id);
      const events = db
        .prepare(
          "SELECT payload FROM events WHERE lore_id = ? AND kind = 'conflict_reported' ORDER BY rowid",
        )
        .all(existingId) as Array<{ payload: string }>;
      expect(events).toHaveLength(2);
      const counterIds = events.map(
        (e) => (JSON.parse(e.payload) as { counterDraftId: string }).counterDraftId,
      );
      expect(counterIds).toEqual([a.id, b.id]);
    });
  });

  describe("conflictsWith and possibleConflicts are orthogonal fields populated independently", () => {
    it("possibleConflicts (heuristic) and conflictsWith (explicit) do not share storage", () => {
      const a = addLore(db, {
        title: "Password policy A: Argon2id",
        summary: "s",
        body: "b",
        repos: ["auth-svc"],
        tags: ["security"],
      });
      const b = addLore(db, {
        title: "Password policy B: scrypt",
        summary: "s",
        body: "b",
        repos: ["auth-svc"],
        tags: ["security"],
      });
      const c = reportConflict(db, {
        existingId: a.id,
        observation: "password policy is wrong — code uses bcrypt",
      });
      const hits = searchLore(db, {
        query: "password policy",
        includeDrafts: true,
      });
      const ha = hits.find((h) => h.id === a.id)!;
      const hb = hits.find((h) => h.id === b.id)!;
      const hc = hits.find((h) => h.id === c.id);
      // Heuristic still fires on shared scope.
      expect(ha.possibleConflicts).toContain(b.id);
      expect(hb.possibleConflicts).toContain(a.id);
      // conflictsWith is independent — only the counter-record carries it.
      expect(ha.conflictsWith).toBeUndefined();
      expect(hb.conflictsWith).toBeUndefined();
      // The counter ships with its own conflict-report tag/repos, so the
      // shared-scope heuristic does NOT trigger between c and a/b (c's
      // tags are ['conflict-report'], not 'security'); demonstrates the
      // two signals are independent.
      expect(hc?.conflictsWith).toEqual([a.id]);
      expect(hc?.possibleConflicts).toBeUndefined();
    });
  });
});

describe("renderSummary shows counter-claims count when conflictsWith populated and is independent of possibleConflicts", () => {
  it("renders ⚠ counter-claims: <count> exactly when conflictsWith non-empty", () => {
    const counter = {
      id: "abcd2345",
      title: "counter draft",
      summary: "s",
      status: "draft" as const,
      confidence: "medium" as const,
      restricted: false,
      repos: [],
      tags: ["conflict-report"],
      updatedAt: "2026-01-01T00:00:00.000Z",
      stale: false,
      conflictsWith: ["bcde2345"],
    };
    const rendered = renderSummary(counter);
    expect(rendered).toContain("counter-claims: 1");

    const plain = { ...counter, conflictsWith: undefined };
    const renderedPlain = renderSummary(plain);
    expect(renderedPlain).not.toContain("counter-claims");
  });
});

describe("cli show renders conflicts with line for counter-records and omits it for plain records", () => {
  it("renderFull emits 'conflicts with: <ids>' when non-empty", () => {
    const counter = {
      id: "abcd2345",
      title: "counter draft",
      summary: "s",
      body: "b",
      status: "draft" as const,
      confidence: "medium" as const,
      restricted: false,
      repos: [],
      tags: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      conflictsWith: ["bcde2345", "cdef2345"],
    };
    const out = renderFull(counter);
    expect(out).toContain("conflicts with: bcde2345, cdef2345");

    const plain = { ...counter, conflictsWith: undefined };
    expect(renderFull(plain)).not.toContain("conflicts with:");
  });
});

describe("sync markdown round-trip preserves conflictsWith on counter-records and omits the field on plain records", () => {
  let dir: string;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "conflicts-sync-"));
    db = newInMemoryDb();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("renderLoreMarkdown emits conflictsWith block; parseFrontmatter + upsert restores it", () => {
    const existingId = addLore(db, {
      title: "rule",
      summary: "s",
      body: "b",
      repos: ["payments-svc"],
    }).id;
    const counter = reportConflict(db, {
      existingId,
      observation: "code says otherwise",
    });
    const md = renderLoreMarkdown(counter);
    expect(md).toContain("conflictsWith:");
    expect(md).toContain(`  - ${existingId}`);
    const parsed = parseFrontmatter(md)!;
    expect(parsed.frontmatter["conflictsWith"]).toEqual([existingId]);

    // Roundtrip into a fresh DB.
    const fresh = newInMemoryDb();
    upsertLoreFromImport(fresh, {
      id: counter.id,
      title: counter.title,
      summary: counter.summary,
      body: counter.body,
      status: counter.status,
      conflictsWith: counter.conflictsWith,
      createdAt: counter.createdAt,
      updatedAt: counter.updatedAt,
    });
    const rehydrated = getLore(fresh, counter.id);
    expect(rehydrated?.conflictsWith).toEqual([existingId]);
  });

  it("plain records round-trip with conflictsWith still undefined and no conflictsWith line emitted", () => {
    const plainId = addLore(db, { title: "plain", summary: "s", body: "b" }).id;
    const plain = getLore(db, plainId)!;
    const md = renderLoreMarkdown(plain);
    expect(md).not.toContain("conflictsWith");
    const fresh = newInMemoryDb();
    exportToDir(db, dir);
    importFromDir(fresh, dir);
    expect(getLore(fresh, plainId)?.conflictsWith).toBeUndefined();
  });
});
