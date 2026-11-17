import type { Command } from "commander";

import { printJson } from "../helpers.js";
import { heavy, open } from "../runtime.js";
import { lessonMemoryEnv } from "./finding.js";

/**
 * LESSONS (backlog 59): `wg lessons` prints every lesson proposed from a post-merge finding,
 * its lore status, and its recurrences on its paths before vs after it went live, plus the
 * totals Health shows ("N live, M drafts waiting, recurrences after: k of n"). A read. The
 * lore statuses come from the memory CLI (MEMORY_CLI_BIN / MEMORY_DB, else the factory's
 * own layout, as `ticket finding lesson`); memory unavailable, they read null.
 */
export function registerLessons(program: Command): void {
  program
    .command("lessons")
    .description(
      "Lessons from post-merge findings: each one's status and whether things still went " +
        "wrong on its paths after it went live (a read).",
    )
    .option("--repo <name>", "only this repository")
    .option("--json", "print JSON (the default output is a short summary)")
    .action((opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const wg = open(globals);
      const { createMemoryReader, lessonsReport } = heavy();
      try {
        const memory = createMemoryReader(lessonMemoryEnv(process.env, globals.db));
        const report = lessonsReport(wg.db, {
          nowMs: Date.now(),
          lookup: (id) => {
            const h = memory.loreHistory(id);
            return h.available ? { status: h.current.status, approvedAt: h.approvedAt } : null;
          },
        });
        const repo = opts.repo ? String(opts.repo) : null;
        const lessons = report.lessons.filter((l) => !repo || l.repo === repo);
        if (opts.json) {
          printJson({ ok: true, ...report, lessons });
          return;
        }
        const k = report.recurrences_after;
        const lines = [
          `Lessons: ${report.live} live, ${report.drafts_waiting} draft${report.drafts_waiting === 1 ? "" : "s"} waiting, recurrences after: ${k.k} of ${k.n}.`,
          ...lessons.map((l) => {
            const m = l.measure;
            const rate = (r: number | null) => (r === null ? "no rate" : `${r}%`);
            return (
              `  #${l.number ?? "?"} ${l.lore_id ?? "(no lore id)"} [${l.lore_status ?? "unknown"}] ${l.repo ?? "?"}: ${l.paths.join(", ")}\n` +
              `    before ${m.recurrences_before} of ${m.changes_before} (${rate(m.rate_before_pct)}), after ${m.recurrences_after} of ${m.changes_after} (${rate(m.rate_after_pct)}). ${m.note}`
            );
          }),
          report.note,
        ];
        process.stdout.write(lines.join("\n") + "\n");
      } finally {
        wg.db.close();
      }
    });
}
