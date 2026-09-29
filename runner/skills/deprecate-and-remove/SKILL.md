---
name: deprecate-and-remove
description: Use when a ticket retires something — a feature flag, an endpoint, a config option, a module, a column, a CLI command — and the removal must not break callers, data, or operators who still depend on it. Invoke for "remove the legacy X", "delete dead code", "drop the old API", or "clean up after the migration".
stack: []
area: workflow
---

# Deprecate, then remove

Removing code changes a contract somebody may still hold. Find every dependent, warn
before you cut, remove in the right order, and prove nothing still points at the thing
you deleted. Dead code that is really dead is the best diff there is; dead code that is
secretly load-bearing is an incident.

## Steps

1. **Prove it is dead — and write the proof down.** Search for every reference,
   including the non-obvious ones:
   - the symbol and its string form (`grep -rn`): reflection, dynamic imports, DI
     registration, templates, routes tables, serialised names, cron/job registries;
   - tests, fixtures, docs, scripts, CI workflows, dashboards and infra config;
   - for a flag or option: every read, and every place that sets it;
   - for a column or table: every query, ORM model, migration and report;
   - other repos: `find_dependents` and `search_lore` for declared consumers, and grep any
     read-only context repos listed in your prompt.
   "No callers" is a claim; the commands you ran and their empty output are the evidence.
2. **Decide: deprecate first, or remove now.** Anything with consumers you cannot see —
   another repo, a public or partner API, an operator-set option, a persisted format —
   gets a deprecation period. Purely internal code with an empty step-1 search is removed
   now. Semantic versioning puts a deprecation in a minor release and the removal in the
   next major. If you cannot tell which case applies, `request_decision`.
3. **When deprecating, make it loud and dated.** Mark it deprecated where tooling shows it
   (JSDoc `@deprecated`, `warnings.warn(DeprecationWarning)`, `[Obsolete]`, `#[deprecated]`),
   log a warning on use (once, not per call), document the replacement, and set the
   removal date. For HTTP APIs send `Deprecation` (RFC 9745) and `Sunset` (RFC 8594)
   headers with a `Link` to the migration note; the sunset date must not precede the
   deprecation date.
4. **Remove in dependency order.** Callers before callees; public surface before
   implementation; code before schema. Data follows expand/contract (the
   `add-db-migration` skill): stop writing, then stop reading, then drop — in separate
   deliveries when the repo deploys them separately.
5. **Delete completely.** Code, tests, fixtures, types, docs, config keys, flag
   declarations, and now-unused helpers that only the dead code used. A dependency that
   becomes unused is listed in your evidence for a human to remove: package-manager
   commands cannot run safely in a delivery worktree (the `dependency-upgrade` skill).
   A half-removed feature leaves a reader guessing which half is real.
6. **Fail loudly for stragglers.** An old API caller gets an explicit error with a
   pointer (HTTP 410 Gone with a link, a CLI message naming the replacement), not a silent
   404 or a no-op stub that swallows the call.
7. **Verify nothing else moved.** Run the full suite, build and lint once: removals break
   through import side effects, registration order, and shared helpers. Re-run the
   step-1 search to show zero remaining references.
8. **Record it.** A CHANGELOG "Removed"/"Deprecated" entry in the repo's format (the
   `changelog-generator` skill), and evidence via the `record-evidence` skill: the
   searches and their empty results, what was deprecated-not-removed and its removal date.
   On a resume that call is refused: do not retry; put this, the AC → test map and the
   smallest-change note in your final message.

## Done when

The post-removal search returns nothing (or only the deliberate deprecation shim), the
full suite and build pass, stragglers get an explicit error, and the evidence contains
the search commands and results.

## Stop and escalate when

- A dependent turns up that the ticket did not anticipate (another repo, a scheduled job,
  an operator runbook): stop removing and `request_decision` with what you found.
- The removal would drop or rewrite persisted data, or needs usage data (request logs,
  metrics) you cannot access to prove the thing is unused: `request_decision`
  (`human_required`) with the search results you have.

## Rules

- No removal without a dependent search whose result is in the evidence.
- External consumers get a dated deprecation and a documented replacement first.
- Remove in dependency order; data removals follow the migration phases.
- Remove the whole thing; never leave a stub that silently swallows old calls.
- Work on the delivery branch (the `create-branch` skill verifies); commit, never push.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While hunting dependents you learn who still relied on the thing and why it existed — a boundary or decision that was never written down.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
