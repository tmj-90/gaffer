import type { Command } from "commander";

import { Dispatch } from "../../core.js";
import { DatabaseOpenError, DatabaseTooNewError } from "../../db/connection.js";
import { resolveDbPath } from "../../util/paths.js";
import { computeStats, renderDoctor, renderHumanQueue, renderStats, runDoctor } from "../ops.js";
import { open, printJson } from "../shared.js";

export function registerDiagnostics(program: Command): void {
  // --- Operational commands --------------------------------------------------

  program
    .command("doctor")
    .description("Diagnose the database: schema, counts, stale claims, integrity")
    .option("--json", "emit machine-readable JSON", false)
    .action((opts, cmd) => {
      const dbPath = resolveDbPath(cmd.optsWithGlobals().db);
      let wg: Dispatch;
      try {
        wg = Dispatch.open(dbPath);
      } catch (err) {
        if (err instanceof DatabaseTooNewError || err instanceof DatabaseOpenError) {
          process.stderr.write(`dispatch doctor: ${err.message}\n`);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
      try {
        const report = runDoctor(wg.db, dbPath);
        if (opts.json) printJson(report);
        else process.stdout.write(`${renderDoctor(report)}\n`);
        process.exitCode = report.exitCode;
      } finally {
        wg.db.close();
      }
    });

  program
    .command("stats")
    .description("Summary: tickets by status, open decisions, active/stale claims")
    .option("--json", "emit machine-readable JSON", false)
    .action((opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      try {
        const stats = computeStats(wg.db);
        if (opts.json) printJson(stats);
        else process.stdout.write(`${renderStats(stats)}\n`);
      } finally {
        wg.db.close();
      }
    });

  program
    .command("human-queue")
    .description(
      "What the HUMAN owns: pending decisions (with reasons), review sign-offs, and " +
        "regulated ready-approvals / reviewer assignments — the operator's queue.",
    )
    .option("--json", "emit machine-readable JSON", false)
    .action((opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      try {
        const queue = wg.humanQueue();
        if (opts.json) {
          printJson(queue);
        } else {
          process.stdout.write(`${renderHumanQueue(queue)}\n`);
        }
      } finally {
        wg.db.close();
      }
    });
}
