import { DispatchError } from "../util/errors.js";

import { parseCommand } from "./mergeRunner.js";
import { type RunTracker, spawnTrackedRun } from "./runTracking.js";

/**
 * Kicks off a headless product-owner run — the "Suggest work" button's backend.
 *
 * The product-owner skill, run headlessly against a repo, files fresh draft
 * tickets into this backlog; they then surface in the board's draft column for a
 * human to triage. This module only *starts* that run (fire-and-gaffert); it does
 * not wait for the drafts, which arrive asynchronously.
 */

/** Env var holding the operator-provided command that runs the skill headlessly. */
export const PRODUCT_OWNER_CMD_ENV = "DISPATCH_PRODUCT_OWNER_CMD";

/** Env var the spawned command reads to learn which repo to suggest work for. */
export const PRODUCT_OWNER_REPO_ENV = "DISPATCH_PRODUCT_OWNER_REPO";

export interface ProductOwnerRunResult {
  started: boolean;
  /** OS process id of the spawned run, or null if the platform withheld one. */
  pid: number | null;
  /** The tracked run id (when a registry is wired), so the UI can poll it. */
  runId?: string | null;
}

export interface ProductOwnerRunner {
  /** Start a run; `repo` (if given) names the repo to suggest work for. */
  run(input: { repo?: string }): ProductOwnerRunResult;
}

/** Strip Dispatch's bearer token from the child env (defence-in-depth). */
function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { DISPATCH_API_TOKEN: _omitToken, ...rest } = env;
  void _omitToken;
  return rest;
}

/**
 * Build the default runner. It spawns {@link PRODUCT_OWNER_CMD_ENV} detached so
 * the slow headless run outlives the HTTP request.
 *
 * Safety (mirrors the merge/poll-work/plan-build runners): NO shell — the
 * operator-configured command is parsed into argv tokens and spawned directly, so
 * nothing reaches a shell. Request input is never interpolated into the command;
 * the (validated) `repo` is passed via {@link PRODUCT_OWNER_REPO_ENV} in the child
 * environment, not on the command line. Dispatch's own bearer token is STRIPPED
 * from the child env as defence-in-depth (contract: agent children never inherit
 * DISPATCH_API_TOKEN) so a misbehaving run helper can never echo it back.
 *
 * RUN-ACTIVITY: when a {@link RunTracker} is wired the run is recorded in the
 * `runs` registry and its (previously discarded) output is captured to a per-run
 * log file — so a run that files 0 tickets is diagnosable. Without a tracker the
 * spawn degrades to the legacy ignore-output behaviour.
 */
export function createProductOwnerRunner(
  env: NodeJS.ProcessEnv = process.env,
  tracker?: RunTracker,
): ProductOwnerRunner {
  return {
    run({ repo }) {
      const tokens = parseCommand(env[PRODUCT_OWNER_CMD_ENV] ?? "");
      if (tokens.length === 0) {
        throw new DispatchError(
          "NOT_CONFIGURED",
          `No product-owner runner configured. Set ${PRODUCT_OWNER_CMD_ENV} to the ` +
            `command that runs the product-owner skill headlessly.`,
        );
      }
      const [bin, ...args] = tokens;
      const base = childEnv(env);
      // No shell: argv is [bin, ...args]; the only caller-derived value (`repo`)
      // rides in the child env, never on the command line. Token stripped above.
      const result = spawnTrackedRun(
        {
          bin: bin!,
          args,
          env: repo ? { ...base, [PRODUCT_OWNER_REPO_ENV]: repo } : base,
          kind: "product_owner",
          repo: repo ?? null,
        },
        tracker,
        env,
      );
      return { started: result.started, pid: result.pid, runId: result.runId };
    },
  };
}
