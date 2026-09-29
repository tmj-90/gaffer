---
name: frontend-state-management
description: Use when a ticket adds or reshapes client-side state — where data lives, how it flows between components, server cache versus UI state, a store, context, URL state, persisted drafts, optimistic updates, multiple tabs — and the result must keep one source of truth per fact and avoid the prop-drilling or global-store sprawl that makes UIs unpredictable. Invoke for "the state is out of sync", "lift this state", "add a store for X", or "the page resets when I navigate back".
stack: [react, web, next, vue, svelte, angular]
area: frontend
---

# Manage frontend state deliberately

"It shows the old value" and "these two parts disagree" are ownership bugs: a fact was
copied, and the copies drifted. For each fact decide one owner and one way it changes.
Server data belongs to the server-cache layer, UI state stays as local as possible,
shareable state lives in the URL, and a global store holds only client-owned global
facts.

## Steps

1. **Inventory the state the ticket touches** and classify each fact:

   | Kind | Examples | Owner |
   |------|----------|-------|
   | Server data | lists, records, the current user's profile | query/cache layer |
   | URL state | filters, sort, page, selected id, open tab | router search params / path |
   | Local UI state | open/closed, hover, an input's draft | the component, or nearest common parent |
   | Global client state | theme, auth session handle, cross-page draft | the repo's store |
   | Derived | counts, filtered lists, "is valid" | computed in render, never stored |

   Call `search_lore` for the chosen libraries and conventions.
2. **Server data stays in the cache layer** (TanStack Query, SWR, RTK Query, Apollo,
   loaders — the `frontend-data-fetching` skill). Read it where needed with the same
   query key; do not copy it into `useState` or a store. To edit a record, keep only the
   draft fields in form state, initialised from the query once, and submit a mutation.
3. **Local first; lift only as far as needed.** Two siblings that must agree share the
   nearest common parent. Passing props through two or three levels is fine; deeper
   usually wants composition (pass the rendered child) before context. Context carries
   rarely changing values; split fast-changing values into their own context so a
   keystroke does not re-render the tree.
4. **URL for anything a user would share, bookmark or expect back.** Parse search params
   on read with a schema (unknown or invalid values fall back to defaults, never crash);
   write with the router's API, `replace` for typing-driven changes and `push` for
   navigations the Back button should undo. The URL is then the only copy — do not mirror
   it into state.
5. **A global store only for truly global client state**, using the repo's library
   (Zustand, Redux Toolkit, Pinia, signals). Small slices, actions named for intent
   (`selectTicket`), selectors that return the minimum so subscribers re-render only when
   their slice changes. External stores in React are read through the library's hooks or
   `useSyncExternalStore`, never by subscribing in an effect.
6. **Transitions are explicit and safe under concurrency.**
   - One named function per transition; reducers are pure (no fetches, no `Date.now()`,
     no mutation of the previous state).
   - Updates that depend on the previous value use the functional form
     (`setCount(c => c + 1)`) so rapid events are not lost.
   - Optimistic updates snapshot and roll back on failure, and a slower earlier response
     must not overwrite a newer optimistic value (cancel or ignore superseded requests).
7. **Persisted state (localStorage, IndexedDB) is versioned.** Store a schema version,
   migrate or discard old shapes on read, never persist server data or secrets, and read
   it after hydration (or with the library's hydration helper) to avoid server/client
   mismatches. If two tabs can edit the same persisted state, sync through the `storage`
   event or `BroadcastChannel`, or declare last-write-wins in the ticket — do not leave it
   undefined.
8. **Reset deliberately.** To reset a subtree's state when an entity changes, key it by
   the entity id (`<Editor key={ticketId} />`) instead of an effect that clears fields.
9. **Test where the state lives** (the `frontend-testing` skill): pure reducer/store
   transition tests; a component test per AC that drives the UI and asserts what is
   shown; a URL test (load with params → correct view; change filter → URL updated; Back
   restores); the rollback path; and rapid repeated events (click ×5 → count is 5). Record
   per-AC evidence with the `record-evidence` skill, then stop.

## Done when

Every fact the ticket touches has one named owner; no server data is duplicated in
local or global state; shareable state survives refresh and Back; each AC has a test
that exercises its behaviour through the UI.

## Anti-patterns

- `useEffect(() => setX(props.y), [props.y])` — state mirroring props or query data.
- Storing derived values (`filteredItems`, `total`) alongside their inputs.
- One app-wide context holding everything; a store slice per component.
- A second store library or query client next to the existing one.
- Persisted state with no version, restored before hydration.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While classifying state you learn which library owns which kind of state here and how URL state is encoded.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
