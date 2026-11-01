#!/usr/bin/env node
import { Command } from "commander";
import { ZodError } from "zod";

import { DatabaseOpenError, DatabaseTooNewError } from "../db/connection.js";
import { DispatchError } from "../util/errors.js";
import { resolveDbPath } from "../util/paths.js";
import { toZod3Issues } from "../util/zod3Compat.js";
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
import { assertPrincipalCommand, commandPath } from "./principalGate.js";
import { cliActor, cliPrincipal, open, printJson, setCliPrincipal } from "./shared.js";

const program = new Command();
program
  .name("dispatch")
  .description("Agent-ready backlog control plane")
  .version(VERSION, "-v, --version", "print the Dispatch version")
  .option("--db <path>", "SQLite database path")
  .option(
    "--as-principal <token>",
    "act as a named principal (its gfp_ token; or set GAFFER_PRINCIPAL_TOKEN): writes are recorded under its identity and its read-only flag and repo/ticket scope are enforced as on the API",
  )
  // Root options (-v, --db) are parsed only BEFORE the subcommand, so a value after
  // it that starts with "-" (a claim token, a free-text reason) is never taken for one.
  .enablePositionalOptions()
  .showHelpAfterError();

// CLI IDENTITY: resolve the principal (if any) before every command, and refuse a
// command outside what it may do. Without a token the operator acts as $USER.
program.hook("preAction", (_root, action) => {
  const globals = action.optsWithGlobals() as { db?: string; asPrincipal?: string };
  const token = (globals.asPrincipal ?? process.env.GAFFER_PRINCIPAL_TOKEN ?? "").trim();
  setCliPrincipal(null);
  if (token === "") return;
  const path = commandPath(action);
  // `init` creates a database; a principal lives in one that exists.
  const wg = open(globals);
  try {
    const resolved = wg.resolvePrincipalToken(token);
    if (!resolved) {
      throw new DispatchError(
        "UNAUTHORIZED",
        "GAFFER_PRINCIPAL_TOKEN / --as-principal is not an active principal token (unknown or revoked). Nothing was done.",
      );
    }
    assertPrincipalCommand(
      wg,
      resolved.principal,
      path,
      action.processedArgs ?? action.args,
      action.opts() as Record<string, unknown>,
    );
    setCliPrincipal(resolved.principal);
  } finally {
    wg.db.close();
  }
});

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

// CLI IDENTITY: who this invocation records writes as, and whether that was checked.
program
  .command("whoami")
  .description(
    "Who this CLI records writes as: a principal (authenticated by its token) or $USER (asserted, not authenticated)",
  )
  .option(
    "--can-write <ref>",
    "also check that this identity may change that ticket (exit 1 with SCOPE_DENIED / READ_ONLY_TOKEN if not); writes nothing",
  )
  .action((opts: { canWrite?: string }, cmd) => {
    // Without a principal the operator may change anything; the ticket must exist.
    if (opts.canWrite !== undefined && !cliPrincipal()) {
      const wg = open(cmd.optsWithGlobals());
      try {
        wg.resolveTicket(opts.canWrite);
      } finally {
        wg.db.close();
      }
    }
    const p = cliPrincipal();
    if (p) {
      printJson({
        ok: true,
        actor: cliActor(),
        authenticated: true,
        principal: { id: p.id, name: p.name },
        capability: p.capability,
        scope: p.scope,
        note: `Acting as principal '${p.name}' (its token was checked against the database): every write is recorded as ${p.actor_type}:${p.actor_id}, and its capability and scope are enforced as on the API.`,
      });
      return;
    }
    printJson({
      ok: true,
      actor: cliActor(),
      authenticated: false,
      principal: null,
      capability: "full",
      scope: null,
      note:
        "Asserted, not authenticated: the CLI records writes as $USER and checks nothing, because whoever can open the database file can change anything in it (operator trust). " +
        "To act with narrower, attributable access, set GAFFER_PRINCIPAL_TOKEN (or pass --as-principal) to a principal's token (`principal create`).",
    });
  });

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
        `${JSON.stringify({ ok: false, code: "VALIDATION_ERROR", issues: toZod3Issues(err.issues).map((i) => ({ path: i.path, message: i.message })) })}\n`,
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

void main();
