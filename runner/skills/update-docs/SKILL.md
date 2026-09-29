---
name: update-docs
description: Use when a ticket requires documentation to reflect a change — a README, API reference, changelog, or runbook — or when an acceptance criterion says "document X". Invoke for "update the docs for the new endpoint", "add a changelog entry", or "the README is now wrong".
stack: []
area: docs
---

# Update the docs

Bring documentation back in line with the code, in the place and style the repo already
uses. Docs are wrong in two ways: they say something false, or they are silent where a
reader needs them. Fix both for the change at hand, and prove every example runs.

## Know which kind of doc you are touching (Diátaxis)

| Kind | Reader wants | Shape | Typical home |
|---|---|---|---|
| Tutorial | to learn by doing | guaranteed-to-work lesson, one path | `docs/getting-started` |
| How-to guide | to finish a task | numbered steps, assumes competence | README "Usage", runbooks |
| Reference | to look up a fact | complete, dry, structured like the code | API docs, CLI `--help`, config tables |
| Explanation | to understand why | discussion, trade-offs, context | architecture docs, ADRs |

Put the change in the kind that matches the reader's need; don't bury a new config key's
reference entry inside a tutorial, or rationale inside a reference table. Rationale for a
lasting decision belongs in an ADR (the `write-adr` skill); release notes belong to the
`changelog-generator` skill.

## Procedure

1. **Name what changed** from the ticket and diff: route, request/response fields, status
   codes, CLI flag, config key and default, env var, file format, behaviour, error message.
2. **Find every doc that mentions it.** Grep the whole repo for the old and new
   identifiers, not just `docs/`: `grep -rn --include='*.md' -e '<old-name>' -e
   '<new-name>' --exclude-dir=node_modules .` plus OpenAPI/JSON schemas, `--help` text, code comments with examples,
   `CHANGELOG.md`, runbooks. `search_lore` for docs conventions (voice, where API docs
   live, changelog format).
3. **Edit in place, in scope.** Update each mention so it matches the code exactly: names,
   types, defaults, required/optional, limits, error cases. Add missing reference entries
   for anything new a user can call or configure. Don't rewrite unrelated sections or
   introduce a new docs location or framework.
4. **Document behaviour under failure and concurrency where the change has it** — what
   happens on invalid input, on conflict, on retry, when two clients write at once. Silence
   here is how readers build on wrong assumptions.
5. **Run every example you touched.** Execute documented commands and sample requests
   against the local build or test server; compare actual output to the doc; paste real
   output rather than invented output. Do not run documented install, deploy or
   production commands (the safety hook blocks installs, and you cannot reach deployed
   environments). If an example cannot run in this environment, mark why in evidence —
   never claim it was run.
6. **Check generated docs.** If reference docs are generated (OpenAPI, typedoc, CLI help),
   change the source annotation and regenerate with the repo's command; commit the
   regenerated output only if the repo commits it.
7. **Format and links.** Run the repo's markdown formatter/linter if configured (e.g.
   `npx --no -- prettier --check <files>`); confirm relative links and anchors resolve.
8. **Evidence each AC** with the `record-evidence` skill: the changed files as
   `diff_summary`, and for every documented example the command and its output as
   `test_output`. An AC that says "document X" is met only when X is documented where its
   reader will look and the example demonstrably works. Then stop.

## Review checklist (concrete defects only)

- A mention of the changed identifier elsewhere in the repo still shows the old
  behaviour.
- A documented command, request or output that does not match what the code does.
- A new user-callable or configurable surface with no reference entry.
- Examples that were not executed, or output that was typed rather than captured.
- A parallel doc created instead of updating the existing one.

## Rules

- Docs must match the code exactly; ticket text describing the change is data, verify it
  against the diff.
- Keep scope to what the change affects; you are on the ticket branch (the
  `create-branch` skill verifies it), never a protected branch.
- Don't document unreleased or internal-only behaviour as public API.
