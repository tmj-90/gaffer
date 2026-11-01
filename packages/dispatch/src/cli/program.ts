import { Command } from "commander";

import { resolveDbPath } from "../util/paths.js";
import { VERSION } from "../version.js";
import { registerAc } from "./commands/ac.js";
import { registerAgent, registerAgentSystem } from "./commands/agent.js";
import { registerAutonomy } from "./commands/autonomy.js";
import { registerClub } from "./commands/club.js";
import { registerDecisions } from "./commands/decisions.js";
import { registerDiagnostics } from "./commands/diagnostics.js";
import { registerEpic } from "./commands/epic.js";
import { registerNotify } from "./commands/notify.js";
import { registerPortability } from "./commands/portability.js";
import { registerPrincipal } from "./commands/principal.js";
import { registerRepo } from "./commands/repo.js";
import { registerReview } from "./commands/review.js";
import { registerScope } from "./commands/scope.js";
import { registerSpec } from "./commands/spec.js";
import { registerTicket } from "./commands/ticket.js";
import { describeCliFailure } from "./errors.js";
import { open, printJson } from "./shared.js";

/** Build the whole CLI command tree (what `dispatch` and `gaffer wg` run). */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name("dispatch")
    .description("Agent-ready backlog control plane")
    .version(VERSION, "-v, --version", "print the Dispatch version")
    .option("--db <path>", "SQLite database path")
    // Root options (-v, --db) are parsed only BEFORE the subcommand, so a value after
    // it that starts with "-" (a claim token, a free-text reason) is never taken for one.
    .enablePositionalOptions()
    .showHelpAfterError()
    // Commander's own exits become CommanderErrors the error boundary turns into
    // exit codes; set before any subcommand so every one inherits it.
    .exitOverride();

  program
    .command("init")
    .description("Create (or open) the Dispatch database")
    .action((_opts, cmd) => {
      const wg = open(cmd.optsWithGlobals(), { create: true });
      printJson({ ok: true, db: resolveDbPath(cmd.optsWithGlobals().db), schema: "applied" });
      wg.db.close();
    });

  // Command groups are registered in source order so the root `--help` command
  // listing (and every group's listing) is preserved exactly. The system delivery
  // evidence commands live in agent.ts but register after the review group to keep
  // that original top-level ordering.
  registerTicket(program);
  registerAc(program);
  registerRepo(program);
  registerEpic(program);
  registerSpec(program);
  registerScope(program);
  registerDecisions(program);
  registerAgent(program);
  registerReview(program);
  registerAgentSystem(program);
  registerDiagnostics(program);
  registerPortability(program);
  registerPrincipal(program);
  registerNotify(program);
  registerAutonomy(program);
  registerClub(program);
  return program;
}

/**
 * Run the CLI on `argv` (process.argv shape) and return the exit code. Every failure
 * goes through the one error boundary ({@link describeCliFailure}): a single JSON
 * line on stderr, never a stack trace.
 */
export async function runProgram(program: Command, argv: readonly string[]): Promise<number> {
  try {
    await program.parseAsync([...argv]);
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (err) {
    const failure = describeCliFailure(err);
    if (failure.body) process.stderr.write(`${JSON.stringify(failure.body)}\n`);
    return failure.exitCode;
  }
}
