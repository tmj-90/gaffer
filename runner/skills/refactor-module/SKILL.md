---
name: refactor-module
description: Use when a ticket asks to restructure code without changing what it does — extract a function, split a file, rename for clarity, reduce duplication — with behaviour preserved. Invoke for "refactor X", "clean up the Y module", or "extract Z" where no behaviour change is intended.
stack: []
area: refactor
---

# Refactor a module

A refactor changes structure, not behaviour. The contract: tests are green before you
start and green after, with no scope creep into new features or fixes.

## Steps

1. **Establish the safety net.** Run the suite first (`run-tests`) and confirm it's green.
   If the module under refactor is thinly tested, add characterization tests (the
   `add-unit-test` skill) that pin the current behaviour before you touch anything.
2. **Read the lore.** Call `search_lore` (Memory MCP) for the repo's module
   boundaries, layering, and naming conventions so the new structure fits the codebase.
3. **Refactor in small, behaviour-preserving steps** — extract, rename, move, dedupe —
   re-running tests after each step. Keep the public interface stable unless the ticket
   explicitly allows changing it; update call sites if you do.
4. **Change no behaviour.** No new features, no bug fixes, no dependency changes riding
   along. If you spot a real bug, note it for a separate ticket — don't fix it here.
5. **Confirm green after.** Run the full suite and lint (`run-tests`, `run-lint`) and
   confirm identical behaviour and no new failures.
6. **Evidence:** before/after passing summaries (proving behaviour preserved) and a
   `diff_summary`. Then use the `record-evidence` skill and submit for review.

## Rules

- Behaviour-preserving only: tests green before and after, same outcomes.
- No scope creep — no features, fixes, or dependency bumps in a refactor ticket.
- Keep the public interface stable unless the AC says otherwise.
- If you uncover a bug, log it separately; don't fix it inside the refactor.
- Run on a branch (the `create-branch` skill), never a protected branch.
