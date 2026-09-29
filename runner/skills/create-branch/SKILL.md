---
name: create-branch
description: Use at the start of work on any claimed Dispatch ticket, before editing files, to create the working branch with the required prefix. Invoke whenever a ticket needs code changes and you are not yet on a non-protected feature branch.
stack: []
area: workflow
---

# Get onto the working branch

All work happens on a `gaffer/` feature branch, never on a protected branch
(`main`, `master`, `release/*`). In the factory the runner has already created that
branch in a throwaway git worktree and put you in it, so this skill is a short
**verification**, not a branching step. Only outside the factory do you create the
branch yourself.

## Factory path — verify, do not create

1. **Read the expected branch and path** from the REPO ACCESS BOUNDARY block of your
   prompt ("WRITABLE repos … on branch 'gaffer/ticket-<n>-…'").
2. **Check where you are:** `git rev-parse --abbrev-ref HEAD` must print exactly that
   branch name. `HEAD` (detached), a protected name, or a different `gaffer/` branch
   means the environment is not what the factory guarantees: `mark_ticket_blocked`
   ("on <actual>, expected <branch>") and stop (on a resume, where that call is refused,
   `request_decision` with the `ticket_id` and severity `human_required` instead). Do not "fix" it with `git switch -c` or
   `git checkout -b` — a new branch diverges from the one the runner will push and review.
3. **Check the tree against the kind of run you are in:**
   - **Fresh delivery** — `git status --porcelain` should be empty. Runner files
     (`.claude/`, `CLAUDE.factory.md`, `.mcp.json`, the `node_modules` symlink) are
     git-excluded and will not show. If
     other uncommitted or untracked files are present, you did not create them:
     `mark_ticket_blocked` ("worktree dirty on arrival: <files>") rather than building on
     unknown state.
   - **Rework** (your prompt shows why a previous attempt was rejected) — the branch
     carries the previous attempt's commits. That is expected: `git log --oneline
     <default>..HEAD` shows them. Build on them and address every rejection reason.
   - **Resume** (your prompt says you are RESUMING) — prior work may be committed AND
     uncommitted. A dirty tree is expected: read `git status` and `git diff`, then
     continue. Never discard it.
4. **Proceed.** Implement on this branch and commit to it
   (`git add -A && git commit -m "deliver #<n>: <summary>"`). Never push or open a PR:
   after its gates the runner does that itself when the operator has enabled it.

**Done when:** the current branch equals the expected `gaffer/…` branch and the tree
state matches the run type. This takes two or three commands; do not repeat it later.

## Standalone path — create the branch yourself

Only when no branch was prepared for you (running outside the factory):

1. Confirm the base branch (the repository's `default_branch` from `get_ticket`, unless
   the ticket names another) and that `git status --porcelain` is empty; if not, stop
   and `mark_ticket_blocked` rather than carrying uncommitted state onto a new branch.
2. Build the name `gaffer/ticket-<number>-<short-slug>`:
   - the `gaffer/` prefix is mandatory — the runner rejects a delivery whose branch
     lacks it;
   - `ticket-<number>` is the literal word, a hyphen, the ticket number;
   - `<short-slug>` is the title in lowercase, hyphen-separated, at most about six words,
     no punctuation.

   Example: #412 "Add rate limiting to login" → `gaffer/ticket-412-add-rate-limiting`.
   Wrong: no prefix, `ticket/412`, UUIDs or random suffixes, uppercase.
3. `git switch -c <name> <base>`, then verify with `git rev-parse --abbrev-ref HEAD`.
   Do not push.

## Rules

- In the factory, verify; never create or switch branches.
- One ticket, one branch; never reuse a branch from an unrelated ticket.
- Never commit on a protected branch; never push, force-push, or delete branches.
- A dirty tree on a fresh delivery is a blocker; on a resume it is your prior work.
- Do not install dependencies in any ecosystem (the hook blocks npm/pnpm/yarn/pip
  installs; your prompt forbids the rest) and do not write outside the worktree
  (hook-blocked).
