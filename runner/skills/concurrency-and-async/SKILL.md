---
name: concurrency-and-async
description: Use when a ticket involves work happening at the same time — async/await flows, promises and futures, goroutines and channels, threads and locks, parallel requests, races, deadlocks, "sometimes it double-processes" — and the change must be correct under interleaving, not just on the happy sequence. Invoke for any concurrency bug, any new parallelism, any shared mutable state, or any code where two requests, workers or processes can write the same file, row, counter or lock.
stack: [node, python, go, java, rust, csharp, kotlin, ruby]
area: backend
---

# Write concurrent code that is correct under interleaving

Concurrency bugs pass every sequential test. Live builds of the same app twice shipped
the same class past review: fixed temp-file names colliding under parallel requests
(HTTP 500), unsynchronised read-modify-write losing updates, and a time-only stale-lock
lease that dropped an **acknowledged** write when the holder was paused past the
threshold. Assume that any code with a shared file, row, counter or lock has one of these
until a test that forces the schedule proves otherwise.

## Steps

1. **Inventory shared state and writers.** For every file, row, counter, cache entry or
   lock file the change touches, list who can write it: concurrent requests in one async
   process (every `await` is a yield point), threads, other worker processes or
   instances, and a restarted process after a crash. Call `search_lore` for the repo's
   lock helper, worker model and transaction rules. Each item must end up immutable,
   single-owner (one queue/actor/goroutine does all writes), or guarded.
2. **Pick the guard by scope.** In one process: a mutex or per-key async lock, or a
   single-writer queue. Across processes on one host: an OS lock the kernel releases on
   death (`flock`/`fcntl`, `LockFileEx`). Across hosts or on database rows: the database
   (`UPDATE … SET n = n + 1`, `SELECT … FOR UPDATE`, a unique constraint, a version
   column, `pg_advisory_xact_lock`). An in-memory flag guards nothing once there are two
   processes.
3. **Serialise every read-modify-write.** Read → compute → write with no guard loses
   updates. Use one atomic statement; or compare-and-swap
   (`UPDATE t SET v = v + 1, data = ? WHERE id = ? AND v = ?`, check the affected row
   count, retry a bounded number of times, then 409); or hold one lock across the whole
   read, modify and write. A lock around only the write does not help. Check-then-act
   across an `await` (`if (!exists) await create()`) is the same bug.
4. **Write files atomically.** Create the temp file in the **same directory** with a
   unique name (`mkstemp`, `os.CreateTemp`, `O_CREAT|O_EXCL`, or pid + random suffix —
   never a fixed `data.json.tmp` or a timestamp), write, `fsync` it when the data must
   survive power loss, `rename` over the target (`os.replace` in Python), then `fsync`
   the directory for a durable rename; delete the temp on failure. Use a library such
   as `write-file-atomic` (Node) or `renameio` (Go) only if it is already a dependency;
   never install one. Rename gives readers old-or-new, never a
   torn file — it does **not** serialise writers, so step 3 still applies. Acknowledge
   (2xx, return success) only after the rename, and after the fsyncs when durability is
   the contract.
5. **Make cross-process locks safe against pauses.** A process can stop for seconds
   without dying: GC, `SIGSTOP`, VM suspend, swap, a debugger. A lock declared stale
   because of **age alone** is then stolen while its holder still believes it owns it;
   the holder resumes and overwrites the new owner's acknowledged write. In order of
   preference:
   - a kernel-held lock (`flock`/`fcntl`) released when the owner process dies and never
     because time passed; or a Postgres advisory lock taken on the same connection or
     transaction that performs every guarded write (`pg_advisory_xact_lock`). Postgres
     releases it whenever the session ends (idle timeout, dropped connection, pooler),
     so it protects only writes made through that session — never a file or another
     store;
   - an owner-liveness check: the lock records pid, host and process start time or a
     nonce, and is broken only when that owner is provably gone — same host, and either
     `kill(pid, 0)` fails with ESRCH or the process now running under that pid has a
     different start time (pid reuse). `EPERM` only means some process holds that pid:
     compare its start time, and never treat `EPERM` alone as gone. Age may trigger
     the check, never decide it;
   - a fencing token when a time lease is unavoidable (distributed lock, job lease):
     each grant returns a monotonically increasing number, every write carries it, and
     the **resource** rejects a token lower than the highest it has accepted.
     "Re-check I still hold the lock, then write" is not a substitute (unless the check
     takes a row lock held until the write commits, as in the `scheduled-jobs` skill); the pause can
     land between check and write.

   Time out lock **acquisition**; never time out a held lock without fencing.
6. **Bound everything.** Every fan-out has a concurrency limit (`p-limit`, a semaphore,
   `errgroup.SetLimit`, a sized executor); every wait and outbound call has a timeout;
   every retry has a cap with backoff (the `idempotency-and-retries` skill); every queue
   has a maximum depth or backpressure.
7. **Keep critical sections small.** Never await network I/O or call user callbacks while
   holding an in-process lock; take locks in one global order; release in `finally` or
   `defer`.
8. **Handle cancellation, crashes and errors.** Propagate cancellation (AbortSignal,
   `context`, CancellationToken); on shutdown stop accepting, drain with a deadline,
   exit. On startup, remove orphaned temp files and locks whose owner is dead. In a
   fan-out collect every failure (`allSettled`, `errgroup`, TaskGroup); no unobserved
   rejection or goroutine that logs and dies.
9. **Test the schedule, not the happy sequence.** This is the canonical parallel-test
   recipe other skills point to. Write one test per invariant the ticket relies on, each
   exercising the acceptance criterion's own behaviour:
   - **Real parallelism:** fire N (≥ 20) concurrent requests or real child processes at
     the same key doing read-modify-write. Cross-process locks need separate OS
     processes; an in-process test shares the mutex and proves nothing. Assert the
     invariant: final count = N, every acknowledged write is present, no 5xx, no leftover
     temp files.
   - **Forced interleaving:** add a test seam (a hook, latch or barrier between read and
     write) so both actors read before either writes. Barriers, not `sleep`, decide the
     order.
   - **Paused holder:** start the holder process, let it acquire, `kill -STOP <pid>`
     (`process.kill(pid, "SIGSTOP")`, `os.kill(pid, signal.SIGSTOP)`), advance an
     injected clock or use a tiny configured stale threshold (e.g. 50 ms via config),
     start a contender, then `kill -CONT`. Assert no acknowledged write is lost: the
     contender waits, or the holder's late write is fenced off.
   - **Crashed holder:** `kill -KILL` the holder mid-operation; assert a contender
     acquires promptly (liveness works) and the file is old-or-new, never torn.
   - Run the race detector where one exists (`go test -race`, ThreadSanitizer, `loom`
     for Rust, `jcstress` for Java) and repeat the suite (`--repeat`, `-count=50`, a
     loop) to show it is stable; a race test that passes once is not evidence (the
     `fix-flaky-test` skill).
10. **Evidence** each AC with the `record-evidence` skill: the test names, the command,
    the iteration count and the invariant asserted.

## Done when

- Every shared file, row and counter from step 1 has a named guard.
- No fixed or clock-derived temp name; every read-modify-write is atomic, CAS'd, or
  under one lock; success is acknowledged only after the durable write.
- No lock is broken by age alone; leases are fenced at the resource.
- Parallel, forced-interleaving, paused-holder and crashed-holder tests exist where the
  scope applies, and pass repeatedly.

## Anti-patterns

- `writeFile(path + ".tmp")` then rename; "a lock older than 30 s is stale".
- Tests that call the handler N times in a sequential loop and call it concurrency.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While reasoning about interleavings you learn the lock order, the queue ownership rules and the races that once bit production.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
