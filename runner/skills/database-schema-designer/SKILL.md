---
name: database-schema-designer
description: Use when designing new database tables from requirements, reviewing a schema for normalisation or performance issues, adding multi-tenancy, planning a breaking migration, or generating TypeScript/Python types from a schema. Triggers on "design the schema", "ERD", "table relationships", "schema migration", "normalise this", or "database model".
stack: [node, python, go, java, rust]
area: data
---

# Design schemas that survive production

A schema is the one place an invariant holds no matter which code path, process or
concurrent request writes. Normalise first, let constraints enforce the rules, index for
the real query patterns, and change it in steps that never block production. Sources:
PostgreSQL docs (constraints, `CREATE INDEX`, `ALTER TABLE`, transaction isolation, row
security); MySQL 8 reference (InnoDB locking, online DDL); Codd's normal forms as taught
in standard database texts.

## Steps

1. **Read the existing schema and conventions.** `search_lore` for the ORM, migration
   tool, naming, key strategy and tenancy model. Extend them; never introduce a second
   pattern.
2. **Model entities and relationships.** Nouns with attributes become tables. State
   cardinality before structure: 1:N → FK on the N side; M:N → junction table with a
   composite primary or unique key on the two FKs; 1:1 → FK with a UNIQUE constraint.
   Sketch the ERD (Mermaid is fine) in the plan or the evidence summary.
3. **Normalise to 3NF for transactional data.** 1NF: atomic values, no repeating groups.
   2NF: no column depends on part of a composite key. 3NF: no column depends on another
   non-key column. Denormalise only for a measured read need, and document who keeps the
   copy consistent (trigger, same-transaction write, or rebuild job).
4. **Write every invariant as a constraint** — the application check alone is a race.
   Under Read Committed (Postgres default) and Repeatable Read (MySQL InnoDB default),
   two transactions can both "check, then insert" and both succeed:
   - uniqueness → `UNIQUE`; conditional ("one active subscription per user") → partial
     unique index `WHERE status = 'active'` (Postgres) or a generated column (MySQL);
   - no overlapping ranges (bookings) → Postgres `EXCLUDE USING gist (room_id WITH =,
     during WITH &&)` with `btree_gist`, or serialise via `SELECT … FOR UPDATE` on a parent;
   - value rules (`amount >= 0`, allowed states) → `CHECK`; references → FK with an
     explicit `ON DELETE` (`RESTRICT` unless cascade is truly intended);
   - counters and balances → a single `UPDATE … SET n = n + :d WHERE … AND n + :d >= 0`,
     never read-modify-write in application code; concurrent edits to one row →
     optimistic `version` column (`UPDATE … WHERE id = ? AND version = ?`, 0 rows → `409`).
   Map constraint violations to a domain error (`409`/`422`), not a `500`. If you use
   `SERIALIZABLE`, retry on SQLSTATE `40001`.
5. **Choose types that cannot drift.** Timestamps `timestamptz` (MySQL: UTC `DATETIME`
   by convention); money as `numeric`/integer minor units, never float; `text` with a
   `CHECK` length over arbitrary `varchar(n)` in Postgres; enums via `CHECK` or a lookup
   table (easier to extend than a native enum). Keys: `bigint` identity for single-node,
   UUIDv7 (time-ordered, index-friendly; Postgres 18 has `uuidv7()`) when ids are
   generated outside the database. `NOT NULL` by default; nullable only with a meaning.
   Absent a repo convention: `created_at`/`updated_at timestamptz NOT NULL DEFAULT now()`
   on every table; soft delete as a nullable `deleted_at` with partial indexes and
   unique keys `WHERE deleted_at IS NULL`; and an append-only audit table (`entity_type`,
   `entity_id`, `action`, `actor_id`, `changed_at`, `before`, `after`) for user-facing
   data with compliance implications.
6. **Tenancy.** `tenant_id NOT NULL` on every tenant-scoped table, leading in composite
   unique keys and indexes; composite FKs `(tenant_id, parent_id)` make cross-tenant
   references impossible. With Postgres RLS: `ENABLE` and `FORCE ROW LEVEL SECURITY`
   (owners bypass otherwise) and connect as a non-owner role.
7. **Index for the query patterns in the ticket.** Postgres does not index FK columns
   automatically (InnoDB does): add them. Composite indexes: equality columns, then range,
   then sort. Partial indexes for hot subsets. Every index costs every write; add none
   without a query that needs it (the `sql-query-performance` skill).
8. **Migrate without blocking** (mechanics: the `add-db-migration` skill; review: the
   `migration-review` skill). Set `lock_timeout` for DDL. See the table below.
9. **Generate types from the schema** (Prisma/Drizzle/sqlc/SQLAlchemy/pydantic tooling
   the repo uses); never hand-write a parallel model.

## Migration safety (Postgres; MySQL: prefer `ALGORITHM=INSTANT/INPLACE, LOCK=NONE`)

| Change                               | Safe pattern                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Add nullable column                  | Safe.                                                                                                 |
| Add column with constant default     | Safe on PG 11+ (metadata only); volatile defaults rewrite the table.                                  |
| Make column `NOT NULL`               | Backfill in batches; `ADD CHECK (c IS NOT NULL) NOT VALID`; `VALIDATE`; then `SET NOT NULL` (PG 12+). |
| Add FK or CHECK                      | `ADD CONSTRAINT … NOT VALID`, then `VALIDATE CONSTRAINT` in a later step.                             |
| Add index                            | `CREATE INDEX CONCURRENTLY`, outside a transaction; if it fails, drop the `INVALID` index and retry.  |
| Rename / drop column, change type    | Expand-contract across deploys: add new, dual-write, backfill, switch reads, drop old.                |

## Tests

- Migrations apply up (and down, if the repo supports it) on a fresh database and on
  one seeded with representative data.
- **Concurrency per invariant:** N parallel transactions attempting to violate it (two
  active subscriptions, overlapping bookings, overdraft) → exactly the allowed number
  commit; the rest get the domain error, none a `500`. Run against the real engine, not
  an in-memory substitute with different semantics (the `concurrency-and-async` skill's
  step 9 recipe).
- `EXPLAIN` on the ticket's main queries shows the intended indexes.

## Done when

The ERD and DDL match the requirements, every invariant is a constraint with a
concurrency test, migrations follow the safety table, types are generated, and each
acceptance criterion has evidence via the `record-evidence` skill.

## Review checklist

- [ ] 3NF, or denormalisation documented with its consistency mechanism.
- [ ] Every business invariant enforced by a constraint, not only application code.
- [ ] FKs indexed (Postgres) with an explicit `ON DELETE`.
- [ ] Types: `timestamptz`, exact money, `NOT NULL` by default.
- [ ] Tenant id in keys, composite FKs, RLS forced if used.
- [ ] Non-blocking migration steps; `lock_timeout` set.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While modelling tables you learn the ORM, the migration tool, the key strategy, the tenancy and RLS model and the invariants the schema enforces.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
