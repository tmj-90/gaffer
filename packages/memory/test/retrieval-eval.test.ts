/**
 * Retrieval eval set — the relevance regression suite for `searchLore`.
 *
 * A small labelled corpus of realistic lore records plus queries with the
 * record(s) an engineer would expect back. Every query is scored under pure
 * lexical ranking (MEMORY_HYBRID_RETRIEVAL=0) and under hybrid ranking, and
 * the suite asserts three things:
 *
 *   1. hybrid never loses a hit that lexical found (recall@5 is monotone),
 *   2. the known lexical blind spots (typos, re-split compounds, unstemmed
 *      inflections) are recovered by the dense side,
 *   3. a query about something the corpus does not know still returns ZERO
 *      hits, so the absence-marker / "search wider" coaching path survives.
 *
 * Extend the corpus and the query table when a real retrieval miss is found;
 * a new row here is the regression test for it.
 */
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addLore, ensureLoreEmbeddings, searchLore } from "../src/core/lore.js";
import { getEmbedder } from "../src/core/embedding.js";
import { runMigrations } from "../src/db/migrations.js";
import type { Database } from "better-sqlite3";

interface Doc {
  readonly key: string;
  readonly title: string;
  readonly summary: string;
  readonly body?: string;
  readonly tags?: string[];
}

const CORPUS: Doc[] = [
  {
    key: "kafka-retry",
    title: "Kafka consumer retry policy",
    summary: "Retry a failed message 3 times with exponential backoff, then dead-letter it.",
    tags: ["kafka", "reliability"],
  },
  {
    key: "http-timeout",
    title: "HTTP client timeout defaults",
    summary: "Outbound HTTP calls use a 5s connect and 30s read timeout unless overridden.",
    tags: ["http"],
  },
  {
    key: "tz-payments",
    title: "Timezone handling in payments-svc",
    summary: "Store every timestamp in UTC; convert at the edge using the merchant's zone.",
    tags: ["payments", "dates"],
  },
  {
    key: "password-hash",
    title: "Password hashing uses argon2id",
    summary: "Never bcrypt for new code; argon2id with the tuned parameters in auth-core.",
    tags: ["security", "auth"],
  },
  {
    key: "migration-style",
    title: "Database migration style guide",
    summary: "One migration per change, forwards-only, never edit an applied migration.",
    tags: ["database"],
  },
  {
    key: "webhook-sig",
    title: "Webhook signature verification",
    summary: "Verify the HMAC-SHA256 header before parsing the body; reject on mismatch.",
    tags: ["webhooks", "security"],
  },
  {
    key: "feature-flags",
    title: "Feature flags via LaunchDarkly wrapper",
    summary: "Read flags through flags-core, never the SDK directly, so tests can stub them.",
    tags: ["flags"],
  },
  {
    key: "logging-pii",
    title: "No PII in structured logs",
    summary: "Redact email, phone and card fields at the logger; audit log is the exception.",
    tags: ["logging", "security"],
  },
  {
    key: "graphql-n1",
    title: "GraphQL resolvers must batch with DataLoader",
    summary: "Avoid N+1 queries: every list resolver goes through a DataLoader.",
    tags: ["graphql", "performance"],
  },
  {
    key: "deploy-freeze",
    title: "Deployment freeze windows",
    summary: "No production deploys Friday after 15:00 or during the month-end close.",
    tags: ["deploy"],
  },
  {
    key: "redis-cache",
    title: "Redis cache key naming",
    summary: "Keys are service:entity:id with a TTL; never cache without an expiry.",
    tags: ["redis", "caching"],
  },
  {
    key: "rate-limit",
    title: "Public API rate limiting",
    summary: "Token bucket per API key, 600 requests per minute, 429 with Retry-After.",
    tags: ["http", "api"],
  },
];

interface Case {
  readonly query: string;
  /** Corpus keys expected inside the top 5. */
  readonly expect: string[];
  /** Why this case is in the set. */
  readonly why: string;
  /** Set when the case is a known lexical blind spot the dense side must recover. */
  readonly denseRecovers?: boolean;
}

const CASES: Case[] = [
  { query: "kafka retry", expect: ["kafka-retry"], why: "plain lexical hit" },
  { query: "password hashing", expect: ["password-hash"], why: "stemmed lexical hit" },
  { query: "webhook signature", expect: ["webhook-sig"], why: "two-token lexical hit" },
  { query: "timezone payments", expect: ["tz-payments"], why: "topic + scope phrasing" },
  { query: "n+1 dataloader", expect: ["graphql-n1"], why: "symbolic token plus a name" },
  {
    query: "kafak retry",
    expect: ["kafka-retry"],
    why: "typo + an anchor token (lexical ties, dense breaks the tie)",
  },
  { query: "ratelimiting", expect: ["rate-limit"], why: "joined compound", denseRecovers: true },
  { query: "featureflags", expect: ["feature-flags"], why: "joined compound", denseRecovers: true },
  {
    query: "structuredlogs",
    expect: ["logging-pii"],
    why: "joined compound + plural",
    denseRecovers: true,
  },
  {
    query: "argon 2id",
    expect: ["password-hash"],
    why: "re-split subword of argon2id",
    denseRecovers: true,
  },
];

/** Queries the corpus has nothing on: hybrid must not invent hits. */
const NEGATIVES = ["kubernetes ingress", "elasticsearch mapping", "mobile push notification"];

let db: Database;
const ids = new Map<string, string>();
const prevHybrid = process.env["MEMORY_HYBRID_RETRIEVAL"];

function setHybrid(on: boolean): void {
  if (on) delete process.env["MEMORY_HYBRID_RETRIEVAL"];
  else process.env["MEMORY_HYBRID_RETRIEVAL"] = "0";
}

function topKeys(query: string, limit = 5): string[] {
  const byId = new Map([...ids.entries()].map(([k, v]) => [v, k]));
  return searchLore(db, { query, limit }).map((h) => byId.get(h.id) ?? h.id);
}

beforeEach(() => {
  db = new BetterSqlite3(":memory:");
  runMigrations(db);
  ids.clear();
  for (const d of CORPUS) {
    const lore = addLore(db, {
      title: d.title,
      summary: d.summary,
      body: d.body ?? d.summary,
      tags: d.tags ?? [],
      repos: ["eval-repo"],
      source: "https://example.com/adr/" + d.key,
      confidence: "medium",
    });
    ids.set(d.key, lore.id);
  }
});

afterEach(() => {
  if (prevHybrid === undefined) delete process.env["MEMORY_HYBRID_RETRIEVAL"];
  else process.env["MEMORY_HYBRID_RETRIEVAL"] = prevHybrid;
  db.close();
});

describe("retrieval eval set", () => {
  it("every record carries a vector under the current embedder after the writes", () => {
    const n = db
      .prepare("SELECT COUNT(*) AS n FROM lore_embeddings WHERE model = ?")
      .get(getEmbedder().model) as { n: number };
    expect(n.n).toBe(CORPUS.length);
    // Nothing left to backfill.
    expect(ensureLoreEmbeddings(db)).toBe(0);
  });

  it("hybrid recall@5 is monotone over lexical on every case", () => {
    for (const c of CASES) {
      setHybrid(false);
      const lex = new Set(topKeys(c.query));
      setHybrid(true);
      const hyb = new Set(topKeys(c.query));
      for (const k of c.expect) {
        if (lex.has(k))
          expect(hyb.has(k), `${c.why}: hybrid lost '${k}' for "${c.query}"`).toBe(true);
      }
    }
  });

  it("plain lexical cases hit under both rankings", () => {
    for (const c of CASES.filter((x) => !x.denseRecovers)) {
      setHybrid(false);
      for (const k of c.expect) expect(topKeys(c.query), `lexical: ${c.why}`).toContain(k);
      setHybrid(true);
      for (const k of c.expect) expect(topKeys(c.query), `hybrid: ${c.why}`).toContain(k);
    }
  });

  it("the dense side recovers each known lexical blind spot", () => {
    for (const c of CASES.filter((x) => x.denseRecovers)) {
      setHybrid(false);
      const lex = topKeys(c.query);
      setHybrid(true);
      const hyb = topKeys(c.query);
      for (const k of c.expect) {
        expect(hyb, `${c.why}: hybrid should surface '${k}' for "${c.query}"`).toContain(k);
      }
      // Documented blind spot: lexical alone misses it (if this starts passing,
      // the case is no longer a blind spot — move it to the plain list).
      expect(lex, `${c.why}: lexical was expected to miss "${c.query}"`).not.toContain(c.expect[0]);
    }
  });

  it("a typo beside an anchor token: lexical ties, hybrid ranks the intended record first", () => {
    // 'retry' matches kafka-retry AND rate-limit ("Retry-After") with equal bm25;
    // lexical alone can only order them by recency. The dense side sees 'kafak'.
    setHybrid(false);
    expect(new Set(topKeys("kafak retry"))).toEqual(new Set(["kafka-retry", "rate-limit"]));
    setHybrid(true);
    expect(topKeys("kafak retry")[0]).toBe("kafka-retry");
  });

  it("hits are tagged with the retrieval side that found them", () => {
    setHybrid(true);
    const typo = searchLore(db, { query: "kafak retry" });
    expect(typo[0]?.retrieval).toBe("both"); // 'retry' is lexical, 'kafak' is dense
    const dense = searchLore(db, { query: "ratelimiting" });
    expect(dense[0]?.retrieval).toBe("dense");
    expect(dense[0]?.score).toBeUndefined(); // no bm25 for a dense-only hit
    const lex = searchLore(db, { query: "password hashing" });
    expect(["lexical", "both"]).toContain(lex[0]?.retrieval);
    setHybrid(false);
    expect(searchLore(db, { query: "kafka retry" })[0]?.retrieval).toBeUndefined();
  });

  it("returns zero hits for topics the corpus does not know (no dense noise)", () => {
    setHybrid(true);
    for (const q of NEGATIVES) {
      expect(searchLore(db, { query: q }), `"${q}" should have no hits`).toHaveLength(0);
    }
  });

  it("is deterministic across repeated searches", () => {
    setHybrid(true);
    for (const c of CASES) {
      expect(topKeys(c.query)).toEqual(topKeys(c.query));
    }
  });

  it("filters apply to the dense side too (repo / tag scope is never widened)", () => {
    setHybrid(true);
    // 'ratelimiting' is a dense-only hit, so every hit below comes from the dense side.
    expect(searchLore(db, { query: "ratelimiting", repo: "other-repo" })).toHaveLength(0);
    expect(searchLore(db, { query: "ratelimiting", tag: "kafka" })).toHaveLength(0);
    expect(searchLore(db, { query: "ratelimiting", kind: "decision" })).toHaveLength(0);
    expect(topKeys("ratelimiting")).toEqual(["rate-limit"]);
    expect(searchLore(db, { query: "ratelimiting", tag: "http" })).toHaveLength(1);
  });

  it("backfills vectors lazily for a database written before the embeddings table", () => {
    db.prepare("DELETE FROM lore_embeddings").run();
    setHybrid(true);
    // First hybrid search embeds everything missing, then finds the dense-only hit.
    expect(topKeys("ratelimiting")).toEqual(["rate-limit"]);
    const n = db.prepare("SELECT COUNT(*) AS n FROM lore_embeddings").get() as { n: number };
    expect(n.n).toBe(CORPUS.length);
  });

  it("drops vectors from a different model and re-embeds under the current one", () => {
    db.prepare("UPDATE lore_embeddings SET model = 'some-other-model'").run();
    expect(ensureLoreEmbeddings(db)).toBe(CORPUS.length);
    const other = db
      .prepare("SELECT COUNT(*) AS n FROM lore_embeddings WHERE model = 'some-other-model'")
      .get() as { n: number };
    expect(other.n).toBe(0);
  });
});
