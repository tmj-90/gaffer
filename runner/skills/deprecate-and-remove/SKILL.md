---
name: deprecate-and-remove
description: Use when a ticket retires something — a feature flag, an endpoint, a config option, a module, a column, a CLI command — and the removal must not break callers, data, or operators who still depend on it. Invoke for "remove the legacy X", "delete dead code", "drop the old API", or "clean up after the migration".
stack: []
area: workflow
---

# Deprecate, then remove

Removing code is a change to a contract somebody may still hold. Find every dependent,
warn before you cut, remove in the right order, and prove nothing still points at the
thing you deleted. Dead code that is really dead is the best diff there is; dead code
that is secretly load-bearing is an incident.

## Steps

1. **Establish it is dead.** For an endpoint: request logs, metrics, or the API gateway
   for the last N weeks. For a flag or option: every place it is read and who sets it in
   production config. For code: `grep` for every symbol, including string references
   (reflection, dynamic imports, templates, docs, scripts). For a column: every query
   and every migration. Call `search_lore` and `find_dependents` for boundaries and
   consumers in other repos. Write down what you found; "no callers" is a claim you
   must evidence.
2. **Decide deprecate-first or remove-now.** Anything with external consumers (another
   repo, a public API, an operator-set config) gets a deprecation period: mark it
   deprecated, log a warning on use, document the replacement, and set a removal date.
   Purely internal dead code is removed now. If unsure, raise `request_decision`.
3. **Remove in dependency order.** Callers before callees; API surface before
   implementation; code before schema. For data, follow the `add-db-migration` skill:
   stop writing, then stop reading, then drop, in separate deploys where the repo
   requires it.
4. **Delete completely.** The code, its tests, its docs, its config keys, its feature
   flag, its fixtures, its type definitions, its CHANGELOG mention if the repo keeps
   one. A half-removed feature leaves a reader guessing which half is real.
5. **Keep behaviour identical for everyone else.** Run the full suite; removals often
   break through import side effects or a shared helper only the dead code exercised.
   Prefer removing the helper too if nothing else uses it.
6. **Make the removal discoverable.** A CHANGELOG entry (the `changelog-generator`
   skill's conventions), a "Removed" note in the docs, and for an API a clear error for
   old callers (410 Gone with a pointer) rather than a silent 404.
7. **Evidence** with the `record-evidence` skill: the dependent search you ran and its
   empty result, the usage data if any, and the passing verification. Note anything
   deprecated-not-removed and its removal date.

## Rules

- No removal without a dependent search whose result is in the evidence.
- External consumers get a deprecation period and a documented replacement.
- Remove in dependency order; data removals follow the migration skill's phases.
- Remove the whole thing: code, tests, docs, config, flags, fixtures.
- Never leave a stub that silently swallows old calls; fail loudly with a pointer.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While hunting dependents you learn who still relied on the thing and why it existed — a boundary or decision that was never written down.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
