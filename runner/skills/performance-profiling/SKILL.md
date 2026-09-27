---
name: performance-profiling
description: Use when a ticket is about speed or resource use — a slow endpoint, a hot loop, memory growth, a test suite that takes too long, "make X faster" — and the change must be driven by a measurement, not a hunch, and proven with a before/after number under the same conditions. Invoke for latency, throughput, CPU, memory, bundle size, or startup-time work.
stack: [node, python, go, java, rust, csharp, kotlin, ruby, react, web]
area: backend
---

# Profile before you optimise

Performance work without a measurement is refactoring with a story attached. Reproduce
the slowness, profile it, fix the thing the profile points at, and show the same
measurement afterwards. Most wins come from doing less work (fewer queries, fewer
allocations, less data over the wire), not from cleverer code.

## Steps

1. **Define the number.** What is slow, measured how, from where, against what target?
   p95 latency of an endpoint under N concurrent requests, wall time of a job, heap after
   M iterations, bundle bytes gzipped. Write it down before touching code; the ticket's
   acceptance criterion should be this number. Call `search_lore` for known hot spots
   and past performance decisions.
2. **Reproduce under controlled conditions.** A benchmark or load script in the repo's
   tooling (`autocannon`, `k6`, `pytest-benchmark`, `go test -bench`, `hyperfine`,
   `criterion`), fixed inputs, warmed up, repeated enough runs to see the variance.
   Record the baseline with the exact command.
3. **Profile, do not guess.** CPU profile (`--cpu-prof`, `py-spy`, `pprof`, `perf`,
   `async-profiler`), allocation/heap profile for memory, query logs with timings for
   database work, the bundler's analyzer for frontend size. Find the top of the profile.
   If the profile does not agree with your hunch, the profile is right.
4. **Fix the top item with the least clever change.** Typical wins in order: eliminate
   an N+1 (batch or join), add the missing index (the `sql-query-performance` skill),
   cache a pure computation or a hot read (the `caching-strategy` skill), stream instead
   of buffering, move work off the request path (the `background-jobs` skill), stop
   serialising what the client does not use. Algorithmic rewrites come last.
5. **Keep behaviour identical.** Performance changes must not change results: run the
   full suite, and add a test if the optimisation introduced a new code path (a cache, a
   batch boundary) that could diverge.
6. **Measure again under the same conditions** and report before/after with the
   variance. One faster run is noise; a consistent shift across repeated runs is a
   result. If the target is not met, say so and what the profile now shows.
7. **Guard the win** where the repo has a mechanism: a benchmark assertion, a bundle-size
   budget, a query-count assertion in a test. Otherwise note the number in the code
   comment near the optimisation so a future change knows what it protects.
8. **Evidence** with the `record-evidence` skill: baseline command and numbers, the
   profile's top entries, the change, the after numbers.

## Rules

- No optimisation without a baseline measurement and a target.
- Profile first; fix what the profile shows, not what looks slow.
- Do less work before doing work faster; algorithmic cleverness last.
- Behaviour unchanged, proven by the suite; new paths get tests.
- Report before/after with repeated runs, same conditions, and variance.
- Never trade correctness, security checks, or readability for a number the ticket did
  not ask for.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While profiling you learn where this repo is actually hot and what a change to that path costs in measured terms.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
