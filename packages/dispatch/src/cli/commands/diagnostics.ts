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

  const events = program
    .command("events")
    .description(
      "The work_events log: `events verify` re-derives the tamper-evidence hash chain; " +
        "`events list --correlation <id>` shows one tick's trail",
    );

  events
    .command("list")
    .description(
      "Events sharing a correlation id (the runner's per-tick GAFFER_TICK_ID), oldest first; " +
        "metadata only — bodies stay in `ticket show`.",
    )
    .requiredOption("--correlation <id>", "the correlation / tick id to list")
    .option("--limit <n>", "max rows", "500")
    .option("--json", "emit machine-readable JSON", false)
    .action((opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      try {
        const limit = Math.max(1, Math.min(5000, Number(opts.limit) || 500));
        const rows = wg.events.listByCorrelation(String(opts.correlation), limit);
        if (opts.json) printJson({ correlation_id: opts.correlation, events: rows });
        else if (rows.length === 0)
          process.stdout.write(`no events carry correlation id ${opts.correlation}\n`);
        else
          for (const r of rows)
            process.stdout.write(
              `${r.created_at}  ${r.event_type.padEnd(28)} ${r.entity_type}${r.ticket_number != null ? ` #${r.ticket_number}` : ""}  ${r.actor_type}${r.actor_id ? `/${r.actor_id}` : ""}\n`,
            );
      } finally {
        wg.db.close();
      }
    });

  events
    .command("verify")
    .description(
      "Walk every work_event in insertion order and re-derive its sha256 chain hash; " +
        "exit 1 and name the first row that was rewritten, deleted or re-ordered.",
    )
    .option("--json", "emit machine-readable JSON", false)
    .action((opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      try {
        const v = wg.verifyEventChain();
        if (opts.json) printJson(v);
        else if (v.ok) process.stdout.write(`event log hash chain intact (${v.checked} events)\n`);
        else
          process.stdout.write(
            `event log hash chain BROKEN at seq ${v.brokenAtSeq} (event ${v.brokenEventId}): ${v.reason} — ${v.checked} rows checked before the break\n`,
          );
        process.exitCode = v.ok ? 0 : 1;
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
