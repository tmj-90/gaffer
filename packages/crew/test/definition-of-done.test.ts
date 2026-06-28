import { describe, expect, it } from "vitest";

import {
  crewConfigSchema,
  definitionOfDoneSchema,
  repoSchema,
  resolveDefinitionOfDone,
} from "../src/config/schema.js";

describe("definition_of_done schema (I3)", () => {
  it("defaults every gate ON and the block enabled", () => {
    const dod = definitionOfDoneSchema.parse(undefined);
    expect(dod).toEqual({ enabled: true, tests: true, typecheck: true, lint: true });
  });

  it("lets a repo turn an individual gate off without affecting the others", () => {
    const dod = definitionOfDoneSchema.parse({ lint: false });
    expect(dod).toEqual({ enabled: true, tests: true, typecheck: true, lint: false });
  });

  it("adds typecheck_command (null by default) to the repo schema", () => {
    const repo = repoSchema.parse({ id: "r1", name: "repo", path: "/tmp/r1" });
    expect(repo.typecheck_command).toBeNull();
    expect(repo.definition_of_done).toBeUndefined();
  });

  it("surfaces a factory-wide default on the crew config", () => {
    const cfg = crewConfigSchema.parse({ factory: { name: "f" } });
    expect(cfg.definition_of_done).toEqual({
      enabled: true,
      tests: true,
      typecheck: true,
      lint: true,
    });
  });
});

describe("resolveDefinitionOfDone (I3)", () => {
  const factoryDefault = definitionOfDoneSchema.parse(undefined);

  it("falls back to the factory default when the repo has no override", () => {
    const repo = repoSchema.parse({ id: "r1", name: "repo", path: "/tmp/r1" });
    expect(resolveDefinitionOfDone(repo, factoryDefault)).toBe(factoryDefault);
  });

  it("uses the repo's own block when present (specific overrides general)", () => {
    const repo = repoSchema.parse({
      id: "r1",
      name: "repo",
      path: "/tmp/r1",
      definition_of_done: { enabled: false, tests: false },
    });
    const resolved = resolveDefinitionOfDone(repo, factoryDefault);
    expect(resolved.enabled).toBe(false);
    expect(resolved.tests).toBe(false);
    // Unset gates in the override still default ON.
    expect(resolved.typecheck).toBe(true);
    expect(resolved.lint).toBe(true);
  });
});
