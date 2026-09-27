---
name: concurrency-and-async
description: Use when a ticket involves work happening at the same time — async/await flows, promises and futures, goroutines and channels, threads and locks, parallel requests, races, deadlocks, "sometimes it double-processes" — and the change must be correct under interleaving, not just on the happy sequence. Invoke for any concurrency bug, any new parallelism, or any shared mutable state.
stack: [node, python, go, java, rust, csharp, kotlin, ruby]
area: backend
---

# Write concurrent code that is correct under interleaving

Concurrency bugs pass every sequential test and then corrupt data in production on a
Tuesday. The discipline is to make shared state either immutable, owned by one party, or
guarded by the mechanism the runtime gives you; to bound every concurrent operation; and
to test the interleavings you fear on purpose.

## Steps

1. **Find the shared state and the ownership.** List every value two concurrent
   activities can touch: a map, a counter, a file, a database row, a cache entry, an
   in-flight request. For each, decide: immutable, single owner (an actor/queue),
   or guarded (mutex, transaction, atomic, compare-and-swap). Call `search_lore` for the
   repo's concurrency conventions (a worker pool, a lock helper, transaction rules).
2. **Prefer the runtime's idiom.** `Promise.all`/`allSettled` with a concurrency limit in
   Node; `asyncio.gather` with semaphores in Python; channels and `errgroup` in Go;
   executors and `CompletableFuture` in Java; `Send`/`Sync`-checked ownership and
   `tokio` tasks in Rust; structured concurrency in Kotlin. Hand-rolled locks are the
   last resort and need a comment saying what they protect.
3. **Bound everything.** Every concurrent fan-out has a limit; every wait has a timeout;
   every retry has a cap; every queue has a maximum depth or backpressure. Unbounded
   parallelism is a denial-of-service against your own dependencies.
4. **Make critical sections small and re-entrant-safe.** Take the lock, do the minimum,
   release. Never await, block on I/O, or call back into user code while holding a lock.
   Never take two locks in different orders in different places.
5. **Use the database for cross-process coordination.** A unique constraint, a
   `SELECT … FOR UPDATE`, a compare-and-swap on a version column, or an advisory lock
   beats an in-memory flag that only one process can see. Idempotency keys make retries
   safe (the `idempotency-and-retries` skill).
6. **Handle cancellation and shutdown.** Propagate cancellation (AbortSignal, context,
   cancellation tokens); on shutdown stop accepting, drain in-flight work with a
   deadline, then exit. A process killed mid-write must leave recoverable state.
7. **Never lose an error in a fan-out.** Collect every failure, decide the policy
   (fail-fast or aggregate), and surface it; an unobserved rejection or a goroutine that
   logs and dies is a silent data loss.
8. **Test the race on purpose.** Run the operation N times in parallel and assert the
   invariant (exactly one winner, total equals sum, no duplicate rows); inject delays
   at the boundaries to force the interleaving; use the language's race detector
   (`go test -race`, `cargo miri`/loom, thread sanitizers) where available. Evidence with
   the `record-evidence` skill.

## Rules

- Shared state is immutable, single-owner, or guarded; there is no fourth option.
- Every fan-out, wait, retry and queue is bounded.
- No I/O or awaits inside a lock; one lock order everywhere.
- Cross-process coordination goes through the database or a real lock service.
- Cancellation propagates; shutdown drains with a deadline.
- Errors in concurrent branches are collected and surfaced, never dropped.
- Race tests exist for every invariant the change relies on.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While reasoning about interleavings you learn the lock order, the queue ownership rules and the races that once bit production.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
