/**
 * Dense-side vector cache (audit: dense-search-full-row-scan). Hybrid search
 * used to read every full lore row (bodies included) plus its BLOB and re-run
 * the backfill LEFT JOIN on every query — ~10x the lexical cost. It now scores
 * against per-connection decoded vectors and hydrates only the winners. These
 * tests pin that the cache never serves stale results, plus a generous
 * performance guard.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addLore, deleteLore, searchLore, updateLore } from "../src/core/lore.js";
import { openDb } from "../src/db/index.js";
import type { Database } from "better-sqlite3";

const prevHybrid = process.env["MEMORY_HYBRID_RETRIEVAL"];
let dir: string;
let db: Database;

beforeEach(() => {
  delete process.env["MEMORY_HYBRID_RETRIEVAL"];
  process.env["MEMORY_AUDIT_OFF"] = "1";
  dir = mkdtempSync(join(tmpdir(), "lore-dense-"));
  db = openDb(join(dir, "lore.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  if (prevHybrid === undefined) delete process.env["MEMORY_HYBRID_RETRIEVAL"];
  else process.env["MEMORY_HYBRID_RETRIEVAL"] = prevHybrid;
});

/** "ratelimiting" is a dense-only hit for this title (no shared FTS token). */
const titleOf = (hits: ReturnType<typeof searchLore>): string[] => hits.map((h) => h.title);

describe("dense vector cache", () => {
  it("a lore row another connection inserts WITHOUT a vector is still embedded and found", () => {
    addLore(db, { title: "Unrelated seed record", summary: "s", body: "b" });
    expect(searchLore(db, { query: "ratelimiting" })).toHaveLength(0); // warms the cache
    // An older binary / another process: plain INSERT, no lore_embeddings row.
    const other = new BetterSqlite3(join(dir, "lore.db"));
    other
      .prepare(
        `INSERT INTO lore (id, title, summary, body, status, kind, confidence, restricted,
           created_at, updated_at) VALUES ('zz22zz22', 'Public API rate limiting',
           'Token bucket per API key', 'b', 'active', 'other', 'medium', 0, ?, ?)`,
      )
      .run(new Date().toISOString(), new Date().toISOString());
    other.close();
    expect(titleOf(searchLore(db, { query: "ratelimiting" }))).toEqual([
      "Public API rate limiting",
    ]);
  });

  it("an update on the same connection re-embeds: the old text stops matching, the new one does", () => {
    const a = addLore(db, { title: "Public API rate limiting", summary: "s", body: "b" });
    expect(titleOf(searchLore(db, { query: "ratelimiting" }))).toHaveLength(1);
    updateLore(db, a.id, { title: "Feature flags via wrapper" });
    expect(searchLore(db, { query: "ratelimiting" })).toHaveLength(0);
    expect(titleOf(searchLore(db, { query: "featureflags" }))).toEqual([
      "Feature flags via wrapper",
    ]);
  });

  it("a deleted record never comes back from the cache", () => {
    const a = addLore(db, { title: "Public API rate limiting", summary: "s", body: "b" });
    expect(searchLore(db, { query: "ratelimiting" })).toHaveLength(1);
    deleteLore(db, a.id);
    expect(searchLore(db, { query: "ratelimiting" })).toHaveLength(0);
  });

  it("a same-connection raw delete of the vectors is backfilled on the next search", () => {
    addLore(db, { title: "Public API rate limiting", summary: "s", body: "b" });
    expect(searchLore(db, { query: "ratelimiting" })).toHaveLength(1);
    db.prepare("DELETE FROM lore_embeddings").run();
    expect(searchLore(db, { query: "ratelimiting" })).toHaveLength(1);
  });

  it("perf guard: warm hybrid search stays within a few x of lexical at 3k records", () => {
    const words =
      "kafka retry webhook payments timezone billing invoice auth token session cache redis postgres migration schema queue worker deploy rollback canary flag config secret logging metrics tracing alert incident latency batch stream partition consumer offset lag".split(
        " ",
      );
    let seed = 7;
    const rnd = (n: number): string => {
      const out: string[] = [];
      for (let i = 0; i < n; i++) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        out.push(words[seed % words.length]!);
      }
      return out.join(" ");
    };
    db.transaction(() => {
      for (let i = 0; i < 3000; i++) {
        addLore(db, {
          title: `Rule ${i} ${rnd(4)}`,
          summary: `We always ${rnd(12)}`,
          body: rnd(80),
          repos: [`repo-${i % 20}`],
        });
      }
    })();
    const median = (hybrid: boolean, query: string): number => {
      if (hybrid) delete process.env["MEMORY_HYBRID_RETRIEVAL"];
      else process.env["MEMORY_HYBRID_RETRIEVAL"] = "0";
      searchLore(db, { query }); // warm (loads the vector cache once)
      const ts: number[] = [];
      for (let k = 0; k < 7; k++) {
        const t = performance.now();
        searchLore(db, { query });
        ts.push(performance.now() - t);
      }
      return ts.sort((x, y) => x - y)[3]!;
    };
    for (const q of ["kafka consumer lag", "completely unrelated gardening topic"]) {
      const lexical = median(false, q);
      const hybrid = median(true, q);
      expect(
        hybrid,
        `"${q}" hybrid ${hybrid.toFixed(1)}ms vs lexical ${lexical.toFixed(1)}ms`,
      ).toBeLessThan(4 * lexical + 8);
    }
  });
});
