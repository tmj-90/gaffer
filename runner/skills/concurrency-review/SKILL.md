---
name: concurrency-review
description: Use as a REVIEW LENS when judging another agent's diff for concurrency and data-integrity defects under failure — concurrent writers, unsynchronised read-modify-write and lost updates, temp-file name collisions, non-atomic file writes, cross-process locking and stale-lock leases, crash/pause/retry schedules, idempotency, transactions and isolation — before recommending approval. Invoke on every review whose diff persists data (files, database rows, caches, queues), takes a lock, retries, or runs in a request handler, worker or job that can execute concurrently; it complements review-ticket and the builder's concurrency-and-async skill.
stack: []
area: review
---

# Concurrency and data-integrity review lens

Race and crash defects pass every sequential test, so they sail through review unless
someone plays the bad schedule on purpose. Live runs shipped exactly this class twice:
concurrent writers sharing one temp-file name (HTTP 500), an unsynchronised
read-modify-write (lost updates), and a time-only stale-lock lease that let a second
process break the lock of a holder that was merely paused — losing a write the first
process had already acknowledged. Every reviewer scored correctness 4/5. This lens exists
so that does not happen again.

A finding here is a **concrete defect only when you can write the schedule**: the
ordered steps (who reads, who writes, who pauses or crashes, when) that end in a wrong,
observable outcome — a lost acknowledged write, a corrupt or partial file, a duplicate
effect, a 500, a deadlock. "Consider adding a lock" without a schedule is a note.

## Steps

1. **Establish the concurrency shape.** Can the changed code run twice at once? An HTTP
   handler can (servers serve requests concurrently; Node interleaves at every `await`);
   so can workers, cron jobs that overlap, CLI commands a user can start twice, multiple
   processes or instances sharing one file or database. Check how the app is deployed
   (worker count, cluster mode, replicas) and call `search_lore` for the repo's locking,
   transaction and persistence conventions. If there is provably one writer and one
   thread, write "single writer — n/a" and stop.
2. **List the shared state the diff touches**: files and directories, database rows,
   in-memory maps/counters/caches, lock files, queues, external resources. For each,
   name who reads it, who writes it, and what guards it.
3. **Walk the checklist below** against the actual code, opening the files. For each
   relevant item write "ok — <the line that guards it>" or a finding.
4. **Play the four schedules** against every write path: (a) two writers interleave
   step by step; (b) the process is **paused** (GC, SIGSTOP, VM suspend) for longer than
   any timeout or lease, then resumes and continues; (c) the process **crashes** between
   any two writes, and between "write" and "acknowledge"; (d) the caller **retries**
   after a timeout, so the operation runs twice. Write the schedule for each failure.
5. **Check the tests reach the path.** If an AC names concurrency, locking, atomicity,
   durability, crash safety or retries, a test must actually run that schedule: real
   parallel writers (separate processes when the AC says cross-process), an injected
   pause or kill, a forced retry, with an assertion on the invariant (count equals N,
   every acknowledged write present, file parses, one effect per key). A sequential test
   of a concurrency AC is a missing test (the `test-quality-review` skill).
6. **Rate each finding.** Blocking: a written schedule reachable in the deployed shape
   that loses or corrupts data, loses an acknowledged write, duplicates a side effect,
   returns a 500, or deadlocks; or an AC about concurrency/durability with no test that
   exercises it. Should-fix: the defect needs an unusual but possible schedule (a crash
   at one exact point, a pause beyond a generous lease). Note: hardening with no
   schedule. Only blocking and should-fix justify `RECOMMEND CHANGES`.
7. **Record each finding** with `record_ac_evidence` (`evidence_type: manual_note`,
   naming the AC, file, line, the schedule, and the single concrete fix), then let the
   `review-ticket` verdict carry the result. Never patch the code yourself.

## Checklist

- **Read-modify-write**: any read → compute → write of shared state (a JSON file, a row,
  a counter, a cache entry) is guarded end to end — one lock spanning read and write, an
  atomic statement (`UPDATE … SET n = n + 1`), a compare-and-swap on a version column or
  ETag (`If-Match` → 412), or `SELECT … FOR UPDATE`. An in-process mutex does not guard
  state shared across processes or instances. In async code a check and the act
  separated by an `await` are two steps.
- **Atomic file writes**: write to a **unique** temp name in the **same directory**
  (`mkstemp`, or pid + random suffix, opened exclusively), fsync, then rename over the
  target; fsync the directory where durability is claimed; remove the temp file on
  failure. A fixed temp name (`data.json.tmp`) collides between writers; writing the
  target in place leaves a torn file on crash.
- **Locks**: prefer locks the OS releases on process death (`flock`/`fcntl`, a database
  advisory or row lock) over lock files. A lock file or lease broken by **age alone**
  lets a paused holder resume and write after another process took over — the lease must
  be paired with a fencing check at the write (a monotonic token or version the store
  rejects when stale) or a liveness check that cannot misfire on a paused process.
  Locks are released on every error path (`finally`/`defer`/`with`); one acquisition
  order everywhere; no lock held across network I/O or user callbacks; waits bounded.
- **Check-then-act (TOCTOU)**: "exists? then create", "free? then book", "no row? then
  insert" is atomic — a unique constraint plus handling the conflict, `O_EXCL`, an upsert
  (ASVS 5 V15.4.2, V2.3.4).
- **Transactions**: multi-step changes that must succeed together are in one
  transaction (ASVS 5 V2.3.3); the isolation level actually prevents the anomaly the code
  risks (PostgreSQL's default READ COMMITTED permits lost updates and write skew; MySQL
  InnoDB's REPEATABLE READ still permits write skew); serialization
  failures and deadlocks are retried a bounded number of times; no network call or
  message publish inside the transaction that cannot be rolled back — use an outbox.
- **Acknowledge after durable**: a success response, event or log line saying "saved"
  is emitted only after the commit/fsync/rename succeeded; errors from write, fsync,
  close and rename are checked, not swallowed.
- **Crash consistency**: a crash between two related writes (data file then index,
  row then file) leaves state that the next start detects and repairs or that is never
  observed half-done; leftover temp and lock files are cleaned up safely.
- **Idempotency**: an operation reachable by retry (client retry, at-least-once queue,
  redelivered webhook, re-run job) has an idempotency key or natural key enforced by a
  unique constraint and stored atomically with the effect (the `idempotency-and-retries`
  skill).
- **In-memory shared state**: module-level maps, counters, caches and rate limiters are
  correct with more than one worker/instance, or the deployment is provably single
  process; concurrent map writes are guarded (Go panics; Java needs concurrent types).
- **Fan-out**: every concurrent branch's error is observed; partial failure leaves a
  defined state.

## Done when

Every write path in the diff has "ok — <guarding line>" or a finding with its schedule
for each relevant checklist item, and every concurrency/durability AC is mapped to a test
that runs its schedule (or recorded as MISSING). Stop there; do not audit untouched code.

## Rules

- No schedule, no finding: every blocking or should-fix item names the interleaving,
  pause, crash or retry that breaks it.
- A lost acknowledged write, a torn file, a duplicate side effect or a deadlock is a
  correctness defect, never "optional".
- Do not ask for locking, transactions or tests beyond what the ACs and the deployed
  shape require.
- You review; you do not patch. Findings go into evidence, the verdict goes through
  `review-ticket`.
