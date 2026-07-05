---
name: add-unit-test
description: Use when a ticket asks for new unit tests, or when an acceptance criterion requires test coverage for a function/module/component and none exists. Invoke for "add tests for X", "cover the Y edge case", or raising coverage on a specific unit.
stack: []
area: testing
---

# Add a unit test

Add focused, behaviour-asserting unit tests for the unit named in the ticket —
matching the repo's existing test framework and conventions, not introducing a new one.

## Steps

1. **Find the unit + its existing tests.** Locate the source file and any sibling
   test file. Read 1–2 existing tests in the repo to copy the framework, naming,
   and assertion style (Vitest/Jest/pytest/JUnit — use what's already there).
2. **Enumerate behaviours to cover** from the ticket/AC: the happy path, each
   meaningful branch, boundary values, and the error/throws cases. Prefer behaviour
   ("returns empty array when no match") over implementation detail.
3. **Write tests** in the repo's test location and naming convention, one assertion
   focus per test, Arrange-Act-Assert. No test without a real assertion; no
   over-broad mocks that assert nothing.
4. **Run the test command** (use the repo's `test` script — see the context packet's
   verification commands). Iterate until green. If a test reveals a real bug, note
   it; fix only what the ticket scopes.
5. **Evidence:** the test command + its passing summary, and the new test file
   paths. Then use the `record-evidence` skill to record `test_output` against the
   AC and submit for review.

## TypeScript specifics

- **Async functions:** `await` the call and assert on the resolved value, or use
  `await expect(fn()).rejects.toThrow(...)` for the failure path — never leave a
  floating promise, or the test passes before the assertion runs.
- **A meaningful assertion** pins the observable outcome: the returned value, a thrown
  error, or a call made to a genuine collaborator with the expected arguments. Asserting
  that a mock you fully control was called (`expect(mock).toHaveBeenCalled()` with no
  argument or outcome check) tests the mock, not the unit — prefer a real return/throw
  assertion over an empty mock check.
- **Fake time and randomness** (`vi.useFakeTimers()` / seeded RNG) so timing- or
  random-dependent behaviour is deterministic rather than flaky.

## Rules

- Match existing conventions; do not add a new test framework or runner.
- Tests must assert behaviour and fail if the behaviour breaks.
- Keep scope to the ticket — don't refactor source unless the AC requires it.
- Run on a branch (the `create-branch` skill); never on a protected branch.
