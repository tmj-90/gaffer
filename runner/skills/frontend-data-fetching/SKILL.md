---
name: frontend-data-fetching
description: Use when a ticket loads or mutates server data from the client — fetching a list or a detail, polling, live updates, mutations with cache updates or optimistic UI, loading and error states, retries, concurrent edits — and the implementation must use the repo's data layer, never fetch in a bare effect, and handle loading, empty, error, stale and offline states visibly. Invoke for "load the X from the API", "it flashes empty then loads", "the list doesn't refresh after saving", or "add live updates".
stack: [react, web, next, vue, svelte, angular]
area: frontend
---

# Fetch and mutate server data from the client

Client data bugs are cache and concurrency bugs: a stale list after a save, an older
response overwriting a newer one, a double-submitted order, two tabs silently
overwriting each other. Use the repo's data layer (it solves dedup, caching, races and
cancellation once), key every query by its inputs, invalidate precisely, and treat
concurrent writers as a normal case, not an edge case.

## Steps

1. **Find the data layer.** Call `search_lore` and read one existing screen: the query
   library (TanStack Query, SWR, RTK Query, Apollo), framework loaders/Server Components,
   the typed API client (the `openapi-contract` skill), the query-key factory, auth
   handling. A `fetch` in `useEffect` with hand-rolled `loading` flags is a defect where a
   layer exists.
2. **Know the defaults you inherit.** TanStack Query v5: `staleTime` 0 (data is stale
   immediately, refetched on mount/focus/reconnect), `gcTime` 5 min, queries retry 3 times
   with backoff, mutations do not retry, `queryFn` receives an `AbortSignal`. SWR:
   revalidate on focus and reconnect, 2 s dedupe. Set `staleTime` deliberately from how
   often the data changes; do not turn off refetching to hide a bug.
3. **Key by every input.** Arrays from the repo's factory, general to specific:
   `['tickets', 'list', { status, page, locale }]`, `['tickets', 'detail', id]`. Any value
   the request uses that is missing from the key serves the wrong cached data. Pass the
   `signal` to `fetch` so key changes and unmounts cancel.
4. **Render the states on purpose.** Pending first load (a skeleton at the final layout's
   size), empty (a message plus the next action), error (what failed plus Retry; never the
   raw response body), refreshing with data shown (a subtle indicator, not a skeleton
   flash), and success. With pagination or filters use `placeholderData: keepPreviousData`
   (TanStack) so the list does not blank between pages. In v5, `isPending` means no data
   yet; `isFetching` means a request is in flight.
5. **Mutate through the same layer.** After success, `invalidateQueries` on the narrowest
   key prefix affected (list and detail), or `setQueryData` with the server's response.
   Optimistic update recipe: `onMutate` → `cancelQueries` for the key → snapshot previous
   data → write the optimistic value → return the snapshot; `onError` → restore it;
   `onSettled` → invalidate. Block duplicate submission while pending (`isPending`), and
   send an idempotency key for non-idempotent creates if the API supports one (the
   `idempotency-and-retries` skill).
6. **Handle concurrent writers.** If the API returns a version or `ETag`, send it back
   (`If-Match` or a `version` field). On `409`/`412`, keep the user's edit, show that the
   record changed, and offer reload-and-reapply — never retry blindly and overwrite. With
   two tabs open, the second tab refetches on focus; confirm your mutation does not
   depend on data the other tab changed.
7. **Poll and stream deliberately.** `refetchInterval` tied to the data's change rate,
   paused in background tabs (the default); SSE/WebSocket messages update the query cache
   (`setQueryData` or invalidate), reconnect with backoff and jitter, and refetch after
   reconnect to fill the gap.
8. **Fail safely.** Retry only idempotent reads and transient errors (network, 5xx,
   429 honouring `Retry-After`); do not retry 4xx. A 401 triggers one refresh or a
   redirect to sign-in, not a loop. Render errors inside an error boundary with a reset.
9. **Test each AC's behaviour** (the `frontend-testing` skill) with the network mocked at
   the fetch boundary (MSW or the repo's equivalent) and a fresh `QueryClient` with
   `retry: false` per test:
   - each state the AC names renders (pending, empty, error with retry, success);
   - the mutation updates what the user sees (assert the list, not that a function ran);
   - optimistic rollback: server returns 500 → the old value is back and an error shows;
   - race: respond to request A after request B → B's data is shown;
   - double-click submit → exactly one request;
   - stale version: server returns 409/412 → the user's input is kept and the conflict is
     shown.
10. **Evidence** per AC with the `record-evidence` skill, then stop.

## Done when

Every AC has a test through the rendered UI with the network mocked; mutations leave no
stale screen; the race, rollback, double-submit and (when the API is versioned)
conflict cases are covered; no bare fetch-in-effect was added.

## Anti-patterns

- Copying query data into `useState` ("so I can edit it") and then showing stale copies.
- `invalidateQueries()` with no key (refetches everything) or keys missing an input.
- `refetchOnWindowFocus: false` or huge `staleTime` to stop a flicker you did not
  diagnose.
- Optimistic updates without `cancelQueries` (an in-flight refetch overwrites them).
- Retrying POSTs automatically; toasts as the only error channel; spinners that shift
  layout.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While keying queries you learn the query-key factory, the client wrapper and how auth refresh is handled on the client.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
