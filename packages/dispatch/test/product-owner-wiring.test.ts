import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ACTION_COMMAND_ENVS, reportActionCommandWiring } from "../src/api/productOwner.js";

/**
 * Startup-diagnostic guard: a dashboard launched without the factory's action-command
 * env (the ad-hoc-launch footgun) has buttons that silently no-op. reportActionCommandWiring
 * splits the action commands into wired/missing and writes one human-readable line, so a
 * mis-launched dashboard is obvious from the API log.
 */
describe("reportActionCommandWiring", () => {
  it("reports every action command as missing for an empty env", () => {
    const lines: string[] = [];
    const { wired, missing } = reportActionCommandWiring({}, (l) => lines.push(l));
    expect(wired).toEqual([]);
    expect(missing).toEqual([...ACTION_COMMAND_ENVS]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("missing:");
    expect(lines[0]).toContain("gaffer dashboard");
  });

  it("splits wired vs missing and ignores whitespace-only values", () => {
    const env = {
      DISPATCH_PRODUCT_OWNER_CMD: "node po.mjs",
      DISPATCH_MERGE_CMD: "node merge.mjs",
      DISPATCH_TICK_CMD: "   ", // whitespace-only counts as missing
    } as NodeJS.ProcessEnv;
    const { wired, missing } = reportActionCommandWiring(env, () => {});
    expect(wired).toEqual(["DISPATCH_PRODUCT_OWNER_CMD", "DISPATCH_MERGE_CMD"]);
    expect(missing).toEqual([
      "DISPATCH_TICK_CMD",
      "DISPATCH_ONBOARD_CMD",
      "DISPATCH_TESTER_CMD",
      "DISPATCH_EPIC_FEATURE_CMD",
    ]);
  });

  it("reports all wired with no warning when every command is set", () => {
    const env = Object.fromEntries(
      ACTION_COMMAND_ENVS.map((k) => [k, "node x.mjs"]),
    ) as NodeJS.ProcessEnv;
    const lines: string[] = [];
    const { wired, missing } = reportActionCommandWiring(env, (l) => lines.push(l));
    expect(wired).toEqual([...ACTION_COMMAND_ENVS]);
    expect(missing).toEqual([]);
    expect(lines[0]).toContain("missing: (none)");
    expect(lines[0]).not.toContain("no-op");
  });
});

/**
 * Doc-drift guard: `.env.example` presents itself as the full wiring reference
 * and quickstart.md lists every command `gaffer dashboard` wires. A new action
 * command missing from either means a launch configured from the docs logs it
 * as "missing" and its dashboard action never runs.
 */
describe("action-command wiring docs", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const envExample = readFileSync(resolve(repoRoot, ".env.example"), "utf8");
  const quickstart = readFileSync(resolve(repoRoot, "quickstart.md"), "utf8");

  it.each([...ACTION_COMMAND_ENVS])(".env.example sets %s", (name) => {
    expect(envExample).toMatch(new RegExp(`^${name}="[^"]+"$`, "m"));
  });

  it.each([...ACTION_COMMAND_ENVS])("quickstart.md wiring reference names %s", (name) => {
    const start = quickstart.indexOf("Wiring reference");
    expect(start).toBeGreaterThanOrEqual(0);
    const block = quickstart.slice(start, quickstart.indexOf("\n\n", start));
    expect(block).toContain(`\`${name}\``);
  });
});
