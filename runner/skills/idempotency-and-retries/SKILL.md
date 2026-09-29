---
name: idempotency-and-retries
description: Use when a ticket makes an operation safe to repeat or adds retries — payment or order creation that must not double-charge, a webhook handler that receives duplicates, a client retry policy, an outbound call to a flaky dependency — and the design must guarantee exactly-once effect under at-least-once delivery. Invoke for "it charged twice", "add retries", "handle duplicate events", or any side effect reached over a network.
stack: [node, python, go, java, rust, csharp, kotlin, ruby]
area: backend
---

# Make operations idempotent and retries safe

Networks deliver at least once or not at all. Exactly-once _effect_ comes only from an
idempotent operation plus retries. The hard part is not the happy path; it is two copies
of the same request arriving at once, and a crash between "did it" and "wrote it down".
Sources: IETF draft-ietf-httpapi-idempotency-key-header; Stripe's idempotency design
(Brandur Leach, "Implementing Stripe-like idempotency keys in Postgres"); AWS Builders'
Library "Timeouts, retries, and backoff with jitter".

## Steps

1. **Classify the operation.** Naturally idempotent (PUT that sets state, DELETE),
   idempotent with a key (create order, send email, charge card), or deliberately
   non-idempotent (say why). Call `search_lore` for the repo's key header and retry policy.
2. **Choose the key.** API creates: client-supplied `Idempotency-Key` header (a string,
   UUID recommended). Webhooks and queue consumers: the event/message id. Internal jobs:
   a natural key (order id + step). Scope it to the caller: the store key is
   `(caller, key)` so two tenants cannot collide.
3. **Store the outcome with a fingerprint.** A table with a UNIQUE constraint on
   `(caller, key)` holding a request fingerprint (hash of method, path and canonical
   body), a status (`in_progress`, `completed`), the stored response (status + body),
   and `locked_until`/`created_at`. Replay rules (IETF draft semantics):
   - key missing on an endpoint that requires it → `400`;
   - same key, different fingerprint → `422`, never a silent success;
   - same key while the first is still `in_progress` → `409` (client retries later);
   - same key, completed → return the stored response byte-for-byte, including stored
     errors from after execution began (Stripe stores `500`s too). Validation errors
     raised before execution are not stored, so a corrected retry works.
4. **Claim the key atomically, never check-then-insert.** `INSERT … ON CONFLICT DO
   NOTHING RETURNING` (Postgres) / `INSERT IGNORE` + affected-rows (MySQL) / a unique
   index violation you catch. Whoever inserts owns the execution; everyone else reads the
   row. A `SELECT` followed by `INSERT` is a race that double-executes under load.
5. **Make local effects atomic with the record.** When the effect is a database write,
   do it in the same transaction that sets `completed` and stores the response.
6. **Bracket external effects with recovery points.** For a charge, email or third-party
   call you cannot enlist in the transaction: commit `in_progress` with the downstream
   idempotency key first, call out passing that key, then commit `completed`. A crash
   leaves `in_progress` past its `locked_until`; a reconciler (or the next retry) resumes
   by re-calling the dependency with the same downstream key, which collapses to one
   effect. Taking over a stale `in_progress` row is a time lease, so fence it: the
   takeover bumps an attempt counter, and the final `completed` write is conditional on
   it (`… WHERE key = ? AND attempt = ?`, 0 rows → roll back and stop), so a paused original holder
   cannot overwrite the recovered result (the `concurrency-and-async` skill, step 5).
   Emit follow-on messages through a transactional outbox, not directly.
7. **Retry only what is safe, at one layer.** Retry idempotent or keyed calls on
   transient failures only: timeouts, connection resets, `502/503/504`, and `429`/`503`
   honouring `Retry-After`. Never retry other 4xx. Backoff with full jitter:
   `sleep = random(0, min(cap, base * 2^attempt))`; cap attempts and set a total
   deadline. Retry at a single layer of the stack (3 retries at each of 5 layers is 243×
   load) and bound retries with a retry budget or token bucket so an outage is not
   amplified. Timeouts come from measured latency (e.g. above p99.9), never infinite.
8. **Expire keys deliberately.** Keep records at least as long as clients retry (Stripe:
   24 h), sweep them with a job (the `scheduled-jobs` skill), and document the window in
   the API contract (the `openapi-contract` skill).

## Tests (each exercises the guarantee itself)

- Same key twice, sequentially → one effect, identical response (status and body).
- **Concurrency:** N (≥ 20) parallel requests with the same key → exactly one effect
  (count rows/charges on a fake); every response is either `409` or byte-identical to
  the one original success; none `500`. Run it with real parallelism against the real database, not mocks (the
  `concurrency-and-async` skill's step 9 recipe).
- Same key, different body → `422`, no second effect.
- **Crash recovery:** kill (throw) after the external call but before `completed`;
  the reconciler/retry finishes with exactly one downstream effect.
- Retry policy with an injected clock and random source: stops at the cap, respects
  `Retry-After`, never retries a `400`, surfaces the final error.

## Done when

The concurrent-same-key test and the crash-recovery test pass alongside the sequential
ones, and each acceptance criterion has evidence via the `record-evidence` skill.

## Review checklist

- [ ] Every networked side effect has a key strategy; keys are caller-scoped.
- [ ] Claim is an atomic insert on a unique constraint, not a read-then-write.
- [ ] Fingerprint mismatch → `422`; in-flight → `409`; completed → stored response.
- [ ] External effects bracketed by recovery points; downstream key propagated.
- [ ] Retries: transient only, full jitter, capped, deadline, single layer.
- [ ] Concurrent and crash tests exist, not only a sequential double call.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While making the operation safe to repeat you learn the idempotency-key header, the outcome table and the retry policy the repo standardises on.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
