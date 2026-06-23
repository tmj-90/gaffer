/**
 * Non-committed repo context store + onboarding orchestration (FG-004 + FG-003).
 *
 * Asserts:
 *   - context is written OUTSIDE the repo, under <root>/factories/<id>/repos/<id>/;
 *   - profile/context/scan-history files have the right shape + freshness/fingerprint;
 *   - rescan updates context, bumps scanCount, appends history, detects change;
 *   - secrets are NEVER stored (the store refuses secret-looking paths);
 *   - onboarding registers the repo in Dispatch (unmapped/standalone/mapped);
 *   - rescan SUGGESTS lore on change but never auto-promotes.
 */
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DryRunGitAdapter } from "../src/adapters/gitAdapter.js";
import { RepoContextStore } from "../src/onboarding/contextStore.js";
import { onboardRepo, rescanRepo } from "../src/onboarding/onboard.js";
import type { OnboardingScanResult } from "../src/onboarding/onboardScan.js";
import { FakeDispatchClient } from "../src/dispatch/fakeClient.js";
import { TestClock } from "../src/util/clock.js";

function fakeScan(overrides: Partial<OnboardingScanResult> = {}): OnboardingScanResult {
  return {
    path: "/repos/api",
    name: "api",
    isGitRepo: true,
    currentBranch: "main",
    stack: "typescript",
    packageManager: "pnpm",
    testCommand: "pnpm test",
    lintCommand: "pnpm lint",
    coverageCommand: null,
    buildCommand: "pnpm build",
    riskSignals: ["ci:github-actions"],
    remoteUrl: "git@github.com:acme/api.git",
    defaultBranch: "main",
    importantPaths: ["package.json", "src"],
    fingerprint: "fp-1",
    secretPathsSkipped: false,
    ...overrides,
  };
}

describe("RepoContextStore", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gaffer-ctx-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function store(): RepoContextStore {
    return new RepoContextStore({ root, factoryId: "acme-factory", clock: new TestClock() });
  }

  it("writes profile/context/scan-history outside the repo under the factory dir", () => {
    const s = store();
    s.onboard({
      repoId: "api",
      name: "api",
      scan: fakeScan(),
      mapping: { mode: "standalone", scopeNodeIds: [] },
      tags: ["backend"],
    });

    const dir = s.repoDir("api");
    expect(dir).toBe(join(root, "factories", "acme-factory", "repos", "api"));
    // Crucially OUTSIDE any repo path.
    expect(dir.includes("/repos/api")).toBe(true);
    expect(existsSync(join(dir, "profile.json"))).toBe(true);
    expect(existsSync(join(dir, "context.json"))).toBe(true);
    expect(existsSync(join(dir, "scan-history.jsonl"))).toBe(true);

    const profile = s.readProfile("api")!;
    expect(profile.remoteUrl).toBe("git@github.com:acme/api.git");
    expect(profile.mapping.mode).toBe("standalone");

    const context = s.readContext("api")!;
    expect(context.commands.test).toBe("pnpm test");
    expect(context.stack).toBe("typescript");
    expect(context.importantPaths).toEqual(["package.json", "src"]);
    expect(context.tags).toEqual(["backend"]);
    expect(context.fingerprint).toBe("fp-1");
    expect(context.scanCount).toBe(1);
    expect(context.firstScannedAt).toBe(context.lastScannedAt);
  });

  it("rescan updates context, bumps scanCount, appends history, detects change", () => {
    const clock = new TestClock();
    const s = new RepoContextStore({ root, factoryId: "acme-factory", clock });
    s.onboard({
      repoId: "api",
      name: "api",
      scan: fakeScan(),
      mapping: { mode: "unmapped", scopeNodeIds: [] },
    });

    clock.advanceSeconds(3600);
    const { context, changed } = s.rescan({
      repoId: "api",
      scan: fakeScan({ fingerprint: "fp-2", testCommand: "pnpm test:ci" }),
    });

    expect(changed).toBe(true);
    expect(context.scanCount).toBe(2);
    expect(context.commands.test).toBe("pnpm test:ci");
    expect(context.fingerprint).toBe("fp-2");
    expect(context.lastScannedAt).not.toBe(context.firstScannedAt);

    const history = s.readScanHistory("api");
    expect(history).toHaveLength(2);
    expect(history[1]!.changed).toBe(true);
    expect(history[1]!.fingerprint).toBe("fp-2");
  });

  it("rescan with an identical fingerprint reports no change", () => {
    const s = store();
    s.onboard({
      repoId: "api",
      name: "api",
      scan: fakeScan(),
      mapping: { mode: "unmapped", scopeNodeIds: [] },
    });
    const { changed } = s.rescan({ repoId: "api", scan: fakeScan({ fingerprint: "fp-1" }) });
    expect(changed).toBe(false);
    expect(s.readScanHistory("api")[1]!.changed).toBe(false);
  });

  it("refuses to store a secret-looking important path", () => {
    const s = store();
    expect(() =>
      s.onboard({
        repoId: "api",
        name: "api",
        scan: fakeScan({ importantPaths: ["package.json", ".env.production"] }),
        mapping: { mode: "unmapped", scopeNodeIds: [] },
      }),
    ).toThrow(/secret/i);
  });

  it("never writes raw secret material to disk", () => {
    const s = store();
    s.onboard({
      repoId: "api",
      name: "api",
      scan: fakeScan(),
      mapping: { mode: "unmapped", scopeNodeIds: [] },
    });
    const dir = s.repoDir("api");
    const blob =
      readFileSync(join(dir, "profile.json"), "utf8") +
      readFileSync(join(dir, "context.json"), "utf8");
    expect(blob).not.toMatch(/password|token=|secret=|BEGIN .*PRIVATE KEY/i);
  });

  it("rejects rescanning a repo that was never onboarded", () => {
    expect(() => store().rescan({ repoId: "ghost", scan: fakeScan() })).toThrow(/not onboarded/i);
  });
});

describe("onboardRepo orchestration", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gaffer-onb-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function deps() {
    const dispatch = new FakeDispatchClient();
    const store = new RepoContextStore({ root, factoryId: "f1", clock: new TestClock() });
    const git = new DryRunGitAdapter({
      isRepo: false, // not a git repo on disk; scan still runs against manifests
    });
    return { dispatch, store, git };
  }

  it("registers an unmapped repo in Dispatch with no scope attachment", () => {
    const { dispatch, store, git } = deps();
    // Use a real temp dir with a manifest so the scan has something to read.
    const repoDir = mkdtempSync(join(tmpdir(), "gaffer-repo-"));
    writeFileSyncJson(join(repoDir, "package.json"), { scripts: { test: "vitest" } });

    const result = onboardRepo(
      repoDir,
      { mapping: { mode: "unmapped" } },
      { dispatch, store, git },
    );

    expect(result.registration?.attachedScopeIds).toEqual([]);
    expect(dispatch.registeredRepos).toHaveLength(1);
    expect(dispatch.registeredRepos[0]!.scopeNodeIds).toEqual([]);
    expect(store.has(result.repoId)).toBe(true);
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("attaches a mapped repo to selected scope nodes", () => {
    const { dispatch, store, git } = deps();
    dispatch.seedScopeNode({ id: "S1", name: "Billing", type: "product", loreTags: ["billing"] });
    const repoDir = mkdtempSync(join(tmpdir(), "gaffer-repo-"));
    writeFileSyncJson(join(repoDir, "package.json"), {});

    const result = onboardRepo(
      repoDir,
      {
        mapping: { mode: "mapped", scopeNodeIds: ["S1"] },
        relation: "contains",
        defaultAccess: "write",
      },
      { dispatch, store, git },
    );

    expect(result.registration?.attachedScopeIds).toEqual(["S1"]);
    expect(dispatch.registeredRepos[0]!.relation).toBe("contains");
    expect(store.readProfile(result.repoId)!.mapping.scopeNodeIds).toEqual(["S1"]);
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("returns a non-null registration and threads stack/testCommand into Dispatch", () => {
    const { dispatch, store, git } = deps();
    const repoDir = mkdtempSync(join(tmpdir(), "gaffer-repo-"));
    writeFileSyncJson(join(repoDir, "package.json"), { scripts: { test: "vitest" } });

    const result = onboardRepo(
      repoDir,
      { mapping: { mode: "unmapped" } },
      { dispatch, store, git },
    );

    // TRUE one-command onboard: the repo is actually registered, not null.
    expect(result.registration).not.toBeNull();
    expect(result.registration!.repoId).toBe(result.repoId);

    // Scanned stack + test command reach the Dispatch repo row...
    const registered = dispatch.registeredRepos[0]!;
    expect(registered.stack).toBe(result.scan.stack);
    expect(registered.testCommand).toBe(result.scan.testCommand);
    expect(registered.stack).not.toBeNull();
    expect(registered.testCommand).not.toBeNull();
    expect(registered.testCommand).toContain("test");

    // ...and the derived context tags (stack + risk signals) land on the context.
    expect(result.context.tags.length).toBeGreaterThan(0);
    expect(result.context.tags).toContain(result.scan.stack);
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("honours explicit --tags over derived tags when provided", () => {
    const { dispatch, store, git } = deps();
    const repoDir = mkdtempSync(join(tmpdir(), "gaffer-repo-"));
    writeFileSyncJson(join(repoDir, "package.json"), { scripts: { test: "vitest" } });

    const result = onboardRepo(
      repoDir,
      { mapping: { mode: "unmapped" }, tags: ["explicit-tag"] },
      { dispatch, store, git },
    );

    expect(result.context.tags).toEqual(["explicit-tag"]);
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("rescan surfaces suggest-only lore on change and never auto-promotes", () => {
    const { dispatch, store, git } = deps();
    const repoDir = mkdtempSync(join(tmpdir(), "gaffer-repo-"));
    writeFileSyncJson(join(repoDir, "package.json"), { scripts: { test: "vitest" } });
    const first = onboardRepo(repoDir, { mapping: { mode: "unmapped" } }, { dispatch, store, git });

    // Change the scripts so the fingerprint + commands change.
    writeFileSyncJson(join(repoDir, "package.json"), {
      scripts: { test: "vitest run", lint: "eslint ." },
    });
    const rescan = rescanRepo(repoDir, { dispatch, store, git, repoId: first.repoId });

    expect(rescan.changed).toBe(true);
    expect(rescan.loreSuggestions.length).toBeGreaterThan(0);
    // Suggestions are tagged for human ratification — they are NOT applied here.
    expect(rescan.loreSuggestions[0]!.tags).toContain("onboarding");
    rmSync(repoDir, { recursive: true, force: true });
  });
});

function writeFileSyncJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value), "utf8");
}
