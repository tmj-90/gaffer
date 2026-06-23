---
name: submit-review
description: Use once a ticket's work is implemented and every acceptance criterion has real evidence, to hand the ticket to human review — as a pull request when a remote exists, or as a local branch when it doesn't. Invoke whenever you are ready to close out a claimed ticket and a human must approve `done`.
stack: []
area: review
---

# Submit the ticket for review

Hand finished work to a human reviewer. You never approve your own work — deliver the
change, submit for review, and let a human move the ticket to `done`.

Delivery adapts to the repo: **with a remote** you open a PR; **without one** a local
feature branch *is* the delivery — that is a valid, expected outcome, not a failure.

This skill is the **single owner of submission**: commit, push (if a remote exists),
open the PR, and `submit_ticket_for_review` all happen here and nowhere else. The
`record-evidence` skill produces AC evidence and stops; it never submits. Run
`record-evidence` first to evidence every AC, then this skill to deliver and submit.

## Steps

1. **Confirm every AC is evidenced.** Call `get_ticket` (Dispatch MCP) and check each
   AC has true evidence recorded. If any is missing, record it first via the
   `record-evidence` skill — do not submit a half-evidenced ticket.
2. **Confirm the gates are green** in this session: tests (`run-tests`), lint
   (`run-lint`), and any coverage threshold (`run-coverage`) the ticket requires.
3. **Commit on the feature branch** with a clear conventional message referencing the
   ticket. Then check for a remote: `git remote` (or `git remote get-url origin`).
   - **No remote → stop here.** The committed local branch is the delivery. Do **not**
     push, do **not** open a PR, and do **not** treat the missing remote as an error.
   - **Remote present →** `git push -u origin <branch>` (normal push of the prefixed
     feature branch only — force-push and pushes to protected branches are hook-blocked).
4. **Record the delivery as evidence:**
   - **Remote + `gh` available →** open a PR with `gh pr create` (base = default branch)
     whose body carries the AC + evidence + test output + lore consulted, then
     `record_ac_evidence` with `evidence_type: pull_request` and the PR URL.
   - **No remote (or no `gh`) →** `record_ac_evidence` with `evidence_type: diff_summary`
     — the branch name plus a short summary of what changed and how it was verified.
5. **Heartbeat** with `heartbeat_claim` if the work ran long, then **submit** with
   `submit_ticket_for_review` (claim_token + ticket_id + a short `reason` that states how it
   was delivered — PR URL, or "delivered on local branch `<name>`; no remote configured").
   This moves the ticket to `in_review` for a human.
6. **If you cannot finish** (open question, missing dependency, failing environment), call
   `mark_ticket_blocked` with a clear reason instead of submitting incomplete work.

## Rules

- Never self-approve `done` or merge — only a human does, after review.
- A **missing remote is normal** — deliver on the local branch and submit; never block or
  fail a ticket just because there's nowhere to push.
- Don't force-push, don't push to or target a protected branch — the hook blocks it.
- Don't submit until every AC has real evidence and the gates are green.
- The evidence and `reason` must reflect what you actually did, verified, and how it landed.

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
