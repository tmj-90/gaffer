---
name: run-coverage
description: Use when a ticket or acceptance criterion sets a coverage threshold or asks to raise coverage on a unit, and you need to measure and evidence it. Invoke for "coverage must stay above N%", "report the coverage delta", or "prove the new code is covered".
stack: []
area: testing
---

# Measure coverage

Run the repo's coverage tool, read the real number, and evidence the result or delta.
Do not chase a number with hollow tests.

## Steps

1. **Find the coverage command** from the context packet (e.g. `pnpm test --coverage`,
   `pytest --cov`, `go test -cover ./...`, `mvn jacoco:report`). If silent, detect the
   configured tool from the manifest.
2. **Run it** and capture the exact command plus the overall percentage and, where the
   ticket names a unit, that file's/module's coverage.
3. **Compare against the threshold** in the ticket/AC. If it falls short, add or extend
   tests for the genuinely uncovered branches (use the `add-unit-test` skill) — cover
   real behaviour, not lines for their own sake.
4. **Re-run** to capture the new figure. Note the before→after delta if the ticket asks
   for an improvement.
5. **Evidence:** the command, the percentage (and delta). Then use the `record-evidence`
   skill to record `coverage_report` against the AC and submit for review.

## Rules

- Report the true figure from a run in this session — never estimate coverage.
- Don't write assertion-free tests just to lift the number.
- Match the repo's coverage tooling and existing thresholds.
- Run on a branch (the `create-branch` skill), never a protected branch.
