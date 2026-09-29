---
name: caching-strategy
description: Use when a ticket adds, changes, or debugs a cache — an in-memory memo, an HTTP cache header, a Redis layer, a CDN rule, a query-result cache — and the change must state what is cached, for how long, what invalidates it, and what happens when it is wrong. Invoke for "cache this", "it's showing stale data", "add Cache-Control", or when a profile shows the same read repeated.
stack: [node, python, go, java, rust, csharp, kotlin, ruby, react, web]
area: backend
---

# Add or fix a cache

A cache trades freshness for speed, and every cache goes stale in a specific way. Write
the story before the code: key, scope, lifetime, invalidation, the race that can leave a
stale value behind, and what happens when the cache is down. A cache without an
invalidation plan is a bug on a delay.

## Steps

1. **Prove the need.** A measurement showing the same expensive read repeated (the
   `performance-profiling` skill). If the fix is "stop calling it twice", batch the
   query, or add an index (the `sql-query-performance` skill), do that instead.
2. **Choose the innermost layer that solves it.** Request-scoped memo (no invalidation
   problem); process memory (fast, per instance, diverges across instances); a shared
   store such as Redis (consistent across instances, one more dependency); HTTP caching
   (RFC 9111: `Cache-Control`, `ETag`/`If-None-Match` → `304`, CDN). Call `search_lore`
   for the repo's cache helper, key prefixing and serializer; use it.
3. **Design the key.** Every input that changes the output is in the key: identifiers,
   tenant, the caller's permission scope, locale, query parameters, and a schema or code
   version. Missing tenant = data leak; missing version = old shapes after a deploy.
   HTTP: `Vary` on every request header the response depends on.
4. **Set the TTL from the data.** Ask how stale this can be before someone is harmed;
   that is the TTL. Add ±10–20 % jitter so keys written together do not expire together.
   TTL is the safety net, not the invalidation plan.
5. **Invalidate on every write path, after commit.** List each code path that changes
   the source data in a comment beside the cache, and delete (not update) the key after
   the transaction commits. Deleting before commit lets a reader repopulate the old
   value. Also close the **stale-set race**: reader A misses and reads the old row,
   writer B commits and deletes the key, A then sets the old value, which stays until
   TTL. Guard with one of: versioned keys (bump a version on write; readers use the
   current version), a compare-on-set against a version tombstone (the write path replaces
   the entry with a tombstone carrying the new row version instead of deleting it, and a
   set succeeds only if its version is ≥ the stored one — a plain delete leaves nothing
   to compare), lease tokens that a delete invalidates (as in Facebook's memcache), or a short
   TTL when brief staleness is acceptable and stated.
6. **Guard against stampedes on expensive keys.** On a miss, let one caller recompute
   and the rest wait or serve stale: request coalescing / single-flight per key in
   process, a short lock key (`SET key NX PX`) across processes, probabilistic early
   refresh (XFetch), or `stale-while-revalidate` / `stale-if-error` (RFC 5861) for HTTP.
   The lock needs a timeout and a fallback so a crashed recomputer does not block reads;
   an expiring lock is acceptable here only because it guards work, not correctness (a
   lock that protects a write needs fencing: the `concurrency-and-async` skill, step 5).
7. **Fail open.** A cache timeout or outage falls back to the source with a short client
   timeout; it is never a user-facing error. Do not cache errors; cache "not found" only
   deliberately and briefly. Emit hit, miss and eviction counters so the cache's value
   and a cold or failing store are visible.
8. **Never share what must not be shared.** Authorization decisions, secrets and
   per-user data are per-user keys or not cached. Responses that vary by session are
   `Cache-Control: private` or `no-store`; a CDN never caches a response carrying
   `Set-Cookie` or user data.
9. **Test each behaviour**, one test per AC exercising the AC's own behaviour, plus: hit,
   miss, invalidation after each listed write path, TTL expiry with a fake clock (no
   sleeps), cache-down fallback, two tenants never sharing a value, and for expensive
   keys N concurrent misses causing one recomputation (parallel, per the
   `concurrency-and-async` skill's step 9). For HTTP, assert the exact
   `Cache-Control`, `ETag` and `Vary` headers and the `304` path.
10. **Evidence** with the `record-evidence` skill: before/after numbers and test output.

## Done when

- The key, TTL, invalidation paths and stale-set guard are written next to the code.
- Every write path invalidates after commit and is covered by a test.
- Cache outage degrades to the source; stampede is bounded for expensive keys.
- No per-user or authorization data can be served to another user or tenant.

## Anti-patterns

- TTL-only caching of data users edit and expect to see immediately.
- Invalidating before commit, or updating the cached value in place from the write path.
- Keys built from a subset of the query parameters.
- `Cache-Control: public` on an authenticated response.
- Tests that sleep for the TTL instead of advancing a fake clock.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While designing the key you learn what is cached where, how it is invalidated and what went wrong the last time it was stale.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
