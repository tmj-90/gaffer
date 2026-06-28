import type { Db } from "../db/connection.js";
import type { Run, RunKind, RunStatus } from "../domain/types.js";

/** Fields needed to record the start of a tracked run. */
export interface RunStartInput {
  id: string;
  kind: RunKind;
  repo: string | null;
  pid: number | null;
  log_path: string | null;
  started_at: string;
}

/** Fields recorded when a tracked run ends. */
export interface RunEndInput {
  id: string;
  status: RunStatus;
  ended_at: string;
  exit_code: number | null;
  detail: string | null;
}

/** Options for {@link RunRepository.list}. */
export interface RunListOptions {
  /** When true, only `running` rows; otherwise the most-recent N of any status. */
  active?: boolean;
  /** Cap on rows returned (recent mode). Defaults to 20. */
  limit?: number;
}

/** Default cap on the most-recent-runs list. */
const DEFAULT_RECENT_LIMIT = 20;

/**
 * Liveness probe: is `pid` still a live process owned by us? `process.kill(pid,
 * 0)` sends no signal but performs the permission/existence check — it throws
 * ESRCH when no such process exists, and EPERM when the process exists but is
 * owned by another user (still "alive"). A null/invalid pid is treated as dead.
 * Injectable so {@link RunRepository.sweepStale} is testable without real pids.
 */
export type PidLivenessProbe = (pid: number) => boolean;

export const defaultPidLiveness: PidLivenessProbe = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM ⇒ the process exists but we may not signal it — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Data access for the run-activity registry (control plane). */
export class RunRepository {
  constructor(private readonly db: Db) {}

  /** Record a freshly-spawned run as `running`. */
  insertStart(input: RunStartInput): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, kind, repo, pid, status, started_at, log_path)
         VALUES (@id, @kind, @repo, @pid, 'running', @started_at, @log_path)`,
      )
      .run(input);
  }

  /**
   * Mark a run ended. Only patches a row that is still `running`, so a stale
   * sweep that already moved the row to `unknown` is never clobbered by a late
   * exit listener (and vice versa); the first writer wins.
   */
  markEnd(input: RunEndInput): void {
    this.db
      .prepare(
        `UPDATE runs
            SET status = @status, ended_at = @ended_at,
                exit_code = @exit_code, detail = @detail
          WHERE id = @id AND status = 'running'`,
      )
      .run(input);
  }

  findById(id: string): Run | undefined {
    return this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as Run | undefined;
  }

  /**
   * List runs. `active` ⇒ only `running` rows (most-recently-started first);
   * otherwise the most-recent `limit` rows of ANY status (started-first, then
   * ended). The default limit (recent mode) is {@link DEFAULT_RECENT_LIMIT}.
   */
  list(options: RunListOptions = {}): Run[] {
    if (options.active) {
      return this.db
        .prepare(`SELECT * FROM runs WHERE status = 'running' ORDER BY started_at DESC`)
        .all() as Run[];
    }
    const limit = options.limit ?? DEFAULT_RECENT_LIMIT;
    return this.db
      .prepare(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`)
      .all(limit) as Run[];
  }

  /**
   * Reconcile orphans: any `running` row whose pid is no longer alive is flipped
   * to `unknown` with the given `endedAt`. Returns the ids swept. Called on API
   * startup so a dashboard restart never leaves a run wedged "running" forever
   * (its exit listener died with the previous process). A null pid is treated as
   * dead — we recorded a run we can't probe, so it can't be trusted as live.
   */
  sweepStale(endedAt: string, isAlive: PidLivenessProbe = defaultPidLiveness): string[] {
    const running = this.db
      .prepare(`SELECT id, pid FROM runs WHERE status = 'running'`)
      .all() as Array<{ id: string; pid: number | null }>;
    const swept: string[] = [];
    const update = this.db.prepare(
      `UPDATE runs SET status = 'unknown', ended_at = ?, detail = ?
         WHERE id = ? AND status = 'running'`,
    );
    for (const row of running) {
      if (row.pid !== null && isAlive(row.pid)) continue;
      update.run(endedAt, "process no longer alive at API startup", row.id);
      swept.push(row.id);
    }
    return swept;
  }
}
