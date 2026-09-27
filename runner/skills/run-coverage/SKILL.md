---
name: run-coverage
description: Use when a ticket or acceptance criterion sets a coverage threshold or asks to raise coverage on a unit, and you need to measure it, find the uncovered branches, and evidence the number. Invoke for "coverage must stay above N%", "cover the new module", or "which paths are untested".
stack: []
area: testing
---

# Measure and raise test coverage

Run the repo's coverage command, read the report for the unit the ticket names, add the
tests that cover real behaviour, and evidence the resulting number. Coverage is a
detector for untested behaviour, not a score to game.

## Steps

1. **Find the command.** Use the context packet's `coverage_command`; else detect it
   (`vitest run --coverage`, `jest --coverage`, `pytest --cov`, `go test -cover
   ./...`, `mvn jacoco:report`, `cargo tarpaulin`). Use the project's script so the
   thresholds and excludes match CI.
2. **Baseline first.** Run it before changing anything and note the total and the
   per-file figure for the unit in scope. If the baseline already fails a threshold that
   your ticket does not own, note it and raise a decision rather than fixing the world.
3. **Read the uncovered lines, not the percentage.** Open the report for the files you
   own and list the uncovered branches: error paths, early returns, boundary conditions,
   the `else` nobody hits. Those are the behaviours to test.
4. **Write tests for behaviour.** Each new test asserts an observable outcome (return
   value, thrown error, emitted event, persisted row) of one uncovered branch. Use the
   `add-unit-test` skill for the shape. A test that merely executes a line without
   asserting anything raises the number and proves nothing; do not write it.
5. **Never lower the bar to pass.** Do not add files to the coverage exclude list, lower
   a threshold, or mark code `/* istanbul ignore */` / `# pragma: no cover` to reach
   the target. If a threshold is genuinely wrong for the ticket's scope, raise it via
   `request_decision`.
6. **Re-run and evidence.** Capture the exact command, the total, and the per-file
   figure for the unit in scope, before and after. Record it with the `record-evidence`
   skill (evidence type `coverage_report`) against the AC that sets the threshold.

## Rules

- Measure with the repo's tool and config; do not introduce a second coverage tool.
- Coverage on the ticket's unit is what matters; do not chase the repo-wide total
  unless the AC names it.
- No exclusions, ignores or threshold edits to hit a number.
- Every added test asserts behaviour; delete any that only touches lines.
- Report the true figure from a run in this session.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While reading the uncovered branches you learn a testing convention the repo assumes — a fixtures directory, a mocked boundary, a module deliberately excluded and why.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
