---
name: outbound-webhooks
description: Use when a ticket makes the system call other systems on events — outbound webhooks, notifications to a partner URL, callbacks — and the delivery must be signed, retried safely, observable, and impossible to turn into a server-side request forgery. Invoke for "notify the customer's endpoint", "add a webhook for X", "deliveries are failing", or "let users register a callback URL".
stack: [node, python, go, java, rust, csharp, kotlin, ruby]
area: backend
---

# Send outbound webhooks safely

An outbound webhook is your system making HTTP requests to URLs other people chose.
That is a delivery problem (their endpoint is down, slow, or wrong) and a security
problem (their URL might point at your own network). Sign every payload, deliver through
a job with bounded retries, validate destinations, and show the customer what happened.

## Steps

1. **Validate the destination at registration and at send time.** HTTPS only; resolve
   the host and reject private, loopback, link-local, and metadata ranges (SSRF); reject
   redirects to such ranges; cap the URL length. Re-check on every send because DNS
   changes. Call `search_lore` for the repo's URL-validation helper (the notify-URL
   validator, if present) and reuse it.
2. **Define the event envelope.** A stable schema: event id (for the receiver's
   idempotency), type, created time, API version, and the payload as identifiers plus
   the minimum data the receiver needs; never internal ids they cannot use or personal
   data they did not ask for. Document it (the `openapi-contract` skill's discipline
   applies to webhooks too).
3. **Sign it.** An HMAC over the raw body with a per-endpoint secret, a timestamp to
   bound replay, the signature in a header the docs name; support secret rotation with
   two active secrets. The receiver must be able to verify without calling you back.
4. **Deliver through the job system**, never inline in the request that caused the
   event (the `background-jobs` skill): enqueue in the same transaction as the event,
   deliver with a short timeout (a few seconds), exponential backoff with jitter, a
   maximum attempt count over hours, then mark failed and stop.
5. **Treat 2xx as delivered and everything else as not**, including timeouts and
   redirects you refused to follow. Never retry on a 4xx other than 408/429; a 410
   disables the endpoint. Read no more than a small bounded body from the response.
6. **Isolate slow endpoints.** Per-endpoint concurrency limits and a circuit breaker so
   one dead customer URL cannot starve deliveries to everyone else.
7. **Record every attempt** with status, latency, and response code, visible to the
   customer (a deliveries page or API) and to operators (metrics on failure rate by
   endpoint) so "we never got it" is answerable in seconds. Include the event id so it
   can be redelivered manually.
8. **Test**: signature verifies with a reference implementation, private/loopback
   destinations are refused at registration and send, retries follow the policy with a
   fake clock, a 410 disables, attempts are recorded, one slow endpoint does not block
   another. Evidence with the `record-evidence` skill.

## Rules

- HTTPS only; private, loopback, link-local and metadata ranges refused, re-resolved
  per send; redirects not followed into them.
- Every payload signed with a rotatable per-endpoint secret and a timestamp.
- Deliveries are jobs: transactional enqueue, bounded retries, failure recorded.
- Payloads carry identifiers and minimal data; no personal data beyond need.
- Per-endpoint isolation; one bad receiver never degrades the rest.
- Every attempt visible to the customer and to operators.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While validating destinations you learn the signing scheme, the SSRF validator in use and the delivery retry policy partners depend on.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
