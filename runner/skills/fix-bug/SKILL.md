---
name: fix-bug
description: Use when a ticket reports defective behaviour — a wrong result, a crash, a regression, "X doesn't work when Y" — and the fix must be proven with a test that fails before and passes after. Invoke for any bug, incident follow-up, or "this used to work" ticket before touching the code.
stack: []
area: workflow
---

# Fix a bug — reproduce, isolate, fix the cause, guard

A bug fix is a claim: "this behaviour was wrong, and now it is right." The only proof a
reviewer can check is a test that fails on the old code for the reported reason and
passes on the new. Debugging is a search, so run it like an experiment: one hypothesis,
one change, one observation at a time.

## Steps

1. **Extract the facts; distrust the diagnosis.** From `get_ticket`, write down the input,
   the expected result, the actual result, the environment, and how often it happens. The
   reporter's theory of the cause is a hint, not a conclusion. Call `search_lore` for known
   gotchas in this area — many bugs are a documented gotcha resurfacing.
2. **Reproduce it before changing anything.** Drive the failing path with a scratch test
   or a command until you SEE the wrong behaviour. Then shrink the reproduction: remove
   inputs, steps and setup until removing one more makes the bug disappear. A minimal
   reproduction usually points straight at the cause.
   - **Intermittent / "sometimes loses data" / "500 under load":** assume shared state.
     Reproduce deterministically — fire two concurrent calls at the same resource (a
     barrier or `Promise.all`), fix the clock with a fake timer, or pause one party past a
     timeout (a lock holder that stalls past its lease). Guessing at a race is not a fix.
   - **"This used to work":** find the introducing commit with
     `git bisect start <bad> <good>` then `git bisect run <test command>` (keep the
     reproduction script untracked inside the worktree, never outside it — the hook
     blocks writes there; untracked files survive each bisect checkout — and delete
     it before your `git add -A` commit, or it ships in the diff).
     Always finish with `git bisect reset` and check `git branch --show-current` is the
     delivery branch again — the runner fails a delivery left on any other HEAD. The
     introducing diff names the cause.
3. **Write the regression test first.** Encode the minimal reproduction as a permanent
   test at the lowest level that exposes it (unit for a function, integration if it needs
   the wiring). Name it after the behaviour, not the ticket number. Run it and confirm it
   FAILS **for the reported reason** — the assertion about the wrong result, not an import
   error, a missing fixture, or a timeout. Keep that output; it is half your evidence.
4. **Find the cause, not the symptom.** Trace from the failing assertion back to the
   decision the code got wrong: a missing guard, an off-by-one boundary, an unhandled
   state, a non-atomic read-modify-write, a stale assumption about an API. Form one
   hypothesis, change one thing, re-run. If a change does not move the result, revert it
   before trying the next — stacked speculative edits hide the real fix.
5. **Fix minimally.** Change only what the cause requires (the `minimalism` skill). A
   `try/catch` that hides the error, a special case for the reporter's exact input, or a
   retry around a race is a symptom patch, not a fix.
6. **Look for siblings.** `grep` for the same call, the same boundary arithmetic, the same
   unguarded shared write. Fix identical instances only if they are the same bug; list the
   others as findings in your evidence rather than widening this diff.
7. **Prove it.** Run the regression test (now passes), then the surrounding suite and
   lint once. For a concurrency or timing bug, run the new test in a loop
   (`for i in {1..20}; do <cmd> || break; done`) — a single green run proves nothing
   about a race.
8. **Guard the class.** If a type, assertion, or validation would have made this bug
   impossible, add it when it is small and in the same code.

## Done when

- The regression test failed before the fix for the reported reason and passes after —
  both outputs recorded via the `record-evidence` skill (`test_output`), with a one-line
  statement of the cause. On a resume, where that call is refused, put them in your final
  message instead (see `record-evidence`).
- The suite and lint pass; siblings are fixed or listed.

## Stop and escalate when

- You cannot reproduce after trying the reported inputs plus two deliberate variations
  (environment, data, timing). Record what you tried and call `request_decision`
  (`human_required`) naming the exact artefact you need — a payload, a log line, a
  version — then `mark_ticket_blocked` (refused on a resume, where the decision only stops
  the ticket being claimed again — the runner still submits what you committed, so
  commit no speculative fix). A blind fix of an unreproduced bug is a second bug.
- The real fix needs a schema change, a new dependency, or a behaviour change the ticket
  did not ask for: `request_decision` with the options.

## Rules

- No fix without a reproduction; no reproduction without a permanent test.
- Never delete, skip, or loosen a failing test to make the bug "go away".
- One bug per ticket; siblings become findings, not scope creep.
- Work on the delivery branch the runner prepared (the `create-branch` skill verifies);
  commit, never push.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While reproducing a defect you find the assumption the code made and the input that broke it — an API quirk, a boundary the code assumed away, a library behaviour nobody wrote down.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
