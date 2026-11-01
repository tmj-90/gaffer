import { CommanderError } from "commander";
import { ZodError } from "zod";

import { DatabaseOpenError, DatabaseTooNewError } from "../db/connection.js";
import { dbBusyError, isDbBusyError } from "../util/dbBusy.js";
import { DispatchError } from "../util/errors.js";
import { toZod3Issues } from "../util/zod3Compat.js";

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
export function describeCliFailure(err: unknown): CliFailure {
  if (err instanceof CommanderError) {
    // Commander has already printed its message (and the help) to stderr.
    return { exitCode: err.exitCode, body: null };
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
    const issues = toZod3Issues(err.issues).map((i) => ({ path: i.path, message: i.message }));
    return {
      exitCode: 1,
      body: body("VALIDATION_ERROR", issues.map((i) => i.message).join("; "), { issues }),
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
