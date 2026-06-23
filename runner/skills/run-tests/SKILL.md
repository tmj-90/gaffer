---
name: run-tests
description: Use when a ticket or acceptance criterion needs the test suite run and its result evidenced, or after making a change to confirm nothing broke. Invoke for "tests must pass", "verify the suite is green", or before submitting any code change for review.
stack: []
area: testing
---

# Run the test suite

Run the repo's existing test command, report the real result, and evidence it. Do
not introduce a new runner — use what the project already uses.

## Steps

1. **Find the test command** from the context packet's verification commands
   (e.g. `pnpm test`, `npm test`, `pytest`, `go test ./...`, `mvn test`). If the
   packet is silent, detect it from the manifest (`package.json` scripts, `pyproject.toml`,
   `go.mod`, `pom.xml`). Use the project script, not the underlying tool directly.
2. **Run the full suite** (or the scoped subset the ticket names). Capture the exact
   command and the pass/fail summary, including counts (passed/failed/skipped).
3. **If tests fail**, read the failures. Fix only what the ticket scopes; if a failure
   is unrelated and pre-existing, note it — do not paper over it or delete the test.
4. **Re-run until green** (or until you confirm a failure is out of scope and blocking).
5. **Evidence:** the exact command and its passing summary. Then use the
   `record-evidence` skill to record `test_output` against the AC and submit for review.

## Rules

- Report the true result — never claim "tests pass" without a run in this session.
- Don't skip or delete failing tests to go green; fix the cause or mark blocked.
- Don't add a new test framework; match the repo's runner.
- Run on a branch (the `create-branch` skill), never a protected branch.
