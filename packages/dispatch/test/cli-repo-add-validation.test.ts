import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";

import { errorCode, runCli } from "./helpers/cli.js";

/**
 * Exploratory finding cli-wg/F-06: `wg repo add` stored a relative, missing or
 * non-git --path verbatim (a relative path then resolved against whatever cwd the
 * dashboard was started from) and accepted any name, `bad name/../x` included, while
 * `gaffer onboard` canonicalises the path (`cd "$path" && pwd -P`), refuses a missing
 * directory and warns "not a git repo". `repo add` now does the same, and repo names
 * refuse path separators, `.`/`..`, a leading '-' and control characters (unicode
 * letters and emoji stay allowed), at the domain boundary every surface shares.
 */
describe("cli-wg F-06: repo add validates --path and the name", () => {
  let dir: string;
  let db: string;
  let gitRepo: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "wg-repo-add-")));
    db = join(dir, "d.sqlite");
    Dispatch.open(db).db.close();
    gitRepo = join(dir, "taskflow");
    execFileSync("git", ["init", "-q", "-b", "trunk", gitRepo]);
    mkdirSync(join(dir, "notgit"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const stored = (name: string): string | null => {
    const wg = Dispatch.open(db);
    try {
      return wg.listRepositories().find((r) => r.name === name)?.local_path ?? null;
    } finally {
      wg.db.close();
    }
  };

  it("stores the canonical absolute path for a relative path and a symlink", () => {
    const rel = relative(process.cwd(), gitRepo);
    expect(runCli(db, ["repo", "add", "-n", "rel", "--path", rel]).error).toBeUndefined();
    expect(stored("rel")).toBe(gitRepo);
    const link = join(dir, "link");
    symlinkSync(gitRepo, link);
    const r = runCli(db, ["repo", "add", "-n", "linked", "--path", link]);
    expect(r.error).toBeUndefined();
    expect(stored("linked")).toBe(gitRepo);
    // The branch really is detected from the path.
    expect((r.json as { repo: { default_branch: string } }).repo.default_branch).toBe("trunk");
  });

  it("refuses a missing path and a file", () => {
    const missing = runCli(db, ["repo", "add", "-n", "ghost", "--path", "/nonexistent/xyz"]);
    expect(errorCode(missing.error)).toBe("VALIDATION_ERROR");
    expect(String((missing.error as Error).message)).toMatch(/no such directory/);
    const file = join(dir, "f.txt");
    writeFileSync(file, "x");
    expect(errorCode(runCli(db, ["repo", "add", "-n", "file", "--path", file]).error)).toBe(
      "VALIDATION_ERROR",
    );
    expect(stored("ghost")).toBeNull();
  });

  it("warns, and still registers, for a directory that is not a git repo", () => {
    const r = runCli(db, ["repo", "add", "-n", "notgit", "--path", join(dir, "notgit")]);
    expect(r.error).toBeUndefined();
    expect(r.stderr).toMatch(/not a git repo/);
    expect((r.json as { warnings: Array<{ code: string }> }).warnings[0]!.code).toBe(
      "NOT_A_GIT_REPO",
    );
    expect(stored("notgit")).toBe(join(dir, "notgit"));
  });

  it("refuses names with a path separator, dot segments, a leading dash or a control character", () => {
    for (const name of ["bad name/../x", "a\\b", "..", ".", "-rf", "tab\tname", "nul\u0000"]) {
      const r = runCli(db, ["repo", "add", "-n", name]);
      expect(r.error, JSON.stringify(name)).toBeDefined();
    }
    for (const name of ["emoji🚀", "café-api", "my.repo_2"]) {
      expect(runCli(db, ["repo", "add", "-n", name]).error, name).toBeUndefined();
    }
  });
});
