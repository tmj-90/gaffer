/**
 * ONBOARDING IDENTITY — a name match is a refresh only for the same repository.
 *
 * Two unrelated checkouts both named "api": the second onboard used to "succeed",
 * swallow dispatch's DUPLICATE, and rescan the stored profile — keeping the first's
 * local path with the second's remote. Now a name match with a different canonical
 * local path (or, for a path-less record, a different remote) is refused before any
 * write, and the same checkout is still a refresh.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DryRunGitAdapter } from "../src/adapters/gitAdapter.js";
import { FakeDispatchClient } from "../src/dispatch/fakeClient.js";
import { RepoContextStore } from "../src/onboarding/contextStore.js";
import { normalizeRemote, onboardRepo, sameRepository } from "../src/onboarding/onboard.js";
import { TestClock } from "../src/util/clock.js";

describe("sameRepository / normalizeRemote", () => {
  it("normalises https, scp-style and .git forms of one remote", () => {
    expect(normalizeRemote("https://github.com/Org/api.git")).toBe("github.com/org/api");
    expect(normalizeRemote("git@github.com:Org/api.git")).toBe("github.com/org/api");
    expect(normalizeRemote("ssh://git@github.com/org/api/")).toBe("github.com/org/api");
    expect(normalizeRemote("")).toBe("");
  });
  it("a record whose checkout is on disk matches only that canonical path", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "gaffer-id-")));
    try {
      mkdirSync(join(base, "a"));
      mkdirSync(join(base, "b"));
      const a = join(base, "a");
      expect(
        sameRepository(
          { source: "dispatch", localPath: a, remoteUrl: null },
          { path: a, remoteUrl: null },
        ),
      ).toBe(true);
      // A second clone of the same remote is still a second checkout.
      expect(
        sameRepository(
          { source: "dispatch", localPath: a, remoteUrl: "https://x/api" },
          { path: join(base, "b"), remoteUrl: "https://x/api" },
        ),
      ).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  it("a record whose checkout is gone (moved) matches on an identical remote only", () => {
    const gone = {
      source: "dispatch" as const,
      localPath: "/nonexistent/gaffer/api",
      remoteUrl: "https://h/o/api",
    };
    expect(sameRepository(gone, { path: "/new/api", remoteUrl: "git@h:o/api.git" })).toBe(true);
    expect(sameRepository(gone, { path: "/new/api", remoteUrl: "https://h/o/other" })).toBe(false);
    expect(
      sameRepository({ ...gone, remoteUrl: null }, { path: "/new/api", remoteUrl: null }),
    ).toBe(false);
  });
  it("a path-less record matches only an identical non-empty remote", () => {
    const rec = { source: "dispatch" as const, localPath: null, remoteUrl: "git@h:o/api.git" };
    expect(sameRepository(rec, { path: "/z", remoteUrl: "https://h/o/api" })).toBe(true);
    expect(sameRepository(rec, { path: "/z", remoteUrl: "https://h/other/api" })).toBe(false);
    expect(sameRepository({ ...rec, remoteUrl: null }, { path: "/z", remoteUrl: null })).toBe(
      false,
    );
  });
});

describe("onboardRepo refuses a name taken by a different repository", () => {
  let parent: string;
  let root: string;
  const git = new DryRunGitAdapter({ isRepo: false });
  beforeEach(() => {
    parent = realpathSync(mkdtempSync(join(tmpdir(), "gaffer-onboard-id-")));
    for (const d of ["one", "two"]) {
      mkdirSync(join(parent, d, "api"), { recursive: true });
      writeFileSync(join(parent, d, "api", "package.json"), "{}");
    }
    root = mkdtempSync(join(tmpdir(), "gaffer-onboard-id-store-"));
  });
  afterEach(() => {
    rmSync(parent, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("second unrelated 'api' → NAME_TAKEN, the first record untouched; same checkout refreshes", () => {
    const store = new RepoContextStore({ root, factoryId: "f", clock: new TestClock() });
    const dispatch = new FakeDispatchClient();
    const deps = { store, dispatch, git };
    onboardRepo(join(parent, "one", "api"), { mapping: { mode: "standalone" } }, deps);
    const before = store.readProfile("api");
    let code = "";
    try {
      onboardRepo(join(parent, "two", "api"), { mapping: { mode: "standalone" } }, deps);
    } catch (e) {
      code = (e as { code?: string }).code ?? "";
    }
    expect(code).toBe("NAME_TAKEN");
    expect(store.readProfile("api")).toEqual(before);
    // The same checkout, also through a symlink, is a refresh.
    symlinkSync(join(parent, "one", "api"), join(parent, "link"));
    expect(() =>
      onboardRepo(join(parent, "one", "api"), { mapping: { mode: "standalone" } }, deps),
    ).not.toThrow();
    expect(() =>
      onboardRepo(
        join(parent, "link"),
        { repoId: "api", name: "api", mapping: { mode: "standalone" } },
        deps,
      ),
    ).not.toThrow();
    // A distinct alias onboards the second as its own record.
    const r = onboardRepo(
      join(parent, "two", "api"),
      { repoId: "api-two", name: "api-two", mapping: { mode: "standalone" } },
      deps,
    );
    expect(r.profile.localPath).toBe(join(parent, "two", "api"));
    expect(store.readProfile("api")?.localPath).toBe(join(parent, "one", "api"));
  });
});
