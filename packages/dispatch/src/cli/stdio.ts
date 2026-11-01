// Light process plumbing the CLI entry needs before it loads the program.

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
 * `dispatch --version` (or `-v`), optionally after the root `--db <path>`, and
 * nothing else: the one invocation the entry answers without loading commander.
 * Commander gives an option its next argument whatever it looks like, so
 * `--db --version` is a --db of "--version" with no command, and is not this.
 */
export function isVersionRequest(args: readonly string[]): boolean {
  let i = 0;
  while (i < args.length - 1) {
    if (args[i] === "--db") i += 2;
    else if (args[i]!.startsWith("--db=")) i += 1;
    else break;
  }
  return i === args.length - 1 && (args[i] === "--version" || args[i] === "-v");
}
