import type { Command } from "commander";

import { AUTONOMY_MODES } from "../../repositories/autonomyPolicyRepository.js";
import { DispatchError } from "../../util/errors.js";
import { open, printJson } from "../shared.js";

/**
 * GRADUATED-AUTONOMY: the read-only view of the stored per-(repo × risk × gate)
 * autonomy policy — the same rows GET /api/autonomy/policies serves the Settings
 * surface. Two runner consumers read it:
 *
 *  - `autonomy list` — `_gaffer_autonomy_on` in factory.config.sh decides whether
 *    the factory can ship unattended: a stored mode='auto' row is an allow-path the
 *    review gate honours in EVERY mode (isAutonomyAllowed = env floor OR policy), so
 *    its presence must turn the autonomy→containment defaults on exactly like an
 *    env ship flag does.
 *  - `autonomy policies [--mode]` — `gaffer_inert_policy_check` warns once per run
 *    when `auto` rows exist but REVIEW_MODE=human: in supervised mode no reviewer
 *    agent runs, so no policy is ever consulted and the grants are inert.
 *
 * No mutation; enable/disable stays on the REST surface behind its explicit-confirm
 * boundary.
 */
export function registerAutonomy(program: Command): void {
  const autonomy = program.command("autonomy").description("Graduated-autonomy policy (read-only)");

  autonomy
    .command("list")
    .description(
      "List the stored autonomy policy rows (repo × risk × gate → mode). " +
        "A mode='auto' row is an unattended ship allow-path in every GAFFER_MODE.",
    )
    .action((_opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const policies = wg.listAutonomyPolicies();
      printJson({
        ok: true,
        policies,
        auto_count: policies.filter((p) => p.mode === "auto").length,
      });
      wg.db.close();
    });

  autonomy
    .command("policies")
    .description(
      "List the stored per-(repo × risk × gate) autonomy policies (the Settings 'Active " +
        "autonomy' rows), optionally filtered by mode. The runner consults this at start-up " +
        "to warn when `auto` rows exist but REVIEW_MODE=human. No mutation.",
    )
    .option("--mode <mode>", "only rows in this mode: off | recommend | auto")
    .action((opts, cmd) => {
      const mode = opts.mode as string | undefined;
      if (mode !== undefined && !(AUTONOMY_MODES as readonly string[]).includes(mode)) {
        throw new DispatchError(
          "VALIDATION_ERROR",
          `--mode must be one of ${AUTONOMY_MODES.join(", ")}.`,
          { mode },
        );
      }
      const wg = open(cmd.optsWithGlobals());
      const rows = wg.listAutonomyPolicies();
      const policies = mode === undefined ? rows : rows.filter((p) => p.mode === mode);
      printJson({ ok: true, count: policies.length, policies });
      wg.db.close();
    });
}
