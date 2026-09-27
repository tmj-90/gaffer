---
name: background-jobs
description: Use when a ticket moves work off the request path or adds asynchronous processing — a job queue, a worker, an outbox, "send the email later", "process uploads in the background", retries for a failed job — and the job must be idempotent, observable, bounded, and safe to run twice. Invoke for any queue, worker, or deferred-processing change.
stack: [node, python, go, java, rust, csharp, kotlin, ruby]
area: backend
---

# Add a background job

A background job is a promise the request made and the worker must keep, possibly
minutes later, possibly on another machine, possibly twice. Design for redelivery,
partial failure, and observability from the start; the queue is not the hard part, the
"what if this runs again" is.

## Steps

1. **Use the repo's job infrastructure.** A queue library (BullMQ, Celery, Sidekiq,
   River, Quartz), a database-backed outbox, or the platform's queue. Call
   `search_lore` for the convention; never add a second queue system for one job.
2. **Define the job by its payload, not its code.** A small, versioned, serialisable
   payload with identifiers (`orderId`), never whole objects that may be stale by the
   time the job runs. Validate the payload at the worker boundary like any input.
3. **Enqueue transactionally.** If the job is created because a row was written, write
   the row and the job in the same transaction (an outbox table drained by a relay) or
   enqueue only after commit. A job that references a row that rolled back is a
   ghost; a row whose job was lost is a silent failure.
4. **Make the handler idempotent.** Redelivery is normal. Use an idempotency key (the
   job id or a natural key), check-then-act inside a transaction or with a unique
   constraint, and make side effects (emails, webhooks, charges) go through a
   deduplicated ledger (the `idempotency-and-retries` skill).
5. **Bound and classify failures.** Retries with exponential backoff and a maximum;
   after that, a dead-letter queue or a `failed` status a human can see and requeue.
   Distinguish transient errors (retry) from permanent ones (fail immediately, no
   retry) in the handler's error handling (the `error-handling` skill).
6. **Set timeouts and concurrency.** A per-job timeout shorter than the visibility
   window; worker concurrency sized to the downstream's capacity; a poison job must not
   stall the queue for everything else.
7. **Instrument it.** Job started/succeeded/failed events with the job id and the
   correlation id from the request that enqueued it (the
   `structured-logging-and-tracing` skill); a metric for queue depth and job duration so
   a backlog is visible before users notice.
8. **Test the lifecycle**: enqueue happens (and rolls back with the transaction),
   handler succeeds, handler is safe when run twice, transient failure retries,
   permanent failure dead-letters. Evidence with the `record-evidence` skill.

## Rules

- One job system per repo; use it.
- Payloads are small, versioned identifiers, validated on the worker side.
- Enqueue in the same transaction as the state change, or after commit; never before.
- Every handler is idempotent under redelivery; prove it with a run-twice test.
- Bounded retries with backoff, then a dead-letter a human can see.
- Timeouts, concurrency limits and poison-job isolation are set, not defaulted.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While enqueueing you learn which queue is in use, its retry policy and the outbox convention deliveries must follow.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
