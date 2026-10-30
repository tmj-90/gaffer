import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initFactory } from "../src/config/init.js";
import { loadConfig, resolveEventLogPath } from "../src/config/loader.js";

function tmp(): string {
  // realpath: macOS tmpdir is a symlink, and process.cwd() reports the real path.
  return realpathSync(mkdtempSync(join(tmpdir(), "fg-evtlog-")));
}

describe("event log path resolution", () => {
  // Snapshot and restore GAFFER_CREW_EVENTS around each test so the suite never
  // bleeds env state onto neighbouring tests.
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.GAFFER_CREW_EVENTS;
    delete process.env.GAFFER_CREW_EVENTS;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.GAFFER_CREW_EVENTS;
    } else {
      process.env.GAFFER_CREW_EVENTS = savedEnv;
    }
  });

  it("returns the config default when GAFFER_CREW_EVENTS is unset", () => {
    const dir = tmp();
    const result = initFactory({ dir, factoryName: "test-factory" });
    const loaded = loadConfig(result.configPath);

    // The template's relative default resolves against the factory root.
    expect(loaded.config.logging.event_log_path).toBe(join(dir, ".crew", "events.jsonl"));
    expect(resolveEventLogPath(loaded)).toBe(join(dir, ".crew", "events.jsonl"));
  });

  it("resolves the relative default against the factory root, not the cwd", () => {
    const dir = tmp();
    const result = initFactory({ dir, factoryName: "test-factory" });
    // Load from a DIFFERENT cwd (e.g. `crew repo onboard .` run inside a repo):
    // the log must still land under the factory, never in that checkout.
    const elsewhere = tmp();
    const savedCwd = process.cwd();
    process.chdir(elsewhere);
    try {
      const loaded = loadConfig(result.configPath);
      expect(loaded.config.logging.event_log_path).toBe(join(dir, ".crew", "events.jsonl"));
      expect(resolveEventLogPath(loaded)).toBe(join(dir, ".crew", "events.jsonl"));
    } finally {
      process.chdir(savedCwd);
    }
  });

  it("resolves a relative GAFFER_CREW_EVENTS against the cwd at load time", () => {
    const dir = tmp();
    const result = initFactory({ dir, factoryName: "test-factory" });
    const elsewhere = tmp();
    mkdirSync(join(elsewhere, "data"));
    process.env.GAFFER_CREW_EVENTS = "data/events.jsonl";
    const savedCwd = process.cwd();
    process.chdir(elsewhere);
    try {
      const loaded = loadConfig(result.configPath);
      expect(loaded.config.logging.event_log_path).toBe(join(elsewhere, "data", "events.jsonl"));
    } finally {
      process.chdir(savedCwd);
    }
  });

  it("resolveEventLogPath returns the env override when GAFFER_CREW_EVENTS is set", () => {
    const dir = tmp();
    const override = `/tmp/gaffer-data-${process.pid}/events.jsonl`;
    process.env.GAFFER_CREW_EVENTS = override;

    const result = initFactory({ dir, factoryName: "test-factory" });
    const loaded = loadConfig(result.configPath);

    expect(resolveEventLogPath(loaded)).toBe(override);
  });

  it("loadConfig applies env override to config.logging.event_log_path", () => {
    const dir = tmp();
    const override = `/tmp/gaffer-data-${process.pid}/events.jsonl`;
    process.env.GAFFER_CREW_EVENTS = override;

    const result = initFactory({ dir, factoryName: "test-factory" });
    const loaded = loadConfig(result.configPath);

    // The config field itself must reflect the override so all consumers
    // (cli/index.ts, mcp/tools.ts) pick it up without an explicit resolver call.
    expect(loaded.config.logging.event_log_path).toBe(override);
  });

  it("ignores an empty GAFFER_CREW_EVENTS and falls back to config default", () => {
    const dir = tmp();
    process.env.GAFFER_CREW_EVENTS = "";

    const result = initFactory({ dir, factoryName: "test-factory" });
    const loaded = loadConfig(result.configPath);

    expect(loaded.config.logging.event_log_path).toBe(join(dir, ".crew", "events.jsonl"));
    expect(resolveEventLogPath(loaded)).toBe(join(dir, ".crew", "events.jsonl"));
  });

  it("config-level yaml path wins when env is unset", () => {
    const dir = tmp();
    const result = initFactory({ dir, factoryName: "test-factory" });

    // Patch the config file to use a custom path.
    const yaml = readFileSync(result.configPath, "utf8");
    const patched = yaml.replace(
      "event_log_path: ./.crew/events.jsonl",
      "event_log_path: /custom/path/events.jsonl",
    );
    writeFileSync(result.configPath, patched, "utf8");

    const loaded = loadConfig(result.configPath);

    expect(loaded.config.logging.event_log_path).toBe("/custom/path/events.jsonl");
    expect(resolveEventLogPath(loaded)).toBe("/custom/path/events.jsonl");
  });
});
