---
name: database-schema-designer
description: Use when designing new database tables from requirements, reviewing a schema for normalisation or performance issues, adding multi-tenancy, planning a breaking migration, or generating TypeScript/Python types from a schema. Triggers on "design the schema", "ERD", "table relationships", "schema migration", "normalise this", or "database model".
stack: [node, python, go, java, rust]
area: data
---

# Design schemas that survive production

Normalise first. Index for query patterns. Never sacrifice data integrity for convenience.

## Design process

### Step 1 — Requirements → Entities

Extract nouns from the requirement. Each noun that has attributes and participates in relationships is likely an entity. Resist making everything a single wide table.

### Step 2 — Relationships

Identify cardinality before choosing the table structure:

| Relationship | Implementation |
|-------------|---------------|
| 1:1 | Foreign key on the less-common side (or same table if always loaded together) |
| 1:N | Foreign key on the N side |
| M:N | Junction table with FK to both sides; add attributes to the junction if needed |

### Step 3 — Normalisation

Target 3NF for transactional data:

1. **1NF** — atomic values; no repeating groups; primary key identifies each row.
2. **2NF** — no partial dependencies (non-key column depends on the whole PK, not a subset).
3. **3NF** — no transitive dependencies (non-key column depends only on the PK, not on another non-key column).

Denormalise deliberately for read-heavy analytics tables — document the trade-off.

## Standard conventions

- Primary key: `id` (UUID v7 for distributed systems; BIGSERIAL for single-node).
- Timestamps: `created_at TIMESTAMPTZ DEFAULT now()`, `updated_at TIMESTAMPTZ DEFAULT now()`.
- Soft delete: `deleted_at TIMESTAMPTZ` nullable — add a partial index `WHERE deleted_at IS NULL`.
- Audit trail: separate `audit_log` table with `entity_type`, `entity_id`, `action`, `actor_id`, `changed_at`, `before`, `after`.
- Multi-tenancy: `tenant_id` on every tenant-scoped table; composite primary key or FK constraint; RLS policy.

## Index strategy

- Index every foreign key (databases do not do this automatically).
- Add composite indexes for the most common `WHERE col1 = ? AND col2 = ?` patterns.
- Partial indexes for filtered queries (`WHERE deleted_at IS NULL`, `WHERE status = 'active'`).
- Covering indexes (`INCLUDE (col)`) to avoid heap lookups on hot read paths.
- Drop indexes that are never used — they slow writes.

## Migration safety

| Change | Safe? | Notes |
|--------|-------|-------|
| Add nullable column | Yes | |
| Add NOT NULL with default | Risky on large tables | Add nullable, backfill, add constraint |
| Rename column | No | Add new, backfill, drop old — across deploys |
| Drop column | No | Mark unused, deploy, then drop |
| Add index | Yes (CONCURRENT) | `CREATE INDEX CONCURRENTLY` — never blocking |
| Change column type | No | New column + backfill pattern |

## Steps

1. **Read the lore + existing schema.** `search_lore` for ORM conventions, migration tool (Drizzle/Prisma/Alembic), naming rules, and existing patterns. Extend; don't contradict.
2. **Extract entities and relationships** from the requirements. Draw the ERD (Mermaid is fine) before writing DDL.
3. **Normalise to 3NF.** Document any deliberate denormalisation.
4. **Write migrations.** Use the repo's migration tool. Each migration: one logical change, reversible (`up`/`down`), idempotent.
5. **Add indexes.** At minimum: every FK; composite for the top query patterns identified from the ticket.
6. **Generate types.** Derive TypeScript interfaces or Python Pydantic models from the schema — do not hand-write them separately.
7. **Verify.** Run migrations against a real database; confirm `EXPLAIN ANALYZE` on the primary query patterns shows index scans, not sequential scans. Record evidence.

## Review checklist

- **3NF achieved** — no partial or transitive dependencies, or denormalisation is documented.
- **Every FK indexed** — check `pg_indexes` or equivalent.
- **Migrations reversible** — `down` migration exists and tested.
- **No blocking DDL** — index creation uses `CONCURRENTLY`; large table alterations use the add-backfill-constraint pattern.
- **Timestamps on every table** — `created_at`, `updated_at`.
- **Types generated** — not hand-written from the schema.

## Rules

- Never rename a column in a single migration on a live table — three-deploy pattern only.
- `CREATE INDEX CONCURRENTLY` always — blocking index creation on production tables is a SEV2.
- Audit trail for every table that stores user-facing data with compliance implications.

## Capture lore

ORM choice, migration tool, naming conventions, UUID strategy, and RLS policy are high-value schema lore — call `suggest_lore` with `tags: [database, schema, migrations]`.
