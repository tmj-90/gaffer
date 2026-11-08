import type { Command } from "commander";

import type { Actor } from "../../domain/types.js";
import { DispatchError } from "../../util/errors.js";
import { cliActor, cliPrincipal, parseAs, printJson, warnLandedAlready } from "../helpers.js";
import { open } from "../runtime.js";

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
          : cliPrincipal()
            ? cliActor() // CLI IDENTITY: the principal's own actor (human or admin)
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
            : cliPrincipal()
              ? cliActor()
              : { type: "human", id: opts.reviewer ?? cliActor().id };
      const res = wg.rejectReview(ref, to, actor, opts.reason);
      warnLandedAlready(res.landedAlready, `rejection (--to ${to})`);
      printJson({
        ok: true,
        status: res.ticket.status,
        event: res.eventId,
        policy: res.policy,
        ...(res.landedAlready.length > 0 ? { landed_already: res.landedAlready } : {}),
      });
      wg.db.close();
    });

  // --- Review comments (A1) + Fix these (A2) ---------------------------------
  // A reviewer's acts: every write here is refused to an agent or the runner by the
  // service, and the safety hook refuses these verbs in an agent shell (where a bare
  // `wg` would otherwise act as the person running the factory).

  const reviewerActor = (opts: { reviewer?: string }): Actor => {
    if (cliPrincipal()) return cliActor();
    const id = opts.reviewer ?? cliActor().id;
    return id !== undefined ? { type: "human", id } : { type: "human" };
  };

  review
    .command("comment <ref>")
    .description(
      "Write a review comment on a ticket in review: on a line (--file + --line), a file " +
        "(--file) or the whole change. The anchor (the lines around it) is read from git.",
    )
    .requiredOption("--body <text>", "what should change (or what to consider)")
    .option("--repo <name>", "the write repository (default: the ticket's only one)")
    .option("--file <path>", "the file, relative to the repository root")
    .option("--line <n>", "the line number on --side", (v: string) => Number.parseInt(v, 10))
    .option("--side <side>", "new (the change, default) or old (the base)", "new")
    .option("--must-fix", "a requirement the next attempt must address (default: consider)")
    .option("--severity <s>", "must_fix or consider (overrides --must-fix)")
    .option("--commit <sha>", "the head you reviewed (default: the delivery head now)")
    .option("--reviewer <id>", "reviewer id (default: $USER)")
    .action((ref, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const severity = (opts.severity ?? (opts.mustFix ? "must_fix" : "consider")) as string;
      if (severity !== "must_fix" && severity !== "consider") {
        throw new DispatchError("VALIDATION_ERROR", "--severity is must_fix or consider.", {
          severity,
        });
      }
      const side = String(opts.side);
      if (side !== "new" && side !== "old") {
        throw new DispatchError("VALIDATION_ERROR", "--side is new or old.", { side });
      }
      const c = wg.createReviewComment(
        ref,
        {
          body: opts.body,
          severity,
          repo: opts.repo ?? null,
          path: opts.file ?? null,
          line: opts.line ?? null,
          side,
          commit: opts.commit ?? null,
        },
        reviewerActor(opts),
      );
      printJson({ ok: true, comment: c });
      wg.db.close();
    });

  review
    .command("comments <ref>")
    .description(
      "List a ticket's review comments, with each anchor's state from git (changed / " +
        "untouched since the comment was written) and the agent's replies (claims).",
    )
    .option("--open", "only the open comments")
    .option("--no-anchors", "skip the git anchor check")
    .action((ref, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const ticket = wg.resolveTicket(ref);
      printJson({
        ok: true,
        comments: wg.listReviewComments(ticket.id, {
          open: Boolean(opts.open),
          anchors: opts.anchors !== false,
        }),
        counts: wg.reviewCommentSvc.counts(ticket.id),
      });
      wg.db.close();
    });

  // BLINDING: the eval judge's grade, opened on purpose. The Review view keeps it collapsed
  // until a person asks; this is the terminal's "Show the judge's view": it records the
  // reveal (once per review round, only while the ticket is in review) and prints the grade.
  review
    .command("judge-view <ref>")
    .description(
      "Show the eval judge's grade of a ticket in review and record that you opened it " +
        "before deciding (judge agreement counts your decision apart from blind ones).",
    )
    .option("--reviewer <id>", "reviewer id (default: $USER)")
    .action((ref, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      // One step, as the Review view: the reveal is recorded before the grade is read, and
      // a reveal that cannot be recorded prints no grade (the error, exit non-zero).
      const r = wg.revealJudge(ref, reviewerActor(opts));
      printJson({
        ok: true,
        recorded: r.recorded,
        reason: r.reason,
        round_entered_at: r.roundEnteredAt,
        judge: r.judge,
      });
      wg.db.close();
    });

  for (const [name, action, what] of [
    ["resolve", "resolve", "Mark a review comment resolved (a reviewer's act)"],
    ["reopen-comment", "reopen", "Open a resolved or withdrawn review comment again"],
    ["withdraw-comment", "withdraw", "Withdraw a review comment you wrote"],
  ] as const) {
    review
      .command(`${name} <cid>`)
      .description(`${what}. <cid> is the comment id or a unique prefix (6+ characters).`)
      .option("--reviewer <id>", "reviewer id (default: $USER)")
      .action((cid, opts, cmd) => {
        const wg = open(cmd.optsWithGlobals());
        const c = wg.setReviewCommentState(cid, action, reviewerActor(opts));
        printJson({ ok: true, comment: c });
        wg.db.close();
      });
  }

  review
    .command("fix <ref>")
    .description(
      "Fix these: send a ticket in review back with its open must-fix comments as numbered " +
        "requirements the next delivery's prompt lists. Resets the acceptance criteria.",
    )
    .option(
      "--comment <cid>",
      "send only these comments (repeat; default: every open must-fix comment)",
      (value: string, prev: string[] = []) => [...prev, value],
    )
    .option("--to <status>", "refining (default) or ready", "refining")
    .option("--reviewer <id>", "reviewer id (default: $USER)")
    .action((ref, opts, cmd) => {
      const to = opts.to as string;
      if (to !== "refining" && to !== "ready") {
        throw new DispatchError("VALIDATION_ERROR", "--to must be 'refining' or 'ready'.", { to });
      }
      const wg = open(cmd.optsWithGlobals());
      const res = wg.fixThese(
        ref,
        { ...(opts.comment ? { commentIds: opts.comment as string[] } : {}), to },
        reviewerActor(opts),
      );
      warnLandedAlready(res.landedAlready, "Fix these");
      printJson({
        ok: true,
        status: res.ticket.status,
        event: res.eventId,
        reject_outcome: res.rejectOutcome,
        requirements: res.requirements.map((c) => c.short_id),
      });
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
      warnLandedAlready(res.landedAlready, "won't do");
      printJson({
        ok: true,
        status: res.ticket.status,
        event: res.eventId,
        ...(res.landedAlready.length > 0 ? { landed_already: res.landedAlready } : {}),
      });
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
