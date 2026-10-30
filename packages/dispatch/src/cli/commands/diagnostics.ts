import type { Command } from "commander";

import { Dispatch } from "../../core.js";
import { DatabaseOpenError, DatabaseTooNewError } from "../../db/connection.js";
import { resolveDbPath } from "../../util/paths.js";
import { computeStats, renderDoctor, renderHumanQueue, renderStats, runDoctor } from "../ops.js";
import { cliActor, open, printJson } from "../shared.js";

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
        else if (v.ok)
          process.stdout.write(
            `event log hash chain intact (${v.checked} events, head ${v.headHash})\n`,
          );
        else
          process.stdout.write(
            `event log hash chain BROKEN at seq ${v.brokenAtSeq} (event ${v.brokenEventId}): ${v.reason} — ${v.checked} rows checked before the break\n`,
          );
        process.exitCode = v.ok ? 0 : 1;
      } finally {
        wg.db.close();
      }
    });

  events
    .command("rechain")
    .description(
      "Hash work_event rows that have no hash, chaining each from its predecessor, and " +
        "record the re-anchor (old/new head) as an events.rechained event. Opening the DB " +
        "never does this on a chained log; requires --confirm.",
    )
    .option("--confirm", "actually re-chain (without it, only report what would change)", false)
    .option("--json", "emit machine-readable JSON", false)
    .action((opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      try {
        const before = wg.verifyEventChain();
        if (!opts.confirm) {
          const out = { confirmed: false, verification: before };
          if (opts.json) printJson(out);
          else
            process.stdout.write(
              before.ok
                ? `event log hash chain intact (${before.checked} events); nothing to re-chain\n`
                : `event log hash chain BROKEN at seq ${before.brokenAtSeq} (${before.reason}); re-run with --confirm to hash unhashed rows and record the re-anchor\n`,
            );
          return;
        }
        const res = wg.rechainEventLog(cliActor());
        if (opts.json) printJson({ confirmed: true, ...res });
        else
          process.stdout.write(
            `re-chained ${res.rechained} event(s); head ${res.oldHead} -> ${res.newHead}; ` +
              `chain ${res.verification.ok ? "intact" : `still BROKEN at seq ${res.verification.brokenAtSeq} (${res.verification.reason})`}\n`,
          );
        process.exitCode = res.verification.ok ? 0 : 1;
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
