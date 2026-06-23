---
name: update-docs
description: Use when a ticket requires documentation to reflect a change — a README, API reference, changelog, or runbook — or when an acceptance criterion says "document X". Invoke for "update the docs for the new endpoint", "add a changelog entry", or "the README is now wrong".
stack: []
area: docs
---

# Update the docs

Bring documentation back in line with the code. Keep it accurate and matched to the
repo's existing docs structure — don't spawn a parallel doc system.

## Steps

1. **Find the source of truth and the docs that reference it.** Identify what changed
   (a route, a config key, a CLI flag, a schema) and locate every doc that describes it:
   README, `docs/`, API reference, changelog, inline examples.
2. **Read the lore** if the change touches a convention — `search_lore` (Memory MCP)
   for docs/style conventions (changelog format, where API docs live, voice).
3. **Update only what the change affects.** Correct commands, signatures, payloads, and
   examples so they match the code exactly. Add a changelog entry in the repo's format if
   one exists. Don't rewrite unrelated sections.
4. **Verify the examples are real** — run any documented command or sample request and
   confirm it produces what the doc claims. Fix drift you find.
5. **Evidence:** the changed doc files and (where applicable) the command output proving an
   example works. Then use the `record-evidence` skill (`diff_summary`) and submit for review.

## Rules

- Docs must match the code exactly; verify commands and examples actually run.
- Edit existing docs in place; don't introduce a new docs framework or location.
- Keep scope tight — only the sections the change touches.
- Run on a branch (the `create-branch` skill), never a protected branch.
