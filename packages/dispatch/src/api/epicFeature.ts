import type { Dispatch } from "../core.js";
import type { CreateEpicResult } from "../services/epicsService.js";

import { parseCommand } from "./mergeRunner.js";
import { type RunTracker, spawnTrackedRun } from "./runTracking.js";
import type { CreateEpicBody } from "./schemas.js";

/**
 * The BROWNFIELD epic → feature(`building`) hook's live trigger.
 *
 * When a human confirms a brownfield epic (every ticket targets ONE existing,
 * registered repo — no bootstrap, no deferred greenfield link), the work for that
 * feature has started, so the memory feature ledger should show it as `building`.
 * The runner's `bin/epic-feature.mjs` does that write (add_feature with
 * status=building and the epic ref as provenance). This module only *starts* it
 * after POST /epics succeeds — fire-and-forget, best-effort, never blocking or
 * failing the epic create.
 *
 * Safety (mirrors the merge runner): NO shell — the operator-configured command is
 * parsed into argv tokens and the request-derived values (repo name, epic ref,
 * epic name/summary) are appended as DISCRETE argv elements, so nothing the caller
 * controls reaches a shell. Dispatch's bearer token is stripped from the child env.
 * Unconfigured → skipped silently (no feature write), exactly as before this hook
 * was wired.
 */

/** Env var holding the operator-provided command (e.g. `node …/bin/epic-feature.mjs`). */
export const EPIC_FEATURE_CMD_ENV = "DISPATCH_EPIC_FEATURE_CMD";

export interface EpicFeatureTriggerResult {
  triggered: boolean;
  pid: number | null;
  skipped?: string;
  runId?: string | null;
}

export interface EpicFeatureRunner {
  trigger(input: {
    repo: string;
    epic: string;
    name: string;
    summary: string;
  }): EpicFeatureTriggerResult;
}

function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { DISPATCH_API_TOKEN: _omitToken, ...rest } = env;
  void _omitToken;
  return rest;
}

export function createEpicFeatureRunner(
  env: NodeJS.ProcessEnv = process.env,
  tracker?: RunTracker,
): EpicFeatureRunner {
  return {
    trigger({ repo, epic, name, summary }) {
      const tokens = parseCommand(env[EPIC_FEATURE_CMD_ENV] ?? "");
      if (tokens.length === 0) return { triggered: false, pid: null, skipped: "not_configured" };
      const [bin, ...rest] = tokens;
      const args = [...rest, "--repo", repo, "--epic", epic, "--name", name];
      if (summary) args.push("--summary", summary);
      try {
        const result = spawnTrackedRun(
          { bin: bin!, args, env: childEnv(env), kind: "other", repo },
          tracker,
          env,
        );
        return { triggered: true, pid: result.pid, runId: result.runId };
      } catch (err) {
        console.error(
          `[dispatch:epic-feature] could not spawn the feature hook for epic ${epic}: ` +
            `${err instanceof Error ? err.message : String(err)} — epic created, feature ledger not updated`,
        );
        return { triggered: false, pid: null, skipped: "spawn_error" };
      }
    },
  };
}

/**
 * The repo NAME a just-created epic is brownfield for, or null. Brownfield means:
 * no greenfield link was deferred, no ticket is a bootstrap, and EVERY ticket names a
 * repo that resolves (by id or name) to the SAME registered repository. A mixed or
 * repo-less plan is not one feature of one repo, so no feature row is written.
 */
export function brownfieldEpicRepo(
  wg: Dispatch,
  body: CreateEpicBody,
  result: CreateEpicResult,
): string | null {
  if (result.deferredRepoLinks > 0) return null;
  const repos = wg.listRepositories(true);
  const ids = new Set<string>();
  let name: string | null = null;
  for (const t of body.tickets) {
    if (t.bootstrap === true || !t.repo) return null;
    const hit = repos.find((r) => r.id === t.repo || r.name === t.repo);
    if (!hit) return null;
    ids.add(hit.id);
    name = hit.name;
  }
  return ids.size === 1 ? name : null;
}
