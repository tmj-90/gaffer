---
name: add-cli-command
description: Use when a ticket adds or changes a command-line interface — a new subcommand, flag, or output format for the repo's CLI tool — and it must follow the CLI's existing conventions for arguments, exit codes, JSON output, help text, and tests. Invoke for "add a `foo bar` command", "add a --json flag", "the CLI should print X", or any change under a cli/ or bin/ entry point.
stack: [node, python, go, rust, java, csharp, ruby, bash]
area: backend
---

# Add a CLI command

A CLI is an API whose consumers are humans at a terminal and scripts in a pipeline.
Scripts depend on the exit code, the stdout format and the flag names; humans depend on
the help text and error messages. Follow the tool's existing conventions first and the
Command Line Interface Guidelines (clig.dev) where the tool is silent.

## Steps

1. **Read a sibling command.** Find the entry point and command registry (Commander,
   yargs, Click, Typer, Cobra, clap, picocli, System.CommandLine) and copy an existing
   command's parsing, validation, output and exit handling. Call `search_lore` for the
   CLI's JSON envelope, error format and exit-code table.
2. **Design the surface and write `--help` first.** Match the tool's naming (`ticket
   create`, not `createTicket`). Positional arguments only for the one thing the command
   acts on; everything else is a long flag, with a short alias only where siblings use
   one. Reuse standard names: `-h/--help`, `--version`, `--json`, `-q/--quiet`,
   `-f/--force`, `-n/--dry-run`, `--no-input`, `--no-color`. Help leads with a usage
   line and one or two examples. If the help is hard to write, the surface is wrong.
3. **Validate before doing any work.** Parse and validate every argument, reject
   unknown flags, and fail with a one-line message naming the bad input and the fix.
   Exit codes: `0` success, non-zero on any failure, and the tool's usage-error code
   (commonly `2`) for bad arguments. Never exit 0 after printing an error.
4. **Separate output streams.** stdout carries the result only; errors, warnings,
   progress and logs go to stderr. `--json` prints exactly one JSON document (or the
   tool's documented NDJSON) on stdout and nothing else, including on failure if the
   envelope defines an error shape. Disable colour and spinners when stdout is not a
   TTY, when `NO_COLOR` is set, or with `--no-color`.
5. **Be safe to script.** Prompt only when stdin is a TTY and `--no-input` is absent;
   otherwise fail with the flag that supplies the answer. Destructive or remote-changing
   actions confirm interactively or require `--force`; offer `--dry-run` when siblings
   do. Make re-runs safe (idempotent where possible) and give network calls a timeout.
   On Ctrl-C, stop promptly and exit non-zero (130 by convention).
6. **Keep the command thin.** Parse, call the same service or core the API uses, render.
   Business logic in the handler cannot be reused or unit-tested without a process.
   If the command writes shared files or state that another invocation, the server or
   a worker may write concurrently, follow the `concurrency-and-async` skill (atomic
   temp-and-rename, a real lock).
7. **Handle configuration and secrets.** Read config through the repo's config spine
   (the `add-config-option` skill), never raw env reads, and honour the siblings' `--config`/`--db`
   overrides. Never accept a secret as a flag value (it lands in shell history and `ps`);
   read it from a file, stdin or the configured secret source. Never print secrets.
8. **Test at both levels.** Unit-test the core logic. Spawn the real binary for the
   contract, one test per AC that exercises the AC's own behaviour, and assert:
   - exit code for success, a usage error and an operational failure;
   - `--json` stdout parses as JSON with the documented shape, and stderr carries
     diagnostics without polluting stdout;
   - the error message for bad input; `--help` lists the new command or flag;
   - non-TTY behaviour: no prompt, no colour; a missing answer fails with a message
     naming the flag that supplies it.

   Update the CLI reference or usage block if the repo keeps one.
9. **Evidence** with the `record-evidence` skill: the test run, `--help` output, and a
   sample invocation with its exit code.

## Done when

- The new surface matches sibling naming, parser and envelope; help and docs updated.
- Every failure path exits non-zero; stdout under `--json` is pure JSON.
- Spawned-binary tests cover exit codes, output shape and error text for each AC.

## Anti-patterns

- `console.log` of progress to stdout; mixing a banner into JSON output.
- `process.exit(0)` in a catch block; swallowing an error and printing a warning.
- Interactive prompts that hang in CI; secrets passed as `--token=…`.
- Tests that only call the handler function and never the real binary.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While matching the sibling commands you learn the CLI's envelope, exit-code and flag conventions — the contract scripts already depend on.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
