/**
 * Resolve the brownfield decomposer for the idle feature-backlog loop.
 *
 *   idle_feature_backlog.enabled && decompose_script set -> real SpawnDecomposer
 *   idle_feature_backlog.enabled && GAFFER_DECOMPOSE_SCRIPT in the environment
 *                                                        -> real SpawnDecomposer on
 *                                                           the runner's own
 *                                                           bin/decompose.mjs (what
 *                                                           runner/tick.sh passes on
 *                                                           an idle tick)
 *   otherwise                                            -> null (loop no-ops)
 *
 * Returning `null` (rather than throwing) keeps the no-decomposer path a
 * first-class case: the entry point simply skips the loop, matching how the
 * async lore-gap loop degrades when no real Memory is configured.
 */
import { dirname } from "node:path";

import { SpawnDecomposer, type Decomposer } from "./decomposer.js";
import type { CrewConfig } from "../config/schema.js";

/** The decompose helper to spawn, or null: crew.yaml's script first, else the runner's. */
function decomposeScript(
  config: CrewConfig,
  env: NodeJS.ProcessEnv,
): { scriptPath: string; cwd: string | null } | null {
  const cfg = config.loops.idle_feature_backlog;
  if (cfg.decompose_script !== null) {
    return { scriptPath: cfg.decompose_script, cwd: cfg.decompose_cwd };
  }
  const fromEnv = env.GAFFER_DECOMPOSE_SCRIPT?.trim();
  if (!fromEnv) return null;
  // bin/decompose.mjs lives one level under the runner root, its working dir.
  return { scriptPath: fromEnv, cwd: cfg.decompose_cwd ?? dirname(dirname(fromEnv)) };
}

/** True when config (or the runner's environment) wires a real decomposer. */
export function hasRealDecomposer(
  config: CrewConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return config.loops.idle_feature_backlog.enabled && decomposeScript(config, env) !== null;
}

/** Build the real decomposer when configured, else return null. */
export function resolveDecomposer(
  config: CrewConfig,
  env: NodeJS.ProcessEnv = process.env,
): Decomposer | null {
  const cfg = config.loops.idle_feature_backlog;
  if (!cfg.enabled) return null;
  const script = decomposeScript(config, env);
  if (script === null) return null;
  return new SpawnDecomposer({
    scriptPath: script.scriptPath,
    ...(script.cwd !== null ? { cwd: script.cwd } : {}),
    timeoutMs: cfg.decompose_timeout_ms,
  });
}
