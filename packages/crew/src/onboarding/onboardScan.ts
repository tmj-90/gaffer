import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { systemGitAdapter, type GitAdapter } from "../adapters/gitAdapter.js";
import { isExcludedDir, isSecretPath } from "../safety/secretPaths.js";
import { scanRepo, type RepoScanResult } from "../scan/repoScan.js";

/**
 * Repo onboarding scan (FG-003).
 *
 * Extends the base {@link scanRepo} (stack + commands + branch + risk signals)
 * with the extra detection onboarding needs: the `origin` remote URL, the
 * default branch, commands declared in a Makefile (not just package.json/etc.),
 * the repo's important top-level paths, and a content fingerprint of the
 * manifest set so a later rescan can tell whether anything material changed.
 *
 * SECURITY: this scan NEVER reads secret files or descends into secret/heavy
 * directories — every path is filtered through {@link isSecretPath} /
 * {@link isExcludedDir} (the shared secret-path discipline). No file content is
 * stored; only derived facts and a hash.
 */

export interface OnboardingScanResult extends RepoScanResult {
  /** `origin` remote fetch URL, or null when the repo has no remote. */
  remoteUrl: string | null;
  /** Default branch (origin/HEAD, else current branch), or null. */
  defaultBranch: string | null;
  /**
   * Commands resolved with Makefile targets folded in. A Makefile `test:` target
   * supplies a `make test` command when the stack detection found none.
   */
  testCommand: string | null;
  lintCommand: string | null;
  buildCommand: string | null;
  coverageCommand: string | null;
  /** Important top-level paths worth surfacing (src dirs, manifests, CI, docs). */
  importantPaths: string[];
  /** SHA-256 over the manifest set's (path,size) pairs — the content fingerprint. */
  fingerprint: string;
  /** True when at least one secret-looking path was seen and deliberately skipped. */
  secretPathsSkipped: boolean;
}

/** Manifest/important files probed at the repo root, in a stable order. */
const IMPORTANT_FILES: readonly string[] = [
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Makefile",
  "Dockerfile",
  "docker-compose.yml",
  "README.md",
  "tsconfig.json",
];

/** Top-level directories worth recording as important when present. */
const IMPORTANT_DIRS: readonly string[] = [
  "src",
  "lib",
  "app",
  "test",
  "tests",
  "docs",
  ".github",
  "migrations",
];

/** Parse phony-style Makefile target names (`name:`), ignoring secret-looking ones. */
function parseMakefileTargets(dir: string): Set<string> {
  const targets = new Set<string>();
  const makefile = join(dir, "Makefile");
  if (!existsSync(makefile) || isSecretPath("Makefile")) return targets;
  let body: string;
  try {
    body = readFileSync(makefile, "utf8");
  } catch {
    return targets;
  }
  for (const line of body.split("\n")) {
    const match = /^([A-Za-z0-9_.-]+)\s*:(?!=)/.exec(line);
    if (match) targets.add(match[1]!);
  }
  return targets;
}

/** Fill a missing command from a Makefile target of the same name (e.g. `make test`). */
function withMakefileCommands(
  base: RepoScanResult,
  targets: ReadonlySet<string>,
): Pick<OnboardingScanResult, "testCommand" | "lintCommand" | "buildCommand" | "coverageCommand"> {
  const fromTarget = (existing: string | null, target: string): string | null =>
    existing ?? (targets.has(target) ? `make ${target}` : null);
  return {
    testCommand: fromTarget(base.testCommand, "test"),
    lintCommand: fromTarget(base.lintCommand, "lint"),
    buildCommand: fromTarget(base.buildCommand, "build"),
    coverageCommand: fromTarget(base.coverageCommand, "coverage"),
  };
}

/** Collect the repo's important top-level paths (secret paths always excluded). */
function collectImportantPaths(dir: string): { paths: string[]; secretSeen: boolean } {
  const paths: string[] = [];
  let secretSeen = false;
  const seen = (rel: string): void => {
    if (isSecretPath(rel)) {
      secretSeen = true;
      return;
    }
    paths.push(rel);
  };
  for (const file of IMPORTANT_FILES) {
    if (existsSync(join(dir, file))) seen(file);
  }
  for (const sub of IMPORTANT_DIRS) {
    const full = join(dir, sub);
    if (existsSync(full) && safeIsDir(full)) {
      if (isExcludedDir(sub)) continue;
      seen(sub);
    }
  }

  // Shallow top-level sweep: flag (and refuse to record) any secret-looking
  // entry actually present at the repo root. This is what makes
  // `secretPathsSkipped` a real, observable proof that the scan saw — and
  // deliberately excluded — secret material, rather than silently never looking.
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (isSecretPath(entry)) secretSeen = true;
  }

  return { paths, secretSeen };
}

function safeIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Fingerprint the repo's manifest set: a SHA-256 over each manifest's
 * (relative-path, byte-size) pair. We hash SIZE, never CONTENT, so a secret
 * accidentally placed in a manifest never enters the digest — and so the
 * fingerprint is cheap and changes when dependencies/scripts change. Secret
 * paths are excluded from the digest entirely.
 */
function fingerprintManifests(dir: string): string {
  const hash = createHash("sha256");
  for (const file of IMPORTANT_FILES) {
    if (isSecretPath(file)) continue;
    const full = join(dir, file);
    if (!existsSync(full)) continue;
    try {
      const size = statSync(full).size;
      hash.update(`${file}:${size}\n`);
    } catch {
      // Unreadable manifest contributes nothing — never throw mid-scan.
    }
  }
  return hash.digest("hex");
}

/**
 * Run the full onboarding scan for a repo directory. Pure detection; never
 * mutates the repo and never reads secret files.
 */
export function scanRepoForOnboarding(
  dir: string,
  git: GitAdapter = systemGitAdapter,
): OnboardingScanResult {
  const base = scanRepo(dir, git);
  const targets = parseMakefileTargets(dir);
  const commands = withMakefileCommands(base, targets);
  const { paths, secretSeen } = collectImportantPaths(dir);

  return {
    ...base,
    ...commands,
    remoteUrl: base.isGitRepo ? git.remoteUrl(dir) : null,
    defaultBranch: base.isGitRepo ? git.defaultBranch(dir) : null,
    importantPaths: paths,
    fingerprint: fingerprintManifests(dir),
    secretPathsSkipped: secretSeen,
  };
}
