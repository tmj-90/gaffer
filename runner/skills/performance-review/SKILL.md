---
name: performance-review
description: Use as a REVIEW LENS when judging another agent's diff for performance regressions — N+1 queries, unbounded loops or fan-outs, missing indexes, blocking calls on hot paths, unbounded memory, bundle growth, needless re-renders — before recommending approval. Invoke on every review of a ticket that touches data access, request handling, loops over collections, concurrency, or frontend rendering; it complements review-ticket, it does not replace it.
stack: []
area: review
---

# Performance review lens

Performance regressions ship because each looks reasonable alone: one more query in a
loop, one more sequential `await`, one more import. For every new hot-path line ask: how
many times does this run, what does each run cost, and what bounds it? A finding is a
concrete defect only when it is **unbounded** (grows with input an outside party
controls), **stalls an async server's request path** (a synchronous I/O call, an outbound
call with no timeout), or **measurably breaks a budget** the repo or an AC states;
everything else is a note. Write the arithmetic into every finding.

## Steps

1. **Find the hot paths in the diff**: request and job handlers, loops over collections
   whose size is not fixed, render functions, anything called per item or per request.
   Skip one-off setup unless it runs at startup of a hot service. Call `search_lore` for
   known hot spots, budgets and the expected data sizes.
2. **Count and cost each path** against the checklist: "this query runs once per order
   on the page; a page holds up to 200 orders; that is 201 queries per request". Use the
   largest size the code allows, not the size in the test fixture.
3. **Check the bound.** Is the collection capped (pagination, `LIMIT`, a max upload
   size, a validated array length)? If a user, tenant or upstream can make it arbitrarily
   large, the work and memory are unbounded.
4. **Check performance claims.** A ticket whose AC promises a speedup or a latency target
   needs before/after numbers under stated conditions with repeated runs (the
   `performance-profiling` skill); without them that AC is unevidenced.
5. **Rate each finding.** Blocking: unbounded work or memory reachable from input; an N+1
   on a list path whose size is unbounded; a blocking call on the
   request path of an async server; a missing timeout on an outbound call in a request
   path; a budget the repo or an AC enforces being broken. Note: a bounded regression
   that breaks no stated budget, or an optimisation opportunity. Only blocking findings
   justify `RECOMMEND CHANGES`.
6. **Record each finding** with `record_ac_evidence` (`evidence_type: manual_note`, with
   the arithmetic and the fix), then let the `review-ticket` verdict carry the result.

## Checklist

- **Queries**: no query per item in a loop — lazy relations loaded in a loop are the
  usual cause (Django `select_related`/`prefetch_related`, Rails `includes`, JPA fetch
  joins or entity graphs, Prisma `include`, SQLAlchemy `selectinload`); list queries
  paginated with a limit and an index-backed sort (the `pagination-and-filtering` skill);
  new `WHERE`/`ORDER BY`/join columns covered by an index in a migration (the
  `sql-query-performance` skill); no `SELECT *` of wide rows on hot paths; a query-count
  test where the repo has the pattern.
- **Fan-out and loops**: concurrent fan-out bounded (a pool, semaphore or `p-limit`),
  never `Promise.all` over an unbounded user list; independent awaits not serialised in a
  loop when order does not matter; nested loops over two collections checked for
  quadratic growth (a lookup map instead of `find` inside `map`).
- **Blocking and waiting**: no synchronous file, network, crypto or compression calls on
  an async request path (`readFileSync`, `bcrypt.hashSync`, `requests` inside `async
  def`); no `sleep` in request paths; outbound calls have timeouts; retries are capped
  with backoff.
- **Memory**: no reading whole files, tables or result sets into memory when streaming
  or pagination works; caches bounded by size or TTL; no per-request allocation of large
  buffers; no module-level collection that grows per request.
- **Caching**: keys cover every input that changes the result (tenant, user, locale);
  invalidation on write exists (the `caching-strategy` skill); removed caches justified.
- **Payloads and logging**: responses exclude fields the client does not use; large
  lists paginated; hot-path logs do not serialise large objects.
- **Frontend**: bundle growth checked against the repo's budget; heavy or rarely used
  imports code-split; state updates do not re-render large trees on every keystroke;
  lists over a few hundred rows virtualised; images sized and lazy-loaded; no layout
  thrash in effects (the `frontend-performance` skill).
- **Startup and build**: new work at process start justified; a new dependency's size
  noted.

## Rules

- Count and cost every hot-path line; the arithmetic goes in the finding.
- Unbounded work or memory reachable from input always blocks.
- Optimisations the ticket did not ask for are notes, never grounds for CHANGES.
- You review; you do not patch. Findings go into evidence, the verdict goes through
  `review-ticket`.
