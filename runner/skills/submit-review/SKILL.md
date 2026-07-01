---
name: submit-review
description: Reference for how a finished ticket reaches human review in the Gaffer factory. Submission is RUNNER-OWNED — the agent commits its work and evidences the ACs, then stops; the runner records the delivery, pushes, opens the PR, and submits for review. Invoke when you think your work is ready to hand off, to confirm what you must do (commit + evidence) and what the runner does for you (push, PR, submit).
stack: []
area: review
---

# Handing a ticket to review (runner-owned)

You do **not** submit your own work. In the Gaffer factory the **runner** — not the
agent — owns delivery bookkeeping: after your agent run it runs the gates
(tests/lint/hygiene/minimalism), records the delivery, pushes the branch and opens the
PR when a remote exists, and moves the ticket to `in_review`. This makes submission
deterministic and token-free, and guarantees a ticket is only ever submitted once its
gates are green.

## What YOU do (then stop)

1. **Confirm every AC is evidenced.** Call `get_ticket` (Dispatch MCP) and check each
   AC has true evidence. If any is missing, record it via the `record-evidence` skill.
2. **Confirm the gates are green** in this session: tests (`run-tests`), lint
   (`run-lint`), and any coverage threshold the ticket requires. Fix anything red.
3. **Commit on the feature branch** with a clear conventional message referencing the
   ticket (`git add -A && git commit -m "deliver #<n>: <summary>"`). An uncommitted
   edit is NOT a delivery — the branch must carry your commit. If you forget, the
   runner auto-commits your uncommitted changes as a safety net, but commit yourself.
4. **Stop.** Do **not** push, do **not** open a PR, do **not** call
   `submit_ticket_for_review`. The runner does all of that. If you cannot finish (open
   question, missing dependency, failing environment), call `mark_ticket_blocked` with
   a clear reason instead of leaving half-done work.

## What the RUNNER does (not you)

- Runs the Definition-of-Done and hygiene/minimalism gates on your committed diff.
- Records the delivery (branch + diff summary + per-repo delivery rows).
- Pushes the branch and opens the PR (`gh pr create`) when the repo has a remote.
- Submits the ticket for review (moves it to `in_review`).

## Rules

- Never self-approve `done` or merge — only a human does, after review.
- Never push, open a PR, or `submit_ticket_for_review` yourself — that is the runner's job.
- Don't consider yourself done until every AC has real evidence and the gates are green —
  the runner's gates will bounce a delivery that isn't.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**A delivery-time gotcha — a non-obvious build/test/landing step or environment quirk that the next agent on this repo will hit.** That kind of fact is *lore* — it would have saved you time had the
previous agent recorded it, and it will save the next one. Capture it.

When you learn something that future agents on this repo should know *before they
start* — a convention, a gotcha, an architectural fact, a decision, a boundary —
call the Memory MCP `suggest_lore` tool once, at the close of your work:

- `title` — the rule/fact in a few words.
- `summary` — one self-contained paragraph: the *what* and the *why*.
- `body` — the detail and evidence that lets a human verify it.
- `repos` — the repo(s) the rule applies to.
- `tags` — lowercase (e.g. `conventions`, `gotchas`, `security`, `db`).
- `source` — a URL to the ticket/PR/ADR that justifies it (records without a
  source are lower-trust); `confidence` — `low` for an inferred convention,
  `high` only when you have a source.

**This is suggested, gated knowledge — not auto-truth.** `suggest_lore` lands a
DRAFT; a human reviews and approves it. You never approve your own lore.

**Capture reusable knowledge, not ticket noise.** Lore is a convention, gotcha,
decision, or boundary the *next* agent needs — never per-ticket trivia (what this
diff changed, a path you happened to read, transient task state). The honest test:
*would a teammate six months from now thank you for this record?* If unsure, skip —
a missing record costs one re-search; a noisy one costs every future reader.
