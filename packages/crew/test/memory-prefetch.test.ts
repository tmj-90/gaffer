/**
 * Tests the async pre-fetch / flush bridge and the lore_gap idle loop.
 *
 * Asserts:
 *   - prefetchLore + seededSyncClient seed the SYNC packet build with lore;
 *   - a dead Memory degrades pre-fetch to empty lore + a warning event;
 *   - flushSuggestions pushes collected suggestions and isolates failures;
 *   - the lore_gap loop emits a SUGGESTION (and optional draft ticket), never
 *     code edits, and skips conventions Memory already covers.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildContextPacket } from "../src/context/packet.js";
import { detectConventions, runIdleLoreGapLoop } from "../src/loops/idleLoreGap.js";
import { flushSuggestions, prefetchLore, seededSyncClient } from "../src/memory/prefetch.js";
import { EventLog } from "../src/events/eventLog.js";
import { FakeDispatchClient } from "../src/dispatch/fakeClient.js";
import { defaultSafetyPolicy } from "../src/safety/policySchema.js";
import { TestClock } from "../src/util/clock.js";
import { RepoRegistry } from "../src/index.js";
import type { AsyncMemoryClient } from "../src/memory/mcpClient.js";
import type {
  AdvanceFeatureResult,
  BacklogFeature,
  ExistingFeature,
  FeatureInput,
  FeatureResult,
  FeatureStatus,
  LoreRecord,
  LoreSearchQuery,
  LoreSuggestionInput,
  LoreSuggestionResult,
  RepoDigestInput,
  RepoDigestResult,
} from "../src/memory/client.js";
import { testConfig, testRepoRegistry } from "./helpers.js";

/** Minimal async Memory fake for the bridge tests. */
class FakeAsyncMemory implements AsyncMemoryClient {
  readonly suggested: LoreSuggestionInput[] = [];
  readonly digests: RepoDigestInput[] = [];
  readonly addedFeatures: FeatureInput[] = [];
  /** Pre-seeded existing features (per repo) for de-dupe assertions. */
  seededFeatures: ExistingFeature[] = [];
  constructor(
    private readonly records: LoreRecord[] = [],
    private readonly opts: { failSearch?: boolean; failSuggest?: boolean } = {},
  ) {}

  async searchLore(query: LoreSearchQuery): Promise<LoreRecord[]> {
    if (this.opts.failSearch) throw new Error("search down");
    const wanted = query.tags ?? [];
    return this.records.filter(
      (r) => wanted.length === 0 || r.tags.some((t) => wanted.includes(t)),
    );
  }

  async suggestLore(input: LoreSuggestionInput): Promise<LoreSuggestionResult> {
    if (this.opts.failSuggest) throw new Error("suggest down");
    this.suggested.push(input);
    return { suggestionId: `draft-${this.suggested.length}`, status: "draft" };
  }

  async updateRepoDigest(input: RepoDigestInput): Promise<RepoDigestResult> {
    const existed = this.digests.some((d) => d.repo === input.repo);
    const idx = this.digests.findIndex((d) => d.repo === input.repo);
    if (idx >= 0) this.digests[idx] = input;
    else this.digests.push(input);
    return { repo: input.repo, status: existed ? "updated" : "created" };
  }

  async listFeatures(repo: string): Promise<ExistingFeature[]> {
    return [
      ...this.seededFeatures.filter((f) => f.repo === repo),
      ...this.addedFeatures
        .filter((f) => f.repo === repo)
        .map((f) => ({ repo: f.repo, name: f.name })),
    ];
  }

  async addFeature(input: FeatureInput): Promise<FeatureResult> {
    this.addedFeatures.push(input);
    return { featureId: `feat-${this.addedFeatures.length}`, status: "added" };
  }

  async listBacklogFeatures(): Promise<BacklogFeature[]> {
    return [];
  }

  async advanceFeature(id: string, toStatus: FeatureStatus): Promise<AdvanceFeatureResult> {
    return { id, status: toStatus };
  }

  async close(): Promise<void> {}
}

function seedClaimedTicket(wg: FakeDispatchClient) {
  return wg.seedTicket({
    title: "Add password reset",
    description: "Implement reset flow.",
    riskLevel: "medium",
    acceptanceCriteria: [{ text: "Reset email is sent" }],
    repositories: [{ name: "web-app", localPath: "/tmp/test-web-app", testCommand: "pnpm test" }],
  });
}

describe("memory pre-fetch bridge", () => {
  it("seeds the sync packet with pre-fetched lore", async () => {
    const config = testConfig();
    const wg = new FakeDispatchClient();
    const ticket = seedClaimedTicket(wg);
    const events = new EventLog(new TestClock());

    const asyncLore = new FakeAsyncMemory([
      {
        id: "L1",
        title: "Auth convention",
        summary: "Use argon2id",
        tags: ["auth"],
        recordType: "convention",
      },
      { id: "L9", title: "Irrelevant", summary: "x", tags: ["payments"], recordType: "convention" },
    ]);
    const records = await prefetchLore(asyncLore, { tags: ["auth"], text: "reset" }, events);
    const seeded = seededSyncClient(records);

    const packet = buildContextPacket(ticket.id, {
      config,
      policy: defaultSafetyPolicy(),
      repoRegistry: testRepoRegistry(config),
      dispatch: wg,
      memory: seeded,
    });

    expect(packet.relevantLore.map((r) => r.id)).toContain("L1");
    expect(events.types()).toContain("lore_prefetched");
  });

  it("degrades to empty lore + warning event when Memory is dead", async () => {
    const events = new EventLog(new TestClock());
    const dead = new FakeAsyncMemory([], { failSearch: true });

    const records = await prefetchLore(dead, { tags: ["auth"] }, events);

    expect(records).toEqual([]);
    expect(events.types()).toContain("memory_unavailable");
  });

  it("flushes collected suggestions and isolates failures", async () => {
    const events = new EventLog(new TestClock());
    const ok = new FakeAsyncMemory();
    const result = await flushSuggestions(
      ok,
      [
        { title: "A", summary: "a" },
        { title: "B", summary: "b" },
      ],
      events,
    );
    expect(result.flushed).toHaveLength(2);
    expect(result.failed).toBe(0);
    expect(ok.suggested).toHaveLength(2);

    const broken = new FakeAsyncMemory([], { failSuggest: true });
    const failResult = await flushSuggestions(broken, [{ title: "X", summary: "x" }], events);
    expect(failResult.flushed).toHaveLength(0);
    expect(failResult.failed).toBe(1);
    expect(events.types()).toContain("memory_unavailable");
  });
});

describe("detectConventions", () => {
  it("flags packages imported across enough files", () => {
    const files = [
      { path: "a.ts", source: "import { z } from 'zod';\nimport x from './local';" },
      { path: "b.ts", source: "import { z } from 'zod';" },
      { path: "c.ts", source: "import { z } from 'zod';\nimport { Client } from '@scope/pkg';" },
    ];
    const conventions = detectConventions(files, 3);
    const keys = conventions.map((c) => c.key);
    expect(keys).toContain("import:zod");
    // Below the threshold and relative imports are excluded.
    expect(keys).not.toContain("import:@scope/pkg");
    expect(keys).not.toContain("import:./local");
  });
});

describe("idle lore_gap loop", () => {
  // A self-contained temp repo whose source repeatedly imports 'zod'.
  let repoDir: string;
  beforeAll(() => {
    repoDir = mkdtempSync(join(tmpdir(), "gaffer-loregap-"));
    for (const name of ["a.ts", "b.ts", "c.ts"]) {
      writeFileSync(
        join(repoDir, name),
        "import { z } from 'zod';\nexport const x = z.string();\n",
      );
    }
  });
  afterAll(() => rmSync(repoDir, { recursive: true, force: true }));

  function loreGapDeps(
    wg: FakeDispatchClient,
    memory: AsyncMemoryClient,
    overrides: { draftRatify?: boolean } = {},
  ) {
    const config = testConfig({
      loops: {
        ...testConfig().loops,
        idle_lore_gap: {
          ...testConfig().loops.idle_lore_gap,
          enabled: true,
          repos: ["lore-gap-repo"],
          minimum_occurrences: 2,
          draft_ratify_ticket: overrides.draftRatify ?? false,
        },
      },
      repos: [
        {
          ...testConfig().repos[0]!,
          id: "lore-gap-repo",
          name: "lore-gap-repo",
          path: repoDir,
          lore_tags: [],
        },
      ],
    });
    return {
      config,
      repoRegistry: RepoRegistry.fromConfig(config, "/"),
      dispatch: wg,
      runner: {
        run: () => ({ stdout: "", stderr: "", exitCode: 0 }),
        runArgs: () => ({ stdout: "", stderr: "", exitCode: 0 }),
      },
      events: new EventLog(new TestClock()),
      clock: new TestClock(),
      memory,
    };
  }

  it("emits a lore SUGGESTION (not code edits) for an uncovered convention", async () => {
    const wg = new FakeDispatchClient();
    const memory = new FakeAsyncMemory([]); // Memory covers nothing.
    const deps = loreGapDeps(wg, memory);

    const outcome = await runIdleLoreGapLoop(deps);

    expect(outcome.status).toBe("suggested");
    if (outcome.status !== "suggested") throw new Error("unreachable");
    expect(outcome.suggestions.length).toBeGreaterThan(0);
    // It SUGGESTED (drafts on the async client), and did NOT edit code or create tickets.
    expect(memory.suggested.length).toBeGreaterThan(0);
    expect(wg.evidence).toHaveLength(0);
    expect(deps.events.types()).toContain("lore_suggested");
  });

  it("skips conventions Memory already covers", async () => {
    const wg = new FakeDispatchClient();
    // Cover everything: any search returns a record.
    const memory = new FakeAsyncMemory([
      { id: "C", title: "covered", summary: "x", tags: [], recordType: "convention" },
    ]);
    // Make every tag match by returning the record regardless of tags.
    memory.searchLore = async () => [
      { id: "C", title: "covered", summary: "x", tags: [], recordType: "convention" },
    ];
    const deps = loreGapDeps(wg, memory);

    const outcome = await runIdleLoreGapLoop(deps);
    expect(outcome.status).toBe("no_findings");
    expect(memory.suggested).toHaveLength(0);
  });

  it("optionally drafts a ratify ticket alongside the suggestion", async () => {
    const wg = new FakeDispatchClient();
    const memory = new FakeAsyncMemory([]);
    const deps = loreGapDeps(wg, memory, { draftRatify: true });

    const outcome = await runIdleLoreGapLoop(deps);
    expect(outcome.status).toBe("suggested");
    if (outcome.status !== "suggested") throw new Error("unreachable");
    const withTicket = outcome.suggestions.find((s) => s.ratifyTicketId);
    expect(withTicket).toBeDefined();
    // The created ticket is a DRAFT — never approved work.
    const ticket = wg.getTicket(withTicket!.ratifyTicketId!);
    expect(ticket.ticket.status).toBe("draft");
    expect(ticket.ticket.description).toMatch(/no code was changed/i);
  });

  it("skips when ready tickets exist", async () => {
    const wg = new FakeDispatchClient();
    wg.seedTicket({ title: "ready", status: "ready" });
    const deps = loreGapDeps(wg, new FakeAsyncMemory([]));
    const outcome = await runIdleLoreGapLoop(deps);
    expect(outcome.status).toBe("skipped_tickets_ready");
  });
});
