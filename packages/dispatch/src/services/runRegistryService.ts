/**
 * RUN-ACTIVITY registry on the facade: recording the start and end of a background run.
 */
import { type Run, type RunKind } from "../domain/types.js";
import { newId } from "../util/id.js";
import type { Dispatch } from "../core.js";

/** What these functions read from the {@link Dispatch} facade they are handed. */
export type RunRegistryHost = Pick<Dispatch, "clock" | "runs">;

/**
 * Record the start of a background run (a detached API-spawned child). Returns
 * the run id so the caller can later {@link markRunEnd} it (and the dashboard
 * can poll its status). The row is created `running`; `pid`/`log_path` are
 * stored as given (null when the platform withheld a pid or no log was opened).
 * The repo (the run's target, when known) is recorded for the panel.
 *
 * `id` may be supplied by the caller (so a per-run log file can be named by the
 * id BEFORE the row is written); when omitted a fresh id is minted.
 */
export function recordRunStart(
  host: RunRegistryHost,
  input: {
    id?: string;
    kind: RunKind;
    repo?: string | null;
    pid?: number | null;
    log_path?: string | null;
  },
): { id: string } {
  const id = input.id ?? newId();
  host.runs.insertStart({
    id,
    kind: input.kind,
    repo: input.repo ?? null,
    pid: input.pid ?? null,
    log_path: input.log_path ?? null,
    started_at: host.clock.now(),
  });
  return { id };
}

/**
 * Mark a tracked run ended. Derives status from the child's exit code: 0 ⇒
 * `succeeded`, any other value (or a null/unknown code) ⇒ `failed`, unless the
 * caller states it (a poll the runner refused exits 0 and is `failed`). A no-op if
 * the run was already swept to `unknown` (the first writer wins — see
 * {@link RunRepository.markEnd}), so a late exit listener never resurrects a
 * reconciled row.
 */
export function markRunEnd(
  host: RunRegistryHost,
  id: string,
  input: { exit_code: number | null; detail?: string | null; status?: Run["status"] },
): void {
  const status: Run["status"] = input.status ?? (input.exit_code === 0 ? "succeeded" : "failed");
  host.runs.markEnd({
    id,
    status,
    ended_at: host.clock.now(),
    exit_code: input.exit_code,
    detail: input.detail ?? null,
  });
}
