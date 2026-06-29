import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
 *
 * The difference is clamped at 0: a lane whose `lastRunTick` exceeds the current
 * `cursor.tick` (from a torn write, a tick reset, or a restored older
 * `$GAFFER_DATA`) would otherwise yield a NEGATIVE staleness and sort dead-last
 * forever — starving the highest-priority lane (security) to zero runs. A
 * future-stamped lane is treated as staleness 0 (just-run), so it neither jumps
 * the queue nor gets buried by it.
 */
function staleness(cursor: MaintenanceCursor, lane: IdleLoopId): number {
  const last = cursor.lastRunTick[lane];
  if (last === undefined) return Number.POSITIVE_INFINITY;
  return Math.max(0, cursor.tick - last);
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
  rawCursor: MaintenanceCursor,
): MaintenanceChoice {
  // Defensively strip any future-stamped lane (lastRunTick > tick) up front so a
  // torn write / tick reset / restored old $GAFFER_DATA can't bury a lane below a
  // clamped staleness of 0 forever — the highest-priority lane (security) would
  // otherwise be starved to zero runs. A dropped entry reads as never-run.
  const cursor = sanitizeCursor(rawCursor);
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
    if (!parsed.success) return emptyCursor();
    return sanitizeCursor(parsed.data);
  } catch {
    return emptyCursor();
  }
}

/**
 * Defensively drop any `lastRunTick` entry that exceeds the cursor's `tick`. Such
 * an entry can only come from a torn write, a tick reset, or a restored older
 * `$GAFFER_DATA`; left in place it would future-stamp a lane. Dropping it makes
 * the lane look never-run (maximally stale) so it is rescued rather than starved.
 */
function sanitizeCursor(cursor: MaintenanceCursor): MaintenanceCursor {
  const cleaned: Record<string, number> = {};
  for (const [lane, last] of Object.entries(cursor.lastRunTick)) {
    if (last <= cursor.tick) cleaned[lane] = last;
  }
  return { ...cursor, lastRunTick: cleaned };
}

/**
 * Persist the rotation cursor to `path`, creating the parent dir as needed.
 *
 * The write is ATOMIC: the JSON is written to a unique temp file in the same
 * directory and then `rename`d over the target. `rename` within a directory is
 * atomic on POSIX and Windows, so a concurrent reader sees either the whole old
 * file or the whole new one — never a torn half-write (which the FIX-1
 * sanitiser then has to clean up). The temp file is uniquely named per-process
 * so two writers never clobber each other's temp.
 */
export function saveCursor(path: string, cursor: MaintenanceCursor): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(cursor, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch (err) {
    // Best-effort cleanup of the temp file; rethrow the original failure.
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Cleanup is best-effort: the temp file is uniquely named so a leftover is
      // harmless and the original error below is what matters.
    }
    throw err;
  }
}

/** How many times a contended commit re-reads + retries before giving up. */
const COMMIT_MAX_ATTEMPTS = 8;
/** How long an O_EXCL lock may be held before a stale holder is reclaimed (ms). */
const COMMIT_LOCK_STALE_MS = 5_000;

/**
 * Atomically select-and-persist the next maintenance lane under a portable lock,
 * closing the read-modify-write race (FIX-4).
 *
 * Without this, two idle workers (`GAFFER_MAINTENANCE=1` + `GAFFER_CONCURRENCY>1`)
 * can each `loadCursor` the SAME cursor, both run {@link chooseMaintenanceLane},
 * and pick the SAME lane — wasting a worker and skewing the rotation. Here the
 * select + save happen under an O_EXCL lock file (the portable primitive: an
 * exclusive create succeeds for exactly one process), and the load is re-read
 * INSIDE the lock so the choice is always made against the latest committed
 * cursor (compare-and-swap by construction). A stale lock (holder crashed) older
 * than {@link COMMIT_LOCK_STALE_MS} is reclaimed so a dead worker can't wedge the
 * lane forever.
 *
 * Returns the same {@link MaintenanceChoice} as {@link chooseMaintenanceLane}; the
 * returned `nextCursor` is already persisted to `path`.
 */
export function commitMaintenanceChoice(config: CrewConfig, path: string): MaintenanceChoice {
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;

  for (let attempt = 0; attempt < COMMIT_MAX_ATTEMPTS; attempt += 1) {
    if (!acquireLock(lockPath)) {
      reclaimStaleLock(lockPath);
      continue; // contended — re-read on the next attempt under a fresh lock.
    }
    try {
      // Re-read INSIDE the lock: this is the compare-and-swap. Any commit by
      // another worker since our caller last looked is now visible, so two
      // workers can never select against the same stale cursor.
      const cursor = loadCursor(path);
      const choice = chooseMaintenanceLane(config, cursor);
      saveCursor(path, choice.nextCursor);
      return choice;
    } finally {
      releaseLock(lockPath);
    }
  }

  // All attempts exhausted — skip this tick rather than performing an unlocked
  // write that could skew the rotation (two workers picking the same lane).
  return {
    lane: null,
    reason: "maintenance cursor locked by another worker; skipping this idle tick",
    nextCursor: loadCursor(path),
  };
}

/** Try to take the exclusive lock. O_EXCL create succeeds for one process only. */
function acquireLock(lockPath: string): boolean {
  try {
    // "wx" = O_CREAT | O_EXCL | O_WRONLY: fails if the file already exists.
    const fd = openSync(lockPath, "wx");
    try {
      writeFileSync(fd, `${process.pid}\n`);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

/** Release the lock; ignore a missing file (already released / reclaimed). */
function releaseLock(lockPath: string): void {
  try {
    rmSync(lockPath, { force: true });
  } catch {
    // Best-effort: a missing lock is the desired end state.
  }
}

/** Reclaim a lock whose holder appears to have crashed (older than the TTL). */
function reclaimStaleLock(lockPath: string): void {
  try {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    if (age > COMMIT_LOCK_STALE_MS) rmSync(lockPath, { force: true });
  } catch {
    // The lock vanished between contention and this check — nothing to reclaim.
  }
}
