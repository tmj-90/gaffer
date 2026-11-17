/**
 * POST-MERGE FINDINGS (backlog 59): `wg ticket finding add|list|withdraw|lesson|fix-ticket`.
 *
 * A person says what went wrong on a done ticket; `list` reads them (an agent may read);
 * `add` and `withdraw` are a person's acts (the service refuses an agent, and the safety
 * hook denies the write verbs to an agent shell).
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Command } from "commander";

import { FINDING_CATEGORY_LABEL, type FindingView } from "../../services/findingService.js";
import { resolveDbPath } from "../../util/paths.js";
import { cliActor, printJson } from "../helpers.js";
import { heavy, open } from "../runtime.js";

/**
 * The memory CLI and database `finding lesson` files the draft through. The environment's
 * MEMORY_CLI_BIN / MEMORY_DB win (the dashboard and the runner set them); a person's
 * `gaffer wg` passes neither, so the factory's own layout is the fallback: the memory
 * package beside this one, and memory.sqlite beside the dispatch database (both under
 * GAFFER_DATA). Only this command reads them: no other command changes.
 */
export function lessonMemoryEnv(env: NodeJS.ProcessEnv, dbOpt: unknown): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  if (!(env["MEMORY_CLI_BIN"] ?? "").trim()) {
    const here = dirname(fileURLToPath(import.meta.url));
    const bin = resolve(here, "../../../../memory/dist/bin/memory.js");
    if (existsSync(bin)) out["MEMORY_CLI_BIN"] = bin;
  }
  if (!(env["MEMORY_DB"] ?? "").trim()) {
    out["MEMORY_DB"] = resolve(dirname(resolveDbPath(dbOpt as string | undefined)), "memory.sqlite");
  }
  return out;
}

const collect = (v: string, prev: string[]): string[] => [...prev, v];

/** One finding as a line of text (`wg ticket finding list` without --json). */
export function findingLine(f: FindingView): string {
  const who = f.filed_by.id ?? f.filed_by.type;
  const cat = f.category ? ` [${FINDING_CATEGORY_LABEL[f.category]}]` : "";
  const via = f.regression_ticket ? ` (from regression #${f.regression_ticket.number ?? "?"})` : "";
  const state = f.withdrawn
    ? ` WITHDRAWN by ${f.withdrawn.by.id ?? f.withdrawn.by.type}: ${f.withdrawn.reason}`
    : "";
  const paths = f.paths.length ? `\n    paths: ${f.paths.join(", ")}` : "";
  const lesson = f.lesson ? `\n    lesson proposed: ${f.lesson.lore_id ?? "(id unknown)"}` : "";
  const fix = f.fix_ticket ? `\n    fix ticket: #${f.fix_ticket.number ?? "?"}` : "";
  return `${f.id.slice(0, 8)} ${f.filed_at.slice(0, 10)} by ${who}${cat}${via}${state}\n    ${f.text.replace(/\s+/g, " ")}${paths}${lesson}${fix}`;
}

export function registerFindingCommands(ticket: Command): void {
  const finding = ticket
    .command("finding")
    .description(
      "What went wrong on a done ticket, said after it landed: a person's record the factory learns from",
    );

  finding
    .command("add <ref>")
    .description(
      "Record what went wrong on a done ticket. Paths default to the ones its recorded " +
        "delivery touched. A person's act: human or admin only.",
    )
    .requiredOption("--text <text>", "what went wrong")
    .option(
      "--category <c>",
      "missed_requirement | wrong_assumption | test_gap | convention | other",
    )
    .option("--path <path>", "a path or glob it concerns (repeatable)", collect, [])
    .option("--criterion <acId>", "an acceptance criterion it concerns (repeatable)", collect, [])
    .action((ref, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const r = wg.addFinding(
        ref,
        {
          text: String(opts.text),
          category: opts.category ?? null,
          paths: opts.path as string[],
          criteria: opts.criterion as string[],
        },
        cliActor(),
      );
      printJson({ ok: true, finding: r.finding, event_id: r.eventId });
      wg.db.close();
    });

  finding
    .command("list <ref>")
    .description("The findings on a ticket, withdrawn ones marked (a read)")
    .option("--json", "print JSON")
    .action((ref, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const all = wg.findingsOf(ref);
      if (opts.json) printJson({ ok: true, findings: all });
      else
        process.stdout.write(
          all.length ? `${all.map(findingLine).join("\n")}\n` : "No findings on this ticket.\n",
        );
      wg.db.close();
    });

  finding
    .command("lesson <ref> <findingId>")
    .description(
      "Propose one finding as a lesson now: a lore draft scoped to its repository and " +
        "paths, waiting for a person's approval in the Memory view (never auto-approved). " +
        "Once approved, later changes on those paths see it. A person's act.",
    )
    .action((ref, fid, _opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const wg = open(globals);
      const { createMemoryReader } = heavy();
      try {
        const memory = createMemoryReader(lessonMemoryEnv(process.env, globals.db));
        const r = wg.proposeLesson(ref, String(fid), cliActor(), (d) => {
          const filed = memory.proposeLesson(d);
          return filed.available ? { ok: true, id: filed.id } : { ok: false, reason: filed.reason };
        });
        printJson({ ok: true, finding: r.finding, lore_id: r.loreId, event_id: r.eventId });
      } finally {
        wg.db.close();
      }
    });

  finding
    .command("fix-ticket <ref> <findingId>")
    .description(
      "Open a fix ticket from a finding: a new ticket at the change's risk, delivering to " +
        "its repository, the finding quoted in its description, linked as a regression of " +
        "the change. When the change was approved or landed automatically, the link also " +
        "takes that automatic approval back (--preview says so without opening anything). " +
        "A person's act.",
    )
    .option("--preview", "say what opening it would do, and open nothing")
    .action((ref, fid, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      try {
        const preview = wg.fixTicketPreview(ref, String(fid), cliActor());
        if (opts.preview) {
          printJson({ ok: true, preview });
          return;
        }
        const r = wg.openFixTicket(ref, String(fid), cliActor());
        printJson({
          ok: true,
          finding: r.finding,
          ticket: r.ticket,
          stepped_down: r.stepped_down,
          message: preview.message,
          event_id: r.eventId,
        });
      } finally {
        wg.db.close();
      }
    });

  finding
    .command("withdraw <ref> <findingId>")
    .description(
      "Take a finding back, with a reason (soft: it stays in the log, marked). A person's act.",
    )
    .requiredOption("--reason <text>", "why it is withdrawn")
    .action((ref, fid, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const r = wg.withdrawFinding(ref, String(fid), String(opts.reason), cliActor());
      printJson({ ok: true, finding: r.finding, event_id: r.eventId });
      wg.db.close();
    });
}
