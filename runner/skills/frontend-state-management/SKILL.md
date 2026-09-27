---
name: frontend-state-management
description: Use when a ticket adds or reshapes client-side state — where data lives, how it flows between components, server cache versus UI state, a store, context, URL state, optimistic updates — and the result must keep one source of truth per fact and avoid the prop-drilling or global-store sprawl that makes UIs unpredictable. Invoke for "the state is out of sync", "lift this state", "add a store for X", or "the page resets when I navigate back".
stack: [react, web, next, vue, svelte, angular]
area: frontend
---

# Manage frontend state deliberately

Every UI bug that says "it shows the old value" or "two parts disagree" is a state
ownership bug. Decide, for each fact, exactly one place it lives and one way it
changes; keep server data in the server-cache layer, UI state as local as possible, and
shareable state in the URL. Reach for a global store last, and only for state that is
truly global.

## Steps

1. **Classify every piece of state the ticket touches.** Server data (fetched, cached,
   invalidated), UI state (open/closed, selected tab, draft input), URL state (route,
   filters, pagination, the thing a user would bookmark), session/global state (current
   user, theme, feature flags). Call `search_lore` for the repo's chosen tools (a query
   library, a store, a router) and conventions.
2. **Put server data in the server-cache layer**, never copied into a store or
   component state: the query/cache library (TanStack Query, SWR, RTK Query, Apollo, the
   framework's loaders) owns fetching, caching, invalidation, and staleness (the
   `frontend-data-fetching` skill). Duplicating it into local state is how "shows the
   old value" happens.
3. **Keep UI state as local as it can be.** Component state for what only that
   component needs; lift to the nearest common ancestor when two siblings must agree;
   colocate reducers with the feature. Prop drilling through two levels is fine; through
   five is a smell that wants composition or context, not a global store.
4. **Put shareable state in the URL.** Filters, sort, page, selected item, open panel:
   anything a user expects to survive refresh, back, and a shared link. Use the router's
   typed search-param helpers; parse and validate on read; keep the URL the single source
   for that state.
5. **Use a global store only for truly global, client-owned state** (auth session, theme,
   an unsaved cross-page draft) and model it with the repo's existing library. Slices are
   small, actions are named for intent, selectors are memoised, and nothing in the store
   is a copy of server data.
6. **Make mutations explicit.** One function per state transition, named for the user's
   intent (`selectTicket`, not `setState`); optimistic updates roll back on failure and
   invalidate the affected queries; derived values are computed, never stored twice.
7. **Prove it with tests** at the level where the state lives: reducer/store tests for
   transitions, component tests for local state and URL sync (the `frontend-testing`
   skill), and one integration test for the optimistic/rollback path. Evidence with the
   `record-evidence` skill.

## Rules

- One owner per fact; derived values are computed, never duplicated.
- Server data lives in the server-cache layer, never mirrored into local or global state.
- UI state local first; URL for anything shareable; global store last and only for
  client-owned global facts.
- Transitions are named functions; optimistic updates always have a rollback.
- Use the repo's chosen libraries; never add a second store or query client.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While classifying state you learn which library owns which kind of state here and how URL state is encoded.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
