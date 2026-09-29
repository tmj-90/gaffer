---
name: property-based-test
description: Use when a ticket's correctness is about invariants over many inputs — parsers and serialisers, encoders/decoders, arithmetic and date logic, sorting and merging, state machines, concurrent operations and interleavings — anything with "for all inputs" in its contract, where example tests would miss the edge case; write property-based, model-based or race-condition tests with the repo's framework (fast-check, Hypothesis, proptest, jqwik, QuickCheck). Invoke for "round-trips", "should never crash on any input", "the invariant must hold", "under any interleaving", or after a bug an example test could not have caught.
stack: [node, python, rust, java, kotlin, go, csharp, ruby]
area: testing
---

# Write property-based tests

An example test proves one point in the input space; a property test states a law, lets
the framework hunt for a counterexample, and shrinks it to the smallest failing case. Use
it where the acceptance criterion is a rule ("decode(encode(x)) == x", "output is sorted",
"never loses an acknowledged write"), keep the generators honest, and turn every found
failure into a permanent example.

## Procedure

1. **Use the repo's framework.** fast-check (JS/TS), Hypothesis (Python), proptest or
   quickcheck (Rust), jqwik (Java/Kotlin), `rapid` or `testing/quick` (Go), FsCheck (.NET),
   Rantly/PropCheck (Ruby). Call `search_lore` for conventions. If none is installed, do
   not add one (installs are blocked and `node_modules` is shared): cover the rule with
   table-driven examples over the step 3 edges and name the framework you would add in
   your evidence.
2. **State the property as a law, named after the AC.** Common shapes:
   - round-trip: `parse(print(x)) == x`;
   - invariant: `isSorted(sort(xs))`, totals preserved by a split, ids unique;
   - idempotence: `f(f(x)) == f(x)` (retries, normalisers, upserts);
   - oracle: `fast(x) == simpleReference(x)`, or new == old implementation for a refactor;
   - metamorphic: `search(q)` ⊇ `search(q + " filter")`;
   - robustness: valid input never throws; invalid input throws only the documented error.
   Avoid restating the implementation in the assertion — that tests nothing.
3. **Build honest generators.** Cover the whole valid domain and its edges: empty, single,
   maximum sizes, duplicates, unicode and surrogate pairs, `-0`, `NaN` where allowed, leap
   days, DST transitions, extreme timezones. Build values with combinators (`fc.record`,
   `st.builds`, `map`/`chain`); filter only rare exclusions — heavy filtering starves the
   generator (Hypothesis raises a health-check failure, fast-check stalls).
4. **For stateful systems, test sequences, not single calls (model-based testing).** Define
   commands (create, update, delete, restart, …) that run against both the real system and
   a simple model, asserting they agree after each step: fast-check `fc.commands` +
   `fc.asyncModelRun`, Hypothesis `RuleBasedStateMachine` with `@rule`/`@invariant`,
   proptest-state-machine. Include "restart/reopen" as a command when the AC is about
   persistence — it catches data that only lived in memory.
5. **For async concurrency, explore interleavings.** fast-check's `fc.scheduler()` wraps
   promises so the framework chooses the resolution order and shrinks a failing schedule
   (`s.schedule`, `s.scheduleFunction`, `await s.waitIdle()` from v4.2; `waitAll` on older
   versions); combine with `fc.commands`
   via `fc.scheduledModelRun`. Assert invariants such as "no acknowledged write is lost" and
   "final count equals successful operations". This explores in-process orderings only; a
   criterion about multiple processes, files or crashes still needs the real-process
   schedule in the `add-integration-test` skill.
6. **Keep bodies pure and fast.** No network, no shared state across runs, no randomness
   outside the framework's; reset any store per run. Hundreds of runs must fit the test
   time budget.
7. **Make failures reproducible.** On failure, fast-check prints `seed` and `path` —
   replay with `fc.assert(prop, { seed, path })`; Hypothesis stores failing examples in its
   database and prints `@reproduce_failure`. In CI use a fixed or logged seed (Hypothesis
   `derandomize=True` or a CI settings profile).
8. **Shrink and pin.** Read the shrunk counterexample, fix the bug (the `fix-bug` skill),
   and add it as a permanent example (`@example(...)`, fast-check `examples: [[...]]`, or a
   plain example test) so the regression stays explicit if generators change.
9. **Tune run counts** to the repo's convention: 100 (the default in fast-check and
   Hypothesis) to ~1000 locally, more in a nightly profile if one exists. Set a per-test
   time limit (Hypothesis `deadline`, fast-check `interruptAfterTimeLimit`).
10. **Prove the property bites** by breaking the behaviour temporarily and seeing a shrunk
    counterexample, then restore. Record evidence with the `record-evidence` skill: property
    names, run count, seed, and any counterexamples turned into examples. (An independent
    tester never edits implementation files and skips the break-it step.)

## Done when

- Each rule-shaped AC has a property named after it that failed against a broken version.
- Generators reach the documented edges; no heavy filtering or health-check suppression.
- Every counterexample found is pinned as an example; seeds make CI failures replayable.

## Rules

- The repo's installed framework only (never install one), time-boxed runs.
- Properties complement examples; they do not replace specific regression cases.
- Work on the delivery branch the runner prepared (the `create-branch` skill verifies),
  never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While writing generators you learn the framework in use, the run-count convention and the edge cases this domain must survive.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
