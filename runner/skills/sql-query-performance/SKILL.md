---
name: sql-query-performance
description: Use when a ticket is about a slow or expensive database query — a timeout, an N+1, a missing index, a report that locks the table, "the list page takes 8 seconds" — and the fix must be driven by the query plan and proven with before/after timings on realistic data. Invoke for any query optimisation, index addition, or ORM-generated SQL problem.
stack: [node, python, go, java, rust, csharp, kotlin, ruby]
area: data
---

# Make a slow query fast

The database already knows why the query is slow; ask it. Read the plan, find the scan
or the loop, fix the query or add the index the plan wants, and measure again on data
shaped like production. Most slow queries are one of five things: an N+1, a missing
index, a function on an indexed column, a `SELECT *` over a wide table, or a sort
without an index.

## Steps

1. **Capture the real SQL.** From the ORM's query log or the slow-query log, with real
   parameters and the time it took. An ORM call is not a query; the SQL it emits is.
   Count the queries per request too: fifty fast queries are one slow page. Call
   `search_lore` for known hot tables and index conventions.
2. **Explain it on realistic data.** `EXPLAIN (ANALYZE, BUFFERS)` (Postgres),
   `EXPLAIN ANALYZE` (MySQL), `EXPLAIN QUERY PLAN` (SQLite) against a dataset with
   production-like cardinality; a plan on ten rows lies. Look for sequential scans on
   large tables, nested loops with high row counts, sorts that spill, and row estimates
   far from actuals (stale statistics).
3. **Fix N+1 first.** Load the related rows in one query (a join or an `IN (...)` batch,
   the ORM's eager loading) and assert the query count in a test so it cannot regress.
4. **Add the index the plan wants.** Composite indexes in the order of equality
   predicates then range then sort; covering indexes for hot read paths; partial indexes
   for selective flags. One index per access pattern, not one per column; every index
   costs every write. Create it via the repo's migration path (the `add-db-migration`
   skill), concurrently/online where the database supports it.
5. **Make the query index-able.** No functions or casts on the indexed column in the
   predicate (compute on the parameter instead), `WHERE` on the stored form, avoid
   leading wildcards, select only the columns you use, paginate with keysets (the
   `pagination-and-filtering` skill).
6. **Consider the write side.** A report that locks or bloats a hot table moves to a
   read replica, a materialised view refreshed on a schedule (the `scheduled-jobs`
   skill), or a precomputed table maintained by the writes.
7. **Measure again** on the same data with the same tool; report before/after plan and
   timing across repeated runs. If the index is unused in the plan, remove it; an index
   that does not change the plan is pure write cost.
8. **Guard it**: a test asserting the query count, and where the repo supports it, a
   plan or timing assertion. Evidence with the `record-evidence` skill: the SQL, both
   plans, both timings, the migration.

## Rules

- The plan decides, on production-shaped data; no index added on a hunch.
- N+1 eliminated and pinned by a query-count test.
- Indexes follow access patterns (equality, range, sort), created online via a
  migration; unused indexes are removed.
- Predicates keep indexed columns bare; select only needed columns; keyset paging.
- Heavy reads move off the write path (replica, materialised view) rather than
  locking it.
- Before/after measured on the same data with repeated runs.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While reading the plan you learn which tables are hot, which indexes exist for which access patterns and what must never be done on table X.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
