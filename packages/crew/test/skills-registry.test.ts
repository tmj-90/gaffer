import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { builtinSkills } from "../src/skills/builtins.js";
import { SkillRegistry } from "../src/skills/registry.js";
import { loadSkillRegistry, parseSkillFile } from "../src/skills/loader.js";
import { CrewError } from "../src/util/errors.js";

describe("built-in skills", () => {
  it("ships the v1 minimum set, all schema-valid", () => {
    const ids = builtinSkills()
      .map((s) => s.id)
      .sort();
    expect(ids).toEqual(
      [
        "add-api-endpoint",
        "add-db-migration",
        "add-integration-test",
        "add-unit-test",
        "create-branch",
        "create-draft-ticket-from-finding",
        "fix-flaky-test",
        "record-evidence",
        "refactor-module",
        "run-coverage",
        "run-lint",
        "run-tests",
        "submit-review",
        "update-docs",
      ].sort(),
    );
    expect(ids).toHaveLength(14);
  });

  it("each built-in has at least one step and a version", () => {
    for (const skill of builtinSkills()) {
      expect(skill.steps.length).toBeGreaterThan(0);
      expect(skill.version).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("SkillRegistry.select", () => {
  it("selects by capability", () => {
    const registry = new SkillRegistry(builtinSkills());
    const tests = registry.select({ capabilities: ["tests"] }).map((s) => s.id);
    expect(tests).toContain("run-tests");
    expect(tests).toContain("run-coverage");
    expect(tests).not.toContain("create-branch");
  });

  it("selects by stack — stack-agnostic built-ins always match", () => {
    const registry = new SkillRegistry(builtinSkills());
    const forPython = registry
      .select({ stacks: ["python"], capabilities: ["git"] })
      .map((s) => s.id);
    expect(forPython).toEqual(["create-branch"]);
  });

  it("a stack-scoped skill only matches its stacks", () => {
    const registry = new SkillRegistry([
      ...builtinSkills(),
      parseSkillFile(
        `id: add-fastapi-endpoint
version: 1
name: Add FastAPI endpoint
applies_to:
  stacks: [python, fastapi]
  capabilities: [backend]
steps:
  - inspect routes
  - add handler
evidence: [diff_summary]`,
      )[0]!,
    ]);

    const py = registry.select({ stacks: ["python"], capabilities: ["backend"] }).map((s) => s.id);
    expect(py).toContain("add-fastapi-endpoint");

    const ts = registry
      .select({ stacks: ["typescript"], capabilities: ["backend"] })
      .map((s) => s.id);
    expect(ts).not.toContain("add-fastapi-endpoint");
  });

  it("throws a structured error for an unknown id", () => {
    const registry = new SkillRegistry(builtinSkills());
    expect(() => registry.get("nope")).toThrow(CrewError);
  });
});

describe("loadSkillRegistry", () => {
  it("loads built-ins plus YAML skills from the factory skills/ directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "fg-skills-"));
    mkdirSync(join(dir, "skills"));
    writeFileSync(
      join(dir, "skills", "custom.yaml"),
      `id: deploy-preview
version: 2
name: Deploy preview
applies_to:
  stacks: [typescript]
  capabilities: [deploy]
steps:
  - build the app
  - push a preview
evidence: [preview_url]`,
    );

    const registry = loadSkillRegistry({ factoryDir: dir });
    expect(registry.find("deploy-preview")?.version).toBe(2);
    expect(registry.find("run-tests")).toBeDefined();
    expect(registry.select({ capabilities: ["deploy"] }).map((s) => s.id)).toContain(
      "deploy-preview",
    );
  });

  it("a human file overrides a built-in by id", () => {
    const dir = mkdtempSync(join(tmpdir(), "fg-skills-override-"));
    mkdirSync(join(dir, "skills"));
    writeFileSync(
      join(dir, "skills", "override.yaml"),
      `id: run-tests
version: 9
name: Run tests (custom)
applies_to:
  capabilities: [tests]
steps:
  - custom step`,
    );
    const registry = loadSkillRegistry({ factoryDir: dir });
    expect(registry.get("run-tests").version).toBe(9);
  });
});
