---
name: caching-strategy
description: Use when a ticket adds, changes, or debugs a cache — an in-memory memo, an HTTP cache header, a Redis layer, a CDN rule, a query-result cache — and the change must state what is cached, for how long, what invalidates it, and what happens when it is wrong. Invoke for "cache this", "it's showing stale data", "add Cache-Control", or when a profile shows the same read repeated.
stack: [node, python, go, java, rust, csharp, kotlin, ruby, react, web]
area: backend
---

# Add or fix a cache

A cache trades freshness for speed; every cache has a story about how it goes stale and
what that costs. Write that story down before you write the code: key, scope, lifetime,
invalidation, and the failure mode. A cache without an invalidation plan is a bug with a
delay.

## Steps

1. **Prove the need.** A measurement showing the same expensive read repeated (the
   `performance-profiling` skill). If the fix is "stop calling it twice" or "add an
   index", do that instead; a cache is the last resort after doing less work.
2. **Choose the layer deliberately.** Request-scoped memo (dies with the request, no
   invalidation problem), process memory (fast, per-instance, lost on restart), a shared
   store like Redis (consistent across instances, another dependency), HTTP caching
   (`Cache-Control`, `ETag`, CDN) for public or per-user responses. Prefer the innermost
   layer that solves the measured problem. Call `search_lore` for the repo's cache
   helpers and conventions.
3. **Design the key.** Every input that changes the output is in the key: identifiers,
   the caller's tenant and permissions, locale, version of the code that computes it. A
   key missing the tenant is a data leak; a key missing the version serves old shapes
   after a deploy.
4. **Set the lifetime from the data, not from a round number.** How stale can this be
   before someone is harmed? That is the TTL. Add jitter so entries do not expire in a
   herd. Pair TTL with explicit invalidation on the writes you control.
5. **Invalidate on write.** Every write path that changes the cached data deletes or
   updates the entry (same transaction where possible, or after commit). Prefer
   invalidate-on-write plus a TTL safety net over TTL alone. List the write paths in the
   code comment next to the cache.
6. **Handle misses and failures safely.** A cache outage degrades to the source, never
   to an error; guard against stampedes (single-flight / lock on miss) for expensive
   keys; never cache errors or empty results unless deliberately, with a short TTL.
7. **Never cache what must not be shared.** Authorization decisions, secrets, and
   per-user data go in per-user keys or not at all; a public CDN never caches a response
   that varies by session (`Cache-Control: private`, `Vary`).
8. **Make it observable and testable.** Hit/miss/evict counters; a test for each: hit,
   miss, invalidation on write, TTL expiry (with a fake clock), and behaviour when the
   store is down. Evidence before/after numbers with the `record-evidence` skill.

## Rules

- A measurement first; less work before more caching.
- Every output-affecting input is in the key, including tenant and code version.
- Every cache has an invalidation path on write and a TTL safety net.
- Cache outages degrade, never fail; stampedes are guarded.
- Nothing per-user or authorization-related in a shared cache.
- Hit/miss metrics and tests for hit, miss, invalidate, expire, outage.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While designing the key you learn what is cached where, how it is invalidated and what went wrong the last time it was stale.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
