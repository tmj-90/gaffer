---
name: property-based-test
description: Use when a ticket's correctness is about invariants over many inputs — parsers and serialisers, encoders/decoders, arithmetic and date logic, sorting and merging, state machines, anything with "for all inputs" in its contract — and example tests would miss the edge case; write property-based tests with the repo's framework (fast-check, Hypothesis, proptest, jqwik, QuickCheck). Invoke for "round-trips", "should never crash on any input", "the invariant must hold", or after a bug that an example test could not have caught.
stack: [node, python, rust, java, kotlin, go, csharp, ruby]
area: testing
---

# Write property-based tests

An example test proves one point in the input space; a property test states a law and
lets the framework hunt for the counterexample, then shrinks it to the smallest failing
case. Use it where the contract is a rule ("decode(encode(x)) == x", "output is
sorted", "never throws"), keep the generators honest, and turn every found failure into
a permanent example.

## Steps

1. **Use the repo's property framework.** fast-check (JS/TS), Hypothesis (Python),
   proptest/quickcheck (Rust), jqwik (Java/Kotlin), rapid or gopter (Go), FsCheck (.NET),
   Rantly (Ruby). Call `search_lore` for conventions; do not add a second framework if
   one exists. If none exists, propose the standard one for the language via the
   evidence and keep the dependency dev-only.
2. **State the property as a law.** Common shapes: round-trip
   (`parse(print(x)) == x`), invariant (`isSorted(sort(xs))`, `sum` preserved by a
   partition), idempotence (`f(f(x)) == f(x)`), commutativity or equivalence with a
   simple reference implementation (`fast(x) == slow(x)`), no-crash (`f(x)` never throws
   for valid inputs; throws the documented error for invalid ones). Write the law in the
   test name.
3. **Build honest generators.** Generate the full valid domain, including the edges:
   empty, single element, maximum sizes, unicode and surrogate pairs, negative zero,
   NaN where allowed, leap days, DST boundaries, timezone extremes. Use the framework's
   combinators; constrain with filters only when the constraint is rare (heavy filtering
   starves the generator; build the value directly instead).
4. **Keep the property pure and fast.** No I/O, no shared state, no randomness outside
   the framework's; each run tests hundreds of cases, so the body must be cheap. Fix the
   seed in CI (or record it) so a failure is reproducible.
5. **Shrink and pin.** When the framework finds a counterexample, read the shrunk case,
   fix the bug (the `fix-bug` skill), and add the shrunk input as a permanent example
   test next to the property so the regression is explicit even if the generator changes.
6. **Tune the run count** to the repo's convention: enough cases to explore (100–1000
   locally), and a documented larger nightly run if the repo has one. Time-box the test.
7. **Evidence** with the `record-evidence` skill: the property names, the run count and
   seed, and any shrunk counterexamples you turned into examples.

## Rules

- Properties are laws stated in the test name; examples remain for specific cases.
- Generators cover the whole valid domain including edges; filters are rare.
- Pure, fast bodies; seeds recorded; runs reproducible.
- Every counterexample becomes a permanent example test after the fix.
- The repo's framework only, dev-only dependency, time-boxed runs.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While writing generators you learn the framework in use, the run-count convention and the edge cases this domain must survive.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
