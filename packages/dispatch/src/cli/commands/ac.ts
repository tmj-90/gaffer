import type { Command } from "commander";

import { cliActor, open, printJson } from "../shared.js";

export function registerAc(program: Command): void {
  const ac = program.command("ac").description("Acceptance-criteria commands");
  ac.command("add <ref>")
    .description("Add an acceptance criterion to a ticket")
    .requiredOption("-t, --text <text>", "AC text")
    .option("--verify <method>", "verification method")
    .option("--evidence", "evidence required", false)
    .option("--clause <id>", "frozen-spec clause id this AC satisfies (spec_clause_id provenance)")
    .action((ref, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const t = wg.resolveTicket(ref);
      const { ac: created, eventId } = wg.addAcceptanceCriterion(
        {
          ticket_id: t.id,
          text: opts.text,
          verification_method: opts.verify,
          evidence_required: opts.evidence,
          ...(opts.clause ? { spec_clause_id: opts.clause } : {}),
        },
        cliActor(),
      );
      printJson({ ok: true, ac_id: created.id, event: eventId });
      wg.db.close();
    });
}
