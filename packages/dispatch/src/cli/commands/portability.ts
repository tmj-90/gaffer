import type { Command } from "commander";

import {
  EXCLUDED_TABLES,
  exportState,
  importStateFromJson,
  serializeBundle,
  verifyBundleRestores,
} from "../../io/stateExport.js";
import { open, printJson, readInputFile, readStdin, writeOutputFile } from "../shared.js";

export function registerPortability(program: Command): void {
  // --- Portability: export / import the whole board (H5) ----------------------

  program
    .command("export")
    .description(
      "Export the whole Dispatch board to a portable JSON bundle (tickets, epics, " +
        "scope graph, ACs, repos, decisions, reviews/evidence, work_events, claims, planner " +
        "sessions, paused deliveries). Not carried: the run registry, API principals and " +
        "schema metadata (machine-local). " +
        "Reads every table from one consistent snapshot, restores the bundle into a " +
        "scratch database with the importer's own checks, and only then writes it — to " +
        "stdout by default, or to a file with --out. Exits non-zero, writing nothing, if " +
        "the bundle would not restore.",
    )
    .option("-o, --out <file>", "write the bundle to this file ('-' for stdout)")
    .action((opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      try {
        const bundle = exportState(wg.db);
        // Fail loudly BEFORE anything is written: a bundle the importer would reject
        // is not a backup, and the operator can still take another copy now.
        const verified = verifyBundleRestores(bundle);
        const json = serializeBundle(bundle);
        const out = opts.out as string | undefined;
        if (out === undefined || out === "-") {
          process.stdout.write(json);
        } else {
          writeOutputFile(out, json);
          printJson({
            ok: true,
            out,
            tables: Object.keys(bundle.tables).length,
            rows: verified.rowsRestored,
            verified: true,
            // Not carried, by design (machine-local): named so "whole board" is honest.
            not_exported: Object.keys(EXCLUDED_TABLES),
          });
        }
      } finally {
        wg.db.close();
      }
    });

  program
    .command("import <file>")
    .description(
      "Import a board bundle (from 'dispatch export') into THIS database. Refuses a " +
        "non-empty DB unless --force is given (which replaces its contents). Reads " +
        "stdin when <file> is '-'.",
    )
    .option("--force", "replace the contents of a non-empty database", false)
    .action((file: string, opts, cmd) => {
      const json = file === "-" ? readStdin() : readInputFile(file);
      const wg = open(cmd.optsWithGlobals());
      try {
        const res = importStateFromJson(wg.db, json, { force: opts.force });
        printJson({ ok: true, ...res });
      } finally {
        wg.db.close();
      }
    });
}
