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
    .command("feature-status [featureIds...]")
    .description(
      "Which tickets make up a feature of the memory ledger and whether they have all " +
        "landed: every ticket carrying `Feature-Id: <id>`, plus every confirmed member of an " +
        "epic holding one of them and that epic's own acceptance ticket. `complete` is true " +
        "only when at least one counted ticket exists, every counted ticket is done and an " +
        "epic holds the marked tickets; a cancelled (won't-do) ticket is listed but not " +
        "counted. With --ticket <n> alone, the feature is the one that ticket belongs to (its " +
        "own marker, else its epic's). With --batch, one answer per feature id, as a JSON " +
        "array. `hold` says what keeps a feature from shipping once its other work landed " +
        "(a failed or blocked ticket, a stray marked ticket, an epic naming two features). " +
        "Read only.",
    )
    .option("--ticket <ref>", "a ticket of the feature (number or id)")
    .option("--batch", "answer for every feature id given, as a JSON array (no --ticket)")
    .action(
      async (featureIds: string[], opts: { ticket?: string; batch?: boolean }, cmd: Command) => {
        if (opts.batch && opts.ticket !== undefined) {
          cmd.error("error: --batch takes feature ids only, not --ticket", { exitCode: 2 });
        }
        if (!opts.batch && featureIds.length > 1) {
          cmd.error("error: more than one feature id needs --batch", { exitCode: 2 });
        }
        // Loaded on use: the CLI loads no service module for help or a usage error.
        const { featureLanding, featureLandings } =
          await import("../../services/featureLanding.js");
        const wg = open(cmd.optsWithGlobals());
        try {
          printJson(
            opts.batch
              ? featureLandings(wg.db, featureIds)
              : featureLanding(wg.db, {
                  featureId: featureIds[0] ?? null,
                  ticketRef: opts.ticket ?? null,
                }),
          );
        } finally {
          wg.db.close();
        }
      },
    );
}
