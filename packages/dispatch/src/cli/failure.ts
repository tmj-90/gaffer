import type { CommanderError } from "commander";

// The light half of the CLI's error boundary (errors.ts): the error shape and the
// exit codes of commander's own exits (usage errors, help, --version). It imports
// nothing heavy, so `--version` and a mistyped command never load zod or the
// database layer (see runtime.ts).

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

/** What the error boundary does with one of commander's own exits. */
export function describeCommanderFailure(err: CommanderError): CliFailure {
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
