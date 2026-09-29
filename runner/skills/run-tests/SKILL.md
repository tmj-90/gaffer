---
name: run-tests
description: Use when a ticket or acceptance criterion needs the test suite run and its result evidenced, or after making a change to confirm nothing broke. Invoke for "tests must pass", "verify the suite is green", or before handing any code change to review — and to check that each acceptance criterion has a test that exercises it.
stack: []
area: testing
---

# Run the test suite

Run the repo's own test command, report the real result, and evidence it per acceptance
criterion. "Green" only counts if the suite actually ran the tests that prove each
criterion: in live runs the weakest dimension across ~30 tickets was test adequacy —
suites passed while an AC had no test, or only a test that never exercised its behaviour.

**Independent tester?** Follow the `black-box-test` skill instead where they differ: you
never fix implementation code, you run the command once (and once more after fixing your
own test), and you record `manual_note` rows, not `test_output`. You run no git beyond the
final add + commit (so no `git diff` in step 4), and you hold no claim, so step 5's
`mark_ticket_blocked` is refused — a failure you cannot attribute is a FAIL finding.

## Procedure

1. **Find the command.** Use the context packet's verification commands (`pnpm test`,
   `npm test`, `pytest`, `go test ./...`, `mvn test`, `cargo test`). If the packet is
   silent, read the manifest (`package.json` scripts, `pyproject.toml`/`tox.ini`,
   `Makefile`, `go.mod`, `pom.xml`, `Cargo.toml`). Use the project script, not the
   underlying tool, so config, setup files and globs match CI. Note any separate
   integration or e2e command the ticket's ACs depend on.
2. **Map ACs to tests before running.** Call `get_ticket` if you do not have the ACs. For
   each AC, name the test(s) that would fail if it were not met. An AC with no such test
   is a gap to fill now (the `add-unit-test` or `add-integration-test` skill); an AC about
   persistence, concurrency or failure needs a test running that real schedule, not a
   happy-path call.
3. **Run the full suite** (or the scoped subset the ticket names, followed by the full
   suite before you finish). Capture the exact command and the summary counts: passed,
   failed, skipped, and the number of test files. Confirm your new tests appear in the
   output — a file outside the runner's glob, a wrong suffix, or a `describe.only`/`it.only`
   elsewhere means they silently did not run.
4. **Read failures before touching anything.** Reproduce a single failure in isolation
   (`vitest run <file> -t "<name>"`, `pytest path::test -x`, `go test -run '^TestX$'`).
   Decide: your change broke it → fix the code, not the test's expectation, unless the AC
   changed that expectation; pre-existing and unrelated → show that neither the test nor
   the code it exercises is in your diff (`git diff --stat <base>...HEAD`) and that it
   fails the same way in the runner's recorded gate evidence or lore, then note it;
   intermittent → the `fix-flaky-test` skill.
5. **Re-run until green**, or until you have shown a failure is out of scope and blocking
   (then `mark_ticket_blocked` with the evidence rather than faking a pass — refused when
   you hold no claim: on a resumed delivery raise `request_decision` with severity
   `human_required`; as the merge resolver, abort and say why in your final message).
6. **Check the skip count.** Skipped or todo tests in files you touched must be justified
   by the ticket; new `.skip`, `xit`, `@pytest.mark.skip`, `t.Skip` added to go green are a
   defect.
7. **Evidence and stop.** Use the `record-evidence` skill: per AC, a `test_output` row with
   the command, the pass summary and the test name(s) that prove that AC. The runner runs
   the gates and submits for review; you do not.

## Done when

- The repo's test command passed in this session, with counts captured.
- Every AC maps to at least one named test that ran and exercises that AC's behaviour.
- No test was skipped, deleted or weakened to get there; any unrelated pre-existing
  failure is shown to be outside your diff and reported.

## Rules

- Report the true result — never claim "tests pass" without a run in this session.
- Don't skip or delete failing tests to go green; fix the cause or mark blocked.
- Don't add a new test framework or runner; match the repo's.
- Work on the delivery branch the runner prepared (the `create-branch` skill); never a
  protected branch.
