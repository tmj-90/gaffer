import { type RunTracker, spawnTrackedRun } from "./runTracking.js";

/**
 * Fires the configured merge command for an approved (`ready_for_merge`) ticket: from
 * the human's Approve when AUTO_MERGE ("Auto-merge on approval") is on, and from the
 * explicit Merge (POST /tickets/:id/merge) always.
 *
 * The runner's `bin/merge-ticket.mjs` attempts the merge of the ticket's
 * delivery branch; on a CONFLICT it spawns a resolver agent that fixes the branch
 * and calls back `wg ticket reopen-for-review …` so the human re-reviews the
 * resolved diff. This module only *starts* that command — fire-and-gaffert, like
 * the product-owner runner — and logs the outcome; it never blocks the approve
 * response on the (slow) merge finishing.
 *
 * Safety (mirrors planBuild's spawn): NO shell — the operator-configured command
 * is parsed into argv tokens, and the only request-derived value (`--ticket
 * <number>`) is appended as discrete argv elements, so nothing the caller controls
 * reaches a shell. Dispatch's own bearer token is STRIPPED from the child env as
 * defence-in-depth so a misbehaving merge helper can never echo it back. Errors
 * are logged, never fatal: a failed merge leaves the ticket `done` for a manual
 * merge, exactly as before this feature existed.
 */

/** Env var holding the operator-provided merge command (e.g. `node …/merge-ticket.mjs`). */
export const MERGE_CMD_ENV = "DISPATCH_MERGE_CMD";

export interface MergeTriggerResult {
  /** True when a merge command was configured and spawned. */
  triggered: boolean;
  /**
   * Reason a merge was NOT triggered. `in_flight`: this runner already started a merge
   * for the ticket and that process is still alive, so a second one was not spawned.
   */
  /** OS process id of the spawned merge, or null (unconfigured / withheld). */
  pid: number | null;
  skipped?: string;
  /** The tracked run id (when a registry is wired), so the UI can poll it. */
  runId?: string | null;
}

export interface MergeRunner {
  /** Trigger the merge for an approved ticket (by its number). */
  trigger(input: { ticketNumber: number }): MergeTriggerResult;
  /**
   * True when a merge command is configured, so a trigger actually starts a merge. The
   * Review view's "what happens on approve" reads it; a runner without it is treated as
   * unconfigured (never promise a merge that may not start).
   */
  configured?(): boolean;
}

/** A logger seam so tests can assert the logged outcome without stderr noise. */
export type MergeLogger = (message: string) => void;

const defaultLogger: MergeLogger = (message) => {
  // Operational breadcrumb for an async merge.
  console.error(`[dispatch:merge] ${message}`);
};

/**
 * Parse a configured command string into argv tokens.
 *
 * Two forms are supported, so a checkout path containing spaces never breaks:
 *   1. JSON array — if the trimmed value parses as a JSON array of strings, it is
 *      used VERBATIM as argv (e.g. `["node","/Users/My Repo/merge.mjs"]` yields a
 *      single argv element for the space-containing path). This is the robust form.
 *   2. Whitespace split — the legacy back-compat form: the string is split on
 *      runs of whitespace. Fine for space-free paths, lossy for paths with spaces.
 *
 * There is no shell in either path — the result is spawned as discrete argv. The
 * command is a FIXED operator-controlled value (never request input). An empty or
 * blank value (or an empty/invalid JSON array) yields an empty array, treated as
 * "unconfigured" by the caller.
 */
export function parseCommand(command: string): string[] {
  const trimmed = command.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every((token) => typeof token === "string")) {
        // Verbatim argv: each element is preserved exactly, spaces and all.
        return (parsed as string[]).filter((token) => token.length > 0);
      }
      // Parsed but not a string[] — fall through to the whitespace split so a
      // stray `[` in a legacy string command can't silently drop the command.
    } catch {
      // Not valid JSON — treat as a legacy whitespace-delimited string.
    }
  }
  return trimmed.split(/\s+/).filter((token) => token.length > 0);
}

/** True while the process `pid` exists (signal 0 probes without signalling). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else (a reused pid): treat as alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Strip Dispatch's bearer token from the child env (defence-in-depth). */
function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { DISPATCH_API_TOKEN: _omitToken, ...rest } = env;
  void _omitToken;
  return rest;
}

/**
 * Build the default merge runner. Spawns {@link MERGE_CMD_ENV} detached (so the
 * slow merge outlives the HTTP request) with `--ticket <number>` appended. When
 * the env var is unset/blank it skips silently — preserving today's manual-merge
 * behaviour.
 */
export function createMergeRunner(
  env: NodeJS.ProcessEnv = process.env,
  log: MergeLogger = defaultLogger,
  tracker?: RunTracker,
): MergeRunner {
  // IN-FLIGHT GUARD (exploratory finding api/F1): the merge this runner started per
  // ticket. Two Merge clicks (or an Approve with Auto-merge and a Merge now) used to
  // spawn two merge-ticket runs on one ticket: the second tore down the first's merge-gate
  // scratch checkout, the first read that as a conflict and sent the approved ticket
  // back to review. A second trigger while the first process is alive starts nothing.
  const inFlight = new Map<number, number>();
  return {
    configured: () => parseCommand(env[MERGE_CMD_ENV] ?? "").length > 0,
    trigger({ ticketNumber }) {
      const tokens = parseCommand(env[MERGE_CMD_ENV] ?? "");
      if (tokens.length === 0) {
        // Unconfigured: skip silently — manual merge stays the default.
        return { triggered: false, pid: null, skipped: "not_configured" };
      }
      const running = inFlight.get(ticketNumber);
      if (running !== undefined) {
        if (pidAlive(running)) return { triggered: false, pid: running, skipped: "in_flight" };
        inFlight.delete(ticketNumber);
      }
      const [bin, ...rest] = tokens;
      const args = [...rest, "--ticket", String(ticketNumber)];
      try {
        // No shell: argv is [bin, ...args]; the ticket number is a discrete argv
        // element, never interpolated into a command line. The child env has
        // Dispatch's bearer token stripped. RUN-ACTIVITY: recorded + output
        // captured when a tracker is wired (the merge's outcome is now a row, not
        // just a console breadcrumb). The child's own error listener still logs.
        const result = spawnTrackedRun(
          { bin: bin!, args, env: childEnv(env), kind: "merge", repo: null },
          tracker,
          env,
        );
        if (result.pid !== null) inFlight.set(ticketNumber, result.pid);
        return { triggered: true, pid: result.pid, runId: result.runId };
      } catch (err) {
        // A synchronous spawn failure must not break the approve response — log
        // and fall through to the manual-merge default. spawnTrackedRun has
        // already recorded the failed attempt when a tracker was wired.
        log(
          `could not spawn merge command for ticket #${ticketNumber}: ` +
            `${err instanceof Error ? err.message : String(err)} — ticket left done for manual merge`,
        );
        return { triggered: false, pid: null, skipped: "spawn_error" };
      }
    },
  };
}
