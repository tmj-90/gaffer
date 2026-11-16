import type { Command } from "commander";

import { AUTONOMY_MODES } from "../../repositories/autonomyPolicyRepository.js";
import type { AutonomyLadder } from "../../services/autonomyLadderService.js";
import { DispatchError } from "../../util/errors.js";
import { RISK_LEVELS, type RiskLevel } from "../../domain/types.js";
import { cliActor, cliPrincipal, printJson } from "../helpers.js";
import { open } from "../runtime.js";

/**
 * GRADUATED-AUTONOMY: the read-only view of the stored per-(repo × risk × gate)
 * autonomy policy — the same rows GET /api/autonomy/policies serves the Settings
 * surface. Two runner consumers read it:
 *
 *  - `autonomy list` — `_gaffer_autonomy_on` in factory.config.sh decides whether
 *    the factory can ship unattended: a stored mode='auto' row is an allow-path the
 *    review gate honours in EVERY mode (isAutonomyAllowed = env floor OR policy), so
 *    its presence must turn the autonomy→containment defaults on exactly like an
 *    env ship flag does.
 *  - `autonomy policies [--mode]` — `gaffer_inert_policy_check` warns once per run
 *    when `auto` rows exist but REVIEW_MODE=human: in supervised mode no reviewer
 *    agent runs, so no policy is ever consulted and the grants are inert.
 *
 * Enable/disable stays on the REST surface behind its explicit-confirm boundary. The one
 * write here is `autonomy lift` (a person gives autonomy back after a step-down).
 */
export function registerAutonomy(program: Command): void {
  const autonomy = program
    .command("autonomy")
    .description("Graduated-autonomy policy and the autonomy ladder");

  autonomy
    .command("ladder")
    .description(
      "The autonomy ladder: for every repo x risk x gate (approve, merge) the rung " +
        "(person / suggested / automatic), the evidence behind it, the distance to the next " +
        "rung and any step-down in force. A scoped principal sees only its repos. No mutation.",
    )
    .option("--repo <repo>", "one repository (id or name)")
    .option("--json", "print the read model as JSON")
    .action((opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      try {
        const ladder = wg.autonomyLadder(cliPrincipal(), opts.repo as string | undefined);
        if (opts.json) printJson({ ok: true, ...ladder });
        else process.stdout.write(renderLadder(ladder));
      } finally {
        wg.db.close();
      }
    });

  autonomy
    .command("lift <repo>")
    .description(
      "Give autonomy back for one repo x risk x gate after a step-down. A person's act " +
        "(the operator, or an admin principal with full capability; never --as agent or " +
        "system, and the safety hook keeps it from agent shells). Without --override the " +
        "evidence since the step-down must clear the bar again.",
    )
    .requiredOption("--risk <risk>", "low | medium | high | critical")
    .requiredOption("--gate <gate>", "approve | merge")
    .option("--override", "give it back before the evidence clears the bar (needs --reason)")
    .option("--reason <text>", "why (required with --override)")
    .action((repo, opts, cmd) => {
      const risk = String(opts.risk);
      const gate = String(opts.gate);
      if (!(RISK_LEVELS as readonly string[]).includes(risk)) {
        throw new DispatchError(
          "VALIDATION_ERROR",
          `--risk must be one of ${RISK_LEVELS.join(", ")}.`,
        );
      }
      if (gate !== "approve" && gate !== "merge") {
        throw new DispatchError("VALIDATION_ERROR", "--gate must be approve or merge.");
      }
      const wg = open(cmd.optsWithGlobals());
      try {
        const lifted = wg.liftAutonomyStepDown(
          {
            repo: String(repo),
            riskLevel: risk as RiskLevel,
            gate,
            how: opts.override ? "override" : "reenable",
            reason: opts.reason ? String(opts.reason) : null,
          },
          cliActor(),
          { principal: cliPrincipal() },
        );
        printJson({ ok: true, event_id: lifted.eventId, how: lifted.how });
      } finally {
        wg.db.close();
      }
    });

  autonomy
    .command("list")
    .description(
      "List the stored autonomy policy rows (repo × risk × gate → mode). " +
        "A mode='auto' row is an unattended ship allow-path in every GAFFER_MODE.",
    )
    .action((_opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const policies = wg.listAutonomyPolicies();
      printJson({
        ok: true,
        policies,
        auto_count: policies.filter((p) => p.mode === "auto").length,
      });
      wg.db.close();
    });

  autonomy
    .command("policies")
    .description(
      "List the stored per-(repo × risk × gate) autonomy policies (the Settings 'Active " +
        "autonomy' rows), optionally filtered by mode. The runner consults this at start-up " +
        "to warn when `auto` rows exist but REVIEW_MODE=human. No mutation.",
    )
    .option("--mode <mode>", "only rows in this mode: off | recommend | auto")
    .action((opts, cmd) => {
      const mode = opts.mode as string | undefined;
      if (mode !== undefined && !(AUTONOMY_MODES as readonly string[]).includes(mode)) {
        throw new DispatchError(
          "VALIDATION_ERROR",
          `--mode must be one of ${AUTONOMY_MODES.join(", ")}.`,
          { mode },
        );
      }
      const wg = open(cmd.optsWithGlobals());
      const rows = wg.listAutonomyPolicies();
      const policies = mode === undefined ? rows : rows.filter((p) => p.mode === mode);
      printJson({ ok: true, count: policies.length, policies });
      wg.db.close();
    });
}

const RUNG_WORD: Record<string, string> = {
  person: "a person decides",
  suggested: "suggested",
  automatic: "automatic",
};

/** The ladder as plain text: one block per repo, one line per risk x gate. */
export function renderLadder(ladder: AutonomyLadder): string {
  const lines: string[] = [];
  if (ladder.repos.length === 0) lines.push("No repositories to show.");
  for (const repo of ladder.repos) {
    lines.push(`${repo.repo_name}`);
    for (const row of repo.rows) {
      for (const gate of ["approve", "merge"] as const) {
        const c = row.gates[gate];
        const word = c.ceiling
          ? "not allowed"
          : c.step_down
            ? "stepped down"
            : (RUNG_WORD[c.rung] ?? c.rung);
        const ev = c.evidence;
        const figure = ev.n > 0 ? `${ev.k} of ${ev.n}` : "none yet";
        lines.push(
          `  ${row.risk_level.padEnd(8)} ${gate.padEnd(7)} ${word.padEnd(17)} ${figure.padEnd(10)} ${c.distance.text}`,
        );
        if (c.step_down) {
          lines.push(`      why: ${c.step_down.why}`);
          lines.push(`      lift: ${c.step_down.lift.text}`);
        }
      }
    }
  }
  if (ladder.recent_step_downs.length > 0) {
    lines.push("");
    lines.push("Step-downs in the last 7 days:");
    for (const r of ladder.recent_step_downs) {
      lines.push(
        `  ${r.at}  ${r.repo_name} ${r.risk_level}/${r.gate}${r.in_force ? "" : " (lifted)"}: ${r.why}`,
      );
    }
  }
  return lines.join("\n") + "\n";
}
