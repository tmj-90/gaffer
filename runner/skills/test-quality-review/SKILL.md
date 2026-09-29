---
name: test-quality-review
description: Use as a REVIEW LENS when judging whether another agent's tests actually prove the acceptance criteria — an AC with no test, tests that assert nothing or only on mocks, mirror the implementation, mock the thing under test, never reach the concurrency or failure path the AC names, depend on order or time, or were weakened to pass — before recommending approval. Invoke on every review; the delivered tests are the evidence the verdict rests on, and weak tests make every other check meaningless.
stack: []
area: review
---

# Test quality review lens

"Tests pass" means something only if the tests could have failed. For each new or
changed test ask: which behaviour breaks it, and is that the behaviour the acceptance
criterion names? Live runs showed the common miss: tests existed, the suite was green,
and the AC's own behaviour (concurrent writers, a paused lock holder) was never run — or
one AC had no test at all and the ticket was approved anyway.

The bar is **one falsifiable test per AC that exercises that AC's own behaviour** —
not more coverage, not a preferred style. Do not raise it.

## Steps

1. **Build the AC → test map.** For each AC write one line:
   `AC <id> → <test file>::<test name> — asserts <observable outcome>`. Find tests by
   grepping the diff's test files for the AC's nouns, endpoints, error codes and
   function names. An AC with no line is **MISSING**, whatever the evidence summary
   claims. An AC that is purely documentation or configuration text is evidenced by the
   diff itself — write `AC <id> → diff: <file>` instead. Call `search_lore` for the
   repo's testing conventions.
2. **Check each mapped test exercises the AC's own behaviour.** Read the test body, not
   its name. It must drive the code path the AC describes and assert the outcome the AC
   promises. Mark it **INDIRECT** (no evidence) when:
   - it asserts nothing: no assertion; assertions only inside a callback, loop or
     branch that never runs; an async assertion not awaited or returned (the test ends
     first); a `try/catch` that swallows the assertion error; `expect(x).toBeDefined()`,
     `assert True`, "no exception thrown" as the only check for an AC about a value; a
     large snapshot generated from the current output with no AC-specific assertion;
   - it asserts only on mocks: the sole checks are `toHaveBeenCalled`/`assert_called`
     on a fake, or the mock returns the value that is then asserted — the real result
     the AC names is never observed;
   - it mocks the unit under test, or fakes the very component whose behaviour the AC
     names (the filesystem mocked for an "atomic write" AC, the clock frozen for a
     "lease expiry" AC without advancing it, the lock stubbed for a locking AC);
   - it never reaches the path the AC names: a concurrency AC tested with one sequential
     caller; a "cross-process" AC tested with threads or `Promise.all` in one process
     against a process-local mutex; a crash/pause/restart AC with no kill, pause or
     restart; an error-handling AC tested only on the happy path; a retry AC where the
     dependency never fails;
   - it re-implements the production logic in the expected value, so a shared bug
     passes both.
3. **Apply the mutation test in your head.** Pick the line that implements the AC
   (the lock, the conditional, the status code, the rename) and imagine deleting it or
   flipping it. Would a mapped test fail? If not, that AC is not evidenced. Also ask:
   would this test have passed on the base branch? A test that passes without the
   change proves nothing about the change. Do not edit the code to check — reason it.
4. **Check the test actually ran.** The recorded test output (or one run of the repo's
   test command) shows the new test names or a count that includes them; the file
   matches the runner's test pattern; no `.only`/`fit`/`-k` filter excludes it.
5. **Check for weakening.** Tests deleted, skipped (`it.skip`, `xit`,
   `@pytest.mark.skip`, `t.Skip`, `@Disabled`), loosened (exact → approximate, an error
   now swallowed), retried, given longer timeouts to mask a race, or thresholds lowered —
   each is a finding unless the ticket asked for it with a stated reason.
6. **Check determinism of the tests that carry an AC.** No dependence on wall-clock
   time, timezone, locale, order, network or shared mutable fixtures; no fixed sleeps as
   synchronisation (use barriers, injected hooks or polling with a deadline — the
   `fix-flaky-test` skill); seeded randomness. A concurrency test that loops enough
   times to expose the race, or forces the interleaving deterministically, is fine.
7. **Rate each finding.** Blocking: an AC that is MISSING or only INDIRECTLY tested; a
   test that cannot fail; a weakened or skipped test without a stated reason. Should-fix:
   a missing negative case when the AC names an error (that is the AC's own behaviour);
   non-determinism that actually made an AC's test fail or flake in the recorded runs.
   Note: other non-determinism risks, naming, structure, extra coverage beyond the ACs,
   wrong-level tests that still prove the AC. Only blocking and should-fix justify
   `RECOMMEND CHANGES`.
8. **Hand the map to `review-ticket`.** Each AC's map line and PASS / MISSING /
   INDIRECT classification go into that AC's single `record_ac_evidence` row (its
   step 8) — do not record a second row per AC. Record a separate `manual_note` only for
   a weakening or determinism finding, naming the test and the fix.

## Checklist

- Every AC has a map line naming a file and a test (or `diff:` for a text-only AC).
- Each mapped test drives the AC's own path and asserts the AC's observable outcome.
- Deleting or flipping the implementing line would fail at least one mapped test.
- Assertions check values, shapes, states or errors — not existence, truthiness or
  only that a mock was called.
- Fakes sit at declared boundaries, never on the unit or component the AC is about.
- Concurrency, crash, pause, retry and failure ACs are exercised by tests that create
  that condition and assert the invariant.
- Nothing deleted, skipped, loosened or retried without a stated reason in the ticket.
- The new tests appear in the run that produced the evidence.

## Rules

- An unfalsifiable test is no evidence; a MISSING or INDIRECT AC blocks approval.
- The bar is one real test per AC; never demand coverage the ACs do not name.
- Weakening a test to pass is a defect, not a delivery.
- You review; you do not patch or add tests. Findings go into evidence, the verdict goes
  through `review-ticket`.
