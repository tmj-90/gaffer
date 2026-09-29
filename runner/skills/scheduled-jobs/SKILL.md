---
name: scheduled-jobs
description: Use when a ticket adds or changes time-driven work — a cron, a nightly report, a periodic cleanup, a poll every N minutes, a retention sweep — and the job must run exactly as intended across time zones, deployments, and multiple instances without overlapping or being silently skipped. Invoke for "run X every night", "add a cron", "the cleanup didn't run", or "it ran twice".
stack: [node, python, go, java, rust, csharp, kotlin, ruby]
area: backend
---

# Add a scheduled job

Scheduled work fails quietly: the tick never fires, two instances fire at once, the job
runs in the wrong zone, or a lock "expires" while its holder is merely paused and two
runs write at once. Gaffer's own builds shipped exactly that last defect: a time-only
stale-lock lease lost an acknowledged write when the holder was paused past the
threshold. Make the schedule explicit, the run idempotent, mutual exclusion enforced at
write time, and absence of a run alertable. Sources: Martin Kleppmann, "How to do
distributed locking" (fencing tokens); PostgreSQL docs on advisory locks and
`SKIP LOCKED`; Kubernetes CronJob docs ("jobs should be idempotent"); Google SRE Workbook
(alerting on absence).

## Steps

1. **Use the repo's scheduler.** Cron library, platform scheduler (Kubernetes CronJob:
   set `concurrencyPolicy: Forbid` and `startingDeadlineSeconds`), a jobs table with
   `next_run_at`, or the queue's delayed jobs. Call `search_lore` for the convention.
   Assume any scheduler can fire twice or not at all; the steps below make both harmless.
2. **Write the schedule in UTC unless the meaning is local.** A "9am local report" uses a
   named IANA zone, never a fixed offset, and has tests for both DST transitions (spring
   forward: 02:30 does not exist; fall back: 01:30 happens twice). Avoid `:00` when the
   exact minute does not matter; jitter by a few minutes.
3. **Make each run idempotent and catch-up-safe.** Process "everything due up to now"
   from a persisted watermark or per-item state (`status`, `processed_at`), not "the last
   interval" computed from wall-clock arithmetic, so a missed tick is recovered by the
   next and a double tick does nothing extra. Advance the watermark in the same
   transaction as the work it covers. Handler shape: the `background-jobs` skill.
4. **Enforce mutual exclusion at write time, not only at start.** A lease that expires
   by time alone is not exclusion: GC pauses, VM suspension or a stalled event loop can
   outlast any TTL, and the paused holder then writes alongside the new one. Pick one:
   - **Fenced lease:** acquiring increments a token,
     `UPDATE job_lease SET owner=:me, lease_until=:now+:ttl, fence=fence+1
     WHERE name=:job AND lease_until < :now RETURNING fence`, with `:now` from the
     injected clock (or `now()` with a tiny TTL in tests); every write the run makes
     is conditional on that fence still being current, checked with a row-locking
     statement in the same transaction as the write (`UPDATE job_lease … WHERE
     name=:job AND fence=:fence` or `SELECT … FOR UPDATE`; zero rows → abort and roll
     back). A plain `SELECT` of the fence is check-then-act and does not fence. Renewal
     checks the fence too; if renewal fails, stop work immediately.
   - **Connection-bound lock:** `pg_try_advisory_xact_lock(key)` held by the transaction
     doing the work, or a session advisory lock on a dedicated connection (not through a
     transaction-mode pooler) that also carries every write the run makes. Postgres
     releases it when that connection or transaction ends (a long pause can end it via
     idle timeouts), taking the uncommitted work with it; writes on any other connection
     or to files are unguarded.
   - **Per-item claims:** workers claim rows with `SELECT … FOR UPDATE SKIP LOCKED` and
     commit each item's result in the claiming transaction.
5. **Bound the run.** A timeout shorter than the interval, a maximum batch per run, and a
   rule for backlog larger than one run (loop to a cap, then stop and report). A nightly
   job that takes 25 hours overlaps itself forever.
6. **Record every run.** Start, end, items processed, outcome, fence/owner, next run, in
   structured logs (the `structured-logging-and-tracing` skill) and a `job_runs` table or
   a `last_success_timestamp` metric.
7. **Alert on absence.** The failure mode of a cron is silence. Configure (or document
   for the operator) an alert when `now - last_success > interval + slack` (a dead man's
   switch), plus one on consecutive failures.

## Tests (injected clock, or a tiny configured TTL; no fixed `sleep`)

- The schedule fires at the expected instants, including both DST transitions if local.
- **Double trigger:** two runners start the same tick concurrently → one does the work;
  item-level effects happen once.
- **Paused holder:** runner A acquires, the injected clock passed to the lease SQL
  advances past the TTL (or a tiny configured TTL elapses) while A is suspended (stub
  its await), runner B acquires and writes, A resumes and attempts its
  write → A's write is rejected (fence mismatch) and B's result survives. This test is
  mandatory for any time-based lease. When the lock lives outside the database (a lock
  file, a process-local lease), run A as a real process and pause it with `SIGSTOP`, as
  in the `concurrency-and-async` skill's step 9.
- **Crash:** a run that throws mid-batch leaves the watermark at the last committed item;
  the next run resumes without duplicates or gaps.
- **Missed window:** skip two ticks; the next run processes everything due.
- The run stops at its batch cap and its timeout, and records its outcome.

## Done when

The paused-holder, double-trigger and crash tests pass alongside the schedule tests,
runs are recorded, the absence alert is configured or documented, and each acceptance
criterion has evidence via the `record-evidence` skill.

## Review checklist

- [ ] Schedule in UTC, or a named zone with DST tests.
- [ ] Watermark/per-item state advanced atomically with the work.
- [ ] Exclusion holds under a paused holder: fencing token checked on write, or a
      connection-bound lock, or per-item `SKIP LOCKED` claims. A bare time lease fails review.
- [ ] Run bounded by timeout and batch cap; outcome recorded.
- [ ] Absence alert exists or is documented for the operator.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While scheduling you learn the scheduler in use, the lease pattern that stops overlap and any DST incident the repo has lived through.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
