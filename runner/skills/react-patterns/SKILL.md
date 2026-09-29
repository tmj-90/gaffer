---
name: react-patterns
description: Use when a ticket adds or changes React code — components, hooks, effects, context, actions and forms, server components, suspense boundaries — and it must follow the Rules of React and modern React 19 idioms (pure render, effects only for synchronisation, derived state computed not stored, stable keys, composition over configuration) as the framework pack for any React or Next.js change. Invoke for "build this in React", "the effect runs twice", "too many re-renders", or as the React layer on top of typescript-conventions.
stack: [react, next, nextjs, web]
area: frontend
---

# Write React the way React wants to be written

Most React bugs break the **Rules of React**: components and hooks must be pure
(same inputs → same output, no side effects during render), props and state are
immutable snapshots, and hooks are called unconditionally at the top level of a
component or custom hook. Model UI as a function of state, keep effects for
synchronising with systems outside React, and compose small components. This pack sits
on top of the `typescript-conventions` skill; the design bar is `frontend-foundations`.

## Steps

1. **Read the repo's React set-up.** React version (19.x adds Actions, `use`, ref-as-prop;
   19.2 adds `useEffectEvent` and `<Activity>`), whether the **React Compiler** is enabled
   (babel/SWC plugin in the build config), `eslint-plugin-react-hooks` config, framework
   (Next.js App Router, Remix/React Router, Vite SPA), and the state/data libraries (the
   `frontend-state-management` and `frontend-data-fetching` skills). Call `search_lore`
   and copy a sibling component's shape.
2. **Keep render pure.** No fetches, subscriptions, `Math.random()`/`Date.now()` for
   output, or mutation of props, state or module variables during render. Never mutate
   state in place (`items.push`); create a new value. Strict Mode double-invokes render and
   effects in development precisely to expose impurity — "the effect runs twice" means the
   effect lacks a correct cleanup, not that Strict Mode should be removed.
3. **You probably don't need that effect.** Before writing `useEffect`, check:
   - Derived from props/state? Compute it during render (`useMemo` only if measured as
     expensive and the Compiler is off).
   - Caused by a user action? Put it in the event handler.
   - Reset when an id changes? Key the component by the id.
   - Fetching? Use the data layer, a loader, or a Server Component.
   Effects remain for synchronisation: subscriptions, timers, imperative widgets, DOM
   measurement (`useLayoutEffect` only when you must measure before paint). Every effect
   that starts something returns a cleanup that stops it.
4. **Honest dependencies.** The array lists every reactive value the effect reads; never
   disable `react-hooks/exhaustive-deps`. Logic that must read the latest value without
   re-running the effect (logging, analytics, a callback prop) goes in `useEffectEvent`
   (React 19.2+) or a ref updated in an effect on older versions. Move pure helpers outside
   the component instead of wrapping them in `useCallback`.
5. **Memoisation policy.** With the React Compiler on, do not add `memo`/`useMemo`/
   `useCallback` by hand unless profiling shows the Compiler bailed out; fix the lint
   diagnostics that cause bail-outs instead. With it off, memoise only what the profiler
   shows is costly (the `frontend-performance` skill).
6. **Keys are identities.** Use stable ids from the data; never array indexes for lists
   that reorder, filter or delete, and never generated keys (`Math.random()`) — both lose
   input state and focus.
7. **Compose instead of configuring.** `children` and slot props over boolean variant
   props; custom hooks (named `useX`, calling hooks) for reusable stateful logic; context
   for rarely changing shared values, split by change frequency. In React 19 `ref` is a
   prop (no `forwardRef`) and `<Context value>` is the provider.
8. **Forms and mutations with Actions** where the repo uses them: `useActionState` for
   submit-with-result, `useFormStatus` for a pending button in a child, `useOptimistic`
   for an optimistic value that reverts when the action settles. Otherwise follow the
   repo's form library (the `frontend-forms-and-validation` skill).
9. **Async boundaries.** `<Suspense>` with a real fallback around the part that waits and
   an error boundary at route or section level; `startTransition`/`useDeferredValue` for
   non-urgent updates so typing stays responsive. No `async` function passed directly to
   `useEffect`; an inner async function checks a cancelled flag or `AbortSignal`.
10. **Server Components (Next.js App Router, RSC).** Server by default. `"use client"`
    marks a module boundary — push it to the interactive leaves; everything passed across
    it must be serialisable. Import server-only code through modules guarded with
    `import 'server-only'`. `"use server"` functions (Server Functions/Actions) are public
    HTTP endpoints: authenticate, authorise and validate their arguments inside the
    function every time (the `security-authz` and `security-input-validation` skills).
    Render nothing that differs between server and client (time, locale, `window`) without
    a client-only boundary, or hydration fails.
11. **Test and evidence.** Per AC, a component test through the rendered UI (the
    `frontend-testing` skill); run type-check, lint (hooks rules included) and tests.
    Record per-AC evidence with the `record-evidence` skill, then stop.

## Review checklist

A reviewer blocks on an item only when it causes a bug (stale value, leak, lost input,
hydration failure, missing auth), breaks an AC or leaves one untested; the memoisation
item is guidance.

- Render is pure; no state mutated in place; no side effects outside effects/handlers.
- No effect that mirrors props or state into other state, or handles a user event.
- Every effect that subscribes or starts a timer cleans up; dependency lint not silenced.
- Keys are stable data ids.
- Manual memoisation justified by the Compiler being off plus a profile.
- Client boundaries at the leaves; Server Functions check auth and validate input.
- Suspense/error boundaries have real fallbacks; no hydration-mismatching output.

## Done when

Lint (including `react-hooks`) and type-check are clean with no new suppressions, each AC
has a behaviour test, and the review checklist holds for the diff.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While copying a sibling component you learn the component structure, the provider layout and where the client/server boundaries sit.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
