---
name: migration-review
description: Use as a REVIEW LENS when judging another agent's diff that changes a database schema or data — a migration, a backfill, a dropped or renamed column, an index, a constraint — for irreversibility, locking, data loss, and deploy-order hazards before recommending approval. Invoke on every review whose diff touches a migrations directory, an ORM schema, or a data script; it complements review-ticket and the builder's add-db-migration skill.
stack: []
area: review
---

# Migration review lens

A schema change is the one part of a deploy you cannot roll back with a redeploy. The
reviewer asks of every migration: what happens on the live database at the moment it
runs (locks, rewrites, duration), what happens if the deploy is halfway (old code
against the new schema), and how do we get back. Findings here are correctness defects
with production consequences.

## Steps

1. **Identify every schema and data change in the diff**: migration files, ORM model
   changes that generate migrations, seed or backfill scripts, changes to queries that
   assume the new schema. Call `search_lore` for the repo's migration conventions
   (online-migration rules, deploy order, the database engine and version).
2. **Simulate the deploy.** Old code runs against the new schema until the rollout
   completes; new code may briefly run against the old schema. Does every combination
   work? A renamed or dropped column read by old code breaks the deploy; a NOT NULL
   column added without a default breaks old inserts.
3. **Check locking and duration** for the engine in use: adding an index without
   `CONCURRENTLY` (Postgres) or online DDL (MySQL) locks writes; adding a column with a
   volatile default or changing a column type rewrites the table; a backfill in one
   transaction over millions of rows holds locks and bloats; `ALTER` on a hot table
   during peak is an outage.
4. **Check reversibility and safety.** Is there a working `down` (or a documented
   forward-fix) that does not destroy data? Are destructive steps (drop column, drop
   table, delete rows) separated from additive steps and preceded by the stop-reading
   deploy? Is data preserved or archived before a destructive step?
5. **Check data integrity.** Constraints match the model's validations (NOT NULL,
   unique, foreign keys with the right `ON DELETE`); backfills are idempotent and
   batched; new columns have sensible defaults; enum/status additions are additive.
6. **Check the migration is a migration.** No application logic or model callbacks
   inside migrations (they drift); raw SQL where the ORM cannot express the safe form;
   the schema snapshot regenerated and committed; the migration tested against a copy
   of a realistic database if the repo has the tooling.
7. **Rate each finding.** Blocking: data loss, a lock on a hot table, a deploy-order
   break (old code fails against new schema or vice versa), an irreversible destructive
   step without a preceding phase. Should-fix: missing index for a new query, missing
   constraint the model assumes, unbatched backfill on a large table. Note: naming and
   style. Only blocking and should-fix justify `RECOMMEND CHANGES`.
8. **Record the findings as evidence** with `record_ac_evidence` (`manual_note` per
   finding), then let the `review-ticket` verdict carry the result.

## Checklist

- Old code ↔ new schema and new code ↔ old schema both work during rollout.
- Indexes created online; no table rewrites on hot tables during the deploy window.
- Destructive changes phased (stop write → stop read → drop) across deploys.
- Backfills idempotent, batched, and resumable; not inside the schema migration.
- Constraints and defaults present; foreign keys with deliberate `ON DELETE`.
- `down` works or a forward-fix is documented; data preserved before destruction.
- No ORM callbacks or app logic in migrations; schema snapshot committed.
- New queries have the indexes they need (the `sql-query-performance` skill).

## Rules

- Simulate the live deploy; the migration runs on production data under load.
- Data loss, hot-table locks, and deploy-order breaks always block.
- You review; you do not patch. Findings go into evidence, the verdict goes through
  `review-ticket`.
