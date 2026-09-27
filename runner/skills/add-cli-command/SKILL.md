---
name: add-cli-command
description: Use when a ticket adds or changes a command-line interface — a new subcommand, flag, or output format for the repo's CLI tool — and it must follow the CLI's existing conventions for arguments, exit codes, JSON output, help text, and tests. Invoke for "add a `foo bar` command", "add a --json flag", "the CLI should print X", or any change under a cli/ or bin/ entry point.
stack: [node, python, go, rust, java, csharp, ruby, bash]
area: backend
---

# Add a CLI command

A CLI is an API whose consumers are humans at a terminal and scripts in a pipeline. Both
need stability: predictable arguments, a documented exit code for each outcome, output
that is either for eyes or for machines (never a mix), and help that tells the truth.

## Steps

1. **Read a sibling command first.** Find the CLI's entry point and command registry
   (Commander, yargs, Click, Cobra, clap, picocli); copy the shape of an existing
   command: how it parses, validates, prints, and exits. Call `search_lore` for the
   CLI's conventions (JSON envelope, error format, actor flags).
2. **Design the surface before the code.** Verb-noun naming consistent with the tool
   (`ticket create`, not `createTicket`), positional arguments only for the one thing
   the command is about, flags for everything else with long names and short aliases
   only where siblings have them. Write the `--help` text first; if it is hard to write,
   the surface is wrong.
3. **Validate inputs at the boundary** and fail with a clear message and a non-zero
   exit before doing any work. Distinguish usage errors (exit 2) from operational
   failures (exit 1) from success (0) if that is the tool's convention; never exit 0 on
   failure.
4. **Separate human and machine output.** Human-readable to stdout by default; a
   `--json` (or the tool's equivalent) that prints exactly one JSON document and
   nothing else on stdout. Diagnostics and progress go to stderr, always. A script must
   be able to `cmd --json | jq` without filtering noise.
5. **Keep the command thin.** It parses, calls the same service or core the API uses,
   and renders the result. Business logic in a CLI handler cannot be reused or tested
   without spawning a process.
6. **Handle the environment honestly.** Read config through the repo's config spine
   (the `add-config-option` skill), never raw env reads; respect `--db`/`--config`
   style overrides the siblings offer; never print secrets.
7. **Test at both levels.** Unit-test the handler's logic; spawn the real binary in a
   test for the contract: exit codes, `--json` shape, error messages, `--help` output.
   Update the CLI reference docs or usage block if the repo keeps one.
8. **Evidence** with the `record-evidence` skill: the `--help` output, the test run,
   and a sample invocation with its exit code.

## Rules

- Match the sibling commands' parser, naming, and envelope exactly.
- Non-zero exit on any failure; usage errors distinguished when the tool does.
- stdout is the result; stderr is everything else; `--json` is pure JSON.
- Thin handler over the shared core; no business logic in the command.
- Help text and docs updated in the same change.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While matching the sibling commands you learn the CLI's envelope, exit-code and flag conventions — the contract scripts already depend on.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
