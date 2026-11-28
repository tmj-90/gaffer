import { spawnSync } from "node:child_process";

import type { Command } from "commander";

import {
  DEFAULT_RESEARCH_BIN,
  GAFFER_RESEARCH_BIN_ENV,
  RESEARCH_KILL_MS,
  parseLastLine,
} from "../../api/research.js";
import { RESEARCH_PRIORITIES, type ResearchRun } from "../../services/researchService.js";
import { DispatchError } from "../../util/errors.js";
import { cliActor, printJson } from "../helpers.js";
import { open } from "../runtime.js";

/**
 * `wg research` (backlog 69): the research runs in front of the spec step, from a
 * terminal. Reads are open (`list`, `get`); every other verb is a person's act: the
 * service refuses an agent or system actor, a scoped principal is refused by the
 * principal gate (a factory-wide write), and the safety hook refuses these verbs to an
 * agent's shell. `runner/gaffer research` is the person-facing front door.
 */
export function registerResearch(program: Command): void {
  const research = program
    .command("research")
    .description("Research runs: web research on an idea, edited by a person, drafted into a spec");

  research
    .command("list")
    .description("List research runs newest first")
    .option("--session <id>", "only the run of this Plan a build session")
    .option("--all", "include discarded runs")
    .action((opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      printJson(
        wg.researchSvc.listRuns({
          ...(opts.session ? { planSessionId: String(opts.session) } : {}),
          includeDiscarded: opts.all === true,
        }),
      );
      wg.db.close();
    });

  research
    .command("get <id>")
    .description("Show one research run (findings with sources, features, open questions)")
    .action((id: string, _opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      printJson(wg.researchSvc.getRun(id));
      wg.db.close();
    });

  research
    .command("create")
    .description(
      "Start a research run and wait for it (a paid web research turn: the idea and the " +
        "search queries are seen by the search provider and every site fetched). Needs a " +
        "dollar cap and an OS sandbox, like every paid launch.",
    )
    .requiredOption("--idea <text>", "the idea to research")
    .option(
      "--repo <name>",
      "a registered repository the idea extends (only its name is sent; the dashboard can also share its overview)",
    )
    .action((opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      try {
        const { run } = wg.researchSvc.startRun(
          {
            idea: String(opts.idea),
            ...(opts.repo ? { repo: String(opts.repo) } : {}),
          },
          cliActor(),
        );
        const bin = (process.env[GAFFER_RESEARCH_BIN_ENV] ?? "").trim() || DEFAULT_RESEARCH_BIN;
        const r = spawnSync(process.execPath, [bin], {
          input: JSON.stringify({
            idea: run.idea,
            ...(run.repo ? { repo: { name: run.repo } } : {}),
          }),
          encoding: "utf8",
          timeout: RESEARCH_KILL_MS,
          maxBuffer: 4_000_000,
          env: (() => {
            const { DISPATCH_API_TOKEN: _t, GAFFER_PRINCIPAL_TOKEN: _p, ...rest } = process.env;
            void _t;
            void _p;
            return rest;
          })(),
        });
        const out = parseLastLine(String(r.stdout ?? "").trim());
        let stored: ResearchRun;
        if (out !== null && out.phase === "research")
          stored = wg.researchSvc.completeRun(run.id, out);
        else
          stored = wg.researchSvc.failRun(
            run.id,
            out !== null && out.phase === "error"
              ? String(out.error)
              : `the research launcher returned no result (exit ${r.status ?? "?"})`,
          );
        printJson(stored);
        if (stored.status !== "ready") process.exitCode = 1;
      } finally {
        wg.db.close();
      }
    });

  research
    .command("feature <id> <featureId>")
    .description("Edit one feature: keep or drop it, change its title, description or priority")
    .option("--keep", "keep it")
    .option("--drop", "drop it")
    .option("--title <text>", "new title")
    .option("--description <text>", "new description")
    .option("--priority <p>", `one of ${RESEARCH_PRIORITIES.join(" | ")}`)
    .action((id: string, featureId: string, opts, cmd) => {
      if (opts.keep && opts.drop)
        throw new DispatchError("VALIDATION_ERROR", "--keep and --drop together");
      const wg = open(cmd.optsWithGlobals());
      try {
        const run = wg.researchSvc.getRun(id);
        if (!run.features.some((f) => f.id === featureId)) {
          throw new DispatchError("NOT_FOUND", `research ${id} has no feature ${featureId}`, {
            feature: featureId,
          });
        }
        const features = run.features.map((f) =>
          f.id !== featureId
            ? {
                id: f.id,
                title: f.title,
                description: f.description,
                priority: f.priority,
                kept: f.kept,
              }
            : {
                id: f.id,
                title: opts.title !== undefined ? String(opts.title) : f.title,
                description:
                  opts.description !== undefined ? String(opts.description) : f.description,
                priority: opts.priority !== undefined ? String(opts.priority) : f.priority,
                kept: opts.keep ? true : opts.drop ? false : f.kept,
              },
        );
        printJson(wg.researchSvc.editRun(id, { features }, cliActor()));
      } finally {
        wg.db.close();
      }
    });

  research
    .command("feature-add <id>")
    .description("Add your own feature (kept)")
    .requiredOption("--title <text>", "its title")
    .requiredOption("--priority <p>", `one of ${RESEARCH_PRIORITIES.join(" | ")}`)
    .option("--description <text>", "one or two sentences", "")
    .action((id: string, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      try {
        const run = wg.researchSvc.getRun(id);
        const features = [
          ...run.features.map((f) => ({
            id: f.id,
            title: f.title,
            description: f.description,
            priority: f.priority,
            kept: f.kept,
          })),
          {
            title: String(opts.title),
            description: String(opts.description ?? ""),
            priority: String(opts.priority),
            kept: true,
          },
        ];
        printJson(wg.researchSvc.editRun(id, { features }, cliActor()));
      } finally {
        wg.db.close();
      }
    });

  research
    .command("question <id> <questionId>")
    .description("Keep or drop an open question (a kept one becomes a decision clause)")
    .option("--keep", "keep it")
    .option("--drop", "drop it")
    .action((id: string, questionId: string, opts, cmd) => {
      if (!!opts.keep === !!opts.drop)
        throw new DispatchError("VALIDATION_ERROR", "give exactly one of --keep or --drop");
      const wg = open(cmd.optsWithGlobals());
      try {
        printJson(
          wg.researchSvc.editRun(
            id,
            { open_questions: [{ id: questionId, kept: opts.keep === true }] },
            cliActor(),
          ),
        );
      } finally {
        wg.db.close();
      }
    });

  research
    .command("draft-spec <id>")
    .description(
      "Draft a spec from what you kept (no model call): must and should features become " +
        "requirements, wont becomes a non-goal, kept open questions become decisions",
    )
    .action((id: string, _opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      try {
        printJson(wg.researchSvc.draftSpec(id, cliActor()));
      } finally {
        wg.db.close();
      }
    });

  research
    .command("discard <id>")
    .description("Discard a research run")
    .action((id: string, _opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      try {
        printJson(wg.researchSvc.discardRun(id, cliActor()));
      } finally {
        wg.db.close();
      }
    });
}
