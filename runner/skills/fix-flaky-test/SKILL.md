---
name: fix-flaky-test
description: Use when a ticket reports an intermittently failing test — passes sometimes, fails others, or fails in CI but not locally. Invoke for "this test is flaky", "fix the intermittent failure in X", or "the suite is non-deterministic". Fix the root cause, never paper over it with a retry.
stack: []
area: testing
---

# Fix a flaky test

A flaky test fails non-deterministically. The job is to find the source of
non-determinism and remove it — not to retry until it passes.

## Steps

1. **Reproduce the flakiness.** Run the named test repeatedly (a loop, or the runner's
   repeat flag) and, where relevant, in randomised order. Capture a failing run; you can't
   fix what you can't observe.
2. **Locate the non-determinism.** It's almost always one of: timing (sleeps, races,
   unawaited async), test order / shared mutable state (leaked globals, DB rows, singletons),
   unseeded randomness, real clock/timezone, or network/external calls. Read the failure to
   narrow which.
3. **Fix the root cause.** Await async properly and wait on conditions not timeouts;
   isolate state with proper setup/teardown; seed randomness and fake the clock; stub the
   external boundary. Do **not** add a retry, increase a sleep, or mark the test skipped —
   those hide the bug.
4. **Prove stability.** Re-run the test many times (and in random order) and confirm it
   passes every time. Then run the full suite (`run-tests`) to confirm no regression.
5. **Evidence:** the repeated-run command and a clean streak, plus the fix summary. Then
   use the `record-evidence` skill to record `test_output` against the AC and submit for review.

## Rules

- Fix the cause (timing/order/shared state/randomness), never add a retry or longer sleep.
- Never skip or delete the test to make the suite green.
- Demonstrate stability with many repeated passes, not a single run.
- If the flake reveals a real product bug, note it; fix only what the ticket scopes.
- Run on a branch (the `create-branch` skill), never a protected branch.
