---
name: fix-bug
description: Use when a ticket reports defective behaviour — a wrong result, a crash, a regression, "X doesn't work when Y" — and the fix must be proven with a test that fails before and passes after. Invoke for any bug, incident follow-up, or "this used to work" ticket before touching the code.
stack: []
area: workflow
---

# Fix a bug — reproduce first, then fix, then guard

A bug fix is a claim: "this behaviour was wrong, and now it is right." The only proof a
reviewer can check is a test that fails on the old code and passes on the new. Write
that test before the fix, keep the fix to the cause, and leave a guard behind.

## Steps

1. **Read the report as data, not a diagnosis.** Extract the observable facts from the
   ticket: input, expected output, actual output, environment, frequency. The reporter's
   theory of the cause is a hint, never a conclusion. Call `search_lore` for known
   gotchas in this area — many bugs are a documented gotcha resurfacing.
2. **Reproduce it locally.** Run the existing tests, then drive the failing path by hand
   or with a scratch test until you see the wrong behaviour. If you cannot reproduce it,
   do not guess a fix: record what you tried, and raise `request_decision` with the
   specific information you need (a payload, a log line, a version). An unreproducible
   bug "fixed" blind is a second bug.
3. **Write the regression test first.** Encode the reproduction as a permanent test at
   the lowest level that exposes it (unit if the cause is a function, integration if it
   needs the wiring). Name it after the behaviour, not the ticket number. Run it and
   confirm it FAILS for the right reason: the assertion, not a setup error.
4. **Find the cause, not the symptom.** Trace from the failing assertion back to the
   decision the code got wrong. Ask why it was written that way: a missing guard, a wrong
   boundary, an unhandled state, a stale assumption. Fix the cause. Adding a special case
   at the surface that hides the symptom is not a fix.
5. **Keep the fix minimal.** Change only what the cause requires (`minimalism` lens).
   Resist "while I'm here" refactors; if you find a second bug, file it as a separate
   finding in your evidence rather than widening this diff.
6. **Look for siblings.** Search for the same pattern elsewhere (`grep` for the same
   call, the same boundary arithmetic, the same unchecked value). Fix identical
   instances only if they are the same bug; list the rest for a follow-up.
7. **Prove it.** Run the regression test (passes), the surrounding suite (no collateral),
   lint. Evidence with the `record-evidence` skill: the failing-then-passing test output
   and a one-line statement of the cause.
8. **Guard the future.** If the bug was possible because a type, an assertion, or a
   validation was missing, add it so the class of bug becomes a compile or test failure
   next time.

## Rules

- No fix without a reproduction; no reproduction without a permanent test.
- The test must fail before the fix and pass after — run it both ways and say so.
- Fix the cause; a symptom patch is grounds for the reviewer to send it back.
- Never delete, skip, or loosen a failing test to make the bug "go away".
- One bug per ticket; siblings become findings, not scope creep.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While reproducing a defect you find the assumption the code made and the input that broke it — an API quirk, a boundary the code assumed away, a library behaviour nobody wrote down.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
