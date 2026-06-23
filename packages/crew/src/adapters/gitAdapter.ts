import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { CrewError } from "../util/errors.js";

/**
 * Thin, safe wrapper around the local `git` binary. Uses `execFileSync` (never a
 * shell) so arguments cannot be interpreted as shell metacharacters. Every
 * method targets an explicit repo directory.
 */
export interface GitAdapter {
  isRepo(repoDir: string): boolean;
  currentBranch(repoDir: string): string | null;
  isClean(repoDir: string): boolean;
  branchExists(repoDir: string, branch: string): boolean;
  createBranch(repoDir: string, branch: string, fromBranch?: string): void;
  /** The `origin` remote fetch URL, or null when there is no remote (FG-003). */
  remoteUrl(repoDir: string, remote?: string): string | null;
  /**
   * The repo's default branch (what `origin/HEAD` points at), falling back to
   * the current branch when no remote HEAD is known (FG-003). Null when not a repo.
   */
  defaultBranch(repoDir: string): string | null;
}

/** The repo's deterministic default-branch fallback when detection is unusable. */
const DEFAULT_BRANCH_FALLBACK = "main";

/**
 * First non-empty, trimmed line of a git command's output. Several git refspec
 * queries can emit MORE than one line (e.g. a `symbolic-ref`/`for-each-ref`/
 * `git branch` that yields both `HEAD` and `main`); storing the raw multi-line
 * blob produced the malformed `"HEAD\nmain"` default_branch we are fixing here.
 * Always collapse to a single clean branch name.
 */
function firstLine(out: string): string {
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

function run(repoDir: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", repoDir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (cause) {
    throw new CrewError("GIT_COMMAND_FAILED", `git ${args.join(" ")} failed in ${repoDir}`, {
      args,
      repoDir,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

export const systemGitAdapter: GitAdapter = {
  isRepo(repoDir: string): boolean {
    return existsSync(join(repoDir, ".git"));
  },

  currentBranch(repoDir: string): string | null {
    if (!this.isRepo(repoDir)) return null;
    try {
      // `--abbrev-ref HEAD` is "HEAD" on a detached head — treated as unusable.
      const branch = firstLine(run(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]));
      if (branch && branch !== "HEAD") return branch;
    } catch {
      // HEAD has no commits yet (unborn branch) — fall through to symbolic-ref.
    }
    try {
      // Works for a freshly-initialised repo with no commits.
      const ref = firstLine(run(repoDir, ["symbolic-ref", "--short", "-q", "HEAD"]));
      return ref.length > 0 ? ref : null;
    } catch {
      return null;
    }
  },

  isClean(repoDir: string): boolean {
    return run(repoDir, ["status", "--porcelain"]).length === 0;
  },

  branchExists(repoDir: string, branch: string): boolean {
    try {
      run(repoDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  },

  createBranch(repoDir: string, branch: string, fromBranch?: string): void {
    const args = ["checkout", "-b", branch];
    if (fromBranch) args.push(fromBranch);
    run(repoDir, args);
  },

  remoteUrl(repoDir: string, remote = "origin"): string | null {
    if (!this.isRepo(repoDir)) return null;
    try {
      const url = run(repoDir, ["remote", "get-url", remote]);
      return url.length > 0 ? url : null;
    } catch {
      return null;
    }
  },

  defaultBranch(repoDir: string): string | null {
    if (!this.isRepo(repoDir)) return null;
    try {
      // `origin/HEAD` symbolic ref, e.g. "origin/main" → "main". Collapse to the
      // first clean line so a multi-line query result can never leak through.
      const ref = firstLine(
        run(repoDir, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]),
      );
      const branch = ref.replace(/^origin\//, "");
      if (branch.length > 0) return branch;
    } catch {
      // No remote HEAD configured — fall through to the current branch.
    }
    // Detached HEAD / no commits yet → currentBranch is null; never store an
    // empty or multi-line value, fall back to the deterministic default branch.
    return this.currentBranch(repoDir) ?? DEFAULT_BRANCH_FALLBACK;
  },
};

/**
 * Dry-run git adapter for tests and `--dry-run` loops. Records created branches
 * without touching any real repository.
 */
export class DryRunGitAdapter implements GitAdapter {
  readonly createdBranches: Array<{ repoDir: string; branch: string; from?: string }> = [];
  private readonly branches = new Map<string, Set<string>>();

  constructor(
    private readonly opts: {
      isRepo?: boolean;
      currentBranch?: string | null;
      clean?: boolean;
      remoteUrl?: string | null;
      defaultBranch?: string | null;
    } = {},
  ) {}

  isRepo(_repoDir: string): boolean {
    return this.opts.isRepo ?? true;
  }

  currentBranch(_repoDir: string): string | null {
    return this.opts.currentBranch ?? "main";
  }

  remoteUrl(_repoDir: string, _remote?: string): string | null {
    return this.opts.remoteUrl ?? null;
  }

  defaultBranch(_repoDir: string): string | null {
    return this.opts.defaultBranch ?? this.currentBranch(_repoDir);
  }

  isClean(_repoDir: string): boolean {
    return this.opts.clean ?? true;
  }

  branchExists(repoDir: string, branch: string): boolean {
    return this.branches.get(repoDir)?.has(branch) ?? false;
  }

  createBranch(repoDir: string, branch: string, fromBranch?: string): void {
    const set = this.branches.get(repoDir) ?? new Set<string>();
    set.add(branch);
    this.branches.set(repoDir, set);
    this.createdBranches.push({ repoDir, branch, ...(fromBranch ? { from: fromBranch } : {}) });
  }
}
