---
name: fix-flaky-test
description: Use when a ticket reports an intermittently failing test — passes sometimes, fails others, or fails in CI but not locally. Invoke for "this test is flaky", "fix the intermittent failure in X", or "the suite is non-deterministic". Fix the root cause — in the test or in the product — never paper over it with a retry.
stack: []
area: testing
---

# Fix a flaky test

A flaky test passes and fails on the same code. Google measured ~1.5% of all test runs
flaky and ~16% of tests flaky at least occasionally; the cost is that people stop
believing red builds. The job is to find the source of non-determinism and remove it.
**First decide whether the flake is in the test or in the product**: a test that fails
one run in fifty under parallel writes may be the only thing reporting a real race — the
same class of lost-update and lock defect that shipped past review in live runs.
"Fixing" that by serialising the test hides a production bug.

## Procedure

1. **Reproduce and measure.** Run the single test in a loop until it fails, and record the
   failure rate:
   - Vitest/Jest: `for i in {1..50}; do npx --no -- vitest run <file> -t "<name>" || break; done`
     (Jest: `--runInBand` vs default to compare parallelism); Playwright:
     `npx --no -- playwright test <spec> --repeat-each=50 --retries=0`.
   - pytest: `pytest <path>::<test> --count=50` (pytest-repeat) or a shell loop; random
     order via pytest-randomly and `-n auto` via xdist — only if the repo already has
     them; never install plugins.
   - Go: `go test -run '^TestName$' -count=200 -race ./pkg/...`; JUnit: repeat via the
     runner or a `@RepeatedTest`.
   Also try the conditions CI has: full suite (not just the file), random order, parallel
   workers, `CI=1`, a different `TZ`/locale, a loaded machine (`stress`/`taskset`). Keep the
   failing output — you cannot fix what you have not observed.
2. **Classify the cause** from the failure (Fowler's "Eradicating Non-Determinism in
   Tests" and Google's flaky-test analyses list the same families):
   - _Async timing:_ unawaited promise, fixed `sleep`, assertion before the event, a timeout
     too tight for CI.
   - _Order / shared state:_ leaked globals, singletons, DB rows, files, env vars, module
     caches, a port reused between tests. Passes alone, fails in the suite (or vice versa).
   - _Concurrency in the product:_ unsynchronised read-modify-write, temp-file name
     collisions, check-then-act on files or rows, lock or lease expiry. Fails more under
     parallelism or load.
   - _Time and environment:_ real clock, midnight/DST/month-end, timezone, locale, float
     formatting, hash/map iteration order.
   - _Randomness:_ unseeded generators, random data hitting a rare edge.
   - _External:_ real network, third-party service, container start-up races, resource
     leaks (open handles, file descriptors) that accumulate.
3. **Fix the root cause where it lives.**
   - Test timing → await properly; wait for a condition (poll with a deadline, web-first
     assertions), never a longer sleep.
   - Order/state → fresh state per test, teardown that runs on failure, unique temp dirs
     and ports (the `test-fixtures-and-factories` skill).
   - Time/randomness → inject or fake the clock, pin `TZ`, seed the RNG and log the seed.
   - External → stub at the boundary, or make the dependency hermetic (a container started
     and awaited by the test).
   - Product race → fix the code (the `concurrency-and-async` skill), and keep or add a
     deterministic test that reproduces the interleaving (a barrier, controlled scheduler
     such as fast-check `scheduler`, or N parallel real processes). If the ticket does not
     scope a product fix, record the finding and raise `request_decision` rather than
     quietly stabilising the test.
4. **Prove it.** Re-run the same loop that reproduced it — at least 10× the runs it took to
   fail, with the same parallelism and order randomisation — with zero failures. Then run
   the full suite with the repo's command (the `run-tests` skill).
5. **Evidence and stop.** Use the `record-evidence` skill: the reproduction command and
   failure rate before, the root cause in one sentence, the fix, and the clean streak
   after (`test_output`). The runner submits for review, not you.

## Done when

- You observed the failure, named its cause, and the fix addresses that cause.
- The reproduction loop is clean at ≥10× the original failure interval.
- The full suite passes, and no retry, skip, quarantine or longer timeout was added.

## Rules

- Never add a retry, raise a sleep or timeout to mask the failure, mark the test skipped,
  or delete it. Quarantine is a human decision (`request_decision`), not a fix.
- Never weaken the assertion or serialise a test that is exposing a real race.
- If the flake reveals a product bug outside the ticket's scope, report it; do not
  silently widen scope.
- Work on the delivery branch the runner prepared (the `create-branch` skill); never a
  protected branch.
