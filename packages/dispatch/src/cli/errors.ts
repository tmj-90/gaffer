import { type Command, CommanderError } from "commander";
import { ZodError } from "zod";

import { DatabaseOpenError, DatabaseTooNewError } from "../db/connection.js";
import { dbBusyError, isDbBusyError } from "../util/dbBusy.js";
import { DispatchError } from "../util/errors.js";
import { toZod3Issues, type Zod3Issue } from "../util/zod3Compat.js";
import { flagForField, ruleForField } from "./limits.js";

/** The CLI's one error shape, written as one JSON line on stderr. */
export interface CliErrorBody {
  ok: false;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** What the error boundary does with a failure: the line to print (if any) and the exit code. */
export interface CliFailure {
  exitCode: number;
  /** Null when the failure already printed itself (commander's usage errors). */
  body: CliErrorBody | null;
}

function body(
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): CliErrorBody {
  return details && Object.keys(details).length > 0
    ? { ok: false, code, message, details: { ...details } }
    : { ok: false, code, message };
}

/**
 * The CLI's single error boundary (exploratory findings cli-wg/F-07, cli-runner/F-13).
 * Every failure becomes the one-line `{ ok:false, code, message, details? }` on stderr
 * and exit 1: a refused domain command, a validation failure, a database that cannot
 * be opened, one another process holds locked, and anything unexpected. A raw stack
 * (with internal file paths) is never printed; DISPATCH_DEBUG=1 adds it under
 * `details.stack` for a bug report.
 */
export function describeCliFailure(
  err: unknown,
  ctx: { command?: Command; commandPath?: string } = {},
): CliFailure {
  if (err instanceof CommanderError) {
    // Commander has already printed its message (and the help) to stderr. A usage
    // mistake (unknown command or option, a missing argument or required option, a
    // command group given no command) exits 2 and did nothing, as the `gaffer` front
    // door promises (cli-wg/F-14); help and --version exit 0.
    if (err.code === "commander.helpDisplayed" || err.code === "commander.version") {
      return { exitCode: 0, body: null };
    }
    if (err.code === "commander.help") {
      process.stderr.write("error: a command is missing: pick one of those listed above\n");
    }
    return { exitCode: 2, body: null };
  }
  if (err instanceof DatabaseTooNewError || err instanceof DatabaseOpenError) {
    return { exitCode: 1, body: body(err.code, err.message) };
  }
  if (err instanceof DispatchError) {
    // No database where the command was pointed: nothing ran, the invocation is
    // wrong (a mistyped --db / GAFFER_DATA), so it exits 2 like a usage error.
    const exitCode = err.code === "DB_NOT_FOUND" ? 2 : 1;
    return { exitCode, body: body(err.code, err.message, err.details) };
  }
  if (err instanceof ZodError) {
    const zod3 = toZod3Issues(err.issues);
    const issues = zod3.map((i) => ({ path: i.path, message: i.message }));
    return {
      exitCode: 1,
      body: body("VALIDATION_ERROR", validationMessage(zod3, ctx), { issues }),
    };
  }
  if (isDbBusyError(err)) {
    const busy = dbBusyError();
    return { exitCode: 1, body: body(busy.code, busy.message, busy.details) };
  }
  const message = err instanceof Error ? err.message : String(err);
  const debug = process.env["DISPATCH_DEBUG"] === "1" && err instanceof Error && err.stack;
  return {
    exitCode: 1,
    body: body(
      "INTERNAL_ERROR",
      `Unexpected error: ${message}`,
      debug ? { stack: err.stack } : undefined,
    ),
  };
}

/**
 * A validation failure in words a person can act on (exploratory finding cli-wg/F-15):
 * the flag they typed and the rule it breaks ("--priority must be a whole number
 * between 0 and 1000"), else the flag (or field) and the issue's own message. One
 * sentence per field; the raw issues stay under `details.issues` for a script.
 */
export function validationMessage(
  issues: readonly Zod3Issue[],
  ctx: { command?: Command; commandPath?: string } = {},
): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const issue of issues) {
    const field = issue.path.length === 1 ? String(issue.path[0]) : undefined;
    const key = field ?? issue.path.join(".");
    if (seen.has(key)) continue;
    seen.add(key);
    const flag = field ? flagForField(ctx.command, field) : undefined;
    const rule = field && ctx.commandPath ? ruleForField(ctx.commandPath, field) : undefined;
    const subject = flag ?? (key || "input");
    parts.push(rule ? `${subject} must be ${rule}` : `${subject}: ${issue.message}`);
  }
  return parts.join("; ") || "Invalid input.";
}
