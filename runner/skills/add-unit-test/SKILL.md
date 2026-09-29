---
name: add-unit-test
description: Use when a ticket asks for new unit tests, or when an acceptance criterion requires test coverage for a function/module/component and none exists. Invoke for "add tests for X", "cover the Y edge case", or raising coverage on a specific unit — one test per criterion that fails if that criterion's behaviour breaks.
stack: []
area: testing
---

# Add a unit test

A unit test earns its place when it would **fail if the behaviour the acceptance
criterion names broke** (Kent Beck's "behavioural" and "structure-insensitive" test
desiderata). The recurring defect in live runs was not missing test files but tests that
never exercised the criterion's own behaviour — they called the function and asserted
something incidental, and the reviewer approved.

## Procedure

1. **Find the unit and its existing tests.** Locate the source file and any sibling test.
   Read one or two existing tests to copy the framework, file naming, location and
   assertion style (Vitest/Jest/`node:test`/pytest/JUnit/`go test`). Call `search_lore`
   for the repo's testing conventions. Never add a second framework or runner.
2. **Map every AC to the behaviour that proves it.** For each criterion write one line:
   _input/state → action → observable outcome_. That outcome is what the test asserts.
   An AC that says "rejects duplicate names" is proven by a duplicate being rejected, not
   by the create function returning something.
3. **Enumerate the cases per behaviour:** the happy path, each branch the AC implies,
   boundary values (0, 1, max, max+1, empty, unicode), and each documented error. If the
   AC is a rule over many inputs ("round-trips", "never throws"), add a property test
   (the `property-based-test` skill).
4. **Write the tests.** One behaviour per test, Arrange-Act-Assert, a name that states the
   behaviour (`rejects a duplicate name with 409`). Include the AC id or wording in the
   test or describe name so the reviewer can map test → criterion. Use real collaborators
   when they are fast and deterministic (a "sociable" unit test); substitute only slow,
   non-deterministic or external ones (network, clock, randomness, filesystem when not the
   subject).
5. **Prove each test can fail (the break-it check).** For every AC test, temporarily break
   the behaviour — invert the condition, return early, drop the write — run the test, see
   it fail for the right reason, then undo the edit and confirm `git diff` shows only your
   intended changes. A test that stays green against broken code is deleted or rewritten.
   (This is manual mutation testing; where the repo has Stryker/mutmut/PIT, run it on the
   unit instead. An independent tester never edits implementation files and skips this.)
6. **Run the repo's test command** from the context packet's verification commands, not
   the tool directly. Iterate until green. If a test reveals a real bug, fix it only when
   the ticket scopes it; otherwise note it.
7. **Evidence and stop.** Use the `record-evidence` skill: one `test_output` row per AC
   naming the command, the pass summary and the test(s) that prove that AC. The runner —
   not you — submits for review.

## Done when

- Every AC in scope has at least one named test that exercises its own behaviour.
- Each of those tests failed under the break-it check and passes on the real code.
- The repo's test command passes in this session, and nothing was skipped to get there.

## TypeScript and async specifics

- **Await everything.** `await` the call and assert on the resolved value, or
  `await expect(fn()).rejects.toThrow(...)`. A floating promise lets the test finish
  before the assertion runs.
- **A meaningful assertion** pins the observable outcome: the returned value, a thrown
  error, state read back through the public API, or a call to a genuine collaborator
  _with the expected arguments_. `expect(mock).toHaveBeenCalled()` on a mock you fully
  control tests the mock, not the unit.
- **Fake time and randomness** (`vi.useFakeTimers()`, injected clock, seeded RNG) so
  timing- and random-dependent behaviour is deterministic.

## Anti-patterns a reviewer will send back

- Tests named after the function (`test createUser`) instead of the behaviour.
- Asserting only `toBeDefined()`, `not.toThrow()`, or a snapshot of whatever came back.
- Mocking the unit under test, or asserting private fields and call counts that pin the
  implementation instead of the outcome.
- A concurrency, persistence or failure AC "covered" by a sequential happy-path unit test —
  those need the real schedule (the `add-integration-test` skill).
- Weakening, skipping (`.skip`, `xit`, `@pytest.mark.skip`) or deleting a test to go green.

## Rules

- Match existing conventions; no new framework, runner or assertion library.
- Keep scope to the ticket; do not refactor source unless an AC requires it.
- Work on the delivery branch the runner prepared (the `create-branch` skill); never a
  protected branch.
