import { describe, expect, it } from "vitest";

import { crewConfigSchema } from "../src/config/schema.js";
import { FakeDispatchClient } from "../src/dispatch/fakeClient.js";
import { EventLog } from "../src/events/eventLog.js";
import { withDispatchRepos } from "../src/registry/dispatchRepos.js";
import { RepoRegistry } from "../src/registry/repoRegistry.js";
import { systemClock } from "../src/util/clock.js";

function registryWith(repos: Array<{ id: string; name: string; path: string }>): RepoRegistry {
  const config = crewConfigSchema.parse({
    factory: { name: "t", mode: "local_strict" },
    repos: repos.map((r) => ({ ...r, stack: "typescript" })),
  });
  return RepoRegistry.fromConfig(config, "/tmp");
}

describe("withDispatchRepos — Dispatch's registry is the idle loops' repo source", () => {
  it("adds every Dispatch repo with a local path, carrying its commands, branch and risk", () => {
    const wg = new FakeDispatchClient();
    wg.seedRepository({
      id: "r1",
      name: "api",
      localPath: "/srv/api",
      defaultBranch: "develop",
      stack: "typescript",
      riskLevel: "low",
      testCommand: "pnpm test",
      lintCommand: "pnpm lint",
    });
    const events = new EventLog(systemClock);

    const merged = withDispatchRepos(registryWith([]), wg, events);

    const api = merged.get("api");
    expect(api.path).toBe("/srv/api");
    expect(api.default_branch).toBe("develop");
    expect(api.risk_level).toBe("low");
    expect(api.test_command).toBe("pnpm test");
    expect(api.lint_command).toBe("pnpm lint");
    expect(merged.absolutePath(api)).toBe("/srv/api");
    expect(events.types()).toContain("dispatch_repos_merged");
  });

  it("skips a Dispatch repo without a local path (nothing on disk to scan)", () => {
    const wg = new FakeDispatchClient();
    wg.seedRepository({ name: "remote-only", localPath: null });
    const merged = withDispatchRepos(registryWith([]), wg);
    expect(merged.list()).toHaveLength(0);
  });

  it("crew.yaml wins on an id or name clash (per-repo overrides survive)", () => {
    const wg = new FakeDispatchClient();
    wg.seedRepository({ id: "other-id", name: "api", localPath: "/elsewhere/api" });
    wg.seedRepository({ id: "web", name: "web-renamed", localPath: "/srv/web" });
    const registry = registryWith([
      { id: "api", name: "api", path: "/srv/api" },
      { id: "web", name: "web", path: "/srv/web" },
    ]);

    const merged = withDispatchRepos(registry, wg);

    expect(merged.list()).toHaveLength(2);
    expect(merged.get("api").path).toBe("/srv/api");
    expect(merged.get("web").name).toBe("web");
  });

  it("defaults risk to medium so a fresh repo is never auto-promoted under a low ceiling", () => {
    const wg = new FakeDispatchClient();
    wg.seedRepository({ name: "fresh", localPath: "/srv/fresh", riskLevel: "" });
    // An empty risk string is not a valid level: the row is skipped and recorded,
    // rather than admitted with an invented risk.
    const events = new EventLog(systemClock);
    const merged = withDispatchRepos(registryWith([]), wg, events);
    expect(merged.list()).toHaveLength(0);
    expect(events.types()).toContain("dispatch_repo_skipped");

    const wg2 = new FakeDispatchClient();
    wg2.seedRepository({ name: "fresh", localPath: "/srv/fresh" });
    expect(withDispatchRepos(registryWith([]), wg2).get("fresh").risk_level).toBe("medium");
  });

  it("fails soft when the facade cannot list repositories", () => {
    const wg = new FakeDispatchClient();
    wg.listRepositories = () => {
      throw new Error("no such method");
    };
    const registry = registryWith([{ id: "api", name: "api", path: "/srv/api" }]);
    const events = new EventLog(systemClock);
    const merged = withDispatchRepos(registry, wg, events);
    expect(merged.list().map((r) => r.name)).toEqual(["api"]);
    expect(events.types()).toContain("dispatch_repos_unavailable");
  });
});
