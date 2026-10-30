import type { Command } from "commander";

import { DispatchError } from "../../util/errors.js";
import { cliActor, open, printJson } from "../shared.js";

/**
 * SQUAD: the operator's club identity for the dashboard's Match Day view.
 * `show` prints it (the name falls back to "Gaffer"); `set` updates any of the
 * name, crest short name and kit colours. Pass "" to clear a field. Presentation
 * only; every change is recorded as a `club.updated` event.
 */
export function registerClub(program: Command): void {
  const club = program
    .command("club")
    .description(
      "The club (team) identity shown on the dashboard: `show` prints it, `set` names it.",
    );

  club
    .command("show")
    .description('Print the club identity (name defaults to "Gaffer")')
    .action((_opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      try {
        printJson({ ok: true, club: wg.getClub() });
      } finally {
        wg.db.close();
      }
    });

  club
    .command("set")
    .description('Set the club name, crest short name and/or kit colours ("" clears a field)')
    .option("--name <name>", "club name (≤ 60 chars)")
    .option("--short <short>", "crest short name (1–4 letters/digits)")
    .option("--kit-primary <hex>", "primary kit colour, e.g. #1d4ed8")
    .option("--kit-secondary <hex>", "secondary kit colour, e.g. #ffffff")
    .action(
      (
        opts: { name?: string; short?: string; kitPrimary?: string; kitSecondary?: string },
        cmd,
      ) => {
        if (
          opts.name === undefined &&
          opts.short === undefined &&
          opts.kitPrimary === undefined &&
          opts.kitSecondary === undefined
        ) {
          throw new DispatchError(
            "VALIDATION_ERROR",
            "Nothing to set: pass --name, --short, --kit-primary and/or --kit-secondary.",
          );
        }
        const wg = open(cmd.optsWithGlobals());
        try {
          const res = wg.updateClub(
            {
              name: opts.name,
              short_name: opts.short,
              kit_primary: opts.kitPrimary,
              kit_secondary: opts.kitSecondary,
            },
            cliActor(),
          );
          printJson({ ok: true, ...res });
        } finally {
          wg.db.close();
        }
      },
    );
}
