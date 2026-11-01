/**
 * The crew git adapter runs on the host (`crew run`, onboarding scans) in a repository
 * an agent may have edited. Like the runner's bookkeeping git (external review #9,
 * finding 2), it must never execute the repository's hooks or its fsmonitor program,
 * whatever environment it was started from.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { systemGitAdapter } from "../src/adapters/gitAdapter.js";

describe("systemGitAdapter never runs repository programs", () => {
  let dir: string;
  let saved: NodeJS.ProcessEnv;
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: "pipe" });

  beforeEach(() => {
    saved = { ...process.env };
    // As if started outside a runner process: no inherited GIT_CONFIG_* overrides.
    for (const k of Object.keys(process.env)) if (k.startsWith("GIT_CONFIG")) delete process.env[k];
    dir = mkdtempSync(join(tmpdir(), "crew-git-progs-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@e");
    git("config", "user.name", "t");
    writeFileSync(join(dir, "a.txt"), "a\n");
    git("add", "a.txt");
    git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "seed");
    mkdirSync(join(dir, "hooks-in-repo"));
    for (const h of ["post-checkout", "reference-transaction"]) {
      const p = join(dir, "hooks-in-repo", h);
      writeFileSync(p, `#!/bin/sh\necho ${h} >> "${join(dir, "marker")}"\n`);
      chmodSync(p, 0o755);
    }
    const fsm = join(dir, "fsm.sh");
    writeFileSync(fsm, `#!/bin/sh\necho fsmonitor >> "${join(dir, "marker")}"\nexit 1\n`);
    chmodSync(fsm, 0o755);
    git("config", "core.hooksPath", "hooks-in-repo");
    git("config", "core.fsmonitor", "./fsm.sh");
  });
  afterEach(() => {
    process.env = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  it("status runs no fsmonitor program", () => {
    systemGitAdapter.isClean(dir);
    expect(existsSync(join(dir, "marker"))).toBe(false);
  });

  it("creating a branch runs no hook", () => {
    systemGitAdapter.createBranch(dir, "gaffer/t-1", "main");
    expect(systemGitAdapter.currentBranch(dir)).toBe("gaffer/t-1");
    expect(existsSync(join(dir, "marker"))).toBe(false);
  });
});
