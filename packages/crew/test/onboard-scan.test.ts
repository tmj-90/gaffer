/**
 * Repo onboarding scan (FG-003).
 *
 * Asserts the scan detects stack, commands (incl. Makefile targets), branch,
 * remote URL, default branch and a content fingerprint — and that it NEVER
 * reads or surfaces secret files/dirs (.env, .ssh, credentials).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DryRunGitAdapter, systemGitAdapter } from "../src/adapters/gitAdapter.js";
import { isSecretPath, isExcludedDir } from "../src/safety/secretPaths.js";
import { scanRepoForOnboarding } from "../src/onboarding/onboardScan.js";

function writeFile(dir: string, rel: string, body: string): void {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body, "utf8");
}

describe("secret-path discipline", () => {
  it("flags secret-looking files and directories", () => {
    for (const p of [
      ".env",
      ".env.production",
      "config/.env.local",
      "deploy/credentials/prod.json",
      "keys/server.pem",
      "certs/private.key",
      "home/.ssh/id_rsa",
      "infra/.aws/credentials",
      "app.secret.ts",
      "service-account-token.json",
    ]) {
      expect(isSecretPath(p)).toBe(true);
    }
  });

  it("does not flag ordinary source/manifest paths", () => {
    for (const p of ["src/index.ts", "package.json", "README.md", "lib/util.ts", "Makefile"]) {
      expect(isSecretPath(p)).toBe(false);
    }
  });

  it("excludes secret + heavy directories from descent", () => {
    for (const d of [".ssh", ".aws", "secrets", "credentials", ".git", "node_modules", "dist"]) {
      expect(isExcludedDir(d)).toBe(true);
    }
    expect(isExcludedDir("src")).toBe(false);
  });
});

describe("scanRepoForOnboarding (manifest detection, no git)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gaffer-onboard-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("detects Node stack and commands from package.json scripts", () => {
    writeFile(
      dir,
      "package.json",
      JSON.stringify({ scripts: { test: "vitest", lint: "eslint .", build: "tsc" } }),
    );
    writeFile(dir, "pnpm-lock.yaml", "");

    const scan = scanRepoForOnboarding(dir, new DryRunGitAdapter({ isRepo: false }));
    expect(scan.stack).toBe("typescript");
    expect(scan.packageManager).toBe("pnpm");
    expect(scan.testCommand).toBe("pnpm test");
    expect(scan.lintCommand).toBe("pnpm lint");
    expect(scan.buildCommand).toBe("pnpm build");
    expect(scan.importantPaths).toContain("package.json");
    expect(scan.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("detects an Expo mobile stack so the mobile skill pack routes", () => {
    writeFile(
      dir,
      "package.json",
      JSON.stringify({
        scripts: { start: "expo start" },
        dependencies: { expo: "^51.0.0", react: "18.2.0", "react-native": "0.74.0" },
      }),
    );

    const scan = scanRepoForOnboarding(dir, new DryRunGitAdapter({ isRepo: false }));
    // The compound label expands (split on "-") to include "expo" + "native", the
    // tokens the mobile-ui pack is tagged with, while still carrying "react"/"typescript".
    expect(scan.stack).toBe("typescript-react-native-expo");
  });

  it("detects a bare React Native stack (no Expo) as a mobile stack", () => {
    writeFile(
      dir,
      "package.json",
      JSON.stringify({
        scripts: { test: "jest" },
        dependencies: { react: "18.2.0", "react-native": "0.74.0" },
      }),
    );

    const scan = scanRepoForOnboarding(dir, new DryRunGitAdapter({ isRepo: false }));
    expect(scan.stack).toBe("typescript-react-native");
  });

  it("keeps a plain React web app as typescript-react (not a mobile stack)", () => {
    writeFile(
      dir,
      "package.json",
      JSON.stringify({ scripts: { build: "vite build" }, dependencies: { react: "18.2.0" } }),
    );

    const scan = scanRepoForOnboarding(dir, new DryRunGitAdapter({ isRepo: false }));
    expect(scan.stack).toBe("typescript-react");
  });

  it("detects a .NET solution as csharp with dotnet commands", () => {
    writeFile(dir, "Shop.sln", "Microsoft Visual Studio Solution File, Format Version 12.00\n");
    writeFile(dir, "src/Shop.Api/Shop.Api.csproj", '<Project Sdk="Microsoft.NET.Sdk.Web" />\n');

    const scan = scanRepoForOnboarding(dir, new DryRunGitAdapter({ isRepo: false }));
    expect(scan.stack).toBe("csharp");
    expect(scan.packageManager).toBe("dotnet");
    expect(scan.testCommand).toBe("dotnet test");
    expect(scan.buildCommand).toBe("dotnet build");
  });

  it("detects EVERY ecosystem in a mixed repo: .NET + TypeScript yields a compound stack", () => {
    // The usual mixed layout: the solution at the root, the SPA one directory down.
    writeFile(dir, "Shop.sln", "Microsoft Visual Studio Solution File, Format Version 12.00\n");
    writeFile(dir, "src/Shop.Api/Shop.Api.csproj", '<Project Sdk="Microsoft.NET.Sdk.Web" />\n');
    writeFile(
      dir,
      "web/package.json",
      JSON.stringify({
        scripts: { build: "vite build", test: "vitest" },
        dependencies: { react: "18.2.0" },
      }),
    );
    // node_modules is never entered, so a vendored manifest cannot add a stack.
    writeFile(dir, "web/node_modules/left-pad/package.json", JSON.stringify({ name: "left-pad" }));

    const scan = scanRepoForOnboarding(dir, new DryRunGitAdapter({ isRepo: false }));
    // Root ecosystem first (its commands win), the SPA's tokens appended: both the
    // csharp-conventions and typescript-conventions packs route from this label.
    expect(scan.stack).toBe("csharp-typescript-react");
    expect(scan.testCommand).toBe("dotnet test");
  });

  it("a Node root with a Go service beside it composes node + go, commands from the root", () => {
    writeFile(dir, "package.json", JSON.stringify({ scripts: { test: "vitest" } }));
    writeFile(dir, "services/indexer/go.mod", "module example.com/indexer\n");

    const scan = scanRepoForOnboarding(dir, new DryRunGitAdapter({ isRepo: false }));
    expect(scan.stack).toBe("node-go");
    expect(scan.testCommand).toBe("npm run test");
  });

  it("a Gradle build applying the Kotlin plugin is a kotlin stack; a Gemfile is ruby; Package.swift is swift", () => {
    writeFile(dir, "build.gradle.kts", 'plugins { kotlin("jvm") version "2.0.0" }\n');
    expect(scanRepoForOnboarding(dir, new DryRunGitAdapter({ isRepo: false })).stack).toBe(
      "kotlin",
    );
    rmSync(join(dir, "build.gradle.kts"));

    writeFile(dir, "Gemfile", 'source "https://rubygems.org"\ngem "rails"\n');
    writeFile(dir, ".rubocop.yml", "AllCops: {}\n");
    writeFile(dir, "spec/app_spec.rb", "");
    const ruby = scanRepoForOnboarding(dir, new DryRunGitAdapter({ isRepo: false }));
    expect(ruby.stack).toBe("ruby");
    expect(ruby.testCommand).toBe("bundle exec rspec");
    expect(ruby.lintCommand).toBe("bundle exec rubocop");
    rmSync(join(dir, "Gemfile"));
    rmSync(join(dir, ".rubocop.yml"));
    rmSync(join(dir, "spec"), { recursive: true });

    writeFile(dir, "Package.swift", "// swift-tools-version:5.9\n");
    expect(scanRepoForOnboarding(dir, new DryRunGitAdapter({ isRepo: false })).stack).toBe("swift");
  });

  it("folds Makefile targets into commands a stackless repo would otherwise lack", () => {
    // No recognised manifest → detectStack returns null and no commands; the
    // Makefile targets become the test/lint/build commands.
    writeFile(
      dir,
      "Makefile",
      "test:\n\t./run-tests.sh\nlint:\n\tshellcheck *.sh\nbuild:\n\tmake all\n",
    );

    const scan = scanRepoForOnboarding(dir, new DryRunGitAdapter({ isRepo: false }));
    expect(scan.stack).toBeNull();
    expect(scan.testCommand).toBe("make test");
    expect(scan.lintCommand).toBe("make lint");
    expect(scan.buildCommand).toBe("make build");
    expect(scan.importantPaths).toContain("Makefile");
  });

  it("never surfaces secret files in important paths and flags the skip", () => {
    writeFile(dir, "package.json", JSON.stringify({ scripts: { test: "vitest" } }));
    writeFile(dir, ".env", "API_TOKEN=supersecret\n");
    writeFile(dir, ".env.production", "DB_PASSWORD=hunter2\n");
    mkdirSync(join(dir, "secrets"), { recursive: true });
    writeFile(dir, "secrets/keystore.json", "{}");

    const scan = scanRepoForOnboarding(dir, new DryRunGitAdapter({ isRepo: false }));
    expect(scan.importantPaths.some((p) => p.includes(".env"))).toBe(false);
    expect(scan.importantPaths.some((p) => p.includes("secret"))).toBe(false);
    expect(scan.secretPathsSkipped).toBe(true);
    // The fingerprint must not have hashed any secret file.
    expect(JSON.stringify(scan)).not.toContain("supersecret");
    expect(JSON.stringify(scan)).not.toContain("hunter2");
  });

  it("reads remote URL and default branch from the git adapter", () => {
    writeFile(dir, "package.json", "{}");
    const git = new DryRunGitAdapter({
      isRepo: true,
      currentBranch: "feature/x",
      remoteUrl: "git@github.com:acme/api.git",
      defaultBranch: "main",
    });
    const scan = scanRepoForOnboarding(dir, git);
    expect(scan.isGitRepo).toBe(true);
    expect(scan.currentBranch).toBe("feature/x");
    expect(scan.remoteUrl).toBe("git@github.com:acme/api.git");
    expect(scan.defaultBranch).toBe("main");
  });
});

describe("scanRepoForOnboarding (real git repo)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gaffer-onboard-git-"));
    const git = (args: string[]) =>
      execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "Test"]);
    git(["remote", "add", "origin", "https://github.com/acme/widget.git"]);
    writeFile(dir, "Cargo.toml", '[package]\nname = "widget"\n');
    git(["add", "."]);
    git(["commit", "-q", "-m", "init"]);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("detects branch + remote from a real repo and a rust stack", () => {
    const scan = scanRepoForOnboarding(dir);
    expect(scan.isGitRepo).toBe(true);
    expect(scan.currentBranch).toBe("main");
    expect(scan.remoteUrl).toBe("https://github.com/acme/widget.git");
    expect(scan.stack).toBe("rust");
    expect(scan.testCommand).toBe("cargo test");
  });
});

/**
 * default_branch detection must always collapse to a single clean branch name
 * (regression for the bootstrap-onboard bug where it was stored as "HEAD\nmain").
 */
describe("systemGitAdapter.defaultBranch (single clean line)", () => {
  let dir: string;
  const git = (args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gaffer-default-branch-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("scans a fresh single-branch 'main' repo to exactly 'main' with no newline", () => {
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "Test"]);
    writeFile(dir, "README.md", "# x\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "init"]);

    const branch = systemGitAdapter.defaultBranch(dir);
    expect(branch).toBe("main");
    // The bug: a multi-line "HEAD\nmain" string would slip through here.
    expect(branch).not.toContain("\n");
  });

  it("falls back to 'main' for an unborn HEAD (git init, no commits)", () => {
    git(["init", "-q", "-b", "main"]);
    expect(systemGitAdapter.defaultBranch(dir)).toBe("main");
  });

  it("falls back to 'main' for a detached HEAD", () => {
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "Test"]);
    writeFile(dir, "a.txt", "1\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "c1"]);
    const sha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    git(["checkout", "-q", sha]); // detach HEAD

    const branch = systemGitAdapter.defaultBranch(dir);
    expect(branch).toBe("main");
    expect(branch).not.toContain("\n");
  });

  it("returns null when the path is not a git repo", () => {
    expect(systemGitAdapter.defaultBranch(dir)).toBeNull();
  });
});
