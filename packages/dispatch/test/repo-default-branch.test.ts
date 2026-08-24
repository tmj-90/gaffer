import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import { detectDefaultBranch } from "../src/cli/commands/repo.js";
import { Dispatch } from "../src/core.js";
import type { Actor, Repository } from "../src/domain/types.js";
import { listEvents } from "../src/events/eventWriter.js";
import { TestClock } from "../src/util/clock.js";
import { DispatchError } from "../src/util/errors.js";

const human: Actor = { type: "human", id: "tom" };

function fresh(): Dispatch {
  return Dispatch.open(":memory:", new TestClock());
}

// --- Core: set default branch round-trip -----------------------------------

describe("repo default branch — core", () => {
  it("a newly registered repo defaults to main", () => {
    const wg = fresh();
    const repo = wg.registerRepository({ name: "alpha" }, human);
    expect(repo.default_branch).toBe("main");
  });

  it("sets the default branch by name and by id, round-tripping the value", () => {
    const wg = fresh();
    const repo = wg.registerRepository({ name: "widget" }, human);

    const byName = wg.setRepoDefaultBranch("widget", "master", human);
    expect(byName.default_branch).toBe("master");

    const byId = wg.setRepoDefaultBranch(repo.id, "develop", human);
    expect(byId.id).toBe(repo.id);
    expect(byId.default_branch).toBe("develop");
  });

  it("writes a default_branch_changed event carrying the from/to", () => {
    const wg = fresh();
    const repo = wg.registerRepository({ name: "audited" }, human);
    wg.setRepoDefaultBranch(repo.id, "trunk", human);
    const evs = listEvents(wg.db, "repository", repo.id);
    const changed = evs.find((e) => e.event_type === "repository.default_branch_changed");
    expect(changed).toBeTruthy();
    const payload = JSON.parse(changed?.payload_json ?? "{}") as { from?: string; to?: string };
    expect(payload.from).toBe("main");
    expect(payload.to).toBe("trunk");
  });

  it("is idempotent: setting the same branch is a no-op (no extra event)", () => {
    const wg = fresh();
    const repo = wg.registerRepository({ name: "idem", default_branch: "main" }, human);
    const before = listEvents(wg.db, "repository", repo.id).length;
    wg.setRepoDefaultBranch(repo.id, "main", human); // unchanged
    const after = listEvents(wg.db, "repository", repo.id).length;
    expect(after).toBe(before);
  });

  it("throws NOT_FOUND when the repo does not exist", () => {
    const wg = fresh();
    try {
      wg.setRepoDefaultBranch("ghost", "main", human);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchError);
      expect((err as DispatchError).code).toBe("NOT_FOUND");
    }
  });

  it("rejects an unsafe branch name (GIT_REF_SAFE) rather than persisting it", () => {
    const wg = fresh();
    wg.registerRepository({ name: "guarded" }, human);
    expect(() => wg.setRepoDefaultBranch("guarded", "../evil", human)).toThrow();
    expect(() => wg.setRepoDefaultBranch("guarded", "", human)).toThrow();
    // The stored value is unchanged after the rejected writes.
    expect(wg.listRepositories(true).find((r) => r.name === "guarded")?.default_branch).toBe(
      "main",
    );
  });
});

// --- CLI helper: detectDefaultBranch against real git repos -----------------

describe("detectDefaultBranch", () => {
  const dirs: string[] = [];
  function repoOnBranch(branch: string): string {
    const dir = mkdtempSync(join(tmpdir(), "gaffer-branch-"));
    dirs.push(dir);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", dir, ...args], {
        stdio: "pipe",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      });
    git("init", "-q", "-b", branch);
    git(
      "-c",
      "user.email=t@t.invalid",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    );
    return dir;
  }
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  it("detects a repo checked out on master", () => {
    expect(detectDefaultBranch(repoOnBranch("master"))).toBe("master");
  });

  it("detects a repo checked out on main", () => {
    expect(detectDefaultBranch(repoOnBranch("main"))).toBe("main");
  });

  it("detects a non-conventional default branch name", () => {
    expect(detectDefaultBranch(repoOnBranch("trunk"))).toBe("trunk");
  });

  it("returns undefined for a missing path or a non-git directory", () => {
    expect(detectDefaultBranch(undefined)).toBeUndefined();
    const plain = mkdtempSync(join(tmpdir(), "gaffer-plain-"));
    dirs.push(plain);
    expect(detectDefaultBranch(plain)).toBeUndefined();
  });
});

// --- REST surface -----------------------------------------------------------

interface Harness {
  wg: Dispatch;
  baseUrl: string;
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const wg = Dispatch.open(":memory:", new TestClock());
  const server = createApiServer(wg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    wg,
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

async function call(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

describe("repo default branch — REST surface", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("POST /repos/:id/default-branch sets the branch and returns the repo", async () => {
    const repo = h.wg.registerRepository({ name: "rest-repo" }, human);
    const set = await call(h.baseUrl, "POST", `/repos/${repo.id}/default-branch`, {
      default_branch: "master",
    });
    expect(set.status).toBe(200);
    expect((set.body.repository as Repository).default_branch).toBe("master");

    // The change is visible in the repo list.
    const repos = await call(h.baseUrl, "GET", "/repositories");
    const listed = (repos.body.repositories as Repository[]).find((r) => r.name === "rest-repo");
    expect(listed?.default_branch).toBe("master");
  });

  it("resolves by repo name too", async () => {
    h.wg.registerRepository({ name: "by-name" }, human);
    const set = await call(h.baseUrl, "POST", `/repos/by-name/default-branch`, {
      default_branch: "develop",
    });
    expect(set.status).toBe(200);
    expect((set.body.repository as Repository).default_branch).toBe("develop");
  });

  it("rejects a missing repo with 404 and a bad body with 422", async () => {
    const missing = await call(h.baseUrl, "POST", "/repos/nope/default-branch", {
      default_branch: "main",
    });
    expect(missing.status).toBe(404);

    const repo = h.wg.registerRepository({ name: "validate-branch" }, human);
    const empty = await call(h.baseUrl, "POST", `/repos/${repo.id}/default-branch`, {
      default_branch: "",
    });
    expect(empty.status).toBe(422);
    const unsafe = await call(h.baseUrl, "POST", `/repos/${repo.id}/default-branch`, {
      default_branch: "../../etc",
    });
    expect(unsafe.status).toBe(422);
  });
});
