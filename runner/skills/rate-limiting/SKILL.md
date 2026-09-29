---
name: rate-limiting
description: Use when a ticket protects a surface from overload or abuse — per-user or per-key request limits, login-attempt throttling, a quota, backpressure to a downstream, "someone is hammering the API" — and the limit must be correct across instances, communicated to clients, and never lock out legitimate use. Invoke for any throttle, quota, or 429 behaviour.
stack: [node, python, go, java, rust, csharp, kotlin, ruby]
area: backend
---

# Add rate limiting

A rate limit is a promise about fairness and safety: no single caller can consume the
service, and callers are told how to behave. Decide what you limit (a key), how (an
algorithm), where the counters live (shared, atomic), and what clients see; then test the
boundary exactly, including under concurrent requests. Sources: RFC 6585 (`429`), RFC
9110 (`Retry-After`), IETF draft-ietf-httpapi-ratelimit-headers (`RateLimit`,
`RateLimit-Policy`), OWASP Authentication and Credential Stuffing Prevention cheat sheets,
Redis documentation on atomic scripts.

## Steps

1. **Name the threat and the key.** Credential stuffing, a noisy client, scraping, or a
   downstream to protect. The key follows: user id, API key, tenant, IP (weakest: NAT
   and IPv6 rotation; use a /64 for IPv6), or a combination. Derive the IP from the
   trusted proxy chain only, never a raw client-supplied `X-Forwarded-For`. Call
   `search_lore` for existing limiter middleware.
2. **Choose the algorithm for the behaviour you want.** Token bucket / GCRA: bursts up
   to capacity, steady refill (most APIs). Sliding-window counter: smooth rate, little
   memory. Fixed window: simplest, allows 2× bursts at window edges. Concurrency limit
   (semaphore): protects a downstream's capacity, not a rate. Use the repo's, gateway's
   or a maintained library's implementation before writing one.
3. **Share and atomically update the counters.** An in-process counter behind a load
   balancer is not a limit. Use the shared store with one atomic operation per decision:
   a Redis Lua script or `INCR` whose returned value is compared, never `GET` then `SET`
   (concurrent requests all read the same value and all pass). Set the TTL in the same
   atomic step: an `INCR` followed by a separate `EXPIRE` that fails leaves a key that
   never expires, locking the caller out forever. Use the store's clock (Redis `TIME`)
   so instance clock skew cannot widen the window.
4. **Fail open or closed on purpose.** If the store is unavailable: fail open for
   ordinary reads (availability), fail closed or fall back to a conservative local limit
   for login, password reset, OTP and costly writes. Put a short timeout on the store
   call. Comment the decision and test it.
5. **Tell the client.** Reject with `429` and `Retry-After` (seconds). Emit the repo's
   rate-limit headers; if the repo has none, use the current IETF draft fields,
   `RateLimit-Policy: "default";q=100;w=60` and `RateLimit: "default";r=42;t=18`, on
   successful responses as well as rejections. `Retry-After` takes precedence over
   `RateLimit`. Legacy `X-RateLimit-*` headers stay if clients depend on them. Never
   leak other tenants' identifiers in a partition key. Document it (the
   `openapi-contract` skill).
6. **Throttle authentication without enabling lockout abuse.** Limit per account and
   per source; prefer progressive delays or a challenge over hard account lockout (an
   attacker can lock a victim out); return the same response whether or not the account
   exists. Never disable a security limit for convenience.
7. **Check early and cheaply.** Run the limiter before expensive work (body parsing,
   downstream calls) where the key is available; for authenticated keys, after cheap
   token validation. Keep key derivation allocation-free.
8. **Leave a way out.** Allow-lists for internal callers, per-tenant overrides in
   config, and a rejection metric by limit name (not by user id; cardinality) with an
   alert, so a limit locking out a real customer is seen within minutes.

## Tests (injected clock or a tiny configured window; never sleep through a real one)

- Boundary: exactly N requests pass, request N+1 gets `429` with `Retry-After` and
  correct `RateLimit` values; after the window/refill the next request passes.
- **Concurrency:** fire N + 20 requests in parallel against the real store (a test
  Redis/container) → exactly N succeed (the `concurrency-and-async` skill's step 9).
  Repeat across two app instances sharing the store → the combined count is still N.
- **Failure:** store unavailable → the documented fail-open/closed behaviour per
  surface; the key always carries a TTL (inspect it after a simulated partial failure).
- Spoofed `X-Forwarded-For` from an untrusted hop does not change the key.
- Login: per-account limit trips regardless of source IP; responses identical for
  existing and non-existing accounts.

## Done when

The tests above pass for the limited surfaces and each acceptance criterion has
evidence via the `record-evidence` skill.

## Review checklist

- [ ] Threat and key named; IP derived from trusted proxies only.
- [ ] Counters shared; each decision one atomic operation with its TTL.
- [ ] Fail-open/closed decided per surface, commented, tested.
- [ ] `429` + `Retry-After`; rate-limit headers per repo convention or IETF draft.
- [ ] Login throttling fails closed and cannot be used to lock out a victim.
- [ ] A parallel-requests test proves exactly N pass.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While placing the limiter you learn which surfaces are limited by which key and whether each fails open or closed when the store is down.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
