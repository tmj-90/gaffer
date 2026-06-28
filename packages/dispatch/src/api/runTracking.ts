import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { RunKind } from "../domain/types.js";

/**
 * Shared spawn tracking for the API's detached background runs (the "Suggest
 * work" / onboard / poll-work / merge buttons).
 *
 * Before this, every such run was spawned with `stdio: "ignore"` and never
 * recorded, so the dashboard couldn't show what was in flight and a run that
 * filed nothing (or errored) left NO trace. This module generalises the spawn so
 * EACH run:
 *   - records a `runs` row on spawn (status `running`) via the {@link RunTracker};
 *   - redirects the child's stdout+stderr to a per-run log file under
 *     `$GAFFER_DATA/runs/<id>.log` (so output is captured, not discarded);
 *   - is marked done (status derived from the exit code) when the child exits —
 *     the listener is attached BEFORE `unref()` so it still fires while the API
 *     process lives (the startup sweep covers the API-restarted-mid-run case).
 *
 * The child stays detached + unref'd, exactly as before; only the discarded
 * output and the missing tracking change.
 */

/**
 * The slice of the Dispatch facade the runners need to track a run. Kept narrow
 * (not the whole facade) so runners depend only on what they use and tests can
 * supply a trivial fake. `recordRunStart` accepts an explicit `id` so the caller
 * can name the per-run log file BEFORE the row is written (the log path is stored
 * on the row).
 */
export interface RunTracker {
  recordRunStart(input: {
    id: string;
    kind: RunKind;
    repo?: string | null;
    pid?: number | null;
    log_path?: string | null;
  }): { id: string };
  markRunEnd(id: string, input: { exit_code: number | null; detail?: string | null }): void;
  /** Mint a fresh run id (so the caller can name the log file up front). */
  newRunId(): string;
}

/**
 * Resolve the per-run log directory. Precedence mirrors the rest of the API
 * (settings / idle-loops): `$GAFFER_DATA/runs` → `~/.gaffer/runs` when
 * `$GAFFER_DATA` is unset. The directory is created (mode 0700) on demand.
 */
export function resolveRunsDir(env: NodeJS.ProcessEnv = process.env): string {
  const dataDir = (env.GAFFER_DATA ?? "").trim();
  const base = dataDir !== "" ? resolve(dataDir) : join(homedir(), ".gaffer");
  return join(base, "runs");
}

/** Result of a tracked spawn. Superset of the legacy `{ started, pid }` shape. */
export interface TrackedSpawnResult {
  started: boolean;
  /** OS process id of the spawned run, or null if the platform withheld one. */
  pid: number | null;
  /** The run id recorded in the registry, or null when no tracker was supplied. */
  runId: string | null;
}

export interface TrackedSpawnInput {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  kind: RunKind;
  /** The run's target repo (when known), recorded on the row for the panel. */
  repo?: string | null;
}

/**
 * Spawn a detached, tracked, output-capturing background run.
 *
 * When a {@link RunTracker} is supplied: the run id is minted up front, a log
 * file is opened at `<runsDir>/<id>.log`, the child's stdout+stderr are
 * redirected to it, a `runs` row is recorded (carrying the pid + log path), and
 * an `exit`/`error` listener marks the row done (and closes the log fd) before
 * the child is unref'd. When no tracker is supplied this falls back to the legacy
 * `stdio: "ignore"` spawn (used by unit tests that exercise a runner in
 * isolation), so behaviour degrades gracefully rather than failing.
 *
 * Log capture is best-effort: if the runs directory or log file can't be opened
 * the run is still tracked (with a null log path) and spawned with ignored stdio.
 */
export function spawnTrackedRun(
  input: TrackedSpawnInput,
  tracker: RunTracker | undefined,
  env: NodeJS.ProcessEnv = process.env,
): TrackedSpawnResult {
  if (!tracker) {
    // Legacy path: no registry → discard output, no tracking (unit-test seam).
    const child = spawn(input.bin, input.args, {
      detached: true,
      stdio: "ignore",
      env: input.env,
    });
    // A detached child reports a spawn failure (e.g. ENOENT) via an async 'error'
    // event; an unhandled 'error' would crash the parent. Swallow it — this path
    // has no tracker to record it against, and a failed background spawn must
    // never take down the API.
    child.on("error", () => {});
    child.unref();
    return { started: true, pid: child.pid ?? null, runId: null };
  }

  // Mint the id up front so the log file can be named by it before the row is
  // written (the row carries the log path).
  const runId = tracker.newRunId();

  // Open the per-run log (best-effort). When it fails, capture is skipped but the
  // run is still tracked and spawned with ignored stdio. Both branches assign all
  // three, so they're declared without a (useless) initial value.
  let logFd: number | null;
  let logPath: string | null;
  let stdio: "ignore" | ["ignore", number, number];
  try {
    const runsDir = resolveRunsDir(env);
    mkdirSync(runsDir, { recursive: true, mode: 0o700 });
    logPath = join(runsDir, `${runId}.log`);
    logFd = openSync(logPath, "a", 0o600);
    stdio = ["ignore", logFd, logFd];
  } catch {
    logFd = null;
    logPath = null;
    stdio = "ignore";
  }

  let child: ChildProcess;
  try {
    child = spawn(input.bin, input.args, {
      detached: true,
      stdio,
      env: input.env,
    });
  } catch (err) {
    // Synchronous spawn failure: record the run already-ended (failed) so the
    // attempt leaves a diagnosable trace, close the log, and rethrow for the
    // caller to decide (throw vs skip).
    if (logFd !== null) closeIgnore(logFd);
    tracker.recordRunStart({
      id: runId,
      kind: input.kind,
      repo: input.repo ?? null,
      pid: null,
      log_path: logPath,
    });
    tracker.markRunEnd(runId, {
      exit_code: null,
      detail: `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    throw err;
  }

  // Record the run now that we have its pid + log path. This is the control
  // plane's ONLY record of the child: the row, the log reference, the kill path
  // and the exit listener all hang off it. If the registry write throws (SQLite
  // locked, a failed migration, disk full, …) AFTER a successful spawn, the
  // child is already running with no row, no kill path and no exit listener — a
  // fail-OPEN orphan that defeats the control plane. Fail CLOSED instead: kill
  // the child we just spawned, close the log fd, and rethrow so the caller sees
  // the failure. Nothing was unref'd or listened-to yet, so a SIGTERM here fully
  // reaps the orphan.
  try {
    tracker.recordRunStart({
      id: runId,
      kind: input.kind,
      repo: input.repo ?? null,
      pid: child.pid ?? null,
      log_path: logPath,
    });
  } catch (err) {
    try {
      child.kill("SIGTERM");
    } catch {
      // Best-effort: the child may have already exited between spawn and here.
    }
    if (logFd !== null) closeIgnore(logFd);
    throw err;
  }

  const finalize = (code: number | null, errDetail?: string): void => {
    if (logFd !== null) {
      closeIgnore(logFd);
      logFd = null;
    }
    tracker.markRunEnd(runId, {
      exit_code: code,
      ...(errDetail !== undefined ? { detail: errDetail } : {}),
    });
  };

  // Attach BEFORE unref so the listener still fires while the API process lives.
  child.on("exit", (code) => finalize(code));
  child.on("error", (err) =>
    finalize(null, `child error: ${err instanceof Error ? err.message : String(err)}`),
  );
  child.unref();

  return { started: true, pid: child.pid ?? null, runId };
}

/** Close a fd, swallowing an already-closed/invalid-fd error. */
function closeIgnore(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Already closed or invalid — nothing to do.
  }
}
