---
name: test-quality-review
description: Use as a REVIEW LENS when judging whether another agent's tests actually prove the acceptance criteria — tests that assert nothing, mirror the implementation, mock the thing under test, depend on order or time, or were weakened to pass — before recommending approval. Invoke on every review; the delivered tests are the evidence the verdict rests on, and weak tests make every other check meaningless.
stack: []
area: review
---

# Test quality review lens

"Tests pass" is only meaningful if the tests could have failed. The reviewer reads each
new or changed test and asks: what behaviour would break it, and is that the behaviour
the acceptance criterion names? A green suite of tests that cannot fail is the most
dangerous state a repo can be in, because everyone stops looking.

## Steps

1. **Map ACs to tests.** For each acceptance criterion, find the test(s) that would fail
   if it were not met. An AC with no such test is unevidenced, whatever the evidence
   summary says. Call `search_lore` for the repo's testing conventions.
2. **Read each new or changed test for falsifiability.** Would it fail if the feature
   were deleted? If the assertion is `expect(result).toBeDefined()`, `assert True`, a
   snapshot nobody reviewed, or a mock returning the value that is then asserted, the
   answer is no.
3. **Check what is real and what is faked.** The unit under test is real; its
   collaborators may be faked at a boundary the test declares. A test that mocks the
   function it claims to test, or mocks so much that only the mock is exercised, proves
   nothing.
4. **Check for weakening.** Compare the diff: tests deleted, skipped (`it.skip`,
   `@pytest.mark.skip`, `t.Skip`), loosened (an exact assertion made approximate, a
   thrown error now swallowed), retried, or thresholds lowered — each is a finding unless
   the ticket explicitly asked for it and the reason is stated.
5. **Check determinism.** No dependence on wall-clock time, timezone, locale, test
   order, network, or shared mutable fixtures; fixed sleeps are a flake in waiting (the
   `fix-flaky-test` skill); randomness is seeded.
6. **Check the level.** Behaviour tested at the lowest level that exposes it; a UI test
   for a pure function or a unit test that re-implements the function's logic in the
   assertion are both wrong levels.
7. **Rate each finding.** Blocking: an AC with no falsifiable test; a test that mocks
   the unit under test; a test weakened or skipped without a stated reason; a test that
   cannot fail. Should-fix: non-determinism, wrong level, missing negative case for an
   error-handling AC. Note: style. Only blocking and should-fix justify
   `RECOMMEND CHANGES`.
8. **Record the findings as evidence** with `record_ac_evidence` (`manual_note` per
   finding naming the AC and the test), then let the `review-ticket` verdict carry the
   result.

## Checklist

- Every AC has at least one test that fails when the AC is unmet.
- Assertions are specific (values, shapes, errors), not existence or truthiness.
- The unit under test is real; fakes sit at declared boundaries only.
- No deleted, skipped, loosened, or retried tests without an explicit, justified reason
  in the ticket.
- Negative cases exist for every error path the ACs name.
- No time, order, locale, network, or shared-state dependence; no fixed sleeps;
  seeded randomness.
- Snapshots are small and clearly reviewed; no page-sized snapshots as "tests".
- Test names describe behaviour; a reader can tell what broke from the name.
- The test command that produced the evidence is the repo's, and its output shows the
  new tests ran.

## Rules

- Evidence rests on falsifiable tests; an unfalsifiable test is no evidence.
- Weakening a test to pass is a defect, not a delivery.
- You review; you do not patch. Findings go into evidence, the verdict goes through
  `review-ticket`.
