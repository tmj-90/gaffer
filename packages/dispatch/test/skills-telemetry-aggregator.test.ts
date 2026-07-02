/**
 * Unit tests for the skill-selection telemetry aggregator
 * (src/health/skillsTelemetryAggregator.ts).
 *
 * Covers the selected-vs-applied hit-rate maths (per-skill + overall), the
 * zero-state, path resolution, and a NEGATIVE CONTROL: a malformed / irrelevant
 * JSONL row must never contribute to the hit-rate.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  aggregateSkillTelemetry,
  aggregateTelemetryRows,
  parseTelemetryLine,
  readTelemetryRows,
  resolveTelemetryPath,
  type SkillTelemetryRow,
} from "../src/health/skillsTelemetryAggregator.js";

describe("skillsTelemetryAggregator: parseTelemetryLine", () => {
  it("parses a well-formed row, intersecting applied with selected", () => {
    const row = parseTelemetryLine(
      JSON.stringify({
        ts: "2025-01-10T10:00:00Z",
        selected: ["run-tests", "frontend-component"],
        applied: ["run-tests"],
      }),
    );
    expect(row).not.toBeNull();
    expect(row!.selected).toEqual(["run-tests", "frontend-component"]);
    expect(row!.applied).toEqual(["run-tests"]);
  });

  it("drops an applied name that was never selected (cannot inflate the hit-rate)", () => {
    const row = parseTelemetryLine(
      JSON.stringify({ selected: ["run-tests"], applied: ["run-tests", "ghost-skill"] }),
    );
    expect(row!.applied).toEqual(["run-tests"]); // ghost-skill filtered out
  });

  it("returns null for empty, non-JSON, non-object, and selection-less rows", () => {
    expect(parseTelemetryLine("")).toBeNull();
    expect(parseTelemetryLine("{not json")).toBeNull();
    expect(parseTelemetryLine("[1,2,3]")).toBeNull();
    expect(parseTelemetryLine(JSON.stringify({ selected: [] }))).toBeNull();
    expect(parseTelemetryLine(JSON.stringify({ role: "delivery" }))).toBeNull();
  });
});

describe("skillsTelemetryAggregator: aggregateTelemetryRows", () => {
  it("returns a zero-state (null overall) for no rows", () => {
    const agg = aggregateTelemetryRows([]);
    expect(agg.total_records).toBe(0);
    expect(agg.total_selected).toBe(0);
    expect(agg.overall_hit_rate_pct).toBeNull(); // no divide-by-zero
    expect(agg.by_skill).toEqual([]);
    expect(agg.last_record_at).toBeNull();
  });

  it("computes per-skill and overall hit-rate", () => {
    const rows: SkillTelemetryRow[] = [
      { ts: "2025-01-10T10:00:00Z", selected: ["a", "b"], applied: ["a"] },
      { ts: "2025-01-11T10:00:00Z", selected: ["a", "b"], applied: ["a", "b"] },
      { ts: "2025-01-09T10:00:00Z", selected: ["b"], applied: [] },
    ];
    const agg = aggregateTelemetryRows(rows);

    // a: selected 2, applied 2 → 100%. b: selected 3, applied 1 → 33.3%.
    const a = agg.by_skill.find((s) => s.skill === "a")!;
    const b = agg.by_skill.find((s) => s.skill === "b")!;
    expect(a).toEqual({ skill: "a", selected: 2, applied: 2, hit_rate_pct: 100 });
    expect(b).toEqual({ skill: "b", selected: 3, applied: 1, hit_rate_pct: 33.3 });

    // Overall: 3 applied of 5 selections = 60%.
    expect(agg.total_selected).toBe(5);
    expect(agg.total_applied).toBe(3);
    expect(agg.overall_hit_rate_pct).toBe(60);

    // Most-selected first (b:3 before a:2).
    expect(agg.by_skill[0]!.skill).toBe("b");
    // last_record_at is the max ts.
    expect(agg.last_record_at).toBe("2025-01-11T10:00:00Z");
  });

  it("NEGATIVE CONTROL: a malformed / irrelevant row does not count", () => {
    // Two valid selections of 'a' (one applied), then a pile of junk lines that
    // must be skipped. If any junk counted, the totals below would move.
    const rows: SkillTelemetryRow[] = [
      parseTelemetryLine(JSON.stringify({ selected: ["a"], applied: ["a"] }))!,
      parseTelemetryLine(JSON.stringify({ selected: ["a"], applied: [] }))!,
      // Junk lines: parseTelemetryLine returns null for all of these.
      ...["", "garbage", "[1,2]", JSON.stringify({ selected: "not-an-array" }), JSON.stringify(42)]
        .map(parseTelemetryLine)
        .filter((r): r is SkillTelemetryRow => r !== null),
    ];
    const agg = aggregateTelemetryRows(rows);
    expect(agg.total_records).toBe(2); // only the two valid rows
    expect(agg.total_selected).toBe(2);
    expect(agg.total_applied).toBe(1);
    expect(agg.overall_hit_rate_pct).toBe(50);
    expect(agg.by_skill).toEqual([{ skill: "a", selected: 2, applied: 1, hit_rate_pct: 50 }]);
  });
});

describe("skillsTelemetryAggregator: file + path resolution", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gaffer-skill-telemetry-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("GAFFER_SKILL_TELEMETRY wins; else GAFFER_DATA/skills-telemetry.jsonl; else null", () => {
    expect(resolveTelemetryPath({ GAFFER_SKILL_TELEMETRY: "/x/t.jsonl" } as NodeJS.ProcessEnv)).toBe(
      "/x/t.jsonl",
    );
    expect(resolveTelemetryPath({ GAFFER_DATA: "/data" } as NodeJS.ProcessEnv)).toBe(
      join("/data", "skills-telemetry.jsonl"),
    );
    expect(resolveTelemetryPath({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("reads a real file, skipping malformed lines, and reports a zero-state for a missing file", () => {
    const file = join(dir, "skills-telemetry.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ ts: "2025-01-10T10:00:00Z", selected: ["run-tests"], applied: ["run-tests"] }),
        "this is not json",
        JSON.stringify({ selected: ["run-tests"], applied: [] }),
      ].join("\n"),
    );
    const rows = readTelemetryRows(file);
    expect(rows).toHaveLength(2);

    const agg = aggregateSkillTelemetry({ GAFFER_SKILL_TELEMETRY: file } as NodeJS.ProcessEnv);
    expect(agg.overall_hit_rate_pct).toBe(50);

    // Missing file → zero-state, never throws.
    const missing = aggregateSkillTelemetry({
      GAFFER_SKILL_TELEMETRY: join(dir, "nope.jsonl"),
    } as NodeJS.ProcessEnv);
    expect(missing.total_records).toBe(0);
    expect(missing.overall_hit_rate_pct).toBeNull();
  });
});
