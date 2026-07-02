import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { createApiServer } from "../src/api/server.js";
import {
  createMemoryReader,
  parseDigest,
  parseFeatures,
  parseLore,
  parseRecallStats,
  type MemoryReader,
} from "../src/api/memoryReader.js";

// --- Sample CLI output (plain text, NO_COLOR) the parsers must handle --------

const DIGEST_OUT = `Repo digest: sample-repo

OVERVIEW
  A pint-tracking app for Guinness lovers.
  Tracks pours across pubs.

STRUCTURE
  Next.js app router with a Postgres backend.

CONVENTIONS
  Strict TypeScript. Zod at the boundaries.

STACK
  Next.js, Postgres, Vitest.

updated_at: 2026-06-20T10:00:00Z  ·  source: merge:#42
NOTE: this digest is a summary — verify it against the code for high-stakes work.
`;

const FEATURES_OUT = `Features for sample-repo: 3

SHIPPED (1)
  [shipped] Pour logging  @ingest  (core)  (feat-001)
      Record a pour with pub + price.
      provenance: merge:#42

BUILDING (1)
  [building] Leaderboard  @social  (feat-002)
      Weekly pub leaderboard.

BACKLOG (1)
  [backlog] Push reminders  (feat-003)
      Nudge users who haven't logged this week.

`;

const LORE_OUT = `Hash passwords with argon2id (lore-1)
  Never use bcrypt for new services.
  [active]  conf=high  manual  repos=payments-svc,auth  tags=security,crypto

Prefer server components (lore-2)
  Default to RSC unless interactivity is required.
  [draft]  conf=medium  ⚠ stale  onboard  tags=react
`;

// `memory recall-stats --json` output (the only JSON-emitting read verb).
const RECALL_OUT = JSON.stringify({
  total: 4,
  clean: 3,
  reworked: 1,
  blocked: 0,
  effectiveness_pct: 75,
  items_adjusted: 9,
  by_day: [
    { date: "2025-01-10", clean: 2, reworked: 0, blocked: 0, total: 2, effectiveness_pct: 100 },
    { date: "2025-01-11", clean: 1, reworked: 1, blocked: 0, total: 2, effectiveness_pct: 50 },
  ],
  last_applied_at: "2025-01-11T10:00:00Z",
});

describe("memoryReader parsers", () => {
  it("parses a repo digest into its four sections + freshness + caveat", () => {
    const d = parseDigest("sample-repo", DIGEST_OUT);
    expect(d).not.toBeNull();
    expect(d!.overview).toContain("pint-tracking app");
    expect(d!.overview).toContain("Tracks pours");
    expect(d!.structure).toContain("Next.js app router");
    expect(d!.conventions).toContain("Strict TypeScript");
    expect(d!.stack).toContain("Vitest");
    expect(d!.meta.updatedAt).toBe("2026-06-20T10:00:00Z");
    expect(d!.meta.source).toBe("merge:#42");
    expect(d!.caveat).toMatch(/verify it against the code/);
  });

  it("returns null for a repo with no digest yet", () => {
    expect(parseDigest("ghost", "memory: no digest for 'ghost' yet.\n")).toBeNull();
  });

  it("parses the feature ledger with status, scope node, area, id and provenance", () => {
    const features = parseFeatures(FEATURES_OUT);
    expect(features).toHaveLength(3);
    const shipped = features.find((f) => f.status === "shipped")!;
    expect(shipped.name).toBe("Pour logging");
    expect(shipped.scopeNode).toBe("ingest");
    expect(shipped.area).toBe("core");
    expect(shipped.id).toBe("feat-001");
    expect(shipped.summary).toBe("Record a pour with pub + price.");
    expect(shipped.provenance).toBe("merge:#42");

    const backlog = features.find((f) => f.status === "backlog")!;
    expect(backlog.name).toBe("Push reminders");
    expect(backlog.scopeNode).toBeNull();
  });

  it("returns an empty ledger for a repo with no features", () => {
    expect(parseFeatures("memory: no features for 'sample-repo'\n")).toEqual([]);
  });

  it("parses the lore list (title/id/summary/status/conf/source/repos/tags/stale)", () => {
    const lore = parseLore(LORE_OUT);
    expect(lore).toHaveLength(2);
    expect(lore[0]!.title).toBe("Hash passwords with argon2id");
    expect(lore[0]!.id).toBe("lore-1");
    expect(lore[0]!.status).toBe("active");
    expect(lore[0]!.confidence).toBe("high");
    expect(lore[0]!.repos).toEqual(["payments-svc", "auth"]);
    expect(lore[0]!.tags).toEqual(["security", "crypto"]);
    expect(lore[0]!.stale).toBe(false);
    expect(lore[1]!.stale).toBe(true);
  });

  it("returns an empty lore list when nothing is recorded", () => {
    expect(parseLore("memory: nothing here yet — try `memory add`.\n")).toEqual([]);
  });

  it("parses recall-stats JSON (totals + per-day trend)", () => {
    const r = parseRecallStats(RECALL_OUT);
    expect(r.total).toBe(4);
    expect(r.clean).toBe(3);
    expect(r.effectiveness_pct).toBe(75);
    expect(r.items_adjusted).toBe(9);
    expect(r.by_day).toHaveLength(2);
    expect(r.by_day[1]!.effectiveness_pct).toBe(50);
    expect(r.last_applied_at).toBe("2025-01-11T10:00:00Z");
  });

  it("coerces a malformed recall-stats payload to a zero-state (null effectiveness, no throw)", () => {
    expect(parseRecallStats("not json").effectiveness_pct).toBeNull();
    const partial = parseRecallStats(JSON.stringify({ total: 2, by_day: "nope" }));
    expect(partial.total).toBe(2);
    expect(partial.by_day).toEqual([]);
    expect(partial.effectiveness_pct).toBeNull();
  });
});

// --- Stub CLI: a tiny node script that echoes canned output per verb ---------

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Write a stub "memory CLI" that prints the right canned output per verb. */
function writeStubCli(): string {
  const dir = mkdtempSync(join(tmpdir(), "wg-mem-"));
  const cli = join(dir, "fake-memory.cjs");
  const script = `
const verb = process.argv[2];
const digest = ${JSON.stringify(DIGEST_OUT)};
const features = ${JSON.stringify(FEATURES_OUT)};
const lore = ${JSON.stringify(LORE_OUT)};
const recall = ${JSON.stringify(RECALL_OUT)};
if (verb === "digest") process.stdout.write(digest);
else if (verb === "features") process.stdout.write(features);
else if (verb === "list") process.stdout.write(lore);
else if (verb === "recall-stats") process.stdout.write(recall);
else { process.stderr.write("unknown verb\\n"); process.exit(2); }
`;
  writeFileSync(cli, script);
  return cli;
}

describe("createMemoryReader (stubbed CLI)", () => {
  it("returns parsed digest / features / lore from the configured CLI", () => {
    const reader = createMemoryReader({
      MEMORY_CLI_BIN: writeStubCli(),
      MEMORY_DB: "/tmp/whatever.sqlite",
    });

    const digest = reader.digest("sample-repo");
    expect(digest.available).toBe(true);
    if (digest.available) expect(digest.digest!.stack).toContain("Vitest");

    const features = reader.features("sample-repo");
    expect(features.available).toBe(true);
    if (features.available) expect(features.features).toHaveLength(3);

    const lore = reader.lore();
    expect(lore.available).toBe(true);
    if (lore.available) expect(lore.lore).toHaveLength(2);

    const recall = reader.recallEffectiveness();
    expect(recall.available).toBe(true);
    if (recall.available) {
      expect(recall.recall.effectiveness_pct).toBe(75);
      expect(recall.recall.by_day).toHaveLength(2);
    }
  });

  it("degrades gracefully when the CLI is NOT configured (available:false, no throw)", () => {
    const reader = createMemoryReader({}); // no MEMORY_CLI_BIN
    for (const res of [
      reader.digest("x"),
      reader.features("x"),
      reader.lore(),
      reader.recallEffectiveness(),
    ]) {
      expect(res.available).toBe(false);
      if (!res.available) expect(res.reason).toMatch(/not configured|MEMORY_CLI_BIN/i);
    }
  });

  it("degrades gracefully when the CLI exits non-zero (available:false, no throw)", () => {
    const dir = mkdtempSync(join(tmpdir(), "wg-mem-fail-"));
    const cli = join(dir, "boom.cjs");
    writeFileSync(cli, `process.stderr.write("db locked\\n"); process.exit(1);`);
    const reader = createMemoryReader({ MEMORY_CLI_BIN: cli });
    const res = reader.digest("x");
    expect(res.available).toBe(false);
    if (!res.available) expect(res.reason).toMatch(/exited|db locked/i);
  });
});

// --- Endpoint tests: the API surfaces the reader, never a 500 ---------------

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startHarness(reader: MemoryReader): Promise<Harness> {
  const wg = Dispatch.open(":memory:");
  const server = createApiServer(
    wg,
    undefined,
    undefined,
    undefined,
    undefined,
    "127.0.0.1",
    reader,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          wg.db.close();
          resolve();
        });
      }),
  };
}

describe("API: /api/memory/* read surfaces", () => {
  describe("with a working memory CLI", () => {
    let h: Harness;
    beforeEach(async () => {
      h = await startHarness(createMemoryReader({ MEMORY_CLI_BIN: writeStubCli() }));
    });
    afterEach(async () => {
      await h.close();
    });

    it("GET /api/memory/digest/:repo returns the parsed digest", async () => {
      const res = await fetch(`${h.baseUrl}/api/memory/digest/sample-repo`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        available: boolean;
        digest: { overview: string; meta: { source: string }; caveat: string } | null;
      };
      expect(body.available).toBe(true);
      expect(body.digest!.overview).toContain("pint-tracking");
      expect(body.digest!.meta.source).toBe("merge:#42");
      expect(body.digest!.caveat).toMatch(/verify it against the code/);
    });

    it("GET /api/memory/features/:repo returns the ledger", async () => {
      const res = await fetch(`${h.baseUrl}/api/memory/features/sample-repo`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        available: boolean;
        features: Array<{ status: string; name: string }>;
      };
      expect(body.available).toBe(true);
      expect(body.features.map((f) => f.status).sort()).toEqual(["backlog", "building", "shipped"]);
    });

    it("GET /api/memory/lore returns the lore list", async () => {
      const res = await fetch(`${h.baseUrl}/api/memory/lore`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { available: boolean; lore: unknown[] };
      expect(body.available).toBe(true);
      expect(body.lore).toHaveLength(2);
    });
  });

  describe("with memory NOT configured", () => {
    let h: Harness;
    beforeEach(async () => {
      h = await startHarness(createMemoryReader({})); // unconfigured
    });
    afterEach(async () => {
      await h.close();
    });

    it("degrades to 200 { available:false } — never a 500 that breaks the dashboard", async () => {
      for (const path of [
        "/api/memory/digest/sample-repo",
        "/api/memory/features/sample-repo",
        "/api/memory/lore",
      ]) {
        const res = await fetch(`${h.baseUrl}${path}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { available: boolean; reason?: string };
        expect(body.available).toBe(false);
        expect(typeof body.reason).toBe("string");
      }
    });

    it("still carries the baseline security headers on the memory routes", async () => {
      const res = await fetch(`${h.baseUrl}/api/memory/lore`);
      expect(res.headers.get("content-security-policy")).toBeTruthy();
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    });
  });
});
