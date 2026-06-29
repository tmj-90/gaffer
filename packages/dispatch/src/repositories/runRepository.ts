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
  /**
   * Cap on rows returned in ACTIVE mode. Defaults to {@link DEFAULT_ACTIVE_LIMIT}.
   * Bounds an otherwise-unbounded "running" list (a wedged factory could
   * accumulate thousands of `running` rows); see {@link RunListResult.truncated}.
   */
  activeLimit?: number;
}

/** Result of {@link RunRepository.listResult}: rows plus a truncation flag. */
export interface RunListResult {
  /** The (capped) rows. */
  runs: Run[];
  /** True when more rows matched than the cap returned (the list was truncated). */
  truncated: boolean;
}

/** Default cap on the most-recent-runs list. */
const DEFAULT_RECENT_LIMIT = 20;

/**
 * Default cap on the ACTIVE (`running`) list. Bounds the in-flight panel so a
 * wedged factory that leaked thousands of `running` rows can't return an
 * unbounded result set. Generous relative to any sane real concurrency.
 */
export const DEFAULT_ACTIVE_LIMIT = 100;

/**
 * Default max age before a still-`running` row is swept regardless of pid
 * liveness (24h). The pid-liveness probe alone is PID-reuse-vulnerable: a reused
 * pid can keep a long-dead run "active" forever. An age cap guarantees eventual
 * reconciliation. Overridable via `GAFFER_RUN_MAX_AGE_MS`.
 * NOTE (deferred): storing a process-start identity (pid + start time) is the
 * fuller fix that closes the reuse window precisely; the age cap is the bounded
 * mitigation.
 */
export const DEFAULT_RUN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Env var overriding {@link DEFAULT_RUN_MAX_AGE_MS}. */
const RUN_MAX_AGE_ENV = "GAFFER_RUN_MAX_AGE_MS";

/**
 * Resolve the sweep age cap from the environment. A positive finite integer in
 * `GAFFER_RUN_MAX_AGE_MS` overrides the default; anything else (unset, empty,
 * non-numeric, non-positive) falls back to {@link DEFAULT_RUN_MAX_AGE_MS}.
 */
export function resolveRunMaxAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env[RUN_MAX_AGE_ENV] ?? "").trim();
  if (raw === "") return DEFAULT_RUN_MAX_AGE_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RUN_MAX_AGE_MS;
}

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
   * List runs. `active` ⇒ only `running` rows (most-recently-started first),
   * hard-capped at {@link RunListOptions.activeLimit} / {@link DEFAULT_ACTIVE_LIMIT};
   * otherwise the most-recent `limit` rows of ANY status. Both modes are bounded
   * so neither can return an unbounded result set. For active-mode truncation
   * awareness use {@link listResult}.
   */
  list(options: RunListOptions = {}): Run[] {
    return this.listResult(options).runs;
  }

  /**
   * As {@link list}, but also reports whether the (active) list was truncated by
   * the cap — so a caller (API/dashboard) can surface "showing N of many".
   * Truncation is detected by fetching one extra row beyond the cap.
   */
  listResult(options: RunListOptions = {}): RunListResult {
    if (options.active) {
      const cap = options.activeLimit ?? DEFAULT_ACTIVE_LIMIT;
      // Fetch cap+1 so a full+1 result tells us there were more than the cap.
      const rows = this.db
        .prepare(`SELECT * FROM runs WHERE status = 'running' ORDER BY started_at DESC LIMIT ?`)
        .all(cap + 1) as Run[];
      const truncated = rows.length > cap;
      return { runs: truncated ? rows.slice(0, cap) : rows, truncated };
    }
    const limit = options.limit ?? DEFAULT_RECENT_LIMIT;
    const rows = this.db
      .prepare(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`)
      .all(limit + 1) as Run[];
    const truncated = rows.length > limit;
    return { runs: truncated ? rows.slice(0, limit) : rows, truncated };
  }

  /**
   * Reconcile orphans: a `running` row is flipped to `unknown` (with `endedAt`)
   * when EITHER
   *   - its pid is no longer alive (a null pid counts as dead — a run we can't
   *     probe can't be trusted live), OR
   *   - it is older than `maxAgeMs` (age = `endedAt` − `started_at`), regardless
   *     of pid liveness.
   *
   * The age cap exists because the pid-liveness probe alone is PID-reuse-
   * vulnerable: after the original process dies, the OS can hand its pid to an
   * unrelated process, and `process.kill(pid, 0)` would then keep the long-dead
   * run wedged `running` forever. The age cap guarantees eventual reconciliation.
   * (Deferred: a process-start identity closes the reuse window precisely.)
   *
   * Returns the ids swept. Called on API startup so a dashboard restart never
   * leaves a run wedged "running" forever (its exit listener died with the
   * previous process).
   */
  sweepStale(
    endedAt: string,
    isAlive: PidLivenessProbe = defaultPidLiveness,
    maxAgeMs: number = resolveRunMaxAgeMs(),
  ): string[] {
    const running = this.db
      .prepare(`SELECT id, pid, started_at FROM runs WHERE status = 'running'`)
      .all() as Array<{ id: string; pid: number | null; started_at: string }>;
    const swept: string[] = [];
    const update = this.db.prepare(
      `UPDATE runs SET status = 'unknown', ended_at = ?, detail = ?
         WHERE id = ? AND status = 'running'`,
    );
    const nowMs = Date.parse(endedAt);
    for (const row of running) {
      const pidDead = row.pid === null || !isAlive(row.pid);
      const tooOld = exceedsMaxAge(row.started_at, nowMs, maxAgeMs);
      if (!pidDead && !tooOld) continue;
      const detail = pidDead
        ? "process no longer alive at API startup"
        : `running longer than max age (${maxAgeMs}ms) — swept regardless of pid liveness`;
      update.run(endedAt, detail, row.id);
      swept.push(row.id);
    }
    return swept;
  }
}

/**
 * True when a row started more than `maxAgeMs` before `nowMs`. Defensive: an
 * unparseable `started_at` or `nowMs` yields false (we don't age-sweep a row we
 * can't date — the pid probe still governs it), so a clock/format anomaly can
 * never mass-sweep live runs.
 */
function exceedsMaxAge(startedAt: string, nowMs: number, maxAgeMs: number): boolean {
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(nowMs)) return false;
  return nowMs - startedMs > maxAgeMs;
}
