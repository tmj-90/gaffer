---
name: frontend-performance
description: Use when a ticket is about a slow or heavy frontend — page load, bundle size, Core Web Vitals (LCP, INP, CLS), a janky list, re-render storms, large images or fonts — and the fix must be measured in the browser before and after with the same tooling, not guessed. Invoke for "the page is slow", "reduce the bundle", "fix the layout shift", "the table lags when typing", or a failing performance budget.
stack: [react, web, next, vue, svelte, angular]
area: frontend
---

# Make the frontend fast, measurably

Performance is what the user's browser does: bytes shipped, main-thread work, layout
shifts. Measure the right metric, find the biggest cost, subtract it, and measure again
the same way. A change with no before/after number is not a performance fix.

## The targets (web.dev Core Web Vitals)

Assessed on **field data at the 75th percentile**, mobile and desktop separately:

| Metric | Good | Poor | What it measures |
|--------|------|------|------------------|
| LCP | ≤ 2.5 s | > 4 s | when the largest image/text block in the viewport renders |
| INP | ≤ 200 ms | > 500 ms | slowest-ish input → next paint across the visit (replaced FID in 2024) |
| CLS | ≤ 0.1 | > 0.25 | unexpected layout shift, largest session window |

Lab tools (Lighthouse) cannot measure INP; use **Total Blocking Time** as the lab proxy
and a scripted interaction trace for the specific slow input.

## Steps

1. **Pin the metric and the conditions.** Name one metric from the ticket (LCP, INP, CLS,
   route JS bytes gzipped, a component's commit time). Call `search_lore` for budgets and
   the measurement set-up. Record the baseline command and conditions, e.g.
   `npx --no -- lighthouse <url> --preset=perf --form-factor=mobile
   --throttling-method=simulate --chrome-flags="--headless=new" --output=json` run 5 times
   (report the median), or the repo's Lighthouse CI / bundle analyzer / `web-vitals`
   report. Use a production build, never the dev server. Use only tools already installed
   (installs are hook-blocked; headless, plain `npx` downloads a missing package, so write
   `npx --no -- <tool>`) — if none can measure the metric, say so in the evidence rather than
   guessing.
2. **Diagnose by sub-part, not by guess.**
   - **LCP** = TTFB + resource load delay + resource load duration + element render delay.
     Find which part dominates from the Lighthouse JSON (the LCP element and its phase
     breakdown) or a Playwright/Chrome trace — you have no interactive DevTools. Common causes: the LCP image is
     discovered late (CSS background, client-rendered, `loading="lazy"`), render-blocking
     CSS/fonts/JS, slow server response.
   - **INP** = input delay + processing duration + presentation delay. Script the slow
     interaction (Playwright plus a trace, or the `web-vitals` attribution build); look
     for long tasks (> 50 ms) before or inside
     the handler and for large re-renders or style/layout work after it. The `web-vitals`
     attribution build (`onINP(cb, { reportAllChanges: true })`) names the element and
     phase.
   - **CLS**: the Lighthouse layout-shift audit or the `web-vitals` attribution shows
     which node moved. Usual causes: images/iframes/
     ads without dimensions, late web fonts with different metrics, content injected above
     existing content, animations of layout properties.
   - **Bundle**: the analyzer (`vite-bundle-visualizer`, `@next/bundle-analyzer`,
     `source-map-explorer`) shows the top modules per route.
3. **Fix the dominant cost — subtract first.**
   - LCP: server-render or statically render the hero; make the LCP image discoverable in
     the HTML with `fetchpriority="high"` and never lazy; `preload` only it and the one
     critical font; inline critical CSS or cut render-blocking CSS; cache the HTML/CDN
     where the data allows (the `caching-strategy` skill).
   - INP: do less in the handler (update the visible state first, defer the rest); yield
     between chunks of work (`await scheduler.yield()` where supported, else
     `setTimeout(0)`); in React mark non-urgent updates with `startTransition` /
     `useDeferredValue`; virtualise long lists; avoid forced synchronous layout (reading
     `offsetHeight` after writing styles in a loop); move heavy pure work to a Web Worker.
   - CLS: `width`/`height` or `aspect-ratio` on all media and embeds; reserve space for
     late content (skeletons at the final size); fonts with `font-display: optional` or a
     metric-matched fallback (`size-adjust`, `ascent-override`); animate only `transform`
     and `opacity`.
   - Bytes: route- and component-level code splitting (`import()`); replace or deep-import
     heavy libraries; drop unneeded polyfills; defer third-party scripts; responsive images
     (`srcset`/`sizes`, AVIF/WebP) sized to their rendered box.
   - Also check back/forward cache eligibility (no `unload` handlers,
     no `Cache-Control: no-store` on HTML without reason) — bfcache makes back navigations
     instant.
4. **Re-render storms (React/Vue).** Count renders in a test (React `<Profiler>`
   `onRender`, or the framework's equivalent) rather than interactive devtools; fix the cause
   (state too high, unstable props, context carrying fast-changing values) before adding
   memoisation. If the React Compiler is enabled, do not hand-add `memo`/`useMemo`; if it
   is not, memoise only what the profiler shows is costly.
5. **Measure again** with the identical command and conditions, same number of runs;
   report median before/after and the spread. A change within run-to-run noise is not a
   win — say so.
6. **Guard it.** Add or tighten the budget the repo uses (Lighthouse CI assertion,
   `size-limit`, bundle-size check) for the metric you improved, so a regression fails CI.
7. **Evidence** via the `record-evidence` skill: the command, baseline and after medians,
   the dominant cost you removed, the bundle diff. Then stop.

## Done when

- The ticket's metric improved beyond noise under identical conditions, and meets the
  stated budget or the "good" threshold above if the ticket names none.
- No other Core Web Vital or route bundle regressed.
- Where the repo has budget tooling, a budget guards the improvement; otherwise the
  evidence names the missing guard (adding one is a `dependency-upgrade` decision).
  Functional tests still pass.

## Anti-patterns

- Measuring on the dev build, on a fast desktop only, or with one run.
- `loading="lazy"` or a fade-in animation on the LCP element; preloading many resources.
- Blanket `useMemo`/`React.memo` without a profile; debouncing a click instead of making
  the handler cheap.
- Skeletons whose size differs from the loaded content (they cause the shift they hide).
- Removing focus styles, labels or validation to improve a score.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While measuring you learn the budgets, the heaviest dependencies and why they stay, and how the measurement is set up.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
