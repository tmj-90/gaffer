import type { Command } from "commander";

import type { Actor } from "../../domain/types.js";
import { DispatchError } from "../../util/errors.js";
import { cliActor, open, parseAs, printJson } from "../shared.js";

/** `--commit repo=sha` (or a bare sha) → a shown commit; malformed input is refused. */
export function parseCommitFlag(value: string): { repo: string | null; sha: string } {
  const v = String(value).trim();
  const eq = v.lastIndexOf("=");
  const repo = eq > 0 ? v.slice(0, eq).trim() : null;
  const sha = (eq > 0 ? v.slice(eq + 1) : v).trim();
  if (!/^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$/.test(sha)) {
    throw new DispatchError(
      "VALIDATION_ERROR",
      `--commit expects <repo>=<full sha> or a full sha (got "${v}").`,
    );
  }
  return { repo, sha: sha.toLowerCase() };
}

export function registerReview(program: Command): void {
  // --- Review (close a ticket from in_review) --------------------------------

  const review = program.command("review").description("Review commands (close in_review tickets)");

  review
    .command("approve <ref>")
    .description("Approve a ticket in review (in_review -> ready_for_merge); evaluates policy")
    .option("--reviewer <id>", "reviewer id (default: $USER for a human approval)")
    .option(
      "--as <type>",
      "actor type: human (default) or agent (requires DISPATCH_ALLOW_AGENT_APPROVE=1)",
      "human",
    )
    .option(
      "--commit <repo=sha>",
      "the commit you reviewed, per write repo (repeat for each repo; a bare <sha> for a " +
        "single-repo ticket). Required whenever the delivery branch resolves: the approval " +
        "is refused (stale_revision) when a branch moved past it. `ticket diff <ref>` prints the heads.",
      (value: string, prev: string[] = []) => [...prev, value],
    )
    .action((ref, opts, cmd) => {
      const as = parseAs(opts.as, ["human", "agent"] as const);
      const wg = open(cmd.optsWithGlobals());
      // cli-wg/F-04: a human approval is recorded as whoever runs the CLI ($USER),
      // like every other wg write, unless --reviewer names someone else.
      const actor: Actor =
        as === "agent"
          ? { type: "agent", id: opts.reviewer ?? "agent" }
          : { type: "human", id: opts.reviewer ?? cliActor().id };
      const commits = ((opts.commit as string[] | undefined) ?? []).map(parseCommitFlag);
      const res = wg.approveReview(ref, actor, { commits, requireCommits: true });
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
    .option("--reviewer <id>", "reviewer id (default: $USER for a human rejection)")
    .option(
      "--as <type>",
      "actor type: human (default), agent (the reviewer agent's verdict) or system (a runner " +
        "gate such as CI). Runner rejections must not be recorded as HUMAN decisions — the " +
        "autonomy recommendations count only human/admin decisions as ground truth.",
      "human",
    )
    .action((ref, opts, cmd) => {
      const as = parseAs(opts.as, ["human", "agent", "system"] as const);
      const wg = open(cmd.optsWithGlobals());
      const to = opts.to as "ready" | "refining" | "cancelled";
      if (to !== "ready" && to !== "refining" && to !== "cancelled") {
        throw new DispatchError(
          "VALIDATION_ERROR",
          "--to must be 'refining', 'ready', or 'cancelled'.",
          { to },
        );
      }
      const actor: Actor =
        as === "agent"
          ? { type: "agent", id: opts.reviewer ?? "agent" }
          : as === "system"
            ? { type: "system", ...(opts.reviewer ? { id: opts.reviewer } : {}) }
            : { type: "human", id: opts.reviewer ?? cliActor().id };
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
