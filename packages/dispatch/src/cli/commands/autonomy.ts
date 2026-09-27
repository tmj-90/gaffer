import type { Command } from "commander";

import { open, printJson } from "../shared.js";

/**
 * GRADUATED-AUTONOMY: the read-only view of the stored per-(repo × risk × gate)
 * autonomy policy — the same rows GET /api/autonomy/policies serves the Settings
 * surface. The runner's config (`_gaffer_autonomy_on` in factory.config.sh) consults
 * it to decide whether the factory can ship unattended: a stored mode='auto' row is
 * an allow-path the review gate honours in EVERY mode (isAutonomyAllowed = env floor
 * OR policy), so its presence must turn the autonomy→containment defaults on exactly
 * like an env ship flag does. No mutation; enable/disable stays on the REST surface
 * behind its explicit-confirm boundary.
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
}
