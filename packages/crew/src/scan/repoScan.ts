import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { systemGitAdapter, type GitAdapter } from "../adapters/gitAdapter.js";

export interface DetectedStack {
  stack: string;
  packageManager: string | null;
  testCommand: string | null;
  lintCommand: string | null;
  coverageCommand: string | null;
  buildCommand: string | null;
}

export interface RepoScanResult {
  path: string;
  name: string;
  isGitRepo: boolean;
  currentBranch: string | null;
  stack: string | null;
  packageManager: string | null;
  testCommand: string | null;
  lintCommand: string | null;
  coverageCommand: string | null;
  buildCommand: string | null;
  riskSignals: string[];
}

function fileExists(dir: string, name: string): boolean {
  return existsSync(join(dir, name));
}

function detectNode(dir: string): DetectedStack {
  let packageManager = "npm";
  if (fileExists(dir, "pnpm-lock.yaml")) packageManager = "pnpm";
  else if (fileExists(dir, "yarn.lock")) packageManager = "yarn";
  else if (fileExists(dir, "bun.lockb")) packageManager = "bun";

  let stack = "node";
  const scripts = readPackageScripts(dir);
  if (scripts) {
    if ("react" in detectDeps(dir) || hasScript(scripts, "build")) stack = "typescript-react";
    else stack = "node";
  }
  const runner = packageManager === "npm" ? "npm run" : packageManager;
  return {
    stack,
    packageManager,
    testCommand: scriptCommand(
      scripts,
      runner,
      "test",
      packageManager === "npm" ? "npm test" : `${packageManager} test`,
    ),
    lintCommand: scriptCommand(scripts, runner, "lint", null),
    coverageCommand: scriptCommand(scripts, runner, "coverage", null),
    buildCommand: scriptCommand(scripts, runner, "build", null),
  };
}

function readPackageScripts(dir: string): Record<string, string> | null {
  if (!fileExists(dir, "package.json")) return null;
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

function detectDeps(dir: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  } catch {
    return {};
  }
}

function hasScript(scripts: Record<string, string> | null, name: string): boolean {
  return scripts !== null && name in scripts;
}

function scriptCommand(
  scripts: Record<string, string> | null,
  runner: string,
  name: string,
  fallback: string | null,
): string | null {
  if (hasScript(scripts, name)) return `${runner} ${name}`;
  return fallback;
}

function detectPython(dir: string): DetectedStack {
  const poetry = fileExists(dir, "poetry.lock") || readsPyprojectTool(dir, "poetry");
  const pm = poetry ? "poetry" : fileExists(dir, "requirements.txt") ? "pip" : "pip";
  const prefix = poetry ? "poetry run " : "";
  return {
    stack: "python",
    packageManager: pm,
    testCommand: `${prefix}pytest`,
    lintCommand:
      fileExists(dir, "ruff.toml") || readsPyprojectTool(dir, "ruff")
        ? `${prefix}ruff check .`
        : null,
    coverageCommand: `${prefix}pytest --cov`,
    buildCommand: null,
  };
}

function readsPyprojectTool(dir: string, tool: string): boolean {
  if (!fileExists(dir, "pyproject.toml")) return false;
  try {
    return readFileSync(join(dir, "pyproject.toml"), "utf8").includes(tool);
  } catch {
    return false;
  }
}

function detectRust(_dir: string): DetectedStack {
  return {
    stack: "rust",
    packageManager: "cargo",
    testCommand: "cargo test",
    lintCommand: "cargo clippy",
    coverageCommand: "cargo llvm-cov",
    buildCommand: "cargo build",
  };
}

function detectJava(dir: string): DetectedStack {
  const maven = fileExists(dir, "pom.xml");
  return {
    stack: "java",
    packageManager: maven ? "maven" : "gradle",
    testCommand: maven ? "mvn test" : "./gradlew test",
    lintCommand: null,
    coverageCommand: maven ? "mvn verify" : "./gradlew jacocoTestReport",
    buildCommand: maven ? "mvn package" : "./gradlew build",
  };
}

function detectGo(_dir: string): DetectedStack {
  return {
    stack: "go",
    packageManager: "go",
    testCommand: "go test ./...",
    lintCommand: "go vet ./...",
    coverageCommand: "go test -cover ./...",
    buildCommand: "go build ./...",
  };
}

/** Detect stack from manifest files, in priority order. Returns null if unknown. */
export function detectStack(dir: string): DetectedStack | null {
  if (fileExists(dir, "package.json")) return detectNode(dir);
  if (
    fileExists(dir, "pyproject.toml") ||
    fileExists(dir, "requirements.txt") ||
    fileExists(dir, "setup.py")
  ) {
    return detectPython(dir);
  }
  if (fileExists(dir, "Cargo.toml")) return detectRust(dir);
  if (
    fileExists(dir, "pom.xml") ||
    fileExists(dir, "build.gradle") ||
    fileExists(dir, "build.gradle.kts")
  ) {
    return detectJava(dir);
  }
  if (fileExists(dir, "go.mod")) return detectGo(dir);
  return null;
}

/** Detect risk signals (infra, CI, migrations) for default risk classification. */
function detectRiskSignals(dir: string): string[] {
  const signals: string[] = [];
  if (existsSync(join(dir, ".github", "workflows"))) signals.push("ci:github-actions");
  if (existsSync(join(dir, "terraform"))) signals.push("infra:terraform");
  if (existsSync(join(dir, "k8s"))) signals.push("infra:k8s");
  if (existsSync(join(dir, "migrations")) || existsSync(join(dir, "alembic")))
    signals.push("data:migrations");
  if (fileExists(dir, "Dockerfile")) signals.push("infra:docker");
  return signals;
}

/** Scan a single repository directory: branch + stack + risk signals. */
export function scanRepo(dir: string, git: GitAdapter = systemGitAdapter): RepoScanResult {
  const isGitRepo = git.isRepo(dir);
  const stack = detectStack(dir);
  return {
    path: dir,
    name: basename(dir),
    isGitRepo,
    currentBranch: isGitRepo ? git.currentBranch(dir) : null,
    stack: stack?.stack ?? null,
    packageManager: stack?.packageManager ?? null,
    testCommand: stack?.testCommand ?? null,
    lintCommand: stack?.lintCommand ?? null,
    coverageCommand: stack?.coverageCommand ?? null,
    buildCommand: stack?.buildCommand ?? null,
    riskSignals: detectRiskSignals(dir),
  };
}
