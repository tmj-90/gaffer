import type { Command } from "commander";

import { cliActor, open, printJson, readJsonInput } from "../shared.js";

export function registerEpic(program: Command): void {
  // --- Epics (EP-001) --------------------------------------------------------

  const epic = program
    .command("epic")
    .description("Epic commands (dependency-ordered ticket plans)");
  epic
    .command("create [file]")
    .description(
      "Create an epic from a JSON plan (a file path, or stdin when omitted or '-'). " +
        "The plan is { epic:{name,description}, tickets:[{title,description,acceptanceCriteria[]," +
        "priority?,risk_level?,policy_pack?,repo?,access?,bootstrap?,dependsOn:[<indexes>]}] }. " +
        "Tickets are created as draft.",
    )
    .action((file: string | undefined, _opts, cmd) => {
      const plan = readJsonInput(file);
      const wg = open(cmd.optsWithGlobals());
      const res = wg.createEpic(plan, cliActor());
      printJson({ ok: true, epic_node_id: res.epicNodeId, ticket_numbers: res.ticketNumbers });
      wg.db.close();
    });
}
