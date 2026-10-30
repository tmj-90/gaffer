import type { CommandRunner } from "../../adapters/commandRunner.js";
import type { CrewConfig } from "../../config/schema.js";
import type { OracleSet } from "../idleLoop.js";
import { createSecurityOracle } from "./securityOracle.js";
import { createTscOracle } from "./tscOracle.js";

/**
 * The production oracle set for one idle tick, from `loops.oracles`. Returns
 * undefined when the flag is off (the default), so every scan loop keeps its
 * heuristic path exactly as before. Only tsc and semgrep are offered, both
 * resolved from PATH (never the repo's node_modules/.bin): eslint and knip load
 * the repo's own JS config, which would run repo code on the host.
 */
export function buildOracleSet(runner: CommandRunner, config: CrewConfig): OracleSet | undefined {
  const cfg = config.loops.oracles;
  if (!cfg.enabled) return undefined;
  const set: OracleSet = {};
  if (cfg.tools.includes("tsc")) set.tsc = createTscOracle(runner, "tsc", { pathOnly: true });
  if (cfg.tools.includes("semgrep"))
    set.security = createSecurityOracle(runner, { pathOnly: true });
  return set;
}
