#!/usr/bin/env node
import { Command } from "commander";
import { ZodError } from "zod";

import { DatabaseOpenError, DatabaseTooNewError } from "../db/connection.js";
import { DispatchError } from "../util/errors.js";
import { resolveDbPath } from "../util/paths.js";
import { VERSION } from "../version.js";
import { registerAc } from "./commands/ac.js";
import { registerAgent, registerAgentSystem } from "./commands/agent.js";
import { registerDecisions } from "./commands/decisions.js";
import { registerDiagnostics } from "./commands/diagnostics.js";
import { registerEpic } from "./commands/epic.js";
import { registerNotify } from "./commands/notify.js";
import { registerPortability } from "./commands/portability.js";
import { registerRepo } from "./commands/repo.js";
import { registerReview } from "./commands/review.js";
import { registerScope } from "./commands/scope.js";
import { registerSpec } from "./commands/spec.js";
import { registerTicket } from "./commands/ticket.js";
import { open, printJson } from "./shared.js";

const program = new Command();
program
  .name("dispatch")
  .description("Agent-ready backlog control plane")
  .version(VERSION, "-v, --version", "print the Dispatch version")
  .option("--db <path>", "SQLite database path")
  .showHelpAfterError();

program
  .command("init")
  .description("Create (or open) the Dispatch database")
  .action((_opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
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
registerNotify(program);

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof DatabaseTooNewError || err instanceof DatabaseOpenError) {
      process.stderr.write(
        `${JSON.stringify({ ok: false, code: err.code, message: err.message })}\n`,
      );
      process.exitCode = 1;
      return;
    }
    if (err instanceof DispatchError) {
      process.stderr.write(
        `${JSON.stringify({ ok: false, code: err.code, message: err.message, details: err.details })}\n`,
      );
      process.exitCode = 1;
      return;
    }
    if (err instanceof ZodError) {
      process.stderr.write(
        `${JSON.stringify({ ok: false, code: "VALIDATION_ERROR", issues: err.issues.map((i) => ({ path: i.path, message: i.message })) })}\n`,
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

void main();
