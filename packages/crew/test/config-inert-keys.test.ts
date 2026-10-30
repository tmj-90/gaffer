/**
 * crew.yaml knobs the live factory never reads are named, not silently accepted.
 *
 * Regression: the `crew init` template offered definition_of_done ("The runner
 * runs these gates…"), safety.model_may_read_secret_files ("secrets never enter
 * model context"), context.token_budget, memory.required_before and more, yet
 * nothing in the live runner read them, and setting them produced no effect and
 * no warning. Now:
 *   - the keys with NO consumer are gone from the template (still accepted);
 *   - the mock-only and DoD keys left in the template say so on the page;
 *   - `crew doctor` names every unread key found in crew.yaml and WARNS when one
 *     is set deliberately (e.g. definition_of_done.tests: false);
 *   - the list stays honest: an "unread" key that gains a consumer under src/
 *     fails here, so it gets taken off the list.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

import { initFactory } from "../src/config/init.js";
import { findInertKeys, INERT_CONFIG_KEYS } from "../src/config/inertKeys.js";
import { defaultConfigYaml } from "../src/config/template.js";
import { FakeDispatchClient } from "../src/dispatch/fakeClient.js";
import { runDoctor } from "../src/ops/doctor.js";
import { loadFactory } from "../src/runtime/wiring.js";

const SRC = join(__dirname, "..", "src");

function srcFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? srcFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("INERT_CONFIG_KEYS stays honest", () => {
  const template = defaultConfigYaml({ factoryName: "t" });

  it("no 'unread' key has gained a consumer outside the config module", () => {
    const consumers = srcFiles(SRC).filter(
      (f) => !f.includes(join("src", "config")) && !f.endsWith(join("ops", "doctor.ts")),
    );
    for (const key of INERT_CONFIG_KEYS.filter((k) => k.scope === "unread")) {
      const leaf = key.path.split(".").pop()!;
      const readers = consumers.filter((f) => readFileSync(f, "utf8").includes(leaf));
      expect(readers, `${key.path} now has a consumer — take it off the list`).toEqual([]);
    }
  });

  it("the template no longer offers the keys that have no consumer", () => {
    const raw = parse(template) as unknown;
    const present = findInertKeys(raw).map((h) => h.at);
    // Only the keys the template keeps ON PURPOSE (each labelled below) remain.
    expect(present.sort()).toEqual(
      [
        "context.max_skills",
        "definition_of_done",
        "hooks.enabled",
        "loops.implementation.post_conditions.enabled",
      ].sort(),
    );
    for (const gone of [
      "token_budget",
      "required_before",
      "suggestion_policy",
      "model_may_read_secret_files",
      "require_clean_worktree_before_start",
      "redact_secrets_in_context",
    ]) {
      expect(template).not.toContain(gone);
    }
  });

  it("each kept inert key is labelled in the template as not read by the live runner", () => {
    expect(template).toMatch(/Definition of Done — NOT READ BY THE LIVE RUNNER/);
    expect(template).toMatch(/Hooks — crew run \(MOCK runtime\) only, not read by the live runner/);
    expect(template).toMatch(
      /post-conditions — crew run \(MOCK runtime\) only, not read\s+#\s+by the live runner/,
    );
    expect(template).toMatch(
      /max_skills — crew run \(MOCK runtime\) \+ crew MCP packet only, not read by the live\s+#\s+runner/,
    );
    expect(template).not.toMatch(/The runner runs these gates/);
    expect(template).not.toMatch(/secrets never enter model context/);
  });

  it("no live-path doc claims crew.yaml's definition_of_done configures the gates", () => {
    // README/SECURITY/tick.sh said DoD was "configurable per repo + factory-wide
    // (definition_of_done in crew.yaml)" and that GAFFER_DOD_* "carry the resolved
    // definition_of_done config": the runner never reads that block.
    const root = join(__dirname, "..", "..", "..");
    const lib = join(root, "runner", "lib");
    const docs = join(root, "docs");
    const files = [
      join(root, "README.md"),
      join(root, "SECURITY.md"),
      join(root, "runner", "README.md"),
      join(root, "runner", "tick.sh"),
      ...readdirSync(lib)
        .filter((f) => f.endsWith(".sh"))
        .map((f) => join(lib, f)),
      ...readdirSync(docs)
        .filter((f) => f.endsWith(".md"))
        .map((f) => join(docs, f)),
    ];
    const offenders = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, i) => ({ line, at: `${file}:${i + 1}` }))
        .filter(({ line }) => line.includes("definition_of_done") && !/not read/i.test(line))
        .map(({ at }) => at),
    );
    expect(offenders).toEqual([]);
  });
});

describe("crew doctor names unread crew.yaml keys", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gaffer-inert-keys-"));
    initFactory({ dir: tmp, factoryName: "inert", force: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  async function inertCheck() {
    const ctx = loadFactory({ config: join(tmp, "crew.yaml") });
    const report = await runDoctor({
      ctx,
      openDispatch: async () => new FakeDispatchClient(),
      env: {},
    });
    return report.checks.find((c) => c.label === "crew.yaml keys in effect");
  }

  function edit(mutate: (cfg: Record<string, any>) => void): void {
    const p = join(tmp, "crew.yaml");
    const cfg = parse(readFileSync(p, "utf8")) as Record<string, any>;
    mutate(cfg);
    writeFileSync(p, stringify(cfg));
  }

  it("a fresh factory is ok (the labelled defaults are untouched)", async () => {
    const check = await inertCheck();
    expect(check?.level).toBe("ok");
  });

  it("an old scaffold's unread keys at their defaults are ok, but named", async () => {
    edit((cfg) => {
      cfg.safety.model_may_read_secret_files = false;
      cfg.memory.required_before = {
        tags: ["auth", "payments", "migrations", "public_api", "security"],
      };
    });
    const check = await inertCheck();
    expect(check?.level).toBe("ok");
    expect(check?.detail).toContain("safety.model_may_read_secret_files");
    expect(check?.detail).toContain("memory.required_before");
  });

  it("warns when a DoD gate is switched off in crew.yaml (it would have no effect)", async () => {
    edit((cfg) => {
      cfg.definition_of_done.tests = false;
    });
    const check = await inertCheck();
    expect(check?.level).toBe("warn");
    expect(check?.detail).toContain("definition_of_done");
    expect(check?.detail).toContain("GAFFER_DOD_TESTS");
  });

  it("warns on a per-repo DoD override and a security-sounding key set deliberately", async () => {
    edit((cfg) => {
      cfg.repos = [{ id: "r", name: "app", path: tmp, definition_of_done: { tests: false } }];
      cfg.safety.model_may_read_secret_files = true;
      cfg.context.token_budget = 4000;
    });
    const check = await inertCheck();
    expect(check?.level).toBe("warn");
    expect(check?.detail).toContain("repos[app].definition_of_done");
    expect(check?.detail).toContain("safety.model_may_read_secret_files=true");
    expect(check?.detail).toContain("context.token_budget=4000");
  });

  it("warns when hooks are enabled (they run only in the mock crew run loop)", async () => {
    edit((cfg) => {
      cfg.hooks.enabled = true;
    });
    const check = await inertCheck();
    expect(check?.level).toBe("warn");
    expect(check?.detail).toContain("mock-only");
  });
});
