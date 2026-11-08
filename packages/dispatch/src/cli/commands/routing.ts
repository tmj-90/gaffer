import { join } from "node:path";

import type { Command } from "commander";

import { DispatchError } from "../../util/errors.js";
import { printJson } from "../helpers.js";
import { heavy, open } from "../runtime.js";

/** `--min <n>`: a positive integer, else the scorecard's default. */
function minOf(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1)
    throw new DispatchError("VALIDATION_ERROR", "--min must be a positive integer");
  return n;
}

/**
 * ROUTING (delta roadmap gap 4). `wg stats routing` prints the routing scorecard (P1);
 * `wg routing recommend` prints an ADVISORY proposed model-registry change as a diff (P3).
 * Both are reads: nothing here writes the registry or changes how the router routes.
 * Modules load through heavy() so `--help` stays light.
 */
export function registerRouting(program: Command): void {
  const stats = program.commands.find((c) => c.name() === "stats");
  if (stats) {
    stats
      .command("routing")
      .description(
        "The routing scorecard: per provider x model x role x work class, attempts, " +
          "submissions, first-pass acceptance, rework, attempts and cost per accepted change, " +
          "escaped defects and tester false greens, with n on every figure. Report only.",
      )
      .option("--min <n>", "the minimum n below which a cell reads too few to compare (default 10)")
      .option("--json", "emit machine-readable JSON", false)
      .action((opts, cmd) => {
        const wg = open(cmd.optsWithGlobals());
        const h = heavy();
        try {
          const card = h.readRoutingScorecard(wg.db, {
            rows: h.readRoutingRows(h.resolveLedgerPath(process.env)),
            manifests: h.readManifestFacts(h.manifestsDir(process.env)),
            ...(opts.min !== undefined ? { minN: minOf(opts.min) as number } : {}),
          });
          if (opts.json) printJson(card);
          else process.stdout.write(`${h.renderRoutingScorecard(card)}\n`);
        } finally {
          wg.db.close();
        }
      });
  }

  const routing = program
    .command("routing")
    .description("Routing evidence: advisory recommendations from the scorecard and experiments");
  routing
    .command("recommend")
    .description(
      "Print a proposed model-registry.json change as a diff, with the cells, n and deltas " +
        "behind it, where the scorecard or a live matched experiment is strong enough. " +
        "Advisory: it never edits the registry; a person applies it.",
    )
    .option("--min <n>", "the minimum n per compared cell (default 10)")
    .option(
      "--registry <path>",
      "the model registry (default GAFFER_MODEL_REGISTRY, else the runner's)",
    )
    .option(
      "--experiment <path...>",
      "experiment results.json file(s) (default: the latest under $GAFFER_DATA/experiments)",
    )
    .option(
      "--margin <m>",
      "the non-inferiority margin: the drop in acceptance rate you accept for a cheaper tier on this work (0 < m < 0.5, default 0.10)",
    )
    .option("--json", "emit machine-readable JSON", false)
    .action((opts, cmd) => {
      let margin: number | undefined;
      if (opts.margin !== undefined) {
        const s = String(opts.margin).trim();
        margin = /^\d*\.?\d+$/.test(s) ? Number(s) : Number.NaN;
        if (!(margin > 0 && margin < 0.5))
          throw new DispatchError(
            "VALIDATION_ERROR",
            `--margin must be a number with 0 < m < 0.5 (got ${String(opts.margin)})`,
          );
      }
      const wg = open(cmd.optsWithGlobals());
      const h = heavy();
      try {
        const card = h.readRoutingScorecard(wg.db, {
          rows: h.readRoutingRows(h.resolveLedgerPath(process.env)),
          manifests: h.readManifestFacts(h.manifestsDir(process.env)),
          ...(opts.min !== undefined ? { minN: minOf(opts.min) as number } : {}),
        });
        const path = opts.registry ? String(opts.registry) : h.resolveRegistryPath(process.env);
        const reg = h.readRegistry(path);
        if (!reg)
          throw new DispatchError(
            "VALIDATION_ERROR",
            `cannot read the model registry ${path ?? "(not found)"}`,
          );
        const experiments = Array.isArray(opts.experiment)
          ? (opts.experiment as string[])
              .map((p) => h.readExperimentResults(p))
              .filter((r): r is NonNullable<typeof r> => r !== null)
          : h.readExperimentDir(
              process.env.GAFFER_DATA ? join(process.env.GAFFER_DATA, "experiments") : null,
            );
        const rec = h.recommendRouting({
          scorecard: card,
          registry: reg.registry,
          registryText: reg.text,
          registryPath: path,
          experiments,
          ...(margin !== undefined ? { margin } : {}),
        });
        if (opts.json) printJson(rec);
        else process.stdout.write(`${h.renderRecommendation(rec)}\n`);
      } finally {
        wg.db.close();
      }
    });
}
