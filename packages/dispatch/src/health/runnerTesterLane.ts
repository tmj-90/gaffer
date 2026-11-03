/**
 * LANE-SETTING CONSISTENCY (lane-hook R1): the tester lane as the RUNNER used it.
 *
 * The dashboard and the runner each read GAFFER_TESTING from their own environment.
 * settings.json reaches both as a default (api/settings.ts applySettingsToEnv,
 * runner/factory.config.sh) and an explicit environment value wins in each, so the two
 * differ only when one process has its own value: `GAFFER_TESTING=0` exported in the
 * shell that runs `gaffer run` while the dashboard is unset. Then the dashboard refuses a
 * person's approval (not tested) and the runner never sends the ticket to the tester.
 *
 * The runner's CLI records the mode it decided under whenever it asks dispatch to route
 * tickets to the tester (`wg ticket tester-route ... --as system`, every pass that could
 * route): one `runner.tester_lane` event on the factory, written when the mode changes or
 * the last record is a day old, so the log does not grow by a row per tick. The dashboard
 * reads the latest one and compares it with its own view. Recording and reading are
 * fail-soft: an error records or reads nothing.
 */

import type { Db } from "../db/connection.js";
import { writeEvent } from "../events/eventWriter.js";
import type { TestingLaneMode } from "../util/testingLane.js";

export const RUNNER_LANE_EVENT = "runner.tester_lane";
const ENTITY_TYPE = "factory";
const ENTITY_ID = "runner";
/** Re-record an unchanged mode after this long, so "last used" stays recent. */
const REFRESH_MS = 24 * 60 * 60 * 1000;

export interface RunnerTesterLane {
  /** The GAFFER_TESTING mode the runner's last tester route ran under. */
  mode: TestingLaneMode;
  /** When that was recorded (the first route under this mode, refreshed daily). */
  at: string;
}

function isMode(v: unknown): v is TestingLaneMode {
  return v === "on" || v === "off" || v === "auto";
}

/** The runner's latest recorded tester lane, or null (none recorded, or unreadable). */
export function readRunnerTesterLane(db: Db): RunnerTesterLane | null {
  try {
    const row = db
      .prepare(
        `SELECT payload_json, created_at FROM work_events
          WHERE entity_type = ? AND entity_id = ? AND event_type = ?
          ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(ENTITY_TYPE, ENTITY_ID, RUNNER_LANE_EVENT) as
      { payload_json: string | null; created_at: string } | undefined;
    if (!row) return null;
    const p = JSON.parse(row.payload_json ?? "{}") as { mode?: unknown };
    return isMode(p.mode) ? { mode: p.mode, at: row.created_at } : null;
  } catch {
    return null;
  }
}

/**
 * Record `mode` as the runner's tester lane when it differs from the last record or that
 * one is older than a day. Returns whether a row was written. Never throws.
 */
export function recordRunnerTesterLane(
  db: Db,
  mode: TestingLaneMode,
  nowMs: number = Date.now(),
): boolean {
  try {
    const last = readRunnerTesterLane(db);
    if (last && last.mode === mode && nowMs - Date.parse(last.at) < REFRESH_MS) return false;
    writeEvent(db, {
      entity_type: ENTITY_TYPE,
      entity_id: ENTITY_ID,
      actor: { type: "system" },
      event_type: RUNNER_LANE_EVENT,
      payload: { mode, ...(last && last.mode !== mode ? { was: last.mode } : {}) },
    });
    return true;
  } catch {
    return false;
  }
}

/** The one-line notice Health shows when the runner's lane and the dashboard's differ. */
export function runnerLaneNotice(dashboard: TestingLaneMode, runner: RunnerTesterLane): string {
  return (
    `tester lane differs: the runner last routed with GAFFER_TESTING ${runner.mode} ` +
    `(recorded ${runner.at.slice(0, 16).replace("T", " ")} UTC) and this dashboard reads ${dashboard}. ` +
    `Approval and the tester route can disagree: set GAFFER_TESTING in Settings and leave it unset ` +
    `in both environments, or export the same value to both`
  );
}
