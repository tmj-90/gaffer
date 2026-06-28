import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  chooseMaintenanceLane,
  emptyCursor,
  loadCursor,
  saveCursor,
  MAINTENANCE_LANES,
  type MaintenanceCursor,
} from "../src/loops/maintenanceLane.js";
import { crewConfigSchema, type CrewConfig } from "../src/config/schema.js";

/**
 * Deterministic scheduler tests (NO LLM). The maintenance lane picks the next
 * maintenance loop to run by a pure priority + rotation function over which
 * loops are enabled plus a persisted rotation cursor.
 */

/** A config with NO idle loops enabled (the default). */
function baseConfig(): CrewConfig {
  return crewConfigSchema.parse({
    factory: { name: "test-factory", mode: "local_strict" },
    repos: [{ id: "demo", name: "demo", path: "/tmp/demo", stack: "typescript" }],
  });
}

/** Enable a set of idle loops by their lane id. */
function withLanes(config: CrewConfig, lanes: readonly string[]): CrewConfig {
  const map: Record<string, () => void> = {
    security_hotspot: () => (config.loops.idle_security_hotspot.enabled = true),
    coverage: () => (config.loops.idle_coverage.enabled = true),
    test_quality: () => (config.loops.idle_test_quality.enabled = true),
    type_quality: () => (config.loops.idle_type_quality.enabled = true),
    tech_debt: () => (config.loops.idle_tech_debt.enabled = true),
    documentation: () => (config.loops.idle_documentation.enabled = true),
    dependency_hygiene: () => (config.loops.idle_dependencies.enabled = true),
  };
  for (const lane of lanes) map[lane]?.();
  return config;
}

describe("maintenance-lane scheduler — priority", () => {
  it("chooses the highest-priority enabled lane first (security over docs)", () => {
    const config = withLanes(baseConfig(), ["documentation", "security_hotspot"]);
    const choice = chooseMaintenanceLane(config, emptyCursor());
    expect(choice.lane).toBe("security_hotspot");
    expect(choice.reason).toMatch(/security_hotspot/);
  });

  it("falls to the next priority lane when the top one is disabled", () => {
    // security off, test_quality + documentation on → test_quality wins on priority.
    const config = withLanes(baseConfig(), ["documentation", "test_quality"]);
    expect(chooseMaintenanceLane(config, emptyCursor()).lane).toBe("test_quality");
  });

  it("returns null with a clear reason when no lane is enabled", () => {
    const choice = chooseMaintenanceLane(baseConfig(), emptyCursor());
    expect(choice.lane).toBeNull();
    expect(choice.reason).toMatch(/no maintenance lane enabled/i);
    // The cursor tick still advances so the caller can persist the no-op.
    expect(choice.nextCursor.tick).toBe(1);
  });
});

describe("maintenance-lane scheduler — rotation", () => {
  it("does not pick the same lane twice running when another is due", () => {
    const config = withLanes(baseConfig(), ["security_hotspot", "documentation"]);
    let cursor = emptyCursor();

    const first = chooseMaintenanceLane(config, cursor);
    expect(first.lane).toBe("security_hotspot"); // priority leader runs first
    cursor = first.nextCursor;

    const second = chooseMaintenanceLane(config, cursor);
    // Rotation: documentation is now the most-stale (never-run) lane, so it
    // runs rather than security_hotspot again.
    expect(second.lane).toBe("documentation");
    cursor = second.nextCursor;

    // Both have now run once; the next tick rotates back to the higher-priority
    // (and now equally/more stale) lane.
    const third = chooseMaintenanceLane(config, cursor);
    expect(third.lane).toBe("security_hotspot");
  });

  it("rotates through every enabled lane before repeating any", () => {
    const lanes = [...MAINTENANCE_LANES];
    const config = withLanes(baseConfig(), lanes);
    let cursor = emptyCursor();
    const seen: string[] = [];

    for (let i = 0; i < lanes.length; i++) {
      const choice = chooseMaintenanceLane(config, cursor);
      expect(choice.lane).not.toBeNull();
      seen.push(choice.lane!);
      cursor = choice.nextCursor;
    }

    // The first full sweep visits every enabled lane exactly once (no starve).
    expect(new Set(seen).size).toBe(lanes.length);
    // The first pick of the very first sweep is the highest-priority lane.
    expect(seen[0]).toBe("security_hotspot");
  });

  it("does not starve a low-priority lane under repeated ticks", () => {
    const config = withLanes(baseConfig(), ["security_hotspot", "documentation"]);
    let cursor = emptyCursor();
    const counts: Record<string, number> = {};
    for (let i = 0; i < 10; i++) {
      const choice = chooseMaintenanceLane(config, cursor);
      counts[choice.lane!] = (counts[choice.lane!] ?? 0) + 1;
      cursor = choice.nextCursor;
    }
    // Over 10 ticks both lanes run a fair share — neither is starved.
    expect(counts.security_hotspot).toBeGreaterThan(0);
    expect(counts.documentation).toBeGreaterThan(0);
    expect(Math.abs(counts.security_hotspot! - counts.documentation!)).toBeLessThanOrEqual(1);
  });
});

describe("maintenance-lane scheduler — enabled-flag respect", () => {
  it("only ever chooses lanes whose idle loop is enabled", () => {
    const config = withLanes(baseConfig(), ["tech_debt"]);
    let cursor = emptyCursor();
    for (let i = 0; i < 5; i++) {
      const choice = chooseMaintenanceLane(config, cursor);
      expect(choice.lane).toBe("tech_debt"); // the only enabled lane
      cursor = choice.nextCursor;
    }
  });

  it("ignores a disabled lane even when it is highest priority", () => {
    // security disabled; coverage enabled → coverage chosen despite lower priority.
    const config = withLanes(baseConfig(), ["coverage"]);
    expect(chooseMaintenanceLane(config, emptyCursor()).lane).toBe("coverage");
  });
});

describe("maintenance-lane scheduler — future-stamped cursor (FIX-1)", () => {
  it("still schedules a future-stamped high-priority lane (does not starve security)", () => {
    // A torn write / tick reset / restored old $GAFFER_DATA can leave a lane's
    // lastRunTick far AHEAD of the cursor tick. On the old code staleness went
    // negative, sorting that lane dead-last forever — security ran 0 times.
    const config = withLanes(baseConfig(), [...MAINTENANCE_LANES]);
    let cursor: MaintenanceCursor = {
      tick: 2,
      lastRunTick: { security_hotspot: 1_000_000 },
      lastChosen: null,
    };

    const counts: Record<string, number> = {};
    for (let i = 0; i < 30; i++) {
      const choice = chooseMaintenanceLane(config, cursor);
      counts[choice.lane!] = (counts[choice.lane!] ?? 0) + 1;
      cursor = choice.nextCursor;
    }

    // Old code: 0. Fixed: clamped staleness lets it rotate in fairly.
    expect(counts.security_hotspot ?? 0).toBeGreaterThan(0);
  });

  it("loadCursor drops a lastRunTick entry that exceeds the cursor tick", () => {
    const path = join(mkdtempSync(join(tmpdir(), "maint-future-")), "cursor.json");
    writeFileSync(
      path,
      JSON.stringify({
        tick: 5,
        lastRunTick: { security_hotspot: 99, coverage: 3 },
        lastChosen: null,
      }),
      "utf8",
    );
    const loaded = loadCursor(path);
    // The future-stamped entry is dropped (treated as never-run); the valid one stays.
    expect(loaded.lastRunTick.security_hotspot).toBeUndefined();
    expect(loaded.lastRunTick.coverage).toBe(3);
  });
});

describe("maintenance-lane cursor persistence", () => {
  function tmpCursorPath(): string {
    return join(mkdtempSync(join(tmpdir(), "maint-cursor-")), "cursor.json");
  }

  it("round-trips a saved cursor and survives across loads", () => {
    const path = tmpCursorPath();
    const config = withLanes(baseConfig(), ["security_hotspot", "documentation"]);

    // Tick 1: persist after choosing.
    const first = chooseMaintenanceLane(config, loadCursor(path));
    saveCursor(path, first.nextCursor);
    expect(first.lane).toBe("security_hotspot");

    // Tick 2: a *fresh* load (simulating a new process) must continue the
    // rotation, not restart it — so documentation runs next, not security again.
    const reloaded = loadCursor(path);
    expect(reloaded.tick).toBe(1);
    expect(reloaded.lastChosen).toBe("security_hotspot");
    const second = chooseMaintenanceLane(config, reloaded);
    expect(second.lane).toBe("documentation");

    // The persisted file is valid JSON carrying the advanced cursor.
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as MaintenanceCursor;
    expect(onDisk.tick).toBe(1);
    expect(onDisk.lastRunTick.security_hotspot).toBe(1);
  });

  it("falls back to an empty cursor when the file is missing or corrupt", () => {
    const path = tmpCursorPath();
    // Missing file → empty cursor.
    expect(loadCursor(path)).toEqual(emptyCursor());
    // Corrupt file → empty cursor (never throws on a quiet tick).
    saveCursor(path, emptyCursor());
    const corruptPath = join(mkdtempSync(join(tmpdir(), "maint-corrupt-")), "c.json");
    writeFileSync(corruptPath, "{ not json", "utf8");
    expect(loadCursor(corruptPath)).toEqual(emptyCursor());
  });
});
