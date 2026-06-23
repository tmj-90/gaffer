---
name: create-branch
description: Use at the start of work on any claimed Dispatch ticket, before editing files, to create the working branch with the required prefix. Invoke whenever a ticket needs code changes and you are not yet on a non-protected feature branch.
stack: []
area: workflow
---

# Get onto the working branch

All work happens on a prefixed feature branch — never on a protected branch
(`main`/`master`/`release/*`). The safety hook blocks pushes to protected branches.

**Two paths — know which one you're in:**

- **In the factory (the normal case):** the runner has ALREADY created your
  `gaffer/…` branch and checked you out onto its worktree. You do **not** create or
  switch branches — you **verify** you're on the right kind of branch and stop if you
  aren't. See *Factory path* below.
- **Standalone / non-factory:** no branch was prepared for you, so you create one
  yourself with the exact convention. See *Standalone path* below.

## Factory path — VERIFY, do not create

The runner already created and checked you out onto your `gaffer/ticket-<number>-…`
worktree branch. Your job is to confirm the ground is safe, not to branch:

1. **Confirm you're on a non-protected branch.** Check the current branch
   (`git branch --show-current` / `git rev-parse --abbrev-ref HEAD`). It must NOT be
   `main`/`master`/`release/*`. The `gaffer/` prefix is expected.
2. **Do NOT run `git switch -c` / `git checkout -b`.** A branch already exists; creating
   another one diverges from the worktree the runner set up and the factory expects.
3. **Check the working tree is clean.** Run `git status --porcelain`. If it is dirty —
   uncommitted or untracked state left over from a prior partial run on this worktree —
   do **not** branch over it or start editing on top of it. **Stop and
   `mark_ticket_blocked`** with a clear reason ("worktree dirty on arrival: <files>");
   a human resolves the stale state. Fabricating a clean start over dirty state corrupts
   the delivery.
4. **If you are somehow on a protected branch** (the runner's setup didn't take), do **not**
   "fix" it by creating your own branch — `mark_ticket_blocked` and report it, because the
   environment isn't what the factory guarantees.

Once you've verified a clean tree on a non-protected `gaffer/…` branch, implement directly
on it. The rest of this skill (the naming convention) applies to the *standalone* case.

## Standalone path — create the branch yourself

Only when **no** branch was prepared for you (running this skill outside the factory):
build the name from the convention below, confirm a clean tree, then `git switch -c <name>`.

## The branch name (exact convention)

Use this shape, exactly:

```
gaffer/ticket-<number>-<short-slug>
```

- **`gaffer/` prefix is mandatory.** The safety hook and the factory both expect it; a branch
  without it is wrong and can fail review or get hook-blocked.
- **`ticket-<number>`** — the literal word `ticket`, a hyphen, then the ticket number
  (e.g. `ticket-412`).
- **`<short-slug>`** — a lowercase, hyphenated slug derived from the ticket title:
  ≤ ~6 words, no spaces, no uppercase, no punctuation beyond the hyphens.

Example: ticket #412 "Add rate limiting to login" → `gaffer/ticket-412-add-rate-limiting`.

**Wrong** (do not produce these): ad-hoc names, UUIDs or random suffixes
(`gaffer/3f9a-…`), the prefix omitted, or `ticket/…` without the `gaffer/` prefix.

## Steps (standalone path only)

1. **Confirm the base branch** from the context packet (e.g. `default_branch`). Branch from
   it unless the ticket explicitly says otherwise.
2. **Build the branch name** as `gaffer/ticket-<number>-<short-slug>` per the convention
   above — ticket number from the claimed ticket, slug from its title.
3. **Confirm the current tree is clean and based on the right ref** before branching.
   If `git status --porcelain` is non-empty, stop (`mark_ticket_blocked`) rather than
   branching over uncommitted state.
4. **Create and switch to the branch** with the repo's VCS (`git switch -c <name>`).
   Do not push yet — pushing happens at review time, and force-push is blocked.
5. **Verify** you are on the new branch and not on a protected one before editing.

> In the **factory path** you skip steps 2 and 4 entirely — the branch already exists.
> You only verify (current branch is a non-protected `gaffer/…`) and confirm a clean tree.

## Rules

- **In the factory, VERIFY — never `git switch -c`.** The runner already created and
  checked you out onto your `gaffer/…` worktree branch; creating another diverges from it.
  Branch creation is for the standalone case only.
- **Use the exact convention: `gaffer/ticket-<number>-<short-slug>`.** The `gaffer/` prefix is
  mandatory — the safety hook and factory depend on it. Ad-hoc names, UUIDs, or `ticket/…`
  without the prefix are wrong and can fail review.
- **A dirty working tree on arrival is a blocker, not a thing to branch over.** Leftover
  uncommitted/untracked state from a prior partial run → `mark_ticket_blocked`, don't build
  on top of it.
- Never create or commit on a protected branch (`main`/`master`/`release/*`) — the hook will
  block the push and the work will be wasted.
- One ticket, one branch. Do not reuse a branch from an unrelated ticket.
- Do not install dependencies or write outside the repo — the hook blocks both.
