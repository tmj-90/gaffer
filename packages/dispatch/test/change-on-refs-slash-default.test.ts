/**
 * External review finding 3 (review13/3): changeOnRefs only accepted remote-tracking
 * refs with exactly four components, so a default branch with a slash in its name
 * (`release/v1`, ref `refs/remotes/origin/release/v1`) was never recognised as landed
 * upstream. A real git fixture: the PR merged upstream, the local default is stale.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { changeOnRefs } from "../src/services/ticketGitService.js";

let root: string;
// No injected runner: changeOnRefs runs the real git.
const NO_RUNNER = { gitRunner: undefined } as Parameters<typeof changeOnRefs>[1];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).trim();
}

function hostFor(localPath: string, defaultBranch: string) {
  return {
    repos: {
      findById: (id: string) =>
        id === "r1" ? { id: "r1", local_path: localPath, default_branch: defaultBranch } : null,
    },
  } as unknown as Parameters<typeof changeOnRefs>[0];
}

/** upstream (default `release/v1`) → local clone; a feature commit merged upstream only. */
function fixture(): { local: string; sha: string } {
  const upstream = join(root, "upstream");
  const local = join(root, "local");
  execFileSync("git", ["init", "-q", "-b", "release/v1", upstream]);
  writeFileSync(join(upstream, "a.txt"), "one\n");
  git(upstream, "add", "-A");
  git(upstream, "commit", "-qm", "root");
  execFileSync("git", ["clone", "-q", upstream, local]);
  git(local, "checkout", "-q", "-b", "gaffer/ticket-1-x");
  writeFileSync(join(local, "b.txt"), "change\n");
  git(local, "add", "-A");
  git(local, "commit", "-qm", "the change");
  const sha = git(local, "rev-parse", "HEAD");
  git(local, "push", "-q", "origin", "gaffer/ticket-1-x");
  // The PR merges upstream; the local release/v1 is left stale.
  git(upstream, "merge", "-q", "--no-ff", "-m", "merge PR", "gaffer/ticket-1-x");
  git(local, "fetch", "-q", "origin");
  return { local, sha };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "slash-default-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("changeOnRefs with a default branch that has a slash (review13/3)", () => {
  it("recognises the change on refs/remotes/origin/release/v1 while the local default is stale", () => {
    const { local, sha } = fixture();
    // The stale local default does not carry it…
    expect(changeOnRefs(hostFor(local, "release/v1"), NO_RUNNER, "r1", sha, ["default"])).toBe(
      false,
    );
    // …the remote-tracking default does.
    expect(
      changeOnRefs(hostFor(local, "release/v1"), NO_RUNNER, "r1", sha, ["remote-default"]),
    ).toBe(true);
  });

  it("does not take a remote branch that only ends with the default's name", () => {
    const { local, sha } = fixture();
    // Point origin/release/v1 back at the stale tip and put the change on
    // origin/hotfix/release/v1 instead: that ref is not the default branch.
    const carrying = git(local, "rev-parse", "refs/remotes/origin/release/v1");
    git(local, "update-ref", "refs/remotes/origin/hotfix/release/v1", carrying);
    git(local, "update-ref", "refs/remotes/origin/release/v1", "refs/heads/release/v1");
    expect(
      changeOnRefs(hostFor(local, "release/v1"), NO_RUNNER, "r1", sha, ["remote-default"]),
    ).toBe(false);
  });
});
