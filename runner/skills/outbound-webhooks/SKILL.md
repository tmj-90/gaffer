---
name: outbound-webhooks
description: Use when a ticket makes the system call other systems on events — outbound webhooks, notifications to a partner URL, callbacks — and the delivery must be signed, retried safely, observable, and impossible to turn into a server-side request forgery. Invoke for "notify the customer's endpoint", "add a webhook for X", "deliveries are failing", or "let users register a callback URL".
stack: [node, python, go, java, rust, csharp, kotlin, ruby]
area: backend
---

# Send outbound webhooks safely

An outbound webhook is your system making HTTP requests to URLs other people chose. It
is a delivery problem (their endpoint is down, slow or wrong) and a security problem
(their URL may point into your network). Unless the repo already has a scheme, follow the
Standard Webhooks specification (standardwebhooks.com) so receivers can use off-the-shelf
verifiers. Other sources: OWASP SSRF Prevention Cheat Sheet; AWS "Exponential Backoff and
Jitter".

## Steps

1. **Validate the destination at registration and at every send.** HTTPS only; cap URL
   length; resolve the host and reject loopback, private (RFC 1918), link-local
   (`169.254.0.0/16`, incl. cloud metadata), CGNAT (`100.64.0.0/10`), `0.0.0.0/8`, and
   IPv6 equivalents (`::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped `::ffff:…`). Connect to
   the IP you validated (pin it) so DNS rebinding cannot swap it between check and
   connect; do not follow redirects. Where the platform allows, send through an egress
   proxy or subnet that cannot reach internal services. Call `search_lore` for the repo's
   URL validator and reuse it (in the factory itself:
   `packages/dispatch/src/notify/urlPolicy.ts`).
2. **Define the envelope.** `type` (dotted, e.g. `invoice.paid`), `timestamp` (ISO 8601),
   and `data` holding identifiers plus the minimum the receiver needs; keep payloads small
   (Standard Webhooks suggests < 20 KB) and prefer thin payloads (ids the receiver fetches)
   for sensitive data. Document it (the top-level `webhooks` map in OpenAPI 3.1; the
   `openapi-contract` skill).
3. **Sign it.** Headers `webhook-id` (stable message id, the receiver's idempotency key,
   identical on every retry), `webhook-timestamp` (Unix seconds) and `webhook-signature`
   (`v1,<base64 HMAC-SHA256>` over `"{id}.{timestamp}.{raw body}"`, with a per-endpoint
   secret of 24–64 random bytes, `whsec_` prefixed). Sign the exact bytes you send. Rotation:
   send space-separated signatures for the old and new secret during the overlap. Document
   that receivers must compare in constant time and reject timestamps outside a tolerance
   (e.g. 5 minutes) to stop replay.
4. **Enqueue transactionally, deliver from a worker.** Write the delivery row in the same
   transaction as the business event (outbox pattern; the `background-jobs` skill); never
   call the URL inline in the request that caused the event. Workers claim due rows
   atomically (`SELECT … FOR UPDATE SKIP LOCKED` or a conditional `UPDATE … RETURNING`)
   so two workers never send the same attempt concurrently; delivery stays at-least-once
   and receivers dedupe on `webhook-id`.
5. **Classify the response.** Any `2xx` is delivered. `410 Gone` disables the endpoint.
   Every other outcome is a failure that is retried: non-`2xx` (a `404` may be a receiver
   mid-deploy), timeouts, connection resets, and refused redirects. Timeout: short connect
   timeout, total 15–30 s. Read at most a small bounded response body (a few KB).
6. **Retry with backoff and jitter, then stop.** Standard Webhooks schedule: immediately,
   5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 14 h, 20 h, 24 h (about three days), each with
   random jitter; honour `Retry-After` on `429`/`503`, and slow down on `502`/`504`.
   After the last attempt mark the delivery failed; after sustained failure (e.g. days)
   disable the endpoint and notify its owner.
7. **Isolate endpoints.** Per-endpoint concurrency cap and a circuit breaker, so one slow
   receiver cannot occupy every worker. Do not promise ordering; receivers order by
   `timestamp` or refetch state.
8. **Record every attempt** (status, latency, response code, error class, attempt
   number) visible to the customer (deliveries page/API with manual redelivery by event
   id) and to operators (failure-rate metric by endpoint, low-cardinality labels).

## Tests

- Signature matches a reference verifier (e.g. the Standard Webhooks library or a
  fixed test vector); rotated secrets produce two signatures; the body sent is the body signed.
- Registration and send refuse `http://`, `127.0.0.1`, `169.254.169.254`, `[::1]`,
  a hostname resolving to `10.x`, and a `302` to a private address.
- **Concurrency:** two workers polling the same due delivery send it once per attempt.
- **Failure:** with a fake clock and fake endpoint, retries follow the schedule, stop at
  the cap and mark failed; `410` disables; a timeout counts as a failure; a crash after
  sending but before recording results in a re-send with the same `webhook-id`.
- A hung endpoint does not delay another endpoint's delivery.

## Done when

The tests above pass for the surfaces the ticket touches and each acceptance criterion
has evidence via the `record-evidence` skill.

## Review checklist

- [ ] SSRF: allow-listed scheme, resolved-IP check with pinning, no redirects, re-checked per send.
- [ ] Signed over id + timestamp + exact body; rotatable secret; replay tolerance documented.
- [ ] Outbox enqueue in the event's transaction; atomic claim by workers.
- [ ] Bounded timeout, bounded response read, jittered bounded retries, `410` disables.
- [ ] Per-endpoint isolation; every attempt recorded and visible.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While validating destinations you learn the signing scheme, the SSRF validator in use and the delivery retry policy partners depend on.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
