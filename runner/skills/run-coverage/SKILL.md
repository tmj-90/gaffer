---
name: run-coverage
description: Use when a ticket or acceptance criterion sets a coverage threshold or asks to raise coverage on a unit, and you need to measure it, find the uncovered branches, and evidence the number. Invoke for "coverage must stay above N%", "cover the new module", "which paths are untested", or a mutation-score check on changed code.
stack: []
area: testing
---

# Measure and raise test coverage

Coverage tells you what the tests did **not** execute; it cannot tell you that what they
executed was checked. A line can be 100% covered by a test with no assertion. Google's
coverage guidance treats it as a signal for finding untested code — reviewed per change,
not chased as a repo-wide score — and Google's diff-based mutation testing exists because
covered-but-unasserted code is common. Measure with the repo's tool, read the uncovered
branches, test the behaviour behind them, and evidence the true number.

## Procedure

1. **Find the command.** Use the context packet's `coverage_command`; else the project
   script (`test:coverage`, `coverage`) or the tool it wraps: `vitest run --coverage`,
   `jest --coverage`, `pytest --cov=<pkg> --cov-branch --cov-report=term-missing`,
   `go test -coverprofile=cover.out ./... && go tool cover -func=cover.out`,
   `mvn verify` (JaCoCo), `cargo llvm-cov`/`cargo tarpaulin`, `dotnet test --collect:"XPlat Code Coverage"`.
   Use the project script so thresholds and excludes match CI.
2. **Baseline first.** Run it before changing anything. Note the total, the per-file line
   and **branch** figures for the files in scope, and whether a threshold already fails. If
   it fails on code your ticket does not own, note it and raise `request_decision` instead
   of fixing the world.
3. **Read the uncovered branches, not the percentage.** Open the report (`term-missing`,
   `coverage/index.html`, `lcov.info`) for the files you changed or own and list each
   uncovered branch: error paths, early returns, boundary conditions, the `else` nobody
   hits, the catch block for a failed write. Those are behaviours awaiting a test.
4. **Tie each gap to an acceptance criterion or a documented behaviour.** Test the
   behaviour behind the line through the unit's public interface (the `add-unit-test`
   skill; the `add-integration-test` skill for failure paths that need a real file,
   process or database). Error and recovery branches for persistence and concurrency are
   exactly where live-run defects hid — cover them with a real injected fault, not a mock
   that throws on cue.
5. **Check the tests would catch a regression.** For the changed code, run the repo's
   mutation tool if it has one (StrykerJS `npx --no -- stryker run --mutate <files>`, `mutmut run`,
   PIT `mvn pitest:mutationCoverage`, `cargo mutants`) scoped to the files in scope, and
   treat surviving mutants on AC-relevant lines as missing assertions. Without a tool, do
   the break-it check by hand: invert a condition in a covered branch, see a test fail,
   restore, confirm with `git diff`. (An independent tester never edits implementation
   files or runs `git diff`; it skips this step.)
6. **Never lower the bar to pass.** Do not add files to the exclude list, lower a
   threshold, or add `/* istanbul ignore */`, `/* c8 ignore */` or `# pragma: no cover` to reach a number. If a threshold is genuinely wrong for the
   ticket's scope, raise it via `request_decision`.
7. **Re-run and evidence.** Record the exact command, the total, and the per-file line and
   branch figures for the files in scope, before and after — plus the mutation score if
   you ran one. Use the `record-evidence` skill (`coverage_report`) against the AC that sets
   the threshold; the runner submits for review.

## Done when

- The coverage AC's threshold is met on a run in this session, measured by the repo's
  configured tool.
- Every newly covered branch is covered by a test that asserts its outcome and fails when
  that branch's behaviour is broken.
- No excludes, ignores or threshold edits were added.

## Anti-patterns

- Tests that call code and assert nothing (or only `toBeDefined()`) to lift the number.
- Chasing the repo-wide total when the AC names a unit; chasing 100% on trivial getters.
- Snapshotting large outputs to cover render paths.
- Reporting a number from memory or a previous session.

## Rules

- Measure with the repo's tool and config; no second coverage tool.
- Coverage on the ticket's code is what matters unless the AC names the total.
- Delete any added test that only touches lines.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While reading the uncovered branches you learn a testing convention the repo assumes — a fixtures directory, a mocked boundary, a module deliberately excluded and why.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
