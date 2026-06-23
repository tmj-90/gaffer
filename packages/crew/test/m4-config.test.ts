import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isAbsolute } from "node:path";

import { initFactory } from "../src/config/init.js";
import {
  loadConfig,
  loadSafetyPolicy,
  parseConfig,
  resolveSqlitePath,
} from "../src/config/loader.js";
import { defaultConfigYaml, defaultSafetyPolicyYaml } from "../src/config/template.js";
import { CrewError } from "../src/util/errors.js";
import { scanRepo, detectStack } from "../src/scan/repoScan.js";
import { systemGitAdapter } from "../src/adapters/gitAdapter.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "fg-cfg-"));
}

describe("crew init", () => {
  it("generates a valid config + safety policy that round-trip through the loader", () => {
    const dir = tmp();
    const result = initFactory({ dir, factoryName: "demo-factory" });
    expect(result.created).toHaveLength(2);

    const loaded = loadConfig(result.configPath);
    expect(loaded.config.factory.name).toBe("demo-factory");
    expect(loaded.config.factory.mode).toBe("local_strict");

    const policy = loadSafetyPolicy(loaded);
    expect(policy.git.require_branch_prefix).toBe("dispatch/");
    expect(policy.git.deny_force_push).toBe(true);
  });

  it("does not overwrite existing files unless forced", () => {
    const dir = tmp();
    initFactory({ dir, factoryName: "a" });
    const second = initFactory({ dir, factoryName: "b" });
    expect(second.skipped).toHaveLength(2);
    expect(second.created).toHaveLength(0);

    const forced = initFactory({ dir, factoryName: "c", force: true });
    expect(forced.created).toHaveLength(2);
  });

  it("templates parse through the zod schemas directly", () => {
    const cfg = parseConfig(defaultConfigYaml({ factoryName: "x" }));
    expect(cfg.loops.idle_coverage.mode).toBe("create_draft_tickets");
    // safety policy template parses too
    expect(defaultSafetyPolicyYaml()).toContain("dispatch/");
  });

  it("a fresh config has the scan loops OFF with the threshold field present", () => {
    const cfg = parseConfig(defaultConfigYaml({ factoryName: "x" }));

    // Delivery loop stays on; every idle SCAN loop is off by default.
    expect(cfg.loops.implementation.enabled).toBe(true);
    expect(cfg.loops.idle_coverage.enabled).toBe(false);
    expect(cfg.loops.idle_test_quality.enabled).toBe(false);
    expect(cfg.loops.idle_documentation.enabled).toBe(false);
    expect(cfg.loops.idle_dependencies.enabled).toBe(false);
    expect(cfg.loops.idle_security_hotspot.enabled).toBe(false);

    // The per-repo delivered-ticket knobs are present and discoverable.
    expect(cfg.loops.default_min_delivered_tickets).toBe(0);
    for (const loop of [
      cfg.loops.idle_coverage,
      cfg.loops.idle_test_quality,
      cfg.loops.idle_documentation,
      cfg.loops.idle_dependencies,
      cfg.loops.idle_security_hotspot,
    ]) {
      expect(loop.min_delivered_tickets).toBeNull();
    }

    // The template text comments both knobs so a user can find them.
    const yaml = defaultConfigYaml({ factoryName: "x" });
    expect(yaml).toContain("default_min_delivered_tickets");
    expect(yaml).toContain("min_delivered_tickets");
    expect(yaml).toMatch(/enabled: false # set true to scan coverage/);
  });

  it("rejects a negative min_delivered_tickets", () => {
    const yaml =
      "factory:\n  name: f\nloops:\n  idle_test_quality:\n    min_delivered_tickets: -1\n";
    expect(() => parseConfig(yaml)).toThrow();
  });

  // Regression: `init` must point Crew at <factory_root>/dispatch.sqlite —
  // an absolute, cwd-independent path — so it opens the SAME db the orchestrator
  // + dashboard use, never a different cwd-relative one.
  it("writes an absolute sqlite_path that does not depend on cwd", () => {
    const factoryDir = tmp(); // tmpA — the factory root passed to init -d
    const otherDir = tmp(); // tmpB — an unrelated working directory

    const originalCwd = process.cwd();
    process.chdir(otherDir);
    try {
      const result = initFactory({ dir: factoryDir, factoryName: "from-other-cwd" });
      const loaded = loadConfig(result.configPath);

      // The persisted value is absolute and does not depend on cwd.
      expect(isAbsolute(loaded.config.dispatch.local.sqlite_path)).toBe(true);

      const resolved = resolveSqlitePath(loaded);
      expect(resolved).toBe(join(factoryDir, "dispatch.sqlite"));
      // Crucially, NOT under the unrelated cwd.
      expect(resolved.startsWith(otherDir)).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("resolves a relative sqlite_path against the config dir, never cwd", () => {
    const factoryDir = tmp();
    const otherDir = tmp();
    // Hand-edited config with a relative path (the defense-in-depth case).
    const yaml = defaultConfigYaml({
      factoryName: "hand-edited",
      sqlitePath: "./db/dispatch.sqlite",
    });
    writeFileSync(join(factoryDir, "crew.yaml"), yaml, "utf8");

    const originalCwd = process.cwd();
    process.chdir(otherDir);
    try {
      const loaded = loadConfig(join(factoryDir, "crew.yaml"));
      const resolved = resolveSqlitePath(loaded);
      expect(resolved).toBe(join(factoryDir, "db", "dispatch.sqlite"));
      expect(resolved.startsWith(otherDir)).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe("config validation errors", () => {
  it("reports a precise path for a missing factory name", () => {
    expect(() => parseConfig("factory:\n  mode: local_strict\n")).toThrowError(CrewError);
    try {
      parseConfig("factory:\n  mode: local_strict\n");
    } catch (err) {
      const e = err as CrewError;
      expect(e.code).toBe("INVALID_CONFIG");
      expect(e.message).toMatch(/factory\.name/);
    }
  });

  it("reports an invalid enum value with its path", () => {
    try {
      parseConfig("factory:\n  name: f\n  mode: galaxy_brain\n");
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as CrewError;
      expect(e.code).toBe("INVALID_CONFIG");
      expect(e.message).toMatch(/factory\.mode/);
    }
  });

  it("rejects an invalid idle-loop mode with its path", () => {
    const yaml = "factory:\n  name: f\nloops:\n  idle_coverage:\n    mode: yolo\n";
    try {
      parseConfig(yaml);
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as CrewError;
      expect(e.code).toBe("INVALID_CONFIG");
      expect(e.message).toMatch(/loops\.idle_coverage\.mode/);
    }
  });

  it("rejects a repo missing a path", () => {
    const yaml = "factory:\n  name: f\nrepos:\n  - id: r\n    name: r\n";
    try {
      parseConfig(yaml);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as CrewError).message).toMatch(/repos\.0\.path/);
    }
  });
});

describe("repo scan", () => {
  it("detects a node/typescript-react stack from package.json", () => {
    const dir = tmp();
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest", build: "tsc" }, dependencies: { react: "^18" } }),
    );
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9");
    const stack = detectStack(dir);
    expect(stack?.stack).toBe("typescript-react");
    expect(stack?.packageManager).toBe("pnpm");
    expect(stack?.testCommand).toBe("pnpm test");
  });

  it("detects a python/poetry stack", () => {
    const dir = tmp();
    writeFileSync(join(dir, "pyproject.toml"), "[tool.poetry]\n[tool.ruff]\n");
    const stack = detectStack(dir);
    expect(stack?.stack).toBe("python");
    expect(stack?.packageManager).toBe("poetry");
    expect(stack?.lintCommand).toMatch(/ruff/);
  });

  it("detects a rust stack from Cargo.toml", () => {
    const dir = tmp();
    writeFileSync(join(dir, "Cargo.toml"), "[package]\nname='x'");
    expect(detectStack(dir)?.stack).toBe("rust");
  });

  it("detects a java stack from pom.xml", () => {
    const dir = tmp();
    writeFileSync(join(dir, "pom.xml"), "<project/>");
    expect(detectStack(dir)?.stack).toBe("java");
  });

  it("detects the current git branch", () => {
    const dir = tmp();
    execFileSync("git", ["-C", dir, "init", "-q", "-b", "trunk"]);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    const result = scanRepo(dir, systemGitAdapter);
    expect(result.isGitRepo).toBe(true);
    expect(result.currentBranch).toBe("trunk");
    expect(result.stack).toBe("node");
  });

  it("flags infra/ci risk signals", () => {
    const dir = tmp();
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    mkdirSync(join(dir, "migrations"), { recursive: true });
    const result = scanRepo(dir, systemGitAdapter);
    expect(result.riskSignals).toContain("ci:github-actions");
    expect(result.riskSignals).toContain("data:migrations");
  });
});

describe("safety policy explains denials", () => {
  it("can be loaded from an init'd factory and explains a denial", () => {
    const dir = tmp();
    const result = initFactory({ dir, factoryName: "x" });
    // sanity: written file is non-empty
    expect(readFileSync(result.safetyPolicyPath, "utf8").length).toBeGreaterThan(0);
  });
});
