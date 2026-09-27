---
name: react-patterns
description: Use when a ticket adds or changes React code — components, hooks, effects, context, server components, suspense boundaries — and it must follow modern React idioms correctly (effects only for synchronisation, derived state computed not stored, stable keys, composition over configuration) as the framework pack for any React or Next.js change. Invoke for "build this in React", "the effect runs twice", "too many re-renders", or as the React layer on top of typescript-conventions.
stack: [react, next, nextjs, web]
area: frontend
---

# Write React the way React wants to be written

Most React bugs are misuses of its model: effects used as event handlers, state that
mirrors props, keys that change identity, context that re-renders the world. Model UI as
a function of state, keep effects for synchronising with the outside, and compose small
components. This pack sits on top of `typescript-conventions`; the design bar is
`frontend-design` and `frontend-foundations`.

## Steps

1. **Read the repo's React conventions first.** Function components only, the state and
   data libraries in use (the `frontend-state-management` and `frontend-data-fetching`
   skills), server vs client component rules in Next.js, the folder pattern
   (feature-first or by kind). Call `search_lore` and copy a sibling component's shape.
2. **Model state, not effects.** Derived values are computed during render (or
   `useMemo`ed when expensive), never stored in a second `useState` synced by an effect.
   An effect exists only to synchronise with something outside React (a subscription, a
   DOM measurement, a non-React widget); if the effect is reacting to a user event, the
   code belongs in the event handler. Every effect returns a cleanup when it subscribes
   or starts anything.
3. **Get dependencies right, honestly.** Dependency arrays list everything the effect
   reads; never silence the lint rule. If the array is wrong because a function identity
   changes, stabilise the function (`useCallback`, move it outside, or a ref for the
   latest value), do not omit it.
4. **Keys are stable identities.** Never an array index for reorderable or removable
   lists; use the item's id. Changing a key deliberately is how you reset a component's
   state, and that intent gets a comment.
5. **Compose instead of configuring.** Prefer children and slot props to boolean props
   that multiply variants; extract hooks for reusable stateful logic and components for
   reusable UI; keep components under a screenful. Context is for genuinely shared,
   rarely-changing values (theme, session); split contexts by change frequency so a
   ticking clock does not re-render everything.
6. **Handle async safely.** Data through the data layer, not raw effects; suspense and
   error boundaries at route or section level with real fallbacks; no state updates
   after unmount (cleanup or the data layer handles it); no `async` directly in
   `useEffect` without an inner function and cancellation.
7. **Server and client components (Next.js App Router).** Default to server components;
   add `"use client"` only where interactivity or browser APIs are needed and push it to
   the leaf; never import server-only modules into client components; pass serialisable
   props; fetch on the server where possible.
8. **Measure re-renders when the ticket is about them** with the profiler (the
   `frontend-performance` skill); memoise components only when the profiler shows the
   cost. Test with the `frontend-testing` skill; evidence with the `record-evidence`
   skill.

## Review checklist (a React reviewer must check)

- No effect that merely mirrors props or state into other state; derived values computed.
- Every subscribing effect cleans up; dependency arrays complete, lint rule not silenced.
- Keys are stable ids, never indexes on mutable lists.
- Context split by change frequency; no giant provider re-rendering the tree.
- Client boundaries at the leaves; no server-only imports in client components.
- Async through the data layer; boundaries with real fallbacks.

## Rules

- Effects synchronise with the outside; they are not event handlers or state syncs.
- Compute derived state; never store it twice.
- Complete dependency arrays; stabilise identities rather than omit them.
- Stable keys; composition over boolean-prop configuration.
- Server components by default in the App Router; client at the leaves.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While copying a sibling component you learn the component structure, the provider layout and where the client/server boundaries sit.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
