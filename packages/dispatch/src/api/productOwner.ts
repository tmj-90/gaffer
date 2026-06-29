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

/**
 * The dashboard's action-command env vars — each backs a button that spawns a
 * detached factory runner. When the API is launched ad-hoc (e.g. `node bin.js`
 * directly) instead of via `gaffer dashboard`, these go UNSET and the matching
 * buttons silently no-op (or 500 with NOT_CONFIGURED), which looks like the
 * dashboard is broken. We log the wired/missing split once at startup so a
 * mis-launched dashboard is obvious from the API log.
 */
export const ACTION_COMMAND_ENVS = [
  "DISPATCH_PRODUCT_OWNER_CMD",
  "DISPATCH_MERGE_CMD",
  "DISPATCH_TICK_CMD",
  "DISPATCH_ONBOARD_CMD",
  "DISPATCH_TESTER_CMD",
] as const;

/**
 * Report which {@link ACTION_COMMAND_ENVS} are wired vs missing. Pure: returns the
 * split and writes a single human-readable line via `write` (stderr by default, so
 * it never pollutes a JSON stdout). Exposed for the startup log and for tests.
 */
export function reportActionCommandWiring(
  env: NodeJS.ProcessEnv = process.env,
  write: (line: string) => void = (line) => process.stderr.write(line),
): { wired: string[]; missing: string[] } {
  const wired: string[] = [];
  const missing: string[] = [];
  for (const key of ACTION_COMMAND_ENVS) {
    if ((env[key] ?? "").trim() !== "") wired.push(key);
    else missing.push(key);
  }
  write(
    `dispatch-api action commands — wired: ${wired.join(", ") || "(none)"}; ` +
      `missing: ${missing.join(", ") || "(none)"}` +
      (missing.length > 0
        ? " — those dashboard buttons will no-op; launch via `gaffer dashboard` to wire them all\n"
        : "\n"),
  );
  return { wired, missing };
}

/** Process-once guard so the startup wiring line is logged a single time. */
let actionWiringReported = false;

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
  // STARTUP DIAGNOSTIC: the default runner is constructed once when the API server
  // boots (a default param of createApiServer/createApiHandler), so logging here
  // surfaces the action-command wiring exactly once at startup — without touching
  // the server bootstrap. Guarded so repeated construction (tests) stays quiet.
  if (!actionWiringReported) {
    actionWiringReported = true;
    reportActionCommandWiring(env);
  }
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
