/**
 * Skill-selection telemetry aggregation — selected-vs-applied hit-rate.
 *
 * The runner writes one JSONL row per delivery to `skills-telemetry.jsonl`
 * (see runner/bin/record-skill-usage.mjs) capturing which skills were SELECTED
 * (mounted / recommended for the ticket) and which were APPLIED (their name
 * appeared in the agent's output). Until now that trail had ZERO consumers.
 *
 * This module reads it and answers one question: for the skills we SELECT, how
 * often does the agent actually USE them? A skill selected 40 times but applied
 * twice is dead weight the prune should reach for; a skill applied nearly every
 * time it's selected is earning its mount cost. The hit-rate is computed per
 * skill and overall.
 *
 * Reuse posture: this mirrors {@link "./healthAggregator"}'s JSONL-reader shape
 * (`parseTelemetryLine` / `readTelemetryRows`) line-for-line — same defensive
 * contract:
 *   - Malformed / non-JSON / non-object lines are silently skipped (never throws).
 *   - A row missing a usable `selected` array contributes nothing.
 *   - `applied` is intersected with `selected`: an applied name that was never
 *     selected cannot inflate the hit-rate (the writer already guarantees this,
 *     but the reader re-enforces it so a hand-edited row can't lie).
 *   - Missing file returns a zero-state aggregate (never throws).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ---- Types ------------------------------------------------------------------

/** A normalised telemetry row — only the fields the hit-rate needs. */
export interface SkillTelemetryRow {
  ts: string;
  /** Skills mounted / recommended for the ticket. */
  selected: string[];
  /** Selected skills the agent actually applied (⊆ selected). */
  applied: string[];
}

/** Per-skill selected/applied counts and the derived hit-rate. */
export interface SkillHitRateEntry {
  skill: string;
  /** How many times this skill was selected. */
  selected: number;
  /** How many of those selections were actually applied. */
  applied: number;
  /** applied/selected as a 0–100 number (0 when never selected). */
  hit_rate_pct: number;
}

/** The full skill-telemetry aggregate. */
export interface SkillTelemetryAggregate {
  /** Number of telemetry rows counted. */
  total_records: number;
  /** Sum of selections across all rows (the hit-rate denominator). */
  total_selected: number;
  /** Sum of applied-that-were-selected across all rows (the numerator). */
  total_applied: number;
  /** total_applied/total_selected as a 0–100 number, or null when nothing was selected. */
  overall_hit_rate_pct: number | null;
  /** Per-skill breakdown, highest selection count first. */
  by_skill: SkillHitRateEntry[];
  last_record_at: string | null;
}

// ---- Helpers ----------------------------------------------------------------

/** applied/selected as a 0–100 number rounded to 0.1; 0 when selected is 0. */
function pctOf(applied: number, selected: number): number {
  return selected > 0 ? Math.round((applied / selected) * 1000) / 10 : 0;
}

/** Coerce a raw value into a de-duped array of non-empty skill-name strings. */
function toNameArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const name = v.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// ---- Core -------------------------------------------------------------------

/**
 * Resolve the telemetry file path from the environment. Mirrors the runner's
 * resolution (runner/lib/skills-mount.sh): `GAFFER_SKILL_TELEMETRY` wins;
 * otherwise `$GAFFER_DATA/skills-telemetry.jsonl`. Null when neither is set.
 */
export function resolveTelemetryPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.GAFFER_SKILL_TELEMETRY;
  if (explicit) return explicit;
  const dir = env.GAFFER_DATA;
  if (!dir) return null;
  return join(dir, "skills-telemetry.jsonl");
}

/**
 * Parse one JSONL line into a SkillTelemetryRow, or null for empty / non-JSON /
 * non-object / unusable lines so the caller can skip them safely. A row with no
 * usable `selected` array yields null (it carries no hit-rate signal).
 */
export function parseTelemetryLine(line: string): SkillTelemetryRow | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as { ts?: unknown; selected?: unknown; applied?: unknown };

  const selected = toNameArray(r.selected);
  if (selected.length === 0) return null; // nothing was selected → no signal

  // applied is only meaningful for skills that were actually selected.
  const selectedSet = new Set(selected);
  const applied = toNameArray(r.applied).filter((name) => selectedSet.has(name));

  const ts = typeof r.ts === "string" ? r.ts : new Date().toISOString();
  return { ts, selected, applied };
}

/**
 * Read and parse all rows from the telemetry file. Returns an empty array when
 * the file is missing, unreadable, or has no valid rows — never throws.
 */
export function readTelemetryRows(telemetryPath: string): SkillTelemetryRow[] {
  try {
    if (!existsSync(telemetryPath)) return [];
    const content = readFileSync(telemetryPath, "utf8");
    const rows: SkillTelemetryRow[] = [];
    for (const line of content.split("\n")) {
      const row = parseTelemetryLine(line);
      if (row !== null) rows.push(row);
    }
    return rows;
  } catch {
    return [];
  }
}

/** Aggregate the selected-vs-applied hit-rate from a set of telemetry rows. */
export function aggregateTelemetryRows(rows: SkillTelemetryRow[]): SkillTelemetryAggregate {
  let totalSelected = 0;
  let totalApplied = 0;
  let lastRecordAt: string | null = null;
  const bySkill = new Map<string, { selected: number; applied: number }>();

  for (const row of rows) {
    if (lastRecordAt === null || row.ts > lastRecordAt) lastRecordAt = row.ts;
    const appliedSet = new Set(row.applied);
    for (const skill of row.selected) {
      totalSelected += 1;
      const entry = bySkill.get(skill) ?? { selected: 0, applied: 0 };
      entry.selected += 1;
      if (appliedSet.has(skill)) {
        entry.applied += 1;
        totalApplied += 1;
      }
      bySkill.set(skill, entry);
    }
  }

  const by_skill: SkillHitRateEntry[] = Array.from(bySkill.entries())
    .map(([skill, { selected, applied }]) => ({
      skill,
      selected,
      applied,
      hit_rate_pct: pctOf(applied, selected),
    }))
    // Most-selected first; ties broken by higher hit-rate then name for stability.
    .sort(
      (a, b) =>
        b.selected - a.selected ||
        b.hit_rate_pct - a.hit_rate_pct ||
        (a.skill < b.skill ? -1 : a.skill > b.skill ? 1 : 0),
    );

  return {
    total_records: rows.length,
    total_selected: totalSelected,
    total_applied: totalApplied,
    overall_hit_rate_pct: totalSelected > 0 ? pctOf(totalApplied, totalSelected) : null,
    by_skill,
    last_record_at: lastRecordAt,
  };
}

/**
 * Aggregate the skill hit-rate from the telemetry file. Returns a zero-state
 * aggregate when the file is missing / unconfigured. Never throws.
 */
export function aggregateSkillTelemetry(
  env: NodeJS.ProcessEnv = process.env,
): SkillTelemetryAggregate {
  const path = resolveTelemetryPath(env);
  const rows = path ? readTelemetryRows(path) : [];
  return aggregateTelemetryRows(rows);
}
