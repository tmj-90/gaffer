---
name: performance-review
description: Use as a REVIEW LENS when judging another agent's diff for performance regressions — N+1 queries, unbounded loops or fan-outs, missing indexes, blocking calls on hot paths, unbounded memory, bundle growth, needless re-renders — before recommending approval. Invoke on every review of a ticket that touches data access, request handling, loops over collections, concurrency, or frontend rendering; it complements review-ticket, it does not replace it.
stack: []
area: review
---

# Performance review lens

Performance regressions ship because each one looks reasonable in isolation: one more
query in a loop, one more await in sequence, one more library import. The reviewer asks
of every new hot-path line: how many times does this run, what does it cost each time,
and what bounds it? A finding here is a concrete defect only when it is measurable or
plainly unbounded; otherwise it is a note.

## Steps

1. **Find the hot paths in the diff.** Request handlers, job handlers, loops over
   collections whose size is not fixed, render functions, anything called per item or
   per request. Ignore one-off setup code unless it runs at startup on a hot service.
   Call `search_lore` for known hot spots and budgets.
2. **Walk the checklist against those paths**, estimating counts: "this query runs once
   per order in the page; a page is up to 200 orders; that is 200 queries". Write the
   arithmetic in the finding.
3. **Rate each finding.** Blocking: unbounded work or memory reachable from user input,
   a demonstrable N+1 on a list path, a blocking call on the request path of an async
   server, a budget the repo enforces being broken. Should-fix: a measurable regression
   the ticket did not need. Note: an opportunity. Only blocking and should-fix findings
   justify `RECOMMEND CHANGES`.
4. **Ask for the measurement when the ticket claims a speedup.** A performance ticket
   without before/after numbers under stated conditions has not met its acceptance
   criterion (the `performance-profiling` skill).
5. **Record the findings as evidence** with `record_ac_evidence` (`manual_note` per
   finding with the arithmetic), then let the `review-ticket` verdict carry the result.

## Checklist

- **Queries**: no query inside a loop over a variable-size collection (N+1); list
  queries paginated with limits and index-backed sorts (the `pagination-and-filtering`
  skill); new filters and sorts have matching indexes via a migration; `SELECT *` on
  wide tables avoided on hot paths; a query-count test where the repo has the pattern.
- **Fan-out and loops**: every concurrent fan-out bounded; nested loops over collections
  checked for quadratic growth; work per item constant or justified.
- **Blocking**: no synchronous file/network/crypto calls on an async request path; no
  `sleep`; no lock held across I/O.
- **Memory**: no reading whole files or result sets into memory when streaming is
  possible; caches bounded (size or TTL); no per-request allocation of large buffers;
  no unbounded collections that outlive the request.
- **Caching**: added caches have keys covering all inputs and an invalidation path (the
  `caching-strategy` skill); removed caches justified.
- **Serialisation and payloads**: responses do not include fields the client does not
  use; large payloads compressed or paginated; logging does not serialise large objects
  on hot paths.
- **Frontend**: bundle growth checked against the budget; heavy imports code-split;
  components re-rendering on every keystroke or scroll called out; lists over ~100 items
  virtualised; images sized and lazy-loaded; no layout thrash in effects (the
  `frontend-performance` skill).
- **Startup and build**: new work at process start justified; new dependencies' size
  noted.
- **Claims**: any "faster" claim has numbers, conditions, and repeated runs.

## Rules

- Count and cost every hot-path line; write the arithmetic into the finding.
- Unbounded work or memory reachable from input always blocks.
- Optimisation opportunities the ticket did not ask for are notes, never grounds for
  CHANGES.
- You review; you do not patch. Findings go into evidence, the verdict goes through
  `review-ticket`.
