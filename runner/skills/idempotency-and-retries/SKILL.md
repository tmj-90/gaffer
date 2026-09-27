---
name: idempotency-and-retries
description: Use when a ticket makes an operation safe to repeat or adds retries — payment or order creation that must not double-charge, a webhook handler that receives duplicates, a client retry policy, an outbound call to a flaky dependency — and the design must guarantee exactly-once effect under at-least-once delivery. Invoke for "it charged twice", "add retries", "handle duplicate events", or any side effect reached over a network.
stack: [node, python, go, java, rust, csharp, kotlin, ruby]
area: backend
---

# Make operations idempotent and retries safe

Networks deliver at least once or not at all; never exactly once. The only way to get
exactly-once effects is to make the effect idempotent and let retries happen. Design the
key, store the outcome, and make every retry bounded, backed off, and safe to give up on.

## Steps

1. **Classify the operation.** Naturally idempotent (a PUT that sets state, a DELETE),
   idempotent with a key (create order, send email, charge card), or non-idempotent and
   must stay so (rare; say why). Call `search_lore` for the repo's idempotency-key and
   retry conventions.
2. **Choose the idempotency key.** Client-supplied (`Idempotency-Key` header, a
   request id) for API creates; the event id for webhooks; a natural key (order id +
   step) for internal jobs. The key must be stable across the client's retries and
   scoped to the caller so two callers cannot collide.
3. **Store the outcome, not just a flag.** A table keyed by (caller, key) holding the
   status and the response (or its hash), written in the same transaction as the side
   effect. A repeat with the same key returns the stored response; a repeat with the
   same key and a different payload is an error (409), not a silent no-op.
4. **Make the effect atomic with its record.** Unique constraint on the key, insert
   first, then act within the transaction; on constraint violation, read and return the
   stored result. Where the side effect is external (a charge, an email), record
   "attempted" before calling out and reconcile "completed" after, so a crash between
   the two is detectable and recoverable.
5. **Retry only what is safe.** Retry idempotent calls on transient failures (timeouts,
   5xx, connection resets) with exponential backoff plus jitter, a maximum attempt count,
   and a total deadline. Never retry on 4xx except 429 with `Retry-After`. Never retry a
   non-idempotent call without a key.
6. **Propagate the key downstream.** Pass the idempotency key to every dependency that
   supports one (payment providers, email APIs, your own services) so a retry chain
   collapses to one effect end to end.
7. **Set expiry and cleanup.** Keys live as long as a client might retry (hours to
   days), then are swept (the `scheduled-jobs` skill). Document the window in the API
   contract.
8. **Test the guarantees**: same key twice yields one effect and the same response;
   same key different payload is rejected; a crash between record and effect is
   recovered by the reconciler; retries stop at the cap and surface the failure.
   Evidence with the `record-evidence` skill.

## Rules

- Every side effect reached over a network has an idempotency strategy.
- Keys are caller-scoped and stable; outcomes are stored with the effect, atomically.
- Same key + different payload is a conflict, never a silent success.
- Retries: transient errors only, backoff with jitter, capped attempts and deadline.
- Keys propagate downstream; external effects are recorded before and after.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While making the operation safe to repeat you learn the idempotency-key header, the outcome table and the retry policy the repo standardises on.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
