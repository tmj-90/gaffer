import { DispatchError } from "../util/errors.js";

import { parseCommand } from "./mergeRunner.js";
import { type RunTracker, spawnTrackedRun } from "./runTracking.js";

/**
 * Kicks off a repo onboarding run — the Memory view's "Onboard a repo" button's
 * backend.
 *
 * Onboarding is a crew/crew capability: it scans a repo, registers it in
 * Dispatch, and (via the onboard producer) builds the repo's digest + inventories
 * its shipped features into Memory — the SAME store the Memory views read. The
 * Memory views tell the user to onboard a repo to populate them; this lets them DO
 * it from the UI instead of dropping to the CLI.
 *
 * This module only *starts* that run (fire-and-gaffert); the digest + feature ledger
 * land asynchronously, after which the Memory view is re-read.
 */

/** Env var holding the operator-provided command that onboards a repo. */
export const ONBOARD_CMD_ENV = "DISPATCH_ONBOARD_CMD";

/** Env var the spawned command reads to learn which repo (id/name/path) to onboard. */
export const ONBOARD_REPO_ENV = "DISPATCH_ONBOARD_REPO";

export interface OnboardRunResult {
  /** True when an onboard command was configured and spawned. */
  started: boolean;
  /** OS process id of the spawned run, or null if the platform withheld one. */
  pid: number | null;
  /** The tracked run id (when a registry is wired), so the UI can poll it. */
  runId?: string | null;
}

export interface OnboardRunner {
  /** Start an onboarding run for `repo` (a registered repo id/name, or a path). */
  run(input: { repo: string }): OnboardRunResult;
}

/** Strip Dispatch's bearer token from the child env (defence-in-depth). */
function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { DISPATCH_API_TOKEN: _omitToken, ...rest } = env;
  void _omitToken;
  return rest;
}

/**
 * Build the default onboard runner. It spawns {@link ONBOARD_CMD_ENV} detached so
 * the slow scan + digest build outlives the HTTP request.
 *
 * Safety (mirrors the merge/poll-work/product-owner runners): NO shell — the
 * operator-configured command is parsed into argv tokens and spawned directly, so
 * nothing reaches a shell. Request input is never interpolated into the command;
 * the (validated) `repo` rides in the child env via {@link ONBOARD_REPO_ENV}, never
 * on the command line. Dispatch's own bearer token is STRIPPED from the child env
 * as defence-in-depth so a misbehaving onboard helper can never echo it back.
 *
 * Unlike the merge runner (which skips silently when unconfigured), an unconfigured
 * onboard is a USER ACTION with no fallback — the human clicked a button expecting
 * something to happen — so it surfaces a clean NOT_CONFIGURED, exactly like the
 * poll-work / product-owner runners do (mapped to a 503 envelope, never a 500).
 */
export function createOnboardRunner(
  env: NodeJS.ProcessEnv = process.env,
  tracker?: RunTracker,
): OnboardRunner {
  return {
    run({ repo }) {
      const tokens = parseCommand(env[ONBOARD_CMD_ENV] ?? "");
      if (tokens.length === 0) {
        throw new DispatchError(
          "NOT_CONFIGURED",
          `No onboarding command configured. Set ${ONBOARD_CMD_ENV} to the command ` +
            `that onboards a repo (scans it, registers it, and builds its Memory digest).`,
        );
      }
      const [bin, ...args] = tokens;
      const base = childEnv(env);
      // No shell: argv is [bin, ...args]; the only caller-derived value (`repo`)
      // rides in the child env, never on the command line. Token stripped above.
      // RUN-ACTIVITY: recorded + output captured when a tracker is wired.
      const result = spawnTrackedRun(
        {
          bin: bin!,
          args,
          env: { ...base, [ONBOARD_REPO_ENV]: repo },
          kind: "onboard",
          repo,
        },
        tracker,
        env,
      );
      return { started: result.started, pid: result.pid, runId: result.runId };
    },
  };
}
