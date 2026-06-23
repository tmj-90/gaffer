/**
 * Repo Digest + feature inventory on onboarding.
 *
 * The mechanical scan-derived understanding now produces a digest (offline
 * fallback prose) and NO features — tests / CI / build / risk signals are
 * INFRASTRUCTURE, not product capabilities, so the old fake "features"
 * ("Build pipeline", "Automated tests", "Infra: ci:github-actions") are gone.
 * The SOURCE OF TRUTH for features is the model-backed onboarding analysis
 * (runner/lib/onboard-analyze.mjs), tested there.
 *
 * Asserts:
 *   - onboarding a stub repo DERIVES (from the SAME scan, no second pass) a Repo
 *     Digest with source="onboard" and ZERO features (no infrastructure-as-feature);
 *   - the unchanged flush helper still writes the digest + adds + de-dupes features
 *     (exercised with explicit feature inputs, since derivation no longer emits any).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DryRunGitAdapter } from "../src/adapters/gitAdapter.js";
import { RepoContextStore, type RepoMapping } from "../src/onboarding/contextStore.js";
import { onboardRepo } from "../src/onboarding/onboard.js";
import { deriveRepoUnderstanding } from "../src/onboarding/repoDigest.js";
import { scanRepoForOnboarding } from "../src/onboarding/onboardScan.js";
import { flushRepoUnderstanding } from "../src/memory/prefetch.js";
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
import type { AsyncMemoryClient } from "../src/memory/mcpClient.js";
import { FakeDispatchClient } from "../src/dispatch/fakeClient.js";
import { TestClock } from "../src/util/clock.js";

/** A Memory async fake that remembers digests + features for assertions. */
class RecordingMemory implements AsyncMemoryClient {
  readonly digests: RepoDigestInput[] = [];
  readonly addedFeatures: FeatureInput[] = [];
  seeded: ExistingFeature[] = [];

  async searchLore(_q: LoreSearchQuery): Promise<LoreRecord[]> {
    return [];
  }
  async suggestLore(_i: LoreSuggestionInput): Promise<LoreSuggestionResult> {
    return { suggestionId: "x", status: "draft" };
  }
  async updateRepoDigest(input: RepoDigestInput): Promise<RepoDigestResult> {
    const idx = this.digests.findIndex((d) => d.repo === input.repo);
    const existed = idx >= 0;
    if (existed) this.digests[idx] = input;
    else this.digests.push(input);
    return { repo: input.repo, status: existed ? "updated" : "created" };
  }
  async listFeatures(repo: string): Promise<ExistingFeature[]> {
    return [
      ...this.seeded.filter((f) => f.repo === repo),
      ...this.addedFeatures
        .filter((f) => f.repo === repo)
        .map((f) => ({ repo: f.repo, name: f.name })),
    ];
  }
  async listBacklogFeatures(): Promise<BacklogFeature[]> {
    return [];
  }
  async advanceFeature(id: string, toStatus: FeatureStatus): Promise<AdvanceFeatureResult> {
    return { id, status: toStatus };
  }
  /** When set, addFeature reports server-side de-dupe ("skipped") for these names. */
  serverSkips: Set<string> = new Set();
  async addFeature(input: FeatureInput): Promise<FeatureResult> {
    if (this.serverSkips.has(input.name)) {
      return { featureId: "existing", status: "skipped" };
    }
    this.addedFeatures.push(input);
    return { featureId: `feat-${this.addedFeatures.length}`, status: "added" };
  }
  async close(): Promise<void> {}
}

/** A synthetic, model-shaped feature inventory used to exercise the flush helper. */
function modelFeatures(repo: string): FeatureInput[] {
  return [
    {
      repo,
      name: "Supplier feed normalisation",
      summary: "Normalises N suppliers to one model.",
      status: "shipped",
      area: "core",
      provenance: "onboard",
    },
    {
      repo,
      name: "Entity registry",
      summary: "Canonical entity store + resolution.",
      status: "shipped",
      area: "core",
      provenance: "onboard",
    },
  ];
}

function writeFile(dir: string, rel: string, body: string): void {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body, "utf8");
}

/** A small but realistic stub repo: Node stack + CI signal + key dirs. */
function stubRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "gaffer-digest-repo-"));
  writeFile(
    repoDir,
    "package.json",
    JSON.stringify({ scripts: { test: "vitest", lint: "eslint .", build: "tsc" } }),
  );
  writeFile(repoDir, "pnpm-lock.yaml", "");
  writeFile(repoDir, "README.md", "# stub\n");
  mkdirSync(join(repoDir, "src"), { recursive: true });
  mkdirSync(join(repoDir, ".github", "workflows"), { recursive: true });
  writeFile(repoDir, ".github/workflows/ci.yml", "name: ci\n");
  return repoDir;
}

describe("deriveRepoUnderstanding (from the same scan, no second pass)", () => {
  let repoDir: string;
  beforeEach(() => {
    repoDir = stubRepo();
  });
  afterEach(() => rmSync(repoDir, { recursive: true, force: true }));

  it("produces a digest with source=onboard and ZERO features (no infra-as-feature)", () => {
    const scan = scanRepoForOnboarding(repoDir, new DryRunGitAdapter({ isRepo: false }));

    const { digest, features } = deriveRepoUnderstanding({
      repoId: "stub",
      name: "stub",
      scan,
      mapping: { mode: "unmapped", scopeNodeIds: [] },
    });

    // Digest prose survives as the offline fallback.
    expect(digest.source).toBe("onboard");
    expect(digest.repo).toBe("stub");
    expect(digest.stack).toBe("typescript-react");
    expect(digest.overview).toContain("stub");
    expect(digest.structure).toContain("package.json");
    expect(digest.conventions).toContain("pnpm test");

    // The mechanical derivation NEVER invents features any more.
    expect(features).toEqual([]);
  });

  it("never emits infrastructure-derived features regardless of mapping", () => {
    const scan = scanRepoForOnboarding(repoDir, new DryRunGitAdapter({ isRepo: false }));
    const mappings: RepoMapping[] = [
      { mode: "unmapped", scopeNodeIds: [] },
      { mode: "mapped", scopeNodeIds: ["scope-1"] },
      { mode: "mapped", scopeNodeIds: ["a", "b"] },
    ];
    for (const mapping of mappings) {
      const { features } = deriveRepoUnderstanding({
        repoId: "stub",
        name: "stub",
        scan,
        mapping,
        scopeNodes: [
          { id: "scope-1", name: "Checkout", type: "capability", loreTags: [] },
          { id: "a", name: "A", type: "capability", loreTags: [] },
          { id: "b", name: "B", type: "capability", loreTags: [] },
        ],
      });
      expect(features).toEqual([]);
      // Explicitly: none of the old fake infra "features" leak through.
      expect(features.some((f) => /build pipeline|automated tests|infra:/i.test(f.name))).toBe(
        false,
      );
    }
  });
});

describe("onboardRepo surfaces understanding derived from the same scan", () => {
  let repoDir: string;
  let root: string;
  beforeEach(() => {
    repoDir = stubRepo();
    root = mkdtempSync(join(tmpdir(), "gaffer-digest-store-"));
  });
  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("produces a source=onboard digest and no infra features when mapped to a scope node", () => {
    const wg = new FakeDispatchClient();
    wg.seedScopeNode({ id: "scope-1", name: "Checkout", type: "capability", loreTags: [] });
    const store = new RepoContextStore({ root, factoryId: "f", clock: new TestClock() });

    const result = onboardRepo(
      repoDir,
      { repoId: "stub", name: "stub", mapping: { mode: "mapped", scopeNodeIds: ["scope-1"] } },
      { store, dispatch: wg, git: new DryRunGitAdapter({ isRepo: true, defaultBranch: "main" }) },
    );

    expect(result.understanding.digest.source).toBe("onboard");
    expect(result.understanding.features).toEqual([]);
  });
});

describe("onboardRepo is idempotent — a re-onboard refreshes instead of throwing", () => {
  let repoDir: string;
  let root: string;
  beforeEach(() => {
    repoDir = stubRepo();
    root = mkdtempSync(join(tmpdir(), "gaffer-digest-reonboard-"));
  });
  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  function onboardOnce(clock: TestClock) {
    const wg = new FakeDispatchClient();
    const store = new RepoContextStore({ root, factoryId: "f", clock });
    return onboardRepo(
      repoDir,
      { repoId: "stub", name: "stub", mapping: { mode: "unmapped" } },
      { store, dispatch: wg, git: new DryRunGitAdapter({ isRepo: false }) },
    );
  }

  it("re-onboarding an already-onboarded repo refreshes (no throw) and still produces a digest", () => {
    const first = onboardOnce(new TestClock());
    expect(first.context.scanCount).toBe(1);

    // The SAME repoId + store: the old first-time-only guard would have thrown
    // `already onboarded; use rescan`. The idempotent path must refresh instead.
    let second!: ReturnType<typeof onboardOnce>;
    expect(() => {
      second = onboardOnce(new TestClock());
    }).not.toThrow();

    // Re-onboard routed through rescan → scanCount bumped, profile preserved.
    expect(second.context.scanCount).toBe(2);
    expect(second.profile.repoId).toBe("stub");
    // The digest is STILL produced on the re-run (no features any more).
    expect(second.understanding.digest.source).toBe("onboard");
    expect(second.understanding.features).toEqual([]);
  });
});

describe("flushRepoUnderstanding idempotency (upsert digest, de-dupe features)", () => {
  let repoDir: string;
  let root: string;
  beforeEach(() => {
    repoDir = stubRepo();
    root = mkdtempSync(join(tmpdir(), "gaffer-digest-flush-"));
  });
  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  function onboardUnmapped(repoId: string) {
    const wg = new FakeDispatchClient();
    const store = new RepoContextStore({ root, factoryId: `f-${repoId}`, clock: new TestClock() });
    return onboardRepo(
      repoDir,
      { repoId, name: repoId, mapping: { mode: "unmapped" } },
      { store, dispatch: wg, git: new DryRunGitAdapter({ isRepo: false }) },
    );
  }

  it("writes the digest and adds every feature on first onboard", async () => {
    const lore = new RecordingMemory();
    const result = onboardUnmapped("stub-a");
    // Derivation yields no features; exercise the flush with a model-shaped set.
    const understanding = {
      digest: result.understanding.digest,
      features: modelFeatures("stub-a"),
    };

    const flush = await flushRepoUnderstanding(lore, understanding);

    expect(flush.digestWritten).toBe(true);
    expect(lore.digests).toHaveLength(1);
    expect(lore.digests[0]!.source).toBe("onboard");
    expect(flush.featuresAdded).toBe(understanding.features.length);
    expect(flush.featuresSkipped).toBe(0);
    expect(flush.failed).toBe(0);
  });

  it("upserts the digest and de-dupes features on re-onboard", async () => {
    const lore = new RecordingMemory();
    const first = onboardUnmapped("stub-b");
    const understanding = { digest: first.understanding.digest, features: modelFeatures("stub-b") };
    await flushRepoUnderstanding(lore, understanding);

    const addedFirst = lore.addedFeatures.length;
    // Re-onboard derives the SAME digest; the model re-emits the SAME features.
    const second = deriveRepoUnderstanding({
      repoId: "stub-b",
      name: "stub-b",
      scan: scanRepoForOnboarding(repoDir, new DryRunGitAdapter({ isRepo: false })),
      mapping: { mode: "unmapped", scopeNodeIds: [] },
    });
    const reUnderstanding = { digest: second.digest, features: modelFeatures("stub-b") };
    const reflush = await flushRepoUnderstanding(lore, reUnderstanding);

    // Digest upserted in place — not duplicated — and reported as "updated".
    expect(lore.digests).toHaveLength(1);
    expect(reflush.digestWritten).toBe(true);
    // Every feature already existed → all skipped, none re-added.
    expect(reflush.featuresAdded).toBe(0);
    expect(reflush.featuresSkipped).toBe(reUnderstanding.features.length);
    expect(lore.addedFeatures.length).toBe(addedFirst);
  });

  it("counts a server-side de-dupe ('skipped') as skipped, not added", async () => {
    const lore = new RecordingMemory();
    const result = onboardUnmapped("stub-d");
    const understanding = {
      digest: result.understanding.digest,
      features: modelFeatures("stub-d"),
    };
    // The server reports the first feature as already present (its own idempotency).
    const skipName = understanding.features[0]!.name;
    lore.serverSkips = new Set([skipName]);

    const flush = await flushRepoUnderstanding(lore, understanding);

    expect(flush.featuresSkipped).toBe(1);
    expect(flush.featuresAdded).toBe(understanding.features.length - 1);
    expect(flush.failed).toBe(0);
  });

  it("de-dupes against features already recorded out-of-band", async () => {
    const lore = new RecordingMemory();
    const result = onboardUnmapped("stub-c");
    const understanding = {
      digest: result.understanding.digest,
      features: modelFeatures("stub-c"),
    };
    // Pre-seed one of the feature names as already present.
    const seededName = understanding.features[0]!.name;
    lore.seeded = [{ repo: "stub-c", name: seededName }];

    const flush = await flushRepoUnderstanding(lore, understanding);

    expect(flush.featuresSkipped).toBe(1);
    expect(flush.featuresAdded).toBe(understanding.features.length - 1);
    expect(lore.addedFeatures.some((f) => f.name === seededName)).toBe(false);
  });
});
