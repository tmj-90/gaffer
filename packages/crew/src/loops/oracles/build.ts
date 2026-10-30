import type { CommandRunner } from "../../adapters/commandRunner.js";
import type { CrewConfig } from "../../config/schema.js";
import type { EventLog } from "../../events/eventLog.js";
import { idleHostExecRefused, type OracleSet } from "../idleLoop.js";
import { createSecurityOracle } from "./securityOracle.js";
import { createTscOracle } from "./tscOracle.js";

/**
 * The production oracle set for one idle tick, from `loops.oracles`. Returns
 * undefined when the flag is off (the default), so every scan loop keeps its
 * heuristic path exactly as before (as it does under strict containment, see
 * below). Only tsc and semgrep are offered, both
 * resolved from PATH (never the repo's node_modules/.bin): eslint and knip load
 * the repo's own JS config, which would run repo code on the host.
 */
export function buildOracleSet(
  runner: CommandRunner,
  config: CrewConfig,
  opts: { env?: NodeJS.ProcessEnv; events?: EventLog } = {},
): OracleSet | undefined {
  const cfg = config.loops.oracles;
  if (!cfg.enabled) return undefined;
  // Strict containment: the oracles run their tool ON THE HOST in the repo's
  // checkout, which GAFFER_STRICT_REQUIRE forbids for idle loops unless the
  // operator opts in (GAFFER_IDLE_HOST_EXEC=1). Refused ⇒ no oracles, so every
  // scan loop falls back to its in-process heuristic path (reads files, runs nothing).
  if (idleHostExecRefused(opts.env ?? process.env)) {
    opts.events?.record("oracles_refused", {
      reason:
        "GAFFER_STRICT_REQUIRE is on and the oracles run unsandboxed on the host; set GAFFER_IDLE_HOST_EXEC=1 to allow",
    });
    return undefined;
  }
  const set: OracleSet = {};
  if (cfg.tools.includes("tsc")) set.tsc = createTscOracle(runner, "tsc", { pathOnly: true });
  if (cfg.tools.includes("semgrep"))
    set.security = createSecurityOracle(runner, { pathOnly: true });
  return set;
}
