/**
 * `crew repo onboard .` must register the repo under its real name and an
 * absolute path.
 *
 * Regression: onboardRepo used basename(dir) and the raw dir as given, so `.`
 * registered a Dispatch repo named "." with local_path "." (resolved later against
 * whatever cwd read it, and colliding with every other repo onboarded as "."), and
 * a missing directory registered without error. Every call here runs from a temp
 * cwd so the relative paths mean something.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DryRunGitAdapter } from "../src/adapters/gitAdapter.js";
import { FakeDispatchClient } from "../src/dispatch/fakeClient.js";
import { RepoContextStore } from "../src/onboarding/contextStore.js";
import { onboardRepo, rescanRepo } from "../src/onboarding/onboard.js";
import { TestClock } from "../src/util/clock.js";

describe("onboardRepo / rescanRepo resolve a relative repo path", () => {
  let parent: string;
  let repoDir: string;
  let root: string;
  let savedCwd: string;
  const git = new DryRunGitAdapter({ isRepo: false });

  beforeEach(() => {
    // realpath: macOS tmpdir is a symlink, and resolve() follows the real cwd.
    parent = realpathSync(mkdtempSync(join(tmpdir(), "gaffer-onboard-rel-")));
    repoDir = join(parent, "my-app");
    mkdirSync(repoDir);
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    root = mkdtempSync(join(tmpdir(), "gaffer-onboard-rel-store-"));
    savedCwd = process.cwd();
    process.chdir(repoDir);
  });
  afterEach(() => {
    process.chdir(savedCwd);
    rmSync(parent, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  function deps() {
    return {
      store: new RepoContextStore({ root, factoryId: "f", clock: new TestClock() }),
      dispatch: new FakeDispatchClient(),
      git,
    };
  }

  for (const dot of [".", "./"]) {
    it(`onboardRepo('${dot}') registers the directory's basename and an absolute path`, () => {
      const d = deps();
      const result = onboardRepo(dot, { mapping: { mode: "standalone" } }, d);

      expect(result.repoId).toBe("my-app");
      expect(result.name).toBe("my-app");
      expect(result.profile.repoId).toBe("my-app");
      expect(result.scan.path).toBe(repoDir);
      expect(result.profile.localPath).toBe(repoDir);
      expect(d.dispatch.registeredRepos).toHaveLength(1);
      expect(d.dispatch.registeredRepos[0]).toMatchObject({
        repoId: "my-app",
        name: "my-app",
        localPath: repoDir,
      });
    });
  }

  it("a path relative to another cwd resolves too", () => {
    process.chdir(parent);
    const d = deps();
    const result = onboardRepo("my-app", { mapping: { mode: "unmapped" } }, d);
    expect(result.scan.path).toBe(repoDir);
    expect(basename(d.dispatch.registeredRepos[0]?.localPath ?? "")).toBe("my-app");
  });

  it("a missing directory throws NOT_FOUND and registers nothing", () => {
    const d = deps();
    expect(() => onboardRepo("./missing", { mapping: { mode: "standalone" } }, d)).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
    expect(d.dispatch.registeredRepos).toHaveLength(0);
  });

  it("a file (not a directory) is refused", () => {
    const d = deps();
    expect(() => onboardRepo("package.json", { mapping: { mode: "standalone" } }, d)).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
  });

  it("rescanRepo('.') stores an absolute path", () => {
    const d = deps();
    const first = onboardRepo(".", { mapping: { mode: "unmapped" } }, d);
    const rescan = rescanRepo(".", { ...d, repoId: first.repoId });
    expect(rescan.scan.path).toBe(repoDir);
    expect(d.store.readProfile(first.repoId)?.localPath).toBe(repoDir);
  });
});
