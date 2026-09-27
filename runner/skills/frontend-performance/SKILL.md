---
name: frontend-performance
description: Use when a ticket is about a slow or heavy frontend — page load, bundle size, Core Web Vitals (LCP, INP, CLS), a janky list, re-render storms, large images or fonts — and the fix must be measured in the browser before and after with the same tooling, not guessed. Invoke for "the page is slow", "reduce the bundle", "fix the layout shift", "the table lags when typing", or a failing performance budget.
stack: [react, web, next, vue, svelte, angular]
area: frontend
---

# Make the frontend fast, measurably

Frontend performance is measured by what a user's browser does: bytes shipped, work on
the main thread, layout shifts, and time to interactive. Profile in the browser, find the
biggest cost, do less of it (ship less, render less, load later), and show the same
measurement afterwards. Cleverness comes after subtraction.

## Steps

1. **Pick the metric and measure it.** LCP, INP, CLS, TTFB, bundle bytes (gzipped, per
   route), or a component's render time. Use the repo's tooling (Lighthouse CI, the
   bundle analyzer, a performance budget, `web-vitals` reporting) and record the
   baseline with the exact command/URL and conditions (throttling profile, cold cache).
   Call `search_lore` for budgets and past decisions.
2. **Profile in the browser.** The Performance panel for long tasks and layout thrash,
   the React/Vue devtools profiler for re-renders, the Network panel for the waterfall,
   the bundle analyzer for what ships. Find the top item; fix that.
3. **Ship less.** Code-split by route and by heavy component; import only the pieces
   you use from large libraries (or replace them); tree-shake; remove polyfills modern
   browsers do not need; defer third-party scripts; compress and cache static assets
   with long TTLs and hashed names (the `caching-strategy` skill).
4. **Render less.** Memoise expensive derived values and components that re-render with
   unchanged props; move state down so a keystroke does not re-render the page;
   virtualise long lists; avoid layout reads in loops; batch DOM writes. Verify with the
   profiler that the re-render count actually dropped.
5. **Load media right.** Responsive images with `srcset`/`sizes`, modern formats, width
   and height set (no CLS), lazy-loading below the fold, the LCP image preloaded and
   never lazy; fonts self-hosted, subsetted, `font-display: swap` or `optional`, and
   preloaded when they are in the first paint.
6. **Protect the main thread.** Move heavy computation to a worker or the server; debounce
   input handlers that trigger work; use `requestIdleCallback`/scheduling for non-urgent
   work; keep INP under the target by keeping event handlers short.
7. **Measure again** under the same conditions, repeated runs, and report before/after
   with variance. Add or update the performance budget so the win is guarded in CI.
8. **Evidence** with the `record-evidence` skill: baseline and after numbers, the
   profile's top item, the bundle diff.

## Rules

- A baseline in the browser before any change; the same measurement after.
- Subtract first: fewer bytes, fewer renders, later loads; algorithms last.
- Images and fonts sized, formatted, and preloaded/lazy-loaded correctly; zero CLS
  from media.
- Memoisation is verified by the profiler, not assumed.
- Budgets exist and are enforced in CI for what you improved.
- Never trade accessibility or correctness for a score (no removing focus styles, no
  skipping validation to "feel faster").
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While measuring you learn the budgets, the heaviest dependencies and why they stay, and how the measurement is set up.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
