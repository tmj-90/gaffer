---
name: migration-review
description: Use as a REVIEW LENS when judging another agent's diff that changes a database schema or data — a migration, a backfill, a dropped or renamed column, an index, a constraint — for irreversibility, locking, data loss, and deploy-order hazards before recommending approval. Invoke on every review whose diff touches a migrations directory, an ORM schema, or a data script; it complements review-ticket and the builder's add-db-migration skill.
stack: []
area: review
---

# Migration review lens

A schema change is the one part of a deploy a redeploy cannot undo. For every migration
ask three questions: what happens on the live database while it runs (locks, rewrites,
duration); what happens mid-rollout, when old and new code both run against one schema;
and how do we get back. A finding is a concrete defect: a named statement, the lock or
data loss it causes, and the safe form.

## Steps

1. **Inventory every schema and data change**: migration files, ORM model or schema
   changes that generate migrations (read the generated SQL — Prisma and some ORMs turn a
   rename into drop + add), seed and backfill scripts, queries that assume the new shape.
   Call `search_lore` for the engine and version, the migration tool, deploy order and
   any online-migration rules.
2. **Simulate the rollout (expand → migrate → contract).** Old code keeps running against
   the new schema until rollout completes; new code may run against the old schema if the
   migration runs after deploy. Every combination must work: a dropped or renamed column
   old code still reads breaks the deploy; a NOT NULL column without a default breaks old
   inserts; an ORM that selects every mapped column fails on a dropped one.
3. **Check locks and rewrites for the engine in use** (checklist below). On PostgreSQL
   remember the lock queue: an `ALTER TABLE` waiting for its ACCESS EXCLUSIVE lock behind
   a long query blocks every query after it — DDL on a busy table needs a short
   `lock_timeout` (with retry) so it fails fast instead of queueing.
4. **Check reversibility.** A working `down` that does not destroy data, or a documented
   forward-fix. Destructive steps (drop column/table, delete rows, narrowing a type) are
   in a later deploy than the code change that stopped using them, and data is copied or
   archived first.
5. **Check data integrity.** Constraints match the model's validations (NOT NULL,
   unique, foreign keys with a deliberate `ON DELETE`); backfills are idempotent, batched,
   resumable and outside the schema transaction; enum/status additions are additive; the
   migration works on a table that already has rows, including rows that violate the new
   constraint.
6. **Check the tests.** If an AC depends on existing data surviving (a rename, a type
   change, a backfill), a test applies the migration to a database seeded with old-shape
   rows and asserts the data afterwards — an empty-database migration run proves only
   that the SQL parses (the `test-quality-review` skill).
7. **Rate each finding.** Blocking: data loss; a table-rewriting or long-locking statement
   on a table the app writes during deploy; a deploy-order break; an irreversible
   destructive step without a preceding phase; a constraint that fails on existing rows.
   Should-fix: a missing constraint the model assumes; an unbatched backfill on a large
   table. Note: a missing index for a new query (the `sql-query-performance` skill),
   unless that query becomes unbounded on a table that grows with user input (then it
   is blocking under `performance-review`); naming and style. Only blocking and
   should-fix justify `RECOMMEND CHANGES`.
8. **Record each finding** with `record_ac_evidence` (`evidence_type: manual_note`:
   statement, hazard, safe form), then let the `review-ticket` verdict carry the result.

## Checklist

- **Indexes**: PostgreSQL `CREATE INDEX CONCURRENTLY` (not inside a transaction — the
  tool must disable its wrapper; a failed build leaves an INVALID index to drop); MySQL
  InnoDB online DDL (`ALGORITHM=INPLACE, LOCK=NONE`) or a tool such as gh-ost for large
  tables; `DROP INDEX CONCURRENTLY` likewise.
- **Columns**: adding a nullable column or one with a constant default is metadata-only
  (PostgreSQL 11+); a volatile default (`now()`, `random()`), a type change or a stored
  generated column rewrites the table; renames are expand/contract (add, dual-write,
  backfill, switch reads, drop later), never a single `RENAME` under live code.
- **Constraints**: foreign keys and CHECKs added `NOT VALID` then `VALIDATE CONSTRAINT`
  in a separate step; `SET NOT NULL` on a big PostgreSQL table preceded by a validated
  `CHECK (col IS NOT NULL)` (PostgreSQL 12+ then skips the full scan); a unique constraint built from a concurrently created
  unique index (`USING INDEX`).
- **Destructive changes**: phased across deploys (stop writing → stop reading → drop);
  the ORM told to ignore a column before it is dropped.
- **Backfills**: batched by key range with a bounded batch size, idempotent, restartable,
  not in the DDL transaction, not in a request path.
- **SQLite**: `ALTER TABLE` supports only rename table, add column, rename column
  (3.25+) and drop column (3.35+); anything else is a rebuild (create new, copy, swap)
  in one transaction with foreign keys handled.
- **Hygiene**: no application models or callbacks inside migrations (they drift); the
  schema snapshot or lock file regenerated and committed; migration ids ordered and unique.

## Rules

- Simulate the live rollout; the migration runs on production data under load.
- Data loss, long locks on written tables, and deploy-order breaks always block.
- Do not ask for phasing or tooling the table size and traffic do not need — a new,
  empty table has no lock hazard.
- You review; you do not patch. Findings go into evidence, the verdict goes through
  `review-ticket`.
