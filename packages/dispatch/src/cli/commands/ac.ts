import type { Command } from "commander";

import { readFileSync } from "node:fs";

import { DispatchError } from "../../util/errors.js";
import { cliActor, open, printJson } from "../shared.js";

export function registerAc(program: Command): void {
  const ac = program.command("ac").description("Acceptance-criteria commands");
  ac.command("add <ref>")
    .description("Add an acceptance criterion to a ticket")
    .requiredOption("-t, --text <text>", "AC text")
    .option("--verify <method>", "verification method")
    .option("--evidence", "evidence required", false)
    .option("--clause <id>", "frozen-spec clause id this AC satisfies (spec_clause_id provenance)")
    .option(
      "--check <command>",
      "MACHINE-CHECKABLE: shell command the runner executes in the delivery worktree to verify this AC (exit 0 ⇒ satisfied)",
    )
    .action((ref, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      // cli-wg/F-16: the provenance must point at a real spec clause.
      if (opts.clause !== undefined && !wg.specClauseExists(String(opts.clause).trim())) {
        wg.db.close();
        throw new DispatchError(
          "VALIDATION_ERROR",
          `--clause ${String(opts.clause)}: no spec clause has that id (\`wg spec get <id>\` lists a spec's clause ids).`,
          { clause: opts.clause },
        );
      }
      const t = wg.resolveTicket(ref);
      const { ac: created, eventId } = wg.addAcceptanceCriterion(
        {
          ticket_id: t.id,
          text: opts.text,
          verification_method: opts.verify,
          evidence_required: opts.evidence,
          ...(opts.clause ? { spec_clause_id: opts.clause } : {}),
          ...(opts.check ? { check_command: opts.check } : {}),
        },
        cliActor(),
      );
      printJson({ ok: true, ac_id: created.id, event: eventId });
      wg.db.close();
    });

  // cli-wg/F-02: a criterion can be corrected (a missing --verify the strict packs
  // need, a reworded check) or removed while the contract is editable (draft,
  // refining, ready, blocked); from claimed on both are CONTRACT_FROZEN.
  ac.command("edit <ref> <ac>")
    .description(
      "Edit an acceptance criterion (<ac> = its position, 1 = the first, or its id). " +
        "It goes back to pending. Refused once the ticket is claimed (CONTRACT_FROZEN).",
    )
    .option("-t, --text <text>", "new AC text (one line)")
    .option("--verify <method>", 'verification method ("" clears it)')
    .option("--check <command>", "new machine check command (the runner executes it)")
    .option("--clear-check", "remove the machine check command", false)
    .action((ref, acRef, opts, cmd) => {
      if (opts.check !== undefined && opts.clearCheck) {
        throw new DispatchError(
          "VALIDATION_ERROR",
          "--check and --clear-check conflict: give one of them.",
        );
      }
      const raw = {
        ...(opts.text !== undefined ? { text: opts.text } : {}),
        ...(opts.verify !== undefined ? { verification_method: opts.verify } : {}),
        ...(opts.check !== undefined ? { check_command: opts.check } : {}),
        ...(opts.clearCheck ? { check_command: null } : {}),
      };
      if (Object.keys(raw).length === 0) {
        throw new DispatchError(
          "VALIDATION_ERROR",
          "Nothing to change: pass -t, --verify, --check and/or --clear-check.",
        );
      }
      const wg = open(cmd.optsWithGlobals());
      try {
        const res = wg.editAcceptanceCriterion(ref, String(acRef), raw, cliActor());
        printJson({ ok: true, ac: res.ac, event: res.eventId });
      } finally {
        wg.db.close();
      }
    });

  ac.command("rm <ref> <ac>")
    .description(
      "Remove an acceptance criterion (<ac> = its position, 1 = the first, or its id). " +
        "Refused once the ticket is claimed (CONTRACT_FROZEN).",
    )
    .action((ref, acRef, _opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      try {
        const res = wg.removeAcceptanceCriterion(ref, String(acRef), cliActor());
        printJson({ ok: true, ac_id: res.acId, event: res.eventId });
      } finally {
        wg.db.close();
      }
    });

  // MACHINE-CHECKABLE AC — the RUNNER reports the result of executing an AC's
  // check_command. Recorded as the trusted `system` actor (the runner), never the
  // agent: this is the runner-owned verification the done gate trusts.
  ac.command("check-result <ac-id>")
    .description(
      "RUNNER-OWNED: record the result of executing an AC's check_command (exit 0 ⇒ satisfied, else failed + test_output evidence)",
    )
    .requiredOption("--ticket <ref>", "the ticket the AC belongs to")
    .requiredOption("--exit <code>", "the check command's exit code")
    .requiredOption("--command <cmd>", "the command that was executed (as recorded)")
    .option(
      "--output-file <path>",
      "file holding the command's combined output (bounded tail is recorded)",
    )
    .option("--duration <seconds>", "wall-clock seconds the check ran")
    .action((acId, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const t = wg.resolveTicket(opts.ticket);
      const exitCode = Number.parseInt(String(opts.exit), 10);
      if (!Number.isInteger(exitCode) || exitCode < 0) {
        throw new DispatchError("VALIDATION_ERROR", "--exit must be a non-negative integer.", {
          exit: opts.exit,
        });
      }
      let outputTail: string | undefined;
      if (opts.outputFile) {
        try {
          const raw = readFileSync(String(opts.outputFile), "utf8");
          outputTail = raw.length > 8_000 ? raw.slice(-8_000) : raw;
        } catch {
          outputTail = undefined;
        }
      }
      const duration = opts.duration === undefined ? undefined : Number(opts.duration);
      const res = wg.recordAcCheck(
        {
          ticket_id: t.id,
          ac_id: acId,
          exit_code: exitCode,
          command: String(opts.command),
          ...(outputTail !== undefined ? { output_tail: outputTail } : {}),
          ...(duration !== undefined && Number.isFinite(duration) ? { duration_s: duration } : {}),
        },
        { type: "system", id: "runner" },
      );
      printJson({
        ok: true,
        ac_id: acId,
        status: res.status,
        evidence_id: res.evidenceId,
        event: res.eventId,
      });
      wg.db.close();
    });
}
