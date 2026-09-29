---
name: add-db-migration
description: Use when a ticket requires a database schema change — a new table/column, an index, a constraint, or a backfill. Invoke for "add a migration for X", "alter the schema", or any change to the persisted data model. Schema changes are high-risk; treat them carefully.
stack: [node, python, go, java, rust]
area: backend
---

# Add a database migration

During a rolling deploy the old code and the new code run against the same schema at
the same time, and a migration that takes a strong lock on a busy table stalls every
query behind it. So every migration must be compatible with the code on both sides of
the deploy, take only brief locks, and be reversible or explicitly justified.

## Steps

1. **Read the conventions.** Call `search_lore` for the tool (Flyway, Liquibase,
   Alembic, Prisma, Knex, Django, Active Record, golang-migrate), naming and numbering,
   whether migrations run in a transaction, and any zero-downtime ADR. Generate the file
   with the repo's generator; never edit a migration that may already have been applied
   elsewhere, add a new one.
2. **Classify the change.**
   - Additive and safe: new table, nullable column, column with a constant default on
     engines that store it as metadata (PostgreSQL 11+, MySQL 8 instant), a new index
     built online.
   - Needs expand/contract: rename or retype a column or table, add NOT NULL, split or
     merge columns, drop anything still read by deployed code.
   - Destructive or high-risk: dropping data, narrowing a type, rewriting a large table,
     a backfill that cannot be undone. Call `mark_ticket_blocked` with the specifics and
     the safe plan you propose; a human decides. (On a resumed delivery
     `mark_ticket_blocked` is refused — raise it with `request_decision`, the
     `ticket_id` and severity `human_required` instead, and do not commit the
     destructive migration: the runner still submits what is committed.)
3. **Use expand → migrate → contract (parallel change)** for anything not purely
   additive, one phase per ticket or deploy:
   - *Expand:* add the new column/table; the code writes both old and new and still
     reads old.
   - *Migrate:* backfill; switch reads to new; verify.
   - *Contract:* stop writing old; tell the ORM to ignore it; drop it in a later deploy.
   This ticket delivers only its phase. State in the evidence which phase this is and
   what the next one must do.
4. **Keep locks short.** Set a `lock_timeout` (a few seconds) so a blocked DDL fails
   instead of queueing all traffic behind it. On PostgreSQL:
   `CREATE INDEX CONCURRENTLY` (outside a transaction); foreign keys and CHECK
   constraints added `NOT VALID` then `VALIDATE CONSTRAINT` separately; NOT NULL via a
   validated CHECK first; unique constraints from a concurrently built unique index.
   On MySQL prefer `ALGORITHM=INSTANT`/`INPLACE, LOCK=NONE`. Never change a column type
   in place on a large table.
5. **Backfill in batches, outside the schema transaction.** Iterate by primary-key range
   (e.g. 1,000–10,000 rows), commit per batch, make it idempotent and resumable
   (`WHERE new_col IS NULL`), and throttle. New writes must already populate the new
   column (expand phase) so the backfill converges.
6. **Write the down migration** that restores the previous schema, or a comment stating
   why a true rollback is impossible and how to recover (e.g. restore from the old
   column still present).
7. **Apply it against the database the repo's test setup creates** (the runner scrubs
   `*_URL` variables such as `DATABASE_URL`; never point a migration at a shared or
   production database): run up, down, then up again, on a database that contains representative rows (an
   empty table hides NOT NULL, unique and type-cast failures).
8. **Test the schema's behaviour per AC.** A test that exercises each AC's own
   behaviour: the constraint rejects bad rows, the default applies, the backfill fills
   every row and is safe to run twice, the old and new code paths both work during the
   expand phase. Run the suite (the `run-tests` skill).
9. **Evidence** with the `record-evidence` skill: the migration file, the up/down/up
   output, the phase, and the test results.

## Done when

- Up, down and up again succeed on a seeded test database.
- Deployed (old) code keeps working against the new schema.
- No statement takes a long exclusive lock on an existing table; `lock_timeout` is set
  where the tool allows.
- Destructive steps were blocked for a human decision, not performed.

## Anti-patterns

- Rename and code change in one deploy; `DROP COLUMN` while the ORM still selects it.
- `ADD COLUMN … NOT NULL` without a default on a populated table.
- A single `UPDATE` over the whole table inside the migration transaction.
- `CREATE INDEX` without `CONCURRENTLY` on a large PostgreSQL table.
- Installing DB tooling (never install anything: the hook blocks npm/pip installs, and
  `go install`, `cargo install` and the like are equally forbidden though not blocked),
  or writing secret/`.env` files (hook-blocked).

The reviewer judges this change with the `migration-review` skill; meet that bar here.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**A schema decision or migration constraint future agents must respect — a naming convention, a reversibility rule, or a modelling choice with downstream impact.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
