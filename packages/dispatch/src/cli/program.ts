import { Command, Help, Option } from "commander";

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

/**
 * The commands the runner (or an agent through it) calls as part of its own
 * bookkeeping. They stay callable, for a person recovering by hand, but sit under
 * their own heading in help so the commands a person uses are not lost among them
 * (exploratory finding cli-wg/F-23). Keyed by the parent command's path ("" = root).
 */
export const RUNNER_INTERNAL_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  "": [
    "claim",
    "claim-ticket",
    "heartbeat",
    "evidence",
    "submit",
    "runner-release",
    "runner-rework",
    "delivery-artifact",
    "attach-evidence",
    "expire-claims",
  ],
  ticket: [
    "landing-begin",
    "record-landing",
    "record-tester-replay",
    "auto-decision",
    "ci-result",
    "hold",
    "mark-merged",
    "pause",
    "resume-begin",
    "paused-context",
    "resume-requested",
    "paused-clear",
  ],
  "ticket repo-access": ["inherit"],
  "ticket repo-delivery": ["record"],
  ac: ["check-result"],
  notify: ["emit"],
};

export const RUNNER_INTERNAL_HEADING = "Runner-internal commands (the factory runs these):";

/** The name a person typed to get here: `gaffer wg` sets DISPATCH_CLI_NAME, else `dispatch`. */
export function cliName(): string {
  const n = process.env["DISPATCH_CLI_NAME"]?.trim();
  return n ? n : "dispatch";
}

/** `ticket create`, `` (root): a command's path below the program. */
export function commandPath(cmd: Command): string {
  const names: string[] = [];
  for (let c: Command | null = cmd; c?.parent; c = c.parent) names.unshift(c.name());
  return names.join(" ");
}

/** Every command in the tree, the program included, parents before children. */
export function allCommands(cmd: Command): Command[] {
  return [cmd, ...cmd.commands.flatMap((c) => allCommands(c))];
}

function rootHelpText(name: string): string {
  return [
    "",
    "Output: every command prints JSON on stdout, except doctor, stats, human-queue and",
    "the events commands, which print text unless given --json. Every command accepts",
    "--json, so a script can pass it everywhere (a no-op where JSON is the default).",
    "",
    'Errors: one JSON line on stderr, {"ok":false,"code","message","details"?}.',
    "Exit codes: 0 done; 1 refused or failed (the error line says why); 2 a usage error",
    "(unknown command or option, missing argument or required option, no database at",
    "--db), and nothing was done.",
    "",
    `\`${name} help <command> [subcommand]\` shows one command's help.`,
  ].join("\n");
}

/** Build the whole CLI command tree (what `dispatch` and `gaffer wg` run). */
export function buildProgram({ name = cliName() }: { name?: string } = {}): Command {
  const program = new Command();
  const pinned = name !== "dispatch";
  program
    .name(name)
    .description("Agent-ready backlog control plane")
    .version(VERSION, "-v, --version", "print the Dispatch version")
    .option(
      "--db <path>",
      pinned
        ? `SQLite database path (${name} passes this factory's own; you never need it)`
        : "SQLite database path (default: DISPATCH_DB, else ./.dispatch/dispatch.sqlite)",
    )
    // Root options (-v, --db) are parsed only BEFORE the subcommand, so a value after
    // it that starts with "-" (a claim token, a free-text reason) is never taken for one.
    .enablePositionalOptions()
    .showHelpAfterError()
    // Help marks the options a command cannot run without (cli-wg/F-23). Set before
    // any subcommand is created so every one inherits it.
    .configureHelp({
      optionDescription(option: Option): string {
        const text = Help.prototype.optionDescription.call(this, option);
        return option.mandatory ? `${text} (required)` : text;
      },
    })
    // Commander's own exits become CommanderErrors the error boundary turns into
    // exit codes; set before any subcommand so every one inherits it.
    .exitOverride()
    .addHelpText("after", rootHelpText(name));

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

  for (const cmd of allCommands(program)) {
    // cli-wg/F-21: one rule for --json. A command that prints JSON anyway accepts it
    // as a no-op (hidden from its help; the root help states the rule), so a script
    // can pass --json to every command.
    if (cmd.commands.length === 0 && !cmd.options.some((o) => o.long === "--json")) {
      cmd.addOption(new Option("--json", "print JSON (already the default)").hideHelp());
    }
    const internal = RUNNER_INTERNAL_COMMANDS[commandPath(cmd)];
    if (!internal) continue;
    for (const sub of cmd.commands) {
      if (internal.includes(sub.name())) sub.helpGroup(RUNNER_INTERNAL_HEADING);
    }
  }
  return program;
}

/** Edit distance, for "did you mean" on `help <unknown>`. */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
    }
  }
  return d[a.length]![b.length]!;
}

function findSub(cmd: Command, token: string): Command | undefined {
  return cmd.commands.find((c) => c.name() === token || c.aliases().includes(token));
}

function fullName(cmd: Command, program: Command): string {
  const path = commandPath(cmd);
  return path ? `${program.name()} ${path}` : program.name();
}

/**
 * `help [command…]` at any level (`help ticket create`, `ticket help create`). Commander
 * printed the root usage and exited 1 for `help <unknown>` without saying the command
 * was unknown (cli-wg/F-24), and only looked one word deep. Returns the exit code when
 * argv is a help request, or null to let commander parse it.
 */
function handleHelpRequest(program: Command, args: readonly string[]): number | null {
  let i = 0;
  // Root options before the command: --db <path> / --db=<path>.
  while (i < args.length && args[i]!.startsWith("-")) {
    if (args[i] === "--db") i += 2;
    else if (args[i]!.startsWith("--db=")) i += 1;
    else return null;
  }
  let cur = program;
  for (; i < args.length; i++) {
    const token = args[i]!;
    if (token.startsWith("-")) return null;
    if (token === "help" && cur.commands.length > 0 && !findSub(cur, "help")) break;
    const sub = findSub(cur, token);
    if (!sub) return null;
    cur = sub;
  }
  if (i >= args.length) return null;
  for (const token of args.slice(i + 1)) {
    if (token.startsWith("-")) continue;
    const sub = findSub(cur, token);
    if (!sub) {
      const near = cur.commands
        .map((c) => c.name())
        .filter((n) => distance(n, token) <= Math.max(1, Math.floor(token.length / 3)));
      const hint = near.length > 0 ? ` (Did you mean ${near.join(", ")}?)` : "";
      process.stderr.write(
        `error: unknown command '${token}'${hint}\n` +
          `(see '${fullName(cur, program)} --help' for the commands)\n`,
      );
      return 2;
    }
    cur = sub;
  }
  cur.outputHelp();
  return 0;
}

/**
 * A reader that stops early (`gaffer wg ticket list | head -1`) closes the pipe, and
 * the CLI's next write fails with EPIPE. Node raises that as an unhandled 'error'
 * event: a raw stack trace and exit 1, after the command had already done its work and
 * the reader had what it wanted. So EPIPE is ignored and the command keeps its own
 * exit code. Any other failure to write stdout is the one JSON error line and exit 1.
 */
export function guardStdio(): void {
  const closed = (err: NodeJS.ErrnoException): boolean =>
    err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED";
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (closed(err)) return;
    const body = {
      ok: false,
      code: "IO_ERROR",
      message: `Could not write the output: ${err.message}`,
      ...(err.code ? { details: { errno: err.code } } : {}),
    };
    process.stderr.write(`${JSON.stringify(body)}\n`);
    process.exitCode = 1;
  });
  // Nowhere left to report a failure to write stderr itself.
  process.stderr.on("error", () => undefined);
}

/**
 * Run the CLI on `argv` (process.argv shape) and return the exit code. Every failure
 * goes through the one error boundary ({@link describeCliFailure}): a single JSON
 * line on stderr, never a stack trace.
 */
export async function runProgram(program: Command, argv: readonly string[]): Promise<number> {
  const help = handleHelpRequest(program, argv.slice(2));
  if (help !== null) return help;
  // The command whose action is running, so a validation failure can name its flags.
  let action: Command | undefined;
  program.hook("preAction", (_root, actionCommand) => {
    action = actionCommand;
  });
  try {
    await program.parseAsync([...argv]);
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (err) {
    const failure = describeCliFailure(err, {
      ...(action ? { command: action, commandPath: commandPath(action) } : {}),
    });
    if (failure.body) process.stderr.write(`${JSON.stringify(failure.body)}\n`);
    return failure.exitCode;
  }
}
