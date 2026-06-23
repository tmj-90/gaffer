/**
 * Resolve the brownfield decomposer for the idle feature-backlog loop.
 *
 *   idle_feature_backlog.enabled && decompose_script set -> real SpawnDecomposer
 *   otherwise                                            -> null (loop no-ops)
 *
 * Returning `null` (rather than throwing) keeps the no-decomposer path a
 * first-class case: the entry point simply skips the loop, matching how the
 * async lore-gap loop degrades when no real Memory is configured.
 */
import { SpawnDecomposer, type Decomposer } from "./decomposer.js";
import type { CrewConfig } from "../config/schema.js";

/** True when config wires a real brownfield decomposer for the backlog loop. */
export function hasRealDecomposer(config: CrewConfig): boolean {
  const cfg = config.loops.idle_feature_backlog;
  return cfg.enabled && cfg.decompose_script !== null;
}

/** Build the real decomposer when configured, else return null. */
export function resolveDecomposer(config: CrewConfig): Decomposer | null {
  const cfg = config.loops.idle_feature_backlog;
  if (!cfg.enabled || cfg.decompose_script === null) return null;
  return new SpawnDecomposer({
    scriptPath: cfg.decompose_script,
    ...(cfg.decompose_cwd !== null ? { cwd: cfg.decompose_cwd } : {}),
    timeoutMs: cfg.decompose_timeout_ms,
  });
}
