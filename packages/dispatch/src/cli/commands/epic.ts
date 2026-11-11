import type { Command } from "commander";

import { cliActor, printJson, readJsonInput } from "../helpers.js";
import { open } from "../runtime.js";

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
        "priority?,risk_level?,policy_pack?,repo?,access?,bootstrap?,testable?,dependsOn:[<indexes>]}] }. " +
        "Tickets are created as draft.",
    )
    .action((file: string | undefined, _opts, cmd) => {
      const plan = readJsonInput(file);
      const wg = open(cmd.optsWithGlobals());
      const res = wg.createEpic(plan, cliActor());
      printJson({
        ok: true,
        epic_node_id: res.epicNodeId,
        ticket_numbers: res.ticketNumbers,
        deferred_repo_links: res.deferredRepoLinks,
        acceptance_ticket_number: res.acceptanceTicketNumber,
        agreed_requirements: res.agreedRequirements,
        testable_tickets: res.testableTickets,
      });
      wg.db.close();
    });
  epic
    .command("feature-status [featureId]")
    .description(
      "Which tickets make up a feature of the memory ledger and whether they have all " +
        "landed: every ticket carrying `Feature-Id: <id>`, plus every confirmed member of an " +
        "epic holding one of them and that epic's own acceptance ticket. `complete` is true " +
        "only when at least one counted ticket exists and every counted ticket is done; a " +
        "cancelled (won't-do) ticket is listed but not counted. With --ticket <n> alone, the " +
        "feature is the one that ticket belongs to (its own marker, else its epic's). Read only.",
    )
    .option("--ticket <ref>", "a ticket of the feature (number or id)")
    .action(async (featureId: string | undefined, opts: { ticket?: string }, cmd) => {
      // Loaded on use: the CLI loads no service module for help or a usage error.
      const { featureLanding } = await import("../../services/featureLanding.js");
      const wg = open(cmd.optsWithGlobals());
      try {
        printJson(
          featureLanding(wg.db, { featureId: featureId ?? null, ticketRef: opts.ticket ?? null }),
        );
      } finally {
        wg.db.close();
      }
    });
}
