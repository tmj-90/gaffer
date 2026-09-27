---
name: rate-limiting
description: Use when a ticket protects a surface from overload or abuse — per-user or per-key request limits, login-attempt throttling, a quota, backpressure to a downstream, "someone is hammering the API" — and the limit must be correct across instances, communicated to clients, and never lock out legitimate use. Invoke for any throttle, quota, or 429 behaviour.
stack: [node, python, go, java, rust, csharp, kotlin, ruby]
area: backend
---

# Add rate limiting

A rate limit is a promise about fairness and safety: no single caller can consume the
service, and the service tells callers how to behave. Decide what you are limiting (a
key), how (an algorithm), where the counters live (shared, across instances), and what
the client sees, then test the boundary precisely.

## Steps

1. **Name the threat and the key.** Abuse (a stolen token, credential stuffing), a
   noisy client, or a downstream you must protect. The key follows: user id, API key,
   IP (least reliable, shared by NATs), tenant, or a combination. Call `search_lore`
   for existing limiter middleware and conventions in the repo.
2. **Choose the algorithm for the behaviour you want.** Token bucket allows bursts with
   a steady refill (most APIs); sliding window gives a smooth rate; fixed window is
   simple but bursts at boundaries; a concurrency limit protects a downstream's
   capacity rather than a rate. Use the repo's or the platform's implementation before
   writing one.
3. **Put the counters where every instance can see them.** In-process memory limits
   only one process; behind a load balancer that is not a limit. Use the shared store
   (Redis with atomic increments, the gateway's limiter) with a TTL on each window.
4. **Fail open or closed on purpose.** If the store is down, decide per surface: fail
   open for ordinary APIs (availability), fail closed for login and password reset
   (safety). Write the decision in a comment and test it.
5. **Tell the client.** `429 Too Many Requests` with `Retry-After` and the standard
   rate-limit headers the repo uses (`RateLimit-Limit`, `RateLimit-Remaining`,
   `RateLimit-Reset`) on every response, not only on rejection, so well-behaved clients
   can pace themselves. Document it in the API contract (the `openapi-contract` skill).
6. **Protect the limiter's own cost.** Check the limit before expensive work (auth
   lookup, body parsing where possible); never let the limiter itself become the hot
   path. Keep the key derivation cheap and non-allocating.
7. **Leave a way out.** Allow-lists for internal callers, per-tenant overrides, and an
   operator-visible metric of rejections by key so a misconfigured limit locking out a
   real customer is seen within minutes.
8. **Test the boundary exactly.** N requests pass, N+1 is rejected with the right
   headers, the window resets, two instances share the count, the store-down policy
   behaves as decided. Use a fake clock; no sleeps. Evidence with the
   `record-evidence` skill.

## Rules

- Key and threat named before the algorithm is chosen.
- Counters are shared across instances or the limit is fiction.
- Fail-open/closed decided per surface, commented, and tested.
- Standard headers on every response; 429 with `Retry-After` on rejection.
- Never rate-limit security controls off; login throttles fail closed.
- Overrides and rejection metrics exist so a bad limit is visible and fixable.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While placing the limiter you learn which surfaces are limited by which key and whether each fails open or closed when the store is down.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
