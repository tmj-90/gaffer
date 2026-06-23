import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isKnownSetting,
  listSettings,
  readSettingsFile,
  resolveSettingsPath,
  SETTING_DEFS,
  writeSettings,
} from "../src/api/settings.js";

describe("settings module: file contract + env-override semantics", () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wg-settings-"));
    settingsPath = join(dir, "settings.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves the path under $GAFFER_DATA as settings.json", () => {
    const p = resolveSettingsPath({ GAFFER_DATA: dir });
    expect(p).toBe(join(dir, "settings.json"));
  });

  it("reports every known setting, value '' when unset, with type + group", () => {
    const views = listSettings({}, settingsPath);
    expect(views.length).toBe(SETTING_DEFS.length);
    const byKey = new Map(views.map((v) => [v.key, v]));
    const max = byKey.get("MAX_TICKS");
    expect(max).toBeDefined();
    expect(max?.value).toBe("");
    expect(max?.envLocked).toBe(false);
    expect(max?.type).toBe("int");
    expect(max?.group).toBe("budget");
  });

  it("round-trips a non-env key: write persists to settings.json and reads back", () => {
    const res = writeSettings({ MAX_TICKS: "50" }, {}, settingsPath);
    expect(res.written).toEqual(["MAX_TICKS"]);
    expect(res.rejected).toEqual([]);

    // Persisted as a flat JSON map of string values.
    const onDisk = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, string>;
    expect(onDisk).toEqual({ MAX_TICKS: "50" });

    // And it reads back through the view layer.
    const views = listSettings({}, settingsPath);
    expect(views.find((v) => v.key === "MAX_TICKS")?.value).toBe("50");
  });

  it("reports an env-set key as envLocked and refuses to change it on write", () => {
    const env = { GAFFER_PLAN_DEBATE: "1" };
    // Seed the file with a different value to prove the env wins and the write
    // does not overwrite it.
    writeFileSync(settingsPath, JSON.stringify({ GAFFER_PLAN_DEBATE: "0" }));

    const views = listSettings(env, settingsPath);
    const debate = views.find((v) => v.key === "GAFFER_PLAN_DEBATE");
    expect(debate?.envLocked).toBe(true);

    const res = writeSettings({ GAFFER_PLAN_DEBATE: "1" }, env, settingsPath);
    expect(res.rejected).toEqual(["GAFFER_PLAN_DEBATE"]);
    expect(res.written).toEqual([]);

    // File untouched — the env-locked value was not persisted.
    const onDisk = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, string>;
    expect(onDisk.GAFFER_PLAN_DEBATE).toBe("0");
  });

  it("treats a set-but-empty env var as locked (env still wins over the file)", () => {
    const env = { MERGE_ON_AGENT_REVIEW: "" };
    const views = listSettings(env, settingsPath);
    expect(views.find((v) => v.key === "MERGE_ON_AGENT_REVIEW")?.envLocked).toBe(true);
  });

  it("merges onto existing settings rather than replacing the whole file", () => {
    writeSettings({ MAX_TICKS: "10" }, {}, settingsPath);
    writeSettings({ GAFFER_MAX_TURNS: "8" }, {}, settingsPath);
    const onDisk = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, string>;
    expect(onDisk).toEqual({ MAX_TICKS: "10", GAFFER_MAX_TURNS: "8" });
  });

  it("ignores unknown keys on write (allow-list only)", () => {
    const res = writeSettings({ NOT_A_SETTING: "x", MAX_TICKS: "3" }, {}, settingsPath);
    expect(res.ignored).toEqual(["NOT_A_SETTING"]);
    expect(res.written).toEqual(["MAX_TICKS"]);
    const onDisk = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, string>;
    expect(onDisk).toEqual({ MAX_TICKS: "3" });
    expect(isKnownSetting("NOT_A_SETTING")).toBe(false);
  });

  it("treats a missing file as the empty state", () => {
    expect(readSettingsFile(join(dir, "nope.json"))).toEqual({});
  });

  it("drops stale/foreign keys when reading a hand-edited file", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ MAX_TICKS: "5", BOGUS: "y", GAFFER_MAX_TURNS: 9 }),
    );
    // BOGUS isn't known; GAFFER_MAX_TURNS is a number (not a string) → both dropped.
    expect(readSettingsFile(settingsPath)).toEqual({ MAX_TICKS: "5" });
  });
});
