import type { Command } from "commander";

import { AUTONOMY_MODES } from "../../repositories/autonomyPolicyRepository.js";
import { DispatchError } from "../../util/errors.js";
import { open, printJson } from "../shared.js";

export function registerAutonomy(program: Command): void {
  // --- GRADUATED-AUTONOMY: read-only view of the per-repo/risk/gate policy rows ---
  const autonomy = program
    .command("autonomy")
    .description("Per-repo autonomy policy commands (read-only)");

  autonomy
    .command("policies")
    .description(
      "List the stored per-(repo × risk × gate) autonomy policies (the Settings 'Active " +
        "autonomy' rows). The runner consults this at start-up to warn when `auto` rows " +
        "exist but REVIEW_MODE=human — in supervised mode no reviewer agent runs, so no " +
        "policy is ever consulted and the grants are inert. No mutation.",
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
