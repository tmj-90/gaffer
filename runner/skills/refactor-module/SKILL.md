---
name: refactor-module
description: Use when a ticket asks to restructure code without changing what it does — extract a function, split a file, rename for clarity, reduce duplication — with behaviour preserved. Invoke for "refactor X", "clean up the Y module", or "extract Z" where no behaviour change is intended.
stack: []
area: refactor
---

# Refactor a module

A refactoring changes structure, not observable behaviour (Fowler). The discipline that
makes it safe is small steps with the tests green between every one of them. You wear
one hat at a time: while refactoring you add no feature and fix no bug.

## Steps

1. **Establish the safety net.** Run the suite (the `run-tests` skill) and confirm it is
   green BEFORE touching anything; record the command and summary. If the code you will
   move is thinly tested, first add characterization tests (the `add-unit-test` skill)
   that pin what it does today — including odd behaviour — through the public interface,
   not its private internals (tests coupled to internals break on every legitimate
   refactoring). Commit them separately.
2. **Read the lore.** Call `search_lore` for module boundaries, layering and naming
   conventions so the new structure fits the codebase instead of inventing a new one.
3. **Name the target and list the moves.** Write the end state in one or two sentences
   and the sequence of named refactorings that gets there: Extract Function, Inline
   Variable, Move Function, Rename, Split Phase, Replace Conditional with Polymorphism,
   Introduce Parameter Object. Each move is small enough to finish and test in minutes.
4. **Execute one move at a time.** After each move: run the fastest relevant tests (and
   typecheck if the language has one). Green → commit (`git commit -m "refactor: …"`) so
   there is a known-good point to return to. Red → undo that move
   (`git restore --staged --worktree <paths>`, and `rm` any file the move created —
   `git clean -fd` is hook-blocked) and take a smaller step. Never debug your way
   forward through a red refactoring.
5. **When a move fails because something else must change first, use the Mikado
   method.** Note the goal, try the change naively, and when it breaks, write down the
   prerequisites it revealed, then revert. Work the prerequisites leaf-first, each as its
   own green commit, then retry the goal. Keep the list in your working notes; it doubles
   as your scope check.
6. **Preserve the public interface** unless the ticket explicitly allows changing it. If
   it does, update every call site in the same change (`grep` the symbol, including
   string and dynamic references) and note the change in the evidence.
7. **Confirm equivalence.** Run the full suite, lint and build once at the end (the
   `run-tests` and `run-lint` skills). Compare the test counts with step 1: the same tests,
   plus any characterization tests you added, must pass. A test you had to edit is a
   behaviour change unless the edit only follows a rename or a move.
8. **Evidence** via the `record-evidence` skill: before and after test summaries, a
   `diff_summary` listing the moves, and any interface change (on a resume that call is
   refused: do not retry; put this, the AC → test map and the smallest-change note in
   your final message). Then the runner takes over.

## Done when

The end state from step 3 is reached, every step was green, the before/after test runs
match, and the diff contains no behaviour change: no new feature, fix, dependency, or
altered output.

## Stop and escalate when

- The Mikado prerequisites grow past what the ticket describes (for example, the change
  now touches modules or public APIs the ticket never named): stop at the last green
  commit and `request_decision` with the prerequisite list and a proposed split.
- You find a real bug. Do not fix it here — it would make "no behaviour change"
  unverifiable. Note it as a finding in the evidence for a separate ticket.
- The code cannot be put under test without changing behaviour: `request_decision`.

## Rules

- Behaviour-preserving only: green before, green after every step, same outcomes.
- No scope creep: no features, fixes, formatting sweeps or dependency bumps in a
  refactor ticket.
- Public interface stable unless the ticket says otherwise.
- The safety hook blocks `git reset --hard`; undo with `git restore` or `git revert`.
- Work on the delivery branch (the `create-branch` skill verifies); commit, never push.
