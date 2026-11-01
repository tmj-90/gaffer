import { DispatchError } from "../util/errors.js";

import { parseCommand } from "./mergeRunner.js";
import { type RunTracker, spawnTrackedRun } from "./runTracking.js";
import { listSettings } from "./settings.js";

/**
 * Fires a single factory tick on demand — the Work/board view's "Poll for work"
 * button. The factory normally ticks on its own schedule; this lets a human nudge
 * it so claimable work is picked up immediately instead of waiting for the next
 * cycle.
 *
 * Safety (mirrors mergeRunner's spawn EXACTLY): NO shell — the operator-configured
 * {@link DISPATCH_TICK_CMD} is parsed into argv tokens and spawned directly, so
 * nothing the caller controls reaches a shell (the request carries no input into
 * the command at all). Dispatch's own bearer token is STRIPPED from the child env
 * as defence-in-depth so a misbehaving tick helper can never echo it back. The run
 * is fire-and-gaffert (detached + unref) so the slow tick outlives the HTTP request.
 *
 * Unlike the merge runner (which skips silently when unconfigured, preserving a
 * manual-merge default), an unconfigured tick is a USER ACTION with no fallback —
 * the human clicked a button expecting something to happen — so it surfaces a clear
 * NOT_CONFIGURED, exactly like the product-owner runner does.
 */

/** Env var holding the operator-provided factory-tick command (e.g. `node …/tick.mjs`). */
export const TICK_CMD_ENV = "DISPATCH_TICK_CMD";

export interface PollWorkResult {
  /** True when a tick command was configured and spawned. */
  started: boolean;
  /** OS process id of the spawned tick, or null if the platform withheld one. */
  pid: number | null;
  /** The tracked run id (when a registry is wired), so the UI can poll it. */
  runId?: string | null;
}

export interface PollWorkRunner {
  /** Trigger one factory tick. Throws NOT_CONFIGURED when no command is set. */
  run(): PollWorkResult;
}

/** Strip Dispatch's bearer token from the child env (defence-in-depth). */
function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { DISPATCH_API_TOKEN: _omitToken, ...rest } = env;
  void _omitToken;
  return rest;
}

/**
 * Build the default poll-work runner. Spawns {@link TICK_CMD_ENV} detached (so the
 * slow tick outlives the HTTP request) with no request-derived arguments. When the
 * env var is unset/blank it throws NOT_CONFIGURED — the click had no effect and the
 * human should be told why, rather than silently doing nothing.
 */
export function createPollWorkRunner(
  env: NodeJS.ProcessEnv = process.env,
  tracker?: RunTracker,
): PollWorkRunner {
  return {
    run() {
      const tokens = parseCommand(env[TICK_CMD_ENV] ?? "");
      if (tokens.length === 0) {
        throw new DispatchError(
          "NOT_CONFIGURED",
          `No factory-tick command configured. Set ${TICK_CMD_ENV} to the command ` +
            `that runs one factory tick (e.g. the runner tick helper).`,
        );
      }
      const [bin, ...args] = tokens;
      // No shell: argv is [bin, ...args]; the request carries no input into the
      // command. The child env has Dispatch's bearer token stripped.
      // RUN-ACTIVITY: recorded + output captured when a tracker is wired.
      const result = spawnTrackedRun(
        { bin: bin!, args, env: childEnv(env), kind: "poll_work", repo: null },
        tracker,
        env,
      );
      return { started: result.started, pid: result.pid, runId: result.runId };
    },
  };
}

/** The two dollar caps a live run accepts (runner/lib/budget.sh gaffer_spend_cap_ok). */
const SPEND_CAP_KEYS = ["GAFFER_DAILY_BUDGET_USD", "GAFFER_BUDGET_USD"] as const;

/**
 * The fix runner/lib/budget.sh gaffer_spend_cap_hint prints when a live run has no
 * dollar cap, word for word, so the dashboard says what the runner would.
 */
export const NO_SPEND_CAP_MESSAGE =
  "no dollar cap is set: set GAFFER_DAILY_BUDGET_USD (try 5) or GAFFER_BUDGET_USD in your " +
  "environment or the dashboard's Settings → Budget & caps; GAFFER_ALLOW_UNCAPPED=1 runs without one";

/**
 * Would the runner refuse this poll for want of a dollar cap? Returns the refusal
 * message, or null when the poll may start. Mirrors gaffer_spend_cap_ok exactly: a dry
 * poll (DRY_RUN=1) and GAFFER_ALLOW_UNCAPPED=1 (environment only, never settings.json)
 * always pass; otherwise one of the caps must hold a positive figure, read the way the
 * runner reads it (awk `c+0 > 0`: a leading number, anything else is 0). The caps come
 * from the same place the spawned tick takes them: the operator's env when set, else
 * settings.json, read fresh. A settings.json that cannot be read is left to the runner,
 * which refuses with its own reason.
 */
export function spendCapRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  if ((env["DRY_RUN"] ?? "").trim() === "1") return null;
  if ((env["GAFFER_ALLOW_UNCAPPED"] ?? "").trim() === "1") return null;
  let views: ReturnType<typeof listSettings>;
  try {
    views = listSettings(env);
  } catch {
    return null;
  }
  const capped = SPEND_CAP_KEYS.some((key) => {
    const v = views.find((s) => s.key === key)?.effective ?? "";
    return Number.parseFloat(v) > 0;
  });
  return capped ? null : NO_SPEND_CAP_MESSAGE;
}
