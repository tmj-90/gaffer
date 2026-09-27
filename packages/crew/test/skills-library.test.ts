/**
 * B30 — the crew skill registry reads the factory's SKILL.md library.
 *
 * Live audit: the registry loaded 14 descriptive built-ins and never read
 * `runner/skills/<name>/SKILL.md` — the skills the live agents are actually mounted —
 * so tick.sh's `fg skills --stack X` fallback returned placeholders, never a real
 * skill. Covers: frontmatter → registry skill (id/name/description/stack/area, steps
 * from the numbered procedure), tolerant parsing, the default library path resolving
 * to the in-repo runner/skills, compound stack-label expansion, and the override
 * order (built-in < SKILL.md < factory YAML).
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  defaultSkillMdDir,
  loadSkillMdLibrary,
  loadSkillRegistry,
  parseSkillMd,
  skillMdSteps,
} from "../src/skills/loader.js";
import { expandStackLabels } from "../src/skills/registry.js";

const SKILL_MD = `---
name: add-fastapi-endpoint
description: Use when a ticket adds an HTTP endpoint to a FastAPI service.
stack: [python, fastapi]
area: backend
---

# Add a FastAPI endpoint

Prose before the steps.

## Steps

1. **Inspect the routes** and find the router the endpoint belongs to.
2. Add the handler with a typed request/response model.
3. Write the integration test (\`add-integration-test\` skill).

## Evidence

- test output
`;

describe("parseSkillMd", () => {
  it("maps frontmatter + numbered steps onto a registry skill", () => {
    const skill = parseSkillMd(SKILL_MD, "add-fastapi-endpoint")!;
    expect(skill).not.toBeNull();
    expect(skill.id).toBe("add-fastapi-endpoint");
    expect(skill.name).toBe("add-fastapi-endpoint");
    expect(skill.description).toMatch(/^Use when/);
    expect(skill.area).toBe("backend");
    expect(skill.applies_to.stacks).toEqual(["python", "fastapi"]);
    expect(skill.applies_to.capabilities).toEqual(["backend"]);
    expect(skill.steps).toEqual([
      "Inspect the routes and find the router the endpoint belongs to.",
      "Add the handler with a typed request/response model.",
      "Write the integration test (`add-integration-test` skill).",
    ]);
  });

  it("falls back to the directory name, an empty stack, and the description as the step", () => {
    const skill = parseSkillMd("---\ndescription: Use to do X.\n---\n\nJust prose.\n", "bare")!;
    expect(skill.id).toBe("bare");
    expect(skill.name).toBe("bare");
    expect(skill.applies_to.stacks).toEqual([]);
    expect(skill.applies_to.capabilities).toEqual([]);
    expect(skill.steps).toEqual(["Use to do X."]);
  });

  it("is tolerant: no frontmatter / non-map frontmatter → null, never a throw", () => {
    expect(parseSkillMd("# no frontmatter\n", "x")).toBeNull();
    expect(parseSkillMd("---\n- a list\n---\nbody", "x")).toBeNull();
    expect(parseSkillMd("---\n: bad: yaml: [\n---\nbody", "x")).toBeNull();
  });

  it("skillMdSteps only reads the Steps section", () => {
    expect(skillMdSteps("## Steps\n\n1. one\n2. two\n\n## Notes\n\n3. not a step\n", "d")).toEqual([
      "one",
      "two",
    ]);
    expect(skillMdSteps("no numbered items", "fallback")).toEqual(["fallback"]);
  });
});

describe("loadSkillMdLibrary + loadSkillRegistry", () => {
  it("loads every <dir>/SKILL.md from a library directory, skipping junk", () => {
    const lib = mkdtempSync(join(tmpdir(), "fg-skill-md-"));
    mkdirSync(join(lib, "add-fastapi-endpoint"));
    writeFileSync(join(lib, "add-fastapi-endpoint", "SKILL.md"), SKILL_MD);
    mkdirSync(join(lib, "broken"));
    writeFileSync(join(lib, "broken", "SKILL.md"), "no frontmatter here\n");
    mkdirSync(join(lib, "no-skill-file"));
    writeFileSync(join(lib, "README.md"), "not a skill dir\n");
    const skills = loadSkillMdLibrary(lib);
    expect(skills.map((s) => s.id)).toEqual(["add-fastapi-endpoint"]);
    expect(loadSkillMdLibrary(join(lib, "does-not-exist"))).toEqual([]);
  });

  it("the default library is the in-repo runner/skills, and its skills are real", () => {
    const dir = defaultSkillMdDir({});
    expect(dir.endsWith(join("runner", "skills"))).toBe(true);
    expect(existsSync(dir)).toBe(true);
    const registry = loadSkillRegistry({ skillMdDir: dir });
    // Well over the 14 built-ins: the whole library is in the registry.
    expect(registry.list().length).toBeGreaterThan(100);
    const ts = registry.find("typescript-conventions")!;
    expect(ts).toBeDefined();
    expect(ts.applies_to.stacks).toContain("typescript");
    expect(ts.area).toBe("language");
    expect(ts.description.length).toBeGreaterThan(20);
    expect(ts.steps.length).toBeGreaterThan(1);
    // A library SKILL.md replaces the descriptive built-in of the same name.
    expect(registry.get("run-tests").description).not.toBe("");
  });

  it("SKILLS_DIR in the env wins over the in-repo default", () => {
    expect(defaultSkillMdDir({ SKILLS_DIR: "/opt/skills" })).toBe("/opt/skills");
  });

  it("`fg skills --stack <compound-label>` semantics: expansion makes stack-tagged skills match", () => {
    expect(expandStackLabels(["Typescript-React-Native-Expo"])).toEqual([
      "typescript-react-native-expo",
      "typescript",
      "react",
      "native",
      "expo",
    ]);
    const registry = loadSkillRegistry({ skillMdDir: defaultSkillMdDir({}) });
    const raw = registry.select({ stacks: ["typescript-react"] }).map((s) => s.id);
    const expanded = registry
      .select({ stacks: expandStackLabels(["typescript-react"]) })
      .map((s) => s.id);
    expect(raw).not.toContain("typescript-conventions"); // the raw label matches nothing tagged
    expect(expanded).toContain("typescript-conventions");
    expect(expanded).toContain("react-patterns");
    // Stack-agnostic library skills (empty stack list) are selectable for any stack.
    expect(expanded).toContain("fix-bug");
  });

  it("override order: built-in < SKILL.md library < factory skills/ YAML", () => {
    const lib = mkdtempSync(join(tmpdir(), "fg-skill-md-order-"));
    mkdirSync(join(lib, "run-tests"));
    writeFileSync(
      join(lib, "run-tests", "SKILL.md"),
      "---\nname: run-tests\ndescription: Use to run the tests.\nstack: []\narea: testing\n---\n\n## Steps\n\n1. run them\n",
    );
    const factory = mkdtempSync(join(tmpdir(), "fg-skill-md-factory-"));
    mkdirSync(join(factory, "skills"));
    writeFileSync(
      join(factory, "skills", "override.yaml"),
      "id: run-tests\nversion: 9\nname: Run tests (custom)\napplies_to:\n  capabilities: [tests]\nsteps:\n  - custom step\n",
    );
    const libOnly = loadSkillRegistry({ skillMdDir: lib });
    expect(libOnly.get("run-tests").description).toBe("Use to run the tests.");
    expect(libOnly.get("run-tests").area).toBe("testing");
    const withYaml = loadSkillRegistry({ skillMdDir: lib, factoryDir: factory });
    expect(withYaml.get("run-tests").version).toBe(9);
    // Built-ins only, when the library is switched off.
    expect(loadSkillRegistry({ skillMdDir: false }).list()).toHaveLength(14);
  });
});
