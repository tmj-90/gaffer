---
name: background-jobs
description: Use when a ticket moves work off the request path or adds asynchronous processing — a job queue, a worker, an outbox, "send the email later", "process uploads in the background", retries for a failed job — and the job must be idempotent, observable, bounded, and safe to run twice. Invoke for any queue, worker, or deferred-processing change.
stack: [node, python, go, java, rust, csharp, kotlin, ruby]
area: backend
---

# Add a background job

A background job is a promise the request made and a worker must keep, later, maybe on
another machine, maybe twice. Queues deliver at least once: a worker that crashes,
times out or pauses past its visibility window gets its job handed to another worker
while it may still finish. Design for redelivery, overlap and partial failure first.

## Steps

1. **Use the repo's job system.** A queue library (BullMQ, Celery, Sidekiq, River,
   Hangfire, Quartz), a database-backed queue or outbox, or the platform queue (SQS,
   Pub/Sub). Call `search_lore` for it and its retry defaults; never add a second
   system for one job. Time-driven work belongs to the `scheduled-jobs` skill.
2. **Keep the payload small and versioned.** Identifiers (`orderId`) and a schema
   version, never whole objects that will be stale when the job runs. Validate the
   payload at the worker like any untrusted input; an invalid payload is a permanent
   failure.
3. **Enqueue atomically with the state change.** Write the row and the job in one
   transaction (a jobs/outbox table in the same database, drained by a relay), or
   enqueue only after commit. Enqueue-before-commit creates jobs for rows that rolled
   back; enqueue-after-commit without an outbox loses the job if the process dies in
   between. An outbox relay either runs as one instance or claims rows with
   `FOR UPDATE SKIP LOCKED`.
4. **Make the handler idempotent.** Redelivery is normal. Key the effect on the job id
   or a natural key: a unique constraint on the result row, a processed-jobs table
   written in the same transaction as the effect, or a conditional update
   (`… WHERE status = 'pending'`). External side effects (email, webhook, charge) pass an
   idempotency key or go through a deduplicating ledger (the `idempotency-and-retries`
   skill).
5. **Fence overlapping workers.** If the job holds a lease (visibility timeout,
   `locked_until`, a lock row), a paused or slow worker can outlive it while a second
   worker runs the same job. Heartbeat to extend the lease while working, and make the
   final write conditional on still owning it, in the same transaction as the job's
   database effects (`UPDATE jobs SET status='done' WHERE id = ? AND lease_token = ?`;
   0 rows → roll back); a worker whose lease was lost must not commit. Ack or delete
   the message only after the work commits (`acks_late`-style), never on receipt. See the
   `concurrency-and-async` skill for fencing tokens.
6. **Classify failures and bound retries.** Transient (timeouts, connection resets,
   `502`/`503`/`504`, `429` honouring `Retry-After`, deadlocks and serialization
   failures): retry with exponential backoff, jitter and a maximum attempt count.
   Permanent (validation, other 4xx, missing row): fail immediately. After the last attempt, move to a
   dead-letter queue or a `failed` status with the error, visible and requeueable
   (the `error-handling` skill).
7. **Set limits deliberately.** Per-job timeout shorter than the visibility window or
   lease; worker concurrency sized to the downstream's capacity; a poison job isolated
   so it cannot block the queue; graceful shutdown stops taking jobs and finishes or
   releases in-flight ones before the deadline.
8. **Instrument it.** Log job enqueued/started/succeeded/failed/dead-lettered with the
   job id, attempt number and the correlation id from the originating request (the
   `structured-logging-and-tracing` skill); expose queue depth, age of oldest job, and
   duration metrics.
9. **Test the lifecycle**, one test per AC exercising the AC's own behaviour, plus:
   - the job is enqueued with the state change and absent when the transaction rolls
     back;
   - the handler run twice with the same job produces one effect;
   - two workers claiming concurrently process it once;
   - a worker paused past its lease cannot commit after resuming, and a worker killed
     mid-job has its job retried and completed once (the paused- and crashed-holder
     tests in the `concurrency-and-async` skill, step 9);
   - a transient failure retries then succeeds; a permanent failure dead-letters
     without retrying.

   Drive time with an injected clock or a configured short timeout, not real sleeps.
10. **Evidence** with the `record-evidence` skill: test names, command, and results.

## Done when

- Enqueue is transactional (outbox) or after commit, proven by a rollback test.
- Run-twice and concurrent-claim tests show exactly one effect.
- A worker that lost its lease cannot commit; ack happens after commit.
- Retries are bounded, permanent errors skip retry, dead letters are visible.

## Anti-patterns

- Passing ORM objects as payloads; enqueueing inside the transaction to an external
  broker.
- Acking on receipt; marking a job done without checking the lease is still held.
- Unlimited retries; retrying a 400; one poison message stalling the worker.
- Tests that call the handler once directly and never exercise redelivery.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While enqueueing you learn which queue is in use, its retry policy and the outbox convention deliveries must follow.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
