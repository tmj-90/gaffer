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
