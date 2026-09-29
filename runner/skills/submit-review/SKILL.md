---
name: submit-review
description: Reference for how a finished ticket reaches human review in the Gaffer factory. Submission is RUNNER-OWNED — the agent commits its work and evidences the ACs, then stops; the runner records the delivery and submits for review (and pushes / opens a PR only when the operator enabled that). Invoke when you think your work is ready to hand off, to confirm what you must do (commit + evidence) and what the runner does for you (gates, submit, optional push/PR).
stack: []
area: review
---

# Handing a ticket to review (runner-owned)

You do **not** submit your own work. In the Gaffer factory the **runner** owns delivery
bookkeeping: after your run it applies the gates (tests, lint, hygiene, minimalism),
records the delivery, moves the ticket to `in_review`, and — only when the operator has
enabled PR creation (`GAFFER_CREATE_PR=1`, off by default) — pushes the branch and opens
a PR. Submission is deterministic and happens only once the gates
are green. Your job ends at a clean commit plus true evidence.

A ticket that reaches review with an AC that no test exercises, or with a test that never
reaches the AC's own path, comes straight back — the reviewer maps every AC to a test
(the `review-ticket` skill). Check that before you stop.

## What YOU do (then stop)

1. **Confirm self-review is done.** The `self-review` skill has been run on the final
   diff: every AC maps to a hunk and a test that exercises its own behaviour
   (`AC <id> → <test file>::<test name>`), and the smallest-change line is recorded.
2. **Confirm the gates are green in this session**, on the final diff: tests
   (`run-tests`), lint (`run-lint`), and any coverage threshold the ticket requires
   (`run-coverage`). Fix anything red; never hand over stale green.
3. **Commit on the ticket branch.** Run `git status --porcelain` and make sure only
   intended files are staged — no build output, coverage reports, temp or lock files,
   editor files, or anything secret-shaped. Then commit with a message referencing the
   ticket, as the brief specifies: `git add -A && git commit -m "deliver #<n>: <summary>"`.
   An uncommitted edit is not a delivery. The runner auto-commits leftovers as a safety
   net, but that commit carries whatever is in the tree — commit yourself.
4. **Evidence every AC** with the `record-evidence` skill: call `get_ticket` (Dispatch
   MCP), then one `record_ac_evidence` per AC with a true summary — the command you ran,
   the test name that proves the AC, the result. Evidence must describe what you
   actually ran in this session.
5. **Stop.** Do **not** push, open a PR, or call `submit_ticket_for_review`. If you cannot
   finish (an open question, a missing dependency, a broken environment), call
   `mark_ticket_blocked` with a clear reason instead of leaving half-done work. (On a
   resumed delivery both calls are refused — follow the resume note in `record-evidence`.)

## Done when

- `git status --porcelain` is empty (apart from runner-excluded files such as `.claude/`)
  after your commit on the runner's `gaffer/...` branch.
- Every AC has one evidence row naming the test (or diff hunk for a text-only AC) that
  proves it.
- You have stopped: no push, no PR, no submit call.

## What the RUNNER does (not you)

- Runs the Definition-of-Done, hygiene and minimalism gates on your committed diff, and
  bounces the delivery if any is red.
- Records the delivery (branch, diff summary, per-repo delivery rows).
- Submits the ticket for review (moves it to `in_review`), where a different agent
  reviews it; a human — or, in autonomy mode, the runner acting on that verdict — makes
  the final decision.
- Only with `GAFFER_CREATE_PR=1` (off by default): pushes the branch and opens a PR
  (`gh pr create`).

## Rules

- Never self-approve, mark `done`, or merge — only a human or the runner does, after
  review.
- Never push, open a PR, or `submit_ticket_for_review` yourself.
- Never commit to a protected branch; never commit secrets or generated artifacts.
- Not done until every AC has true evidence backed by a test that exercises it and the
  gates are green.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**A delivery-time gotcha — a non-obvious build/test/landing step or environment quirk that the next agent on this repo will hit.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
