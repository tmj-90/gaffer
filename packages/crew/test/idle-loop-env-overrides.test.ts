/**
 * B29 — the dashboard's idle-loop settings must reach the crew idle loops.
 *
 * Live audit: `GAFFER_IDLE_MODE` and `GAFFER_IDLE_FEATURE_BACKLOG` were in the Settings
 * allow-list (and exported into every runner child process) but had NO reader anywhere,
 * so the panel promised control it never had. They are now env overrides applied by
 * `loadConfig` on top of crew.yaml, like `GAFFER_CREW_EVENTS`.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initFactory } from "../src/config/init.js";
import {
  applyIdleLoopEnvOverrides,
  boolFromEnv,
  idleModeFromEnv,
  loadConfig,
  parseConfig,
} from "../src/config/loader.js";
import { defaultConfigYaml } from "../src/config/template.js";

const SAVED = ["GAFFER_IDLE_MODE", "GAFFER_IDLE_FEATURE_BACKLOG"] as const;
const saved: Partial<Record<(typeof SAVED)[number], string | undefined>> = {};

beforeEach(() => {
  for (const k of SAVED) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of SAVED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const IDLE_LOOPS = [
  "idle_coverage",
  "idle_test_quality",
  "idle_documentation",
  "idle_dependencies",
  "idle_security_hotspot",
  "idle_type_quality",
  "idle_tech_debt",
  "idle_feature_backlog",
] as const;

describe("idleModeFromEnv / boolFromEnv", () => {
  it("accepts the crew vocabulary and the panel's short forms; rejects garbage", () => {
    expect(idleModeFromEnv("observe_only")).toBe("observe_only");
    expect(idleModeFromEnv("create_draft_tickets")).toBe("create_draft_tickets");
    expect(idleModeFromEnv("create_ready_tickets")).toBe("create_ready_tickets");
    expect(idleModeFromEnv("create_draft")).toBe("create_draft_tickets");
    expect(idleModeFromEnv("create_ready")).toBe("create_ready_tickets");
    expect(idleModeFromEnv(" Observe_Only ")).toBe("observe_only");
    expect(idleModeFromEnv("")).toBeNull();
    expect(idleModeFromEnv(undefined)).toBeNull();
    expect(idleModeFromEnv("yolo")).toBeNull();
  });

  it("parses the settings-panel boolean forms", () => {
    for (const v of ["1", "true", "yes", "on", "TRUE"]) expect(boolFromEnv(v)).toBe(true);
    for (const v of ["0", "false", "no", "off"]) expect(boolFromEnv(v)).toBe(false);
    expect(boolFromEnv("")).toBeNull();
    expect(boolFromEnv("maybe")).toBeNull();
  });
});

describe("applyIdleLoopEnvOverrides", () => {
  const base = () => parseConfig(defaultConfigYaml("t"));

  it("leaves the config byte-identical when neither knob is set", () => {
    const cfg = base();
    expect(applyIdleLoopEnvOverrides(cfg, {})).toBe(cfg);
  });

  it("GAFFER_IDLE_MODE sets EVERY idle loop's mode and the safety default", () => {
    const cfg = applyIdleLoopEnvOverrides(base(), { GAFFER_IDLE_MODE: "observe_only" });
    for (const key of IDLE_LOOPS) expect(cfg.loops[key].mode).toBe("observe_only");
    expect(cfg.safety.default_idle_loop_mode).toBe("observe_only");
    // Nothing else moved.
    expect(cfg.loops.idle_coverage.enabled).toBe(base().loops.idle_coverage.enabled);
    expect(cfg.loops.maintenance).toEqual(base().loops.maintenance);
  });

  it("the panel's short form maps onto the crew vocabulary", () => {
    const cfg = applyIdleLoopEnvOverrides(base(), { GAFFER_IDLE_MODE: "create_ready" });
    expect(cfg.loops.idle_tech_debt.mode).toBe("create_ready_tickets");
  });

  it("an unrecognised mode is ignored — crew.yaml stands (never fail open to ready)", () => {
    const cfg = applyIdleLoopEnvOverrides(base(), { GAFFER_IDLE_MODE: "create_everything" });
    expect(cfg.loops.idle_coverage.mode).toBe("create_draft_tickets");
    expect(cfg.safety.default_idle_loop_mode).toBe("create_draft_tickets");
  });

  it("GAFFER_IDLE_FEATURE_BACKLOG flips only the backlog loop's enabled flag", () => {
    const on = applyIdleLoopEnvOverrides(base(), { GAFFER_IDLE_FEATURE_BACKLOG: "1" });
    expect(on.loops.idle_feature_backlog.enabled).toBe(true);
    expect(on.loops.idle_coverage.enabled).toBe(false);
    expect(on.loops.idle_feature_backlog.mode).toBe("create_draft_tickets");
    const off = applyIdleLoopEnvOverrides(
      {
        ...base(),
        loops: {
          ...base().loops,
          idle_feature_backlog: { ...base().loops.idle_feature_backlog, enabled: true },
        },
      },
      { GAFFER_IDLE_FEATURE_BACKLOG: "false" },
    );
    expect(off.loops.idle_feature_backlog.enabled).toBe(false);
  });
});

describe("loadConfig applies the overrides (what `fg idle` / `fg maintain` read)", () => {
  it("reads GAFFER_IDLE_MODE + GAFFER_IDLE_FEATURE_BACKLOG from the process env", () => {
    const dir = mkdtempSync(join(tmpdir(), "fg-idle-env-"));
    const result = initFactory({ dir, factoryName: "idle-env" });
    process.env.GAFFER_IDLE_MODE = "observe_only";
    process.env.GAFFER_IDLE_FEATURE_BACKLOG = "yes";
    const loaded = loadConfig(result.configPath);
    expect(loaded.config.loops.idle_security_hotspot.mode).toBe("observe_only");
    expect(loaded.config.loops.idle_feature_backlog.enabled).toBe(true);
    expect(loaded.config.loops.idle_feature_backlog.mode).toBe("observe_only");
    // The rest of the file is untouched.
    expect(loaded.config.factory.name).toBe("idle-env");
  });
});
