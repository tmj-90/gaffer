import type { Command } from "commander";

import { cliActor, printJson } from "../helpers.js";
import { heavy, open } from "../runtime.js";

/**
 * REVIEW RULES (D6): repeated human review feedback as proposed repository rules.
 * `wg review-rules` prints the candidates, the proposed rules with their lore status and
 * their rejections before vs after approval (a read). `wg review-rules propose` files the
 * candidates not proposed yet as lore convention drafts through the memory CLI
 * (MEMORY_CLI_BIN / MEMORY_DB); a person approves them with `gaffer lore approve` or the
 * Memory view, and they never auto-approve. Proposing is a person's act: the safety hook
 * denies it to an agent shell, and the service refuses an agent actor. Its modules load
 * through heavy() (runtime.ts), never statically, so `--help` stays light.
 */
export function registerReviewRules(program: Command): void {
  const rules = program
    .command("review-rules")
    .description(
      "Repeated review feedback from people as proposed repository rules (lore drafts): " +
        "the candidates, the proposed rules and whether rejections citing them fell after approval.",
    )
    .option("--repo <name>", "only this repository")
    .action((opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const { createMemoryReader, reviewRuleThreshold, reviewRulesReport } = heavy();
      try {
        const memory = createMemoryReader(process.env);
        const report = reviewRulesReport(wg.db, {
          threshold: reviewRuleThreshold(process.env),
          nowMs: Date.now(),
          lookup: (id) => {
            const h = memory.loreHistory(id);
            return h.available ? { status: h.current.status, approvedAt: h.approvedAt } : null;
          },
        });
        const repo = opts.repo ? String(opts.repo) : null;
        printJson({
          ok: true,
          ...report,
          candidates: report.candidates.filter((c) => !repo || c.repo === repo),
          proposed: report.proposed.filter((p) => !repo || p.repo === repo),
        });
      } finally {
        wg.db.close();
      }
    });

  rules
    .command("propose")
    .description(
      "File every repeated-feedback rule not proposed yet as a lore convention draft " +
        "(never auto-approved). A person's act.",
    )
    .option("--repo <name>", "only this repository")
    .action((opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const { createMemoryReader, reviewRuleThreshold, proposeReviewRules } = heavy();
      try {
        const memory = createMemoryReader(process.env);
        const res = proposeReviewRules(wg.db, cliActor(), {
          threshold: reviewRuleThreshold(process.env),
          repo: opts.repo ? String(opts.repo) : null,
          proposer: (d) => {
            const filed = memory.proposeReviewRule(d);
            return filed.available
              ? { ok: true, id: filed.id }
              : { ok: false, reason: filed.reason };
          },
        });
        printJson({ ok: true, ...res });
      } finally {
        wg.db.close();
      }
    });
}
