---
name: performance-profiling
description: Use when a ticket is about speed or resource use — a slow endpoint, a hot loop, memory growth, a test suite that takes too long, "make X faster" — and the change must be driven by a measurement, not a hunch, and proven with a before/after number under the same conditions. Invoke for latency, throughput, CPU, memory, bundle size, or startup-time work.
stack: [node, python, go, java, rust, csharp, kotlin, ruby, react, web]
area: backend
---

# Profile before you optimise

Performance work without a measurement is refactoring with a story attached. Reproduce
the slowness, profile it, fix what the profile points at, and show the same measurement
afterwards. Most wins come from doing less work (fewer queries, allocations, bytes), not
cleverer code. Sources: Brendan Gregg (USE method, flame graphs); Gil Tene on coordinated
omission; Google SRE book ch. 6 (percentiles, not averages); the `benchstat`/`hyperfine`
documentation on repeated runs and variance.

## Steps

1. **Define the number and the target.** Metric, percentile, load and environment:
   "p95 of `GET /orders` ≤ 200 ms at 50 req/s open-model load", "job wall time",
   "heap after 10k iterations", "gzipped bundle bytes". Averages hide tails; report
   p50/p95/p99. Write it down before changing code; the acceptance criterion should be
   this number. Call `search_lore` for known hot spots and past decisions.
2. **Build a reproducible harness.** Use the repo's tooling (`autocannon`, `k6`,
   `wrk2`, `pytest-benchmark`, `go test -bench`, `hyperfine`, JMH, `criterion`): fixed
   inputs, realistic data volume, warm-up, and enough repetitions to see variance
   (≥ 10 runs or the tool's statistical mode). For latency under load use an
   open-model / constant-arrival-rate generator (`k6` `constant-arrival-rate`, `wrk2
   -R`): closed-loop tools that wait for each response under-report tail latency
   (coordinated omission). Record the exact command and machine. Use only tools already
   installed; never install one (npm/pip installs are hook-blocked; `go install`,
   `cargo install`, `uv`/`pipx` and a fetching `npx` are not blocked but are equally
   forbidden; `node_modules` is shared). If a needed tool is missing, say so in the
   evidence and use what exists.
3. **Find the bottleneck resource first.** For each resource (CPU, memory, disk,
   network, connection pools, locks) check utilisation, saturation and errors (USE). A
   request waiting on a pool or a lock is not a CPU problem.
4. **Profile, do not guess.** CPU: `node --cpu-prof`, `py-spy record`, `go tool pprof`,
   `perf` + flame graph, `async-profiler`. Memory: heap snapshots / allocation profiles
   taken at two points to see what grows. Database: query log with timings and
   per-request query count. Frontend: the bundler's analyzer. Fix the widest frame in the
   flame graph; if the profile disagrees with your hunch, the profile is right.
5. **Fix the top item with the least clever change.** Usual order: remove an N+1 (batch
   or join), add the index the plan wants (the `sql-query-performance` skill), stop
   serialising unused data, stream instead of buffering, cache a pure or hot read (the
   `caching-strategy` skill), move work off the request path (the `background-jobs`
   skill). Algorithmic rewrites and micro-optimisations last.
6. **Keep behaviour identical, including under concurrency.** Run the full suite. A
   new cache, batch boundary, memoisation or parallelism is a new code path: test it
   directly, including concurrent callers (stale reads, lost updates, shared mutable
   state; the `concurrency-and-async` skill). Never drop a validation, authorisation
   check or lock to win time.
7. **Measure again under identical conditions** and compare distributions, not single
   runs: same command, data and machine, repeated; use the tool's comparison
   (`benchstat old.txt new.txt`, `hyperfine` with several commands) and report the
   change with its variance. A difference within noise is not a result. If the target
   is not met, say so and what the profile shows now.
8. **Guard the win with a deterministic check.** Prefer assertions that do not flake on
   shared CI hardware: query count per request, allocation count, bundle-size budget,
   algorithmic complexity on a fixed input. Wall-clock assertions only with generous
   margins or on dedicated runners.

## Done when

Baseline and after numbers exist for the same command under the same conditions with
variance reported, the target is met (or the shortfall is stated with the current
profile), the suite passes, a regression guard is in place, and each acceptance
criterion has evidence via the `record-evidence` skill (command, baseline, profile top
entries, change, after numbers).

## Anti-patterns

- Optimising code the profile shows is cold; "it looked slow".
- Benchmarks on ten rows, cold caches, or a single run; closed-loop latency tests.
- Averaging percentiles across runs or hosts (merge histograms instead).
- Caches with no invalidation story or no bound on size.
- Timing assertions that make CI flaky.

## Review checklist

- [ ] Metric, percentile, load and target stated before the change.
- [ ] Profile evidence identifies the fixed hotspot.
- [ ] Before/after from the same harness with repeated runs and variance.
- [ ] New code paths (cache, batch, parallelism) tested, including concurrent use.
- [ ] A deterministic regression guard exists.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While profiling you learn where this repo is actually hot and what a change to that path costs in measured terms.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
