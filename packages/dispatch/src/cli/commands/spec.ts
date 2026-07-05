import type { Command } from "commander";
import { z } from "zod";

import { SPEC_STATUSES } from "../../domain/types.js";
import { DispatchError } from "../../util/errors.js";
import { cliActor, open, printJson, readJsonInput } from "../shared.js";

export function registerSpec(program: Command): void {
  // --- Specs (Spec-Driven Development, Phase 1a) -----------------------------

  const spec = program
    .command("spec")
    .description("Spec commands (frozen statements of product intent)");
  spec
    .command("create [file]")
    .description(
      "Create a draft spec from a JSON document (a file path, or stdin when omitted " +
        "or '-'). The document is { title, brief?, clauses:[{clause_id?,kind,text," +
        "rationale?}], target_repo?, scope_node_id? } where kind is one of " +
        "requirement | non-goal | decision. The spec is created as draft.",
    )
    .action((file: string | undefined, _opts, cmd) => {
      const doc = readJsonInput(file);
      const wg = open(cmd.optsWithGlobals());
      const s = wg.createSpec(doc, cliActor());
      printJson({ ok: true, spec: s });
      wg.db.close();
    });

  spec
    .command("get <id>")
    .description("Show a spec by id")
    .action((id: string, _opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      printJson(wg.getSpec(id));
      wg.db.close();
    });

  spec
    .command("freeze <id>")
    .description("Freeze a draft spec (draft→frozen); a frozen spec is immutable")
    .action((id: string, _opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const s = wg.freezeSpec(id, cliActor());
      printJson({ ok: true, spec: s });
      wg.db.close();
    });

  spec
    .command("coverage <id>")
    .description(
      "Show the coverage read model for a spec: per clause its covering ACs " +
        "(satisfied vs open), covered / satisfied / orphan (the gap report) and the " +
        "bounce count, plus a spec-level rollup.",
    )
    .action((id: string, _opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      printJson(wg.specCoverage(id));
      wg.db.close();
    });

  spec
    .command("list")
    .description("List specs newest-first")
    .option("--status <status>", "filter by status (draft | frozen | superseded)")
    .action((opts, cmd) => {
      if (opts.status !== undefined) {
        const statusResult = z.enum(SPEC_STATUSES).safeParse(opts.status);
        if (!statusResult.success) {
          throw new DispatchError(
            "VALIDATION_ERROR",
            `Invalid status: "${opts.status}". Allowed: ${SPEC_STATUSES.join(", ")}.`,
            { status: opts.status, allowed: SPEC_STATUSES },
          );
        }
      }
      const wg = open(cmd.optsWithGlobals());
      const specs = wg.listSpecs(opts.status);
      printJson(specs);
      wg.db.close();
    });
}
