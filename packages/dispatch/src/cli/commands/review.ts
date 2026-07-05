import type { Command } from "commander";

import type { Actor } from "../../domain/types.js";
import { DispatchError } from "../../util/errors.js";
import { cliActor, open, printJson } from "../shared.js";

export function registerReview(program: Command): void {
  // --- Review (close a ticket from in_review) --------------------------------

  const review = program.command("review").description("Review commands (close in_review tickets)");

  review
    .command("approve <ref>")
    .description("Approve a ticket in review (in_review -> ready_for_merge); evaluates policy")
    .option("--reviewer <id>", "reviewer id")
    .option(
      "--as <type>",
      "actor type: human (default) or agent (requires DISPATCH_ALLOW_AGENT_APPROVE=1)",
      "human",
    )
    .action((ref, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const actor: Actor =
        opts.as === "agent"
          ? { type: "agent", id: opts.reviewer ?? "agent" }
          : { type: "human", id: opts.reviewer ?? "reviewer" };
      const res = wg.approveReview(ref, actor);
      printJson({ ok: true, status: res.ticket.status, event: res.eventId, policy: res.policy });
      wg.db.close();
    });

  review
    .command("reject <ref>")
    .description(
      "Reject a ticket in review: rework (--to refining, default) or abandon (--to cancelled). " +
        "Resets the ticket's acceptance criteria to not-satisfied.",
    )
    .requiredOption("--reason <text>", "rejection reason (recorded on the event)")
    .option("--to <status>", "return status: refining (default), ready, or cancelled", "refining")
    .option("--reviewer <id>", "reviewer id")
    .action((ref, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const to = opts.to as "ready" | "refining" | "cancelled";
      if (to !== "ready" && to !== "refining" && to !== "cancelled") {
        throw new DispatchError(
          "VALIDATION_ERROR",
          "--to must be 'refining', 'ready', or 'cancelled'.",
          { to },
        );
      }
      const actor: Actor = { type: "human", id: opts.reviewer ?? "reviewer" };
      const res = wg.rejectReview(ref, to, actor, opts.reason);
      printJson({ ok: true, status: res.ticket.status, event: res.eventId, policy: res.policy });
      wg.db.close();
    });

  // --- Won't do (terminal abandon) + reopen ----------------------------------

  program
    .command("wont-do <ref>")
    .description(
      "Mark a ticket terminal 'won't do' (-> cancelled bucket); resets its ACs. Guarded: rejected for claimed/in-flight tickets.",
    )
    .requiredOption("--reason <text>", "why the ticket is being abandoned (recorded on the event)")
    .action((ref, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const res = wg.wontDo(ref, cliActor(), opts.reason);
      printJson({ ok: true, status: res.ticket.status, event: res.eventId });
      wg.db.close();
    });

  program
    .command("reopen <ref>")
    .description(
      "Reopen a won't-do (cancelled) ticket into the pipeline (-> refining default, or draft)",
    )
    .option("--to <status>", "target: refining (default) or draft", "refining")
    .action((ref, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const to = opts.to as "refining" | "draft";
      if (to !== "refining" && to !== "draft") {
        throw new DispatchError("VALIDATION_ERROR", "--to must be 'refining' or 'draft'.", { to });
      }
      const res = wg.reopenFromWontDo(ref, to, cliActor());
      printJson({ ok: true, status: res.ticket.status, event: res.eventId });
      wg.db.close();
    });
}
