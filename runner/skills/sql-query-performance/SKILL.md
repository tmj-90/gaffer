---
name: sql-query-performance
description: Use when a ticket is about a slow or expensive database query — a timeout, an N+1, a missing index, a report that locks the table, "the list page takes 8 seconds" — and the fix must be driven by the query plan and proven with before/after timings on realistic data. Invoke for any query optimisation, index addition, or ORM-generated SQL problem.
stack: [node, python, go, java, rust, csharp, kotlin, ruby]
area: data
---

# Make a slow query fast

The database already knows why the query is slow; ask it. Read the plan, find the scan,
loop or sort that dominates, change the query or add the index the plan needs, and
measure again on data shaped like production. Most slow queries are an N+1, a missing
or wrong-order index, a function or type cast on an indexed column, a wide `SELECT *`,
an `OFFSET` walk, or stale statistics. Sources: PostgreSQL docs ("Using EXPLAIN",
indexes, `pg_stat_statements`, explicit locking); MySQL 8 reference (`EXPLAIN ANALYZE`,
optimisation, InnoDB locking); Markus Winand, _Use The Index, Luke_.

## Steps

1. **Capture the real SQL and its frequency.** From the ORM query log, the slow-query
   log, `pg_stat_statements` (total and mean time) or `performance_schema`, with real
   parameter values. An ORM call is not a query. Count queries per request: fifty fast
   queries make one slow page. Call `search_lore` for hot tables and index conventions.
2. **Build production-shaped data.** Seed row counts, value distributions and skew
   comparable to production (`generate_series` or the repo's fixture factories, the
   `test-fixtures-and-factories` skill), then run `ANALYZE`. A plan on ten rows lies.
3. **Read the plan.** Postgres: `EXPLAIN (ANALYZE, BUFFERS)`; MySQL 8.0.18+:
   `EXPLAIN ANALYZE` (or `EXPLAIN FORMAT=TREE`); SQLite: `EXPLAIN QUERY PLAN`.
   `ANALYZE` executes the statement: wrap `INSERT/UPDATE/DELETE` in `BEGIN; … ROLLBACK;`.
   Look for: sequential scans filtering most rows away, nested loops with large outer
   row counts, sorts or hashes spilling to disk, estimated vs actual rows off by 10× or
   more (stale or missing statistics; try `ANALYZE` or extended statistics), and heap
   fetches on an intended index-only scan (vacuum/visibility map).
4. **Fix N+1 first.** Load related rows in one query (join, `IN (…)`/`= ANY($1)` batch,
   the ORM's eager loading or a dataloader) and pin it with a query-count assertion.
5. **Add the index the plan needs, and only that.** Composite order: equality columns,
   then the range column, then the sort columns in the query's direction. Covering
   (`INCLUDE`) for hot read paths, partial for selective predicates. One index per access
   pattern; every index costs every write. Ship it through the migration path (the
   `add-db-migration` skill): `CREATE INDEX CONCURRENTLY` outside a transaction in
   Postgres (drop and retry if it leaves an `INVALID` index), online DDL in MySQL.
6. **Make predicates sargable.** No function or cast on the indexed column (`WHERE
   created_at >= :day_start AND created_at < :next_day`, not `date(created_at) = :d`),
   or index the expression; match parameter types to column types (MySQL string-vs-int
   comparisons defeat indexes); no leading-wildcard `LIKE` (use trigram or full-text);
   split `OR` across different columns into `UNION ALL` when the plan shows a scan;
   select only needed columns; replace `OFFSET` walks with keyset pagination (the
   `pagination-and-filtering` skill).
7. **Protect the write path and other sessions.** Long reports and bulk updates hold
   locks and snapshots: set `statement_timeout`/`lock_timeout` (or `max_execution_time`),
   batch large `UPDATE`/`DELETE` in keyed chunks with a commit per chunk, and move heavy
   reads to a replica, a materialised view refreshed on a schedule (the `scheduled-jobs`
   skill; `REFRESH MATERIALIZED VIEW CONCURRENTLY` needs a unique index), or a summary
   table maintained by the writes.
8. **Measure again** with the same data and tool: before/after plan and timing over
   repeated runs (discard the first cold run or report cold and warm separately). If the
   new index does not appear in the plan, drop it.

## Tests

- A query-count assertion per fixed endpoint (N+1 cannot return).
- The optimised query returns exactly the same rows, in the same order, as before, on
  the seeded dataset, including NULLs, ties and empty results.
- Where the repo supports it, a plan assertion (index name present, no seq scan on the
  large table) against seeded data.
- **Concurrency:** for chunked writes or rewritten updates, run the job alongside
  concurrent application writes and assert no lost updates and no deadlock-induced
  failure that is not retried.

## Done when

The plan shows the intended access path on production-shaped data, repeated timings meet
the target, results are unchanged, a regression guard exists, and each acceptance
criterion has evidence via the `record-evidence` skill: the SQL, both plans, both
timings and the migration.

## Review checklist

- [ ] Real SQL and realistic data; plans before and after attached.
- [ ] N+1 removed and pinned by a query-count test.
- [ ] Index order matches equality → range → sort; created online; unused indexes dropped.
- [ ] Predicates sargable; types match; no `OFFSET` walk on large tables.
- [ ] Timeouts and chunking protect other sessions; heavy reads off the write path.
- [ ] Result equivalence tested.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While reading the plan you learn which tables are hot, which indexes exist for which access patterns and what must never be done on table X.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
