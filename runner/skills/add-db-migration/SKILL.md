---
name: add-db-migration
description: Use when a ticket requires a database schema change — a new table/column, an index, a constraint, or a backfill. Invoke for "add a migration for X", "alter the schema", or any change to the persisted data model. Schema changes are high-risk; treat them carefully.
stack: []
area: backend
---

# Add a database migration

Schema changes are high-risk: they can lock tables, drop data, or break running code.
Produce a reversible migration that follows the repo's tooling — and escalate when a
human decision is needed.

## Steps

1. **Read the lore first.** Call `search_lore` (Memory MCP) for migration
   conventions: the tool (Flyway/Liquibase/Alembic/Prisma/Knex/…), naming/numbering,
   whether migrations must be backward-compatible with running code, and any ADR on
   zero-downtime changes.
2. **Assess the risk.** If the change is destructive (drop column/table, narrow a type,
   non-nullable add without default), rewrites a large table, or could cause downtime or
   data loss — stop and call `mark_ticket_blocked` with the specifics. A human decides.
3. **Write a reversible migration** using the repo's generator. Provide both up and down
   (or an explicit, justified note when a true rollback is impossible). Prefer additive,
   backward-compatible steps; split risky changes into expand → migrate → contract phases.
4. **Make it safe at scale.** Add indexes concurrently where the engine supports it; add
   columns nullable or with a default; backfill in batches, not one statement.
5. **Apply it against a test/dev database** (the context packet's DB; never production)
   and confirm it runs forward and rolls back cleanly. Add/adjust tests for the new schema.
6. **Run tests** (`run-tests`). Evidence the migration file, the apply+rollback output,
   and test results, then use the `record-evidence` skill and submit for review.

## Rules

- Every migration must be reversible, or carry an explicit reason it cannot be.
- Destructive or downtime-risking changes → `mark_ticket_blocked`; do not decide alone.
- Never run migrations against production; use the test/dev DB from the packet.
- Don't install DB tooling or write secret/`.env` files — the hook blocks both.
- Run on a branch (the `create-branch` skill), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**A schema decision or migration constraint future agents must respect — a naming convention, a reversibility rule, or a modelling choice with downstream impact.** That kind of fact is *lore* — it would have saved you time had the
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
