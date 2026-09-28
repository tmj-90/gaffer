import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { systemGitAdapter, type GitAdapter } from "../adapters/gitAdapter.js";
import { isExcludedDir } from "../safety/secretPaths.js";

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
    const deps = detectDeps(dir);
    // React Native / Expo first: these are mobile stacks even though they ship a
    // package.json, so the mobile skill pack must route to them. The compound label
    // expands (split on "-") to its parts at selection time, so "typescript-react-native"
    // also matches the broad "typescript"/"react" packs, and "expo" routes the mobile pack.
    if ("expo" in deps) stack = "typescript-react-native-expo";
    else if ("react-native" in deps) stack = "typescript-react-native";
    else if ("react" in deps) stack = "typescript-react";
    // A build script is NOT React: a plain TypeScript service/CLI (tsc, tsconfig, or the
    // typescript dependency) was labelled "typescript-react" and pulled the React design
    // and frontend packs into every delivery on it (seen live on a bootstrapped CLI).
    else if (
      "typescript" in deps ||
      fileExists(dir, "tsconfig.json") ||
      /\btsc\b/.test(scripts.build ?? "")
    )
      stack = "typescript";
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
  // A Gradle build that applies the Kotlin plugin is a Kotlin project: route the
  // kotlin-conventions pack, not java's. Same commands either way.
  const kotlin =
    !maven &&
    ((fileExists(dir, "build.gradle.kts") &&
      readsFile(dir, "build.gradle.kts", /kotlin\(|org\.jetbrains\.kotlin/)) ||
      (fileExists(dir, "build.gradle") &&
        readsFile(dir, "build.gradle", /org\.jetbrains\.kotlin|kotlin-gradle-plugin/)));
  return {
    stack: kotlin ? "kotlin" : "java",
    packageManager: maven ? "maven" : "gradle",
    testCommand: maven ? "mvn test" : "./gradlew test",
    lintCommand: null,
    coverageCommand: maven ? "mvn verify" : "./gradlew jacocoTestReport",
    buildCommand: maven ? "mvn package" : "./gradlew build",
  };
}

function readsFile(dir: string, name: string, re: RegExp): boolean {
  try {
    return re.test(readFileSync(join(dir, name), "utf8"));
  } catch {
    return false;
  }
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

/** A .NET project or solution at `dir`: *.sln / *.slnx / *.csproj / *.fsproj / global.json. */
function hasDotnetManifest(dir: string): boolean {
  if (fileExists(dir, "global.json") || fileExists(dir, "Directory.Build.props")) return true;
  return listDir(dir).some((f) => /\.(sln|slnx|csproj|fsproj|vbproj)$/i.test(f));
}

function detectDotnet(_dir: string): DetectedStack {
  return {
    stack: "csharp",
    packageManager: "dotnet",
    testCommand: "dotnet test",
    lintCommand: "dotnet format --verify-no-changes",
    coverageCommand: 'dotnet test --collect:"XPlat Code Coverage"',
    buildCommand: "dotnet build",
  };
}

function detectRuby(dir: string): DetectedStack {
  const rspec = existsSync(join(dir, "spec")) || fileExists(dir, ".rspec");
  return {
    stack: "ruby",
    packageManager: "bundler",
    testCommand: rspec ? "bundle exec rspec" : "bundle exec rake test",
    lintCommand: fileExists(dir, ".rubocop.yml") ? "bundle exec rubocop" : null,
    coverageCommand: null,
    buildCommand: null,
  };
}

function detectSwift(_dir: string): DetectedStack {
  return {
    stack: "swift",
    packageManager: "swiftpm",
    testCommand: "swift test",
    lintCommand: null,
    coverageCommand: "swift test --enable-code-coverage",
    buildCommand: "swift build",
  };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Every ecosystem detector, in PRIORITY order. The first one that fires at the repo
 * root is the PRIMARY ecosystem (its commands become the repo's test/lint/build
 * commands); every other one that fires contributes to the compound stack label.
 */
const DETECTORS: ReadonlyArray<{
  fires: (dir: string) => boolean;
  detect: (dir: string) => DetectedStack;
}> = [
  { fires: (d) => fileExists(d, "package.json"), detect: detectNode },
  {
    fires: (d) =>
      fileExists(d, "pyproject.toml") ||
      fileExists(d, "requirements.txt") ||
      fileExists(d, "setup.py"),
    detect: detectPython,
  },
  { fires: (d) => fileExists(d, "Cargo.toml"), detect: detectRust },
  {
    fires: (d) =>
      fileExists(d, "pom.xml") ||
      fileExists(d, "build.gradle") ||
      fileExists(d, "build.gradle.kts"),
    detect: detectJava,
  },
  { fires: (d) => fileExists(d, "go.mod"), detect: detectGo },
  { fires: hasDotnetManifest, detect: detectDotnet },
  { fires: (d) => fileExists(d, "Gemfile"), detect: detectRuby },
  { fires: (d) => fileExists(d, "Package.swift"), detect: detectSwift },
];

/** Every ecosystem whose manifest sits directly in `dir`, in priority order. */
function detectStacksAt(dir: string): DetectedStack[] {
  return DETECTORS.filter((d) => d.fires(dir)).map((d) => d.detect(dir));
}

/** Join stack labels into one compound label with no repeated token ("-" separated). */
export function composeStackLabel(stacks: readonly string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const label of stacks) {
    for (const token of label.split(/[-/]+/).filter(Boolean)) {
      if (!seen.has(token)) {
        seen.add(token);
        out.push(token);
      }
    }
  }
  return out.join("-");
}

/** How deep below the root the ecosystem scan looks, and how many dirs it will visit. */
const STACK_SCAN_DEPTH = 2;
const STACK_SCAN_MAX_DIRS = 400;

/**
 * Detect EVERY ecosystem in the repo: the manifests at the root, plus the manifests up
 * to two directories down (`api/*.csproj` beside `web/package.json`, or the
 * `apps/<name>/` / `services/<name>/` / `packages/<name>/` monorepo layout; excluded
 * dirs — node_modules, dist, .git, secret dirs, dot-dirs — are never entered, and the
 * walk is capped so a huge tree stays cheap). Returns the ecosystems in priority order
 * with the root's first. A .NET + TypeScript repo therefore yields
 * `[csharp, typescript-react]`, so BOTH conventions packs route, instead of whichever
 * manifest an if/else chain happened to test first.
 */
export function detectStacks(dir: string): DetectedStack[] {
  const found = detectStacksAt(dir);
  const seen = new Set(found.map((s) => s.stack));
  let visited = 0;
  const walk = (base: string, depth: number): void => {
    if (depth > STACK_SCAN_DEPTH || visited >= STACK_SCAN_MAX_DIRS) return;
    for (const entry of listDir(base).sort()) {
      if (visited >= STACK_SCAN_MAX_DIRS) return;
      if (isExcludedDir(entry) || entry.startsWith(".")) continue;
      const sub = join(base, entry);
      if (!isDirectory(sub)) continue;
      visited += 1;
      for (const s of detectStacksAt(sub)) {
        if (seen.has(s.stack)) continue;
        seen.add(s.stack);
        found.push(s);
      }
      walk(sub, depth + 1);
    }
  };
  walk(dir, 1);
  return found;
}

/**
 * Detect the repo's stack from its manifest files. Returns null if unknown. The
 * commands come from the PRIMARY ecosystem (root first, then priority order); the
 * `stack` label is the COMPOUND of every ecosystem found (see {@link detectStacks}),
 * which the skill selector expands to its parts.
 */
export function detectStack(dir: string): DetectedStack | null {
  const all = detectStacks(dir);
  if (all.length === 0) return null;
  const primary = all[0]!;
  return { ...primary, stack: composeStackLabel(all.map((s) => s.stack)) };
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
