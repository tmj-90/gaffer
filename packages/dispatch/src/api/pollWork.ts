import { spawn } from "node:child_process";

import { DispatchError } from "../util/errors.js";

import { parseCommand } from "./mergeRunner.js";

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
export function createPollWorkRunner(env: NodeJS.ProcessEnv = process.env): PollWorkRunner {
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
      const child = spawn(bin!, args, {
        detached: true,
        stdio: "ignore",
        env: childEnv(env),
      });
      child.unref();
      return { started: true, pid: child.pid ?? null };
    },
  };
}
