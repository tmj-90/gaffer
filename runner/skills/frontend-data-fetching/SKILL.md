---
name: frontend-data-fetching
description: Use when a ticket loads or mutates server data from the client — fetching a list or a detail, polling, live updates, mutations with cache updates, loading and error states, retries — and the implementation must use the repo's data layer, never fetch in a bare effect, and handle loading, empty, error, stale and offline states visibly. Invoke for "load the X from the API", "it flashes empty then loads", "the list doesn't refresh after saving", or "add live updates".
stack: [react, web, next, vue, svelte, angular]
area: frontend
---

# Fetch and mutate server data from the client

Data fetching is where most UI complexity lives: caching, deduplication, invalidation,
races, and the five states every screen has. Use the repo's data layer so those problems
are solved once, declare what each screen needs, and render every state on purpose.

## Steps

1. **Use the repo's data layer.** A query library (TanStack Query, SWR, Apollo, RTK
   Query), the framework's loaders/server components, or a typed API client generated
   from the contract (the `openapi-contract` skill). Call `search_lore` for conventions
   (query keys, the client wrapper, auth header handling). A `fetch` inside a
   `useEffect` with manual loading flags is not acceptable where a data layer exists.
2. **Key queries by their inputs.** Every parameter that changes the result is in the
   query key (id, filters, page, locale); keys follow the repo's factory pattern so
   invalidation can target them precisely.
3. **Render all five states**: loading (skeleton matching the final layout, not a
   spinner that shifts everything), empty (a real empty state with the next action),
   error (what failed and a retry), stale-while-revalidating (show data, indicate
   refresh subtly), and success. Decide each with the design system's components.
4. **Mutate through the same layer.** A mutation invalidates or updates the exact
   queries it affects; optimistic updates roll back on failure; the UI disables the
   action while in flight to prevent double submits; success and failure are announced
   (toast or inline, per the repo).
5. **Handle races and cancellation.** Rapid parameter changes must not let an older
   response overwrite a newer one; the data layer handles this when keys are right.
   Cancel in-flight requests on unmount or key change where supported.
6. **Poll and stream deliberately.** Polling has an interval justified by the data's
   change rate and pauses when the tab is hidden; live updates (SSE/WebSocket) update the
   cache rather than local state, reconnect with backoff, and fall back to polling.
7. **Fail safely.** Retries only for idempotent GETs and transient errors, with a cap;
   401 routes to re-auth once, not in a loop; error boundaries catch render-time
   failures; never show raw error bodies to users.
8. **Test**: each state renders, the mutation invalidates the right keys, the optimistic
   rollback works, an out-of-order response does not win, the retry policy caps (the
   `frontend-testing` skill, with the network mocked at the fetch boundary). Evidence
   with the `record-evidence` skill.

## Rules

- All server data through the repo's data layer; no bare fetch-in-effect.
- Query keys contain every input; invalidation targets exact keys.
- Loading, empty, error, stale, success: all five designed and rendered.
- Mutations invalidate or update precisely; optimistic updates roll back; in-flight
  actions are disabled.
- Retries bounded and only for idempotent requests; no re-auth loops; no raw errors
  shown.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While keying queries you learn the query-key factory, the client wrapper and how auth refresh is handled on the client.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
