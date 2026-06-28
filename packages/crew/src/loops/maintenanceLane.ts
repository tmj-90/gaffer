import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { z } from "zod";

import type { CrewConfig } from "../config/schema.js";
import type { IdleLoopId } from "./idleRegistry.js";

/**
 * The idle MAINTENANCE LANE scheduler (audit item A4).
 *
 * When a worker finds no claimable ticket, instead of always running a single
 * fixed idle scan the factory can run the *next* maintenance loop chosen by a
 * deterministic priority + rotation function — NO LLM in the selection. This is
 * the "factory improves the longer it runs" promise made literal: every quiet
 * tick spends its tokens on the highest-leverage maintenance lane that is due.
 *
 * The decision is a pure function over three inputs:
 *   1. which loops are enabled in config (a loop never runs if its flag is off),
 *   2. a stable PRIORITY ordering (security first, then test-gaps, then
 *      type/tech-debt, then docs/lore), and
 *   3. a small ROTATION cursor (which lanes ran recently) so a high-priority
 *      lane can't starve the lower ones and the same lane isn't picked on every
 *      consecutive idle tick.
 *
 * The cursor is persisted (a tiny JSON file under `$GAFFER_DATA`) so the cadence
 * survives across ticks/processes; see {@link loadCursor}/{@link saveCursor}.
 */

/**
 * The maintenance lanes, in PRIORITY order (most important first). Each maps to
 * an {@link IdleLoopId} the registry already knows how to run. Security comes
 * first (a live vulnerability outranks everything), then the test-gap lanes
 * (coverage / test quality), then the type/tech-debt lanes, then documentation.
 * Lore-gap is intentionally absent: it is async + needs a real Memory, so it is
 * not part of the sync maintenance rotation.
 */
export const MAINTENANCE_LANES: readonly IdleLoopId[] = [
  "security_hotspot",
  "coverage",
  "test_quality",
  "type_quality",
  "tech_debt",
  "documentation",
  "dependency_hygiene",
] as const;

/** A lane's lower index = higher priority. Used to break rotation ties. */
const LANE_PRIORITY = new Map<IdleLoopId, number>(
  MAINTENANCE_LANES.map((lane, index) => [lane, index]),
);

/** Config flag lookup per lane — a lane only runs when its idle loop is enabled. */
function isLaneEnabled(config: CrewConfig, lane: IdleLoopId): boolean {
  const loops = config.loops;
  switch (lane) {
    case "security_hotspot":
      return loops.idle_security_hotspot.enabled;
    case "coverage":
      return loops.idle_coverage.enabled;
    case "test_quality":
      return loops.idle_test_quality.enabled;
    case "type_quality":
      return loops.idle_type_quality.enabled;
    case "tech_debt":
      return loops.idle_tech_debt.enabled;
    case "documentation":
      return loops.idle_documentation.enabled;
    case "dependency_hygiene":
      return loops.idle_dependencies.enabled;
    default:
      return false;
  }
}

/**
 * The persisted rotation cursor. `lastRunTick` records the monotonically
 * increasing tick index at which each lane last ran, so the scheduler can pick
 * the lane that has waited longest (largest staleness) while honouring priority
 * as the tie-breaker. `tick` is the running counter advanced on every selection.
 */
export const maintenanceCursorSchema = z.object({
  /** Monotonic counter advanced once per scheduler selection. */
  tick: z.number().int().nonnegative().default(0),
  /** Per-lane tick index of the lane's last run (absent = never run). */
  lastRunTick: z.record(z.string(), z.number().int().nonnegative()).default({}),
  /** The lane chosen on the previous selection (for the no-repeat guard). */
  lastChosen: z.string().nullable().default(null),
});
export type MaintenanceCursor = z.infer<typeof maintenanceCursorSchema>;

/** A fresh, never-run cursor. */
export function emptyCursor(): MaintenanceCursor {
  return { tick: 0, lastRunTick: {}, lastChosen: null };
}

/** Why a lane was chosen — surfaced in the log line so the choice is auditable. */
export interface MaintenanceChoice {
  /** The lane the scheduler picked, or null when no lane is eligible. */
  lane: IdleLoopId | null;
  /** Human-readable rationale for the log line. */
  reason: string;
  /** The cursor to persist after this selection (advanced + lane stamped). */
  nextCursor: MaintenanceCursor;
}

/**
 * How "stale" a lane is: how many ticks since it last ran. A never-run enabled
 * lane is maximally stale so it is reached before any lane runs twice.
 */
function staleness(cursor: MaintenanceCursor, lane: IdleLoopId): number {
  const last = cursor.lastRunTick[lane];
  if (last === undefined) return Number.POSITIVE_INFINITY;
  return cursor.tick - last;
}

/**
 * Choose the next maintenance lane to run — pure, deterministic, NO LLM.
 *
 * Selection rules, applied over the ENABLED lanes only:
 *  1. Any enabled lane that has NEVER run is picked first, in priority order
 *     (so a freshly-enabled high-priority lane runs before re-running others).
 *  2. Otherwise pick the lane with the greatest staleness (longest since it
 *     last ran) — this is the rotation that stops a high-priority lane starving
 *     the rest, and stops the same lane being picked every consecutive tick.
 *  3. Priority breaks ties: among lanes equally stale, the higher-priority lane
 *     (security > test-gaps > type/tech-debt > docs) wins.
 *  4. The no-repeat guard: if the winner equals `lastChosen` AND another
 *     enabled lane is due, prefer the other lane so two distinct lanes run back
 *     to back rather than the same one twice.
 *
 * Returns the chosen lane plus the cursor to persist (tick advanced, lane
 * stamped). When no lane is enabled it returns `lane: null` and leaves the
 * cursor's tick advanced so the caller can persist a no-op selection.
 */
export function chooseMaintenanceLane(
  config: CrewConfig,
  cursor: MaintenanceCursor,
): MaintenanceChoice {
  const enabled = MAINTENANCE_LANES.filter((lane) => isLaneEnabled(config, lane));
  const advancedTick = cursor.tick + 1;

  if (enabled.length === 0) {
    return {
      lane: null,
      reason: "no maintenance lane enabled",
      nextCursor: { ...cursor, tick: advancedTick },
    };
  }

  // Rank enabled lanes by (staleness desc, priority asc). A stable sort over a
  // priority-ordered source array means equal-staleness ties already resolve in
  // priority order, but we compare explicitly for clarity.
  const ranked = [...enabled].sort((a, b) => {
    const sa = staleness(cursor, a);
    const sb = staleness(cursor, b);
    if (sa !== sb) return sb - sa; // most stale first
    return LANE_PRIORITY.get(a)! - LANE_PRIORITY.get(b)!; // higher priority first
  });

  let chosen = ranked[0]!;
  // No-repeat guard: if the top pick is the lane we ran last tick and there is
  // another eligible lane, hand the slot to that other lane so the rotation does
  // not stall on a single lane across consecutive idle ticks.
  if (chosen === cursor.lastChosen && ranked.length > 1) {
    chosen = ranked[1]!;
  }

  const never = staleness(cursor, chosen) === Number.POSITIVE_INFINITY;
  const reason = never
    ? `lane '${chosen}' selected: highest-priority enabled lane not yet run`
    : `lane '${chosen}' selected: most-stale enabled lane (priority ${LANE_PRIORITY.get(chosen)!}, ` +
      `${staleness(cursor, chosen)} tick(s) since last run)`;

  return {
    lane: chosen,
    reason,
    nextCursor: {
      tick: advancedTick,
      lastRunTick: { ...cursor.lastRunTick, [chosen]: advancedTick },
      lastChosen: chosen,
    },
  };
}

// ── Cursor persistence ───────────────────────────────────────────────────────
// A tiny JSON file under $GAFFER_DATA keeps the rotation cadence across ticks
// and processes. Reads are fault-tolerant: a missing/corrupt file falls back to
// an empty cursor so a bad write can never wedge the maintenance lane.

/**
 * Load the rotation cursor from `path`. Returns a fresh {@link emptyCursor} when
 * the file is absent, unreadable, or fails schema validation — the scheduler
 * must never throw on a quiet idle tick.
 */
export function loadCursor(path: string): MaintenanceCursor {
  if (!existsSync(path)) return emptyCursor();
  try {
    const parsed = maintenanceCursorSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : emptyCursor();
  } catch {
    return emptyCursor();
  }
}

/** Persist the rotation cursor to `path`, creating the parent dir as needed. */
export function saveCursor(path: string, cursor: MaintenanceCursor): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cursor, null, 2)}\n`, "utf8");
}
