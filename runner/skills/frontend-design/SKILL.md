---
name: frontend-design
description: Use when a ticket builds or reworks a user-facing frontend surface — a hero, landing page, dashboard, marketing section, or any screen where the *visual quality* matters, not just the markup. Produces distinctive, intentional, production-grade UI that avoids generic template aesthetics. Invoke for "build the landing page", "make this look premium / less templatey", "design the X section", or as the design pack for any high-visibility frontend work.
stack: [typescript, javascript, react]
area: frontend
---

# Design distinctive, production-grade frontend

Build frontend that looks **intentional, opinionated, and specific to the product** — not
a default template. The bar is: *would this look believable in a real product screenshot?*
This pack is about visual quality and design judgement; pair it with `frontend-component`,
`frontend-a11y`, and `frontend-responsive` for structure, semantics, and breakpoints.

## Before you write any code — pick a direction

Generic defaults ("clean minimal") are not a direction. Commit to a specific one and let
it drive every decision:

- **Editorial / magazine**, **Swiss / International**, **Neo-brutalism**, **Bento layouts**,
  **Glassmorphism with real depth**, **dark or light luxury** (disciplined contrast),
  **Scrollytelling**, **retro-futurism**, **3D integration**.
- Do **not** default to dark mode. Choose the direction the *product* wants.
- Define the palette deliberately (semantic roles, not one accent on grey-on-white) and a
  real **typography pairing strategy** — pick fonts with character, with a reason.
- Read the repo's existing tokens/brand first. If a brand exists, **extend it in its idiom**;
  do not re-pitch the aesthetic.

## Required qualities

Every meaningful surface must demonstrate **at least four**:

1. **Hierarchy through scale contrast** — a real type scale, not uniform sizes.
2. **Intentional rhythm** in spacing — not the same padding on everything.
3. **Depth / layering** — overlap, shadows, surfaces, or motion; not a flat stack.
4. **Typography with character** and a deliberate pairing.
5. **Colour used semantically**, not just decoratively.
6. **Designed hover / focus / active states** — interaction feels considered.
7. **Grid-breaking editorial or bento composition** where it fits.
8. **Texture, grain, or atmosphere** when the direction calls for it.
9. **Motion that clarifies flow**, never distracts.
10. **Data visualisation treated as part of the design system**, not an afterthought.

## Steps

1. **Read the lore + tokens first.** `search_lore` (Memory MCP) for the design system,
   brand voice, and component conventions. Inspect `tokens.css`/theme files and a sibling
   surface; match the framework and styling system — never introduce a competing one.
2. **Commit to one direction** (above) and a palette + type pairing before building.
3. **Define design tokens as CSS custom properties** — colour, type scale (`clamp()` for
   fluid sizes), spacing, durations, easings. Reference tokens everywhere; **hardcode no
   raw hex or `px` font sizes** in component files.
4. **Build semantic HTML first** — `header`/`nav`/`main`/`section`/`footer`, real `button`s,
   a single `h1`, labelled landmarks. Hierarchy comes from structure + scale, not `div` soup.
5. **Layer and compose** — use overlap, surfaces, and a grid you deliberately break for
   editorial moments; avoid uniform card grids with no hierarchy.
6. **Design every interactive state** — hover/focus/active/disabled — so they feel
   designed, with visible, accessible focus rings (never `outline: none` with no replacement).
7. **Animate on the compositor only** — `transform`, `opacity`, `clip-path`, `filter`
   (sparingly). **Never animate** `width`/`height`/`top`/`left`/`margin`/`font-size`. Use
   `will-change` narrowly and remove it when done; respect `prefers-reduced-motion`.
8. **Mind performance budgets** (see below) — fluid type, optimised images with explicit
   dimensions, deferred non-critical JS, ≤2 font families with `font-display: swap`.
9. **Verify + evidence.** Run the repo's tests + lint; for visual-heavy work prefer
   screenshot/visual checks at key breakpoints. Record `test_output` via `record-evidence`
   and submit for review.

## Build / Test

- Run the repo's configured test + lint; type-check (`tsc --noEmit`) for TS surfaces.
- **Visual regression carries more signal than brittle markup assertions** for visual work:
  screenshot the key breakpoints (320 / 768 / 1024 / 1440) and both themes if both exist.
- Run an automated a11y check (axe/Lighthouse) and verify keyboard nav + reduced-motion.
- The DoD is verified by the repo's configured commands — record the output as evidence.

## Performance budgets (Core Web Vitals)

- Targets: **LCP < 2.5s · INP < 200ms · CLS < 0.1 · FCP < 1.5s**.
- Bundle: landing **< 150kb JS / < 30kb CSS** gzipped (app pages < 300kb / < 50kb).
- All images: explicit `width`/`height`; hero `loading="eager"` + `fetchpriority="high"`;
  below-fold `loading="lazy"`; prefer AVIF/WebP; never ship images far beyond rendered size.
- Preload only the hero image + the single critical font; defer non-critical CSS/JS;
  dynamically import heavy libs (e.g. `await import('gsap')`).

## Security (frontend)

- **No unsanitised HTML** — avoid `dangerouslySetInnerHTML`/`innerHTML` unless sanitised
  with a vetted sanitizer first; escape dynamic values.
- Third-party scripts load `async`/`defer`, with SRI when served from a CDN.
- A production **CSP** should be configured (prefer per-request nonce over `'unsafe-inline'`).

## Review checklist (a design reviewer must check)

- **Doesn't look like a default Tailwind/shadcn/template** — has a point of view.
- **At least four required qualities** are clearly present (hierarchy, rhythm, depth,
  type, semantic colour, designed states, composition, atmosphere, motion, data-viz).
- **Hierarchy via scale**, not uniform emphasis; rhythm is intentional, not uniform padding.
- **Tokens, not hardcoded values** — no raw hex / `px` font sizes leaking into components.
- **Designed hover/focus/active states**; focus is visible and accessible.
- **Motion is compositor-only** and respects `prefers-reduced-motion`.
- **Semantic HTML + a11y** — landmarks, one `h1`, labelled controls, contrast holds.
- **Performance** — images have dimensions, no obvious render-blocking, no layout shift,
  fonts capped and `swap`ed.
- **Both themes feel intentional** if both exist.

## Rules

- Pick a specific direction and a deliberate palette + type pairing — never ship "generic clean".
- Tokens for all colour/spacing/type; no hardcoded palette/sizes in components.
- Animate compositor-friendly properties only; honour reduced-motion.
- Semantic HTML, accessible focus, no unsanitised HTML; match the repo's framework + styling system.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**A design-system fact this repo enforces — the token set, the brand voice, a chosen aesthetic direction, a motion philosophy, or a "never do X" visual rule.** That kind of fact is *lore* — it would have saved you time had the
previous agent recorded it, and it will save the next one. Capture it.

When you learn something that future agents on this repo should know *before they
start* — a convention, a gotcha, an architectural fact, a decision, a boundary —
call the Memory MCP `suggest_lore` tool once, at the close of your work:

- `title` — the rule/fact in a few words.
- `summary` — one self-contained paragraph: the *what* and the *why*.
- `body` — the detail and evidence that lets a human verify it.
- `repos` — the repo(s) the rule applies to.
- `tags` — lowercase (e.g. `conventions`, `gotchas`, `security`, `db`).
- `source` — a URL to the ticket/PR/ADR that justifies it (records without a
  source are lower-trust); `confidence` — `low` for an inferred convention,
  `high` only when you have a source.

**This is suggested, gated knowledge — not auto-truth.** `suggest_lore` lands a
DRAFT; a human reviews and approves it. You never approve your own lore.

**Capture reusable knowledge, not ticket noise.** Lore is a convention, gotcha,
decision, or boundary the *next* agent needs — never per-ticket trivia (what this
diff changed, a path you happened to read, transient task state). The honest test:
*would a teammate six months from now thank you for this record?* If unsure, skip —
a missing record costs one re-search; a noisy one costs every future reader.
