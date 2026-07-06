import type { Command } from "commander";
import { z } from "zod";

import { DECISION_SEVERITIES } from "../../domain/types.js";
import { DispatchError } from "../../util/errors.js";
import { cliActor, open, printJson } from "../shared.js";

export function registerDecisions(program: Command): void {
  const decisions = program.command("decisions").description("Decision commands");
  decisions
    .command("list")
    .description("List pending decisions")
    .action((_opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      printJson(wg.listPendingDecisions());
      wg.db.close();
    });

  program
    .command("decision")
    .description("Create a decision/blocker")
    .requiredOption("--title <title>", "title")
    .requiredOption("--question <q>", "question")
    .option("--severity <sev>", "severity", "human_preferred")
    .option("--ticket <ref>", "block this ticket")
    .action((opts, cmd) => {
      const severityResult = z.enum(DECISION_SEVERITIES).safeParse(opts.severity);
      if (!severityResult.success) {
        throw new DispatchError(
          "VALIDATION_ERROR",
          `Invalid severity: "${opts.severity}". Allowed: ${DECISION_SEVERITIES.join(", ")}.`,
          { severity: opts.severity, allowed: DECISION_SEVERITIES },
        );
      }
      const wg = open(cmd.optsWithGlobals());
      const ticketId = opts.ticket ? wg.resolveTicket(opts.ticket).id : undefined;
      const d = wg.createDecision(
        {
          title: opts.title,
          question: opts.question,
          severity: severityResult.data,
          ...(ticketId ? { ticketId } : {}),
        },
        cliActor(),
      );
      printJson({ ok: true, decision: { id: d.id, status: d.status } });
      wg.db.close();
    });
}
