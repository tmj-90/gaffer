---
name: frontend-design
description: Use when a ticket builds or reworks a user-facing frontend surface — a hero, landing page, dashboard, marketing section, or any screen where the *visual quality* matters, not just the markup. Produces distinctive, intentional, production-grade UI that avoids generic template aesthetics. Invoke for "build the landing page", "make this look premium / less templatey", "design the X section", or as the design pack for any high-visibility frontend work.
stack: [react, web]
area: frontend
---

# Design distinctive, production-grade frontend

The bar: *would this pass as a screenshot of a real, well-funded product?* This pack owns
visual judgement — direction, hierarchy, composition, motion. It consumes, and does not
re-derive, the identity from the `brand` skill, the token architecture and component state
matrices from the `design-system` skill, and the depth in the `frontend-a11y`,
`frontend-responsive` and `frontend-performance` skills.

## Pick a direction before code

"Clean minimal" is not a direction. If a brand exists, extend it in its idiom. If not,
commit to one direction the product warrants and write one sentence on why: editorial /
magazine, Swiss / International, neo-brutalism, bento, glassmorphism with real depth,
light or dark luxury, scrollytelling, retro-futurism. Dark mode is a product decision, not
a default. Choose a type pairing with a reason and a palette with semantic roles, not one
accent on grey-on-white.

## Required qualities

Each meaningful surface demonstrates **at least four**, and the evidence names which:

1. Hierarchy through scale contrast — a real type scale, one obvious focal point.
2. Intentional spacing rhythm — tight within groups, generous between them.
3. Depth or layering — surfaces, overlap, shadow or motion, not a flat stack.
4. Typography with character and a deliberate pairing.
5. Colour used semantically, not decoratively.
6. Designed hover / focus-visible / active / disabled states.
7. Grid-breaking editorial or bento composition where it fits.
8. Texture, grain or atmosphere when the direction calls for it.
9. Motion that clarifies flow (entry, state change, spatial relationship).
10. Data visualisation styled as part of the system (legends, tooltips, accessible
    colours, never colour-only encoding).

## Steps

1. **Read before designing.** `search_lore` for brand, tokens and design decisions;
   open `BRAND.md`, the token files and a sibling surface. Match the framework and styling
   system; never introduce a competing one.
2. **State the direction and the four-plus qualities** you will deliver, in one short
   note you will reuse as evidence.
3. **Consume tokens.** Colour, type scale (`clamp()` fluid sizes), space, radius, shadow,
   duration and easing come from the token layers (the `design-system` skill). If a value
   you need is missing, add a token in the right layer — never a literal in a component.
4. **Structure first.** Landmarks (`header`, `nav`, `main`, `section`, `footer`), one `h1`,
   headings in order, real buttons and links. Hierarchy comes from structure plus scale.
   Rich content never goes through `dangerouslySetInnerHTML`/`innerHTML` unsanitised;
   third-party scripts load `async`/`defer`, with Subresource Integrity when served from a
   CDN, and fit the repo's CSP (nonces, not `'unsafe-inline'`) (the `security-input-validation`
   skill).
5. **Compose.** Establish the grid, then break it deliberately for the focal moment.
   Vary card size and emphasis by importance; avoid uniform grids of identical cards.
   Keep body text at 45–75 characters per line, at least 16px, line-height about 1.5.
6. **Design every state** the surface has: interaction states with a visible
   `:focus-visible` ring (3:1 against its surroundings), loading at final size, empty with
   a next action, error with recovery.
7. **Motion on the compositor.** Animate `transform`, `opacity`, and sparingly
   `clip-path`/`filter`; never `width`/`height`/`top`/`left`/`margin`/`font-size`.
   150–300 ms for UI feedback, ease-out for entrances; wrap non-essential motion in
   `@media (prefers-reduced-motion: no-preference)`; `will-change` only while animating.
8. **Media and fonts that do not hurt Core Web Vitals.** Explicit `width`/`height` or
   `aspect-ratio` on every image; the hero/LCP image eager with `fetchpriority="high"`,
   everything below the fold `loading="lazy"`; AVIF/WebP via `srcset`/`sizes`; at most two
   font families, self-hosted, subset, one critical weight preloaded, `font-display: swap`
   with a metric-matched fallback; heavy libraries (animation, charts, 3D) loaded with
   dynamic `import()`. If the repo sets no bundle budget, aim for roughly 150 KB JS / 30 KB
   CSS gzipped on a landing page and 300 KB / 50 KB on app pages. Targets and measurement:
   the `frontend-performance` skill (LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1 at p75).
9. **Verify the rendered result** with the repo's browser tooling (Playwright or the
   visual-regression setup, only if already installed): screenshot 320 / 768 / 1024 /
   1440 and both themes if both exist, into the repo's git-ignored test output, never
   committed unless an AC asks; update baselines only for intended changes; run axe and a
   scripted keyboard pass (the `frontend-a11y` skill); run the repo's lint, type-check and
   tests. If nothing can render the page, say so in the evidence.
10. **Evidence** per AC with the `record-evidence` skill — screenshot paths, the
    direction note, the qualities delivered, axe output — then stop.

## Decision priorities

When goals conflict, the higher item wins:

1. Accessibility — contrast 4.5:1 text and 3:1 UI, visible focus, labelled controls,
   colour never the only signal, reduced motion honoured.
2. Interaction — targets ≥ 24×24 CSS px (44 on touch-primary UI), primary actions never
   hover-only, async actions show progress.
3. Performance — no layout shift from media or fonts, nothing render-blocking that is not
   critical.
4. Layout and navigation — no horizontal scroll, zoom never disabled, no fixed-pixel
   containers; predictable back, bottom nav of at most five items, deep-linkable state.
5. Direction consistency — one style held across the surface; SVG icons from one set,
   never emoji as icons.
6. Polish — texture, micro-interactions, atmosphere.

## Review checklist

- Has a point of view; does not look like unmodified Tailwind/shadcn/starter defaults.
- At least four required qualities visibly present and named in the evidence.
- Scale-based hierarchy; rhythm varies intentionally.
- Tokens only; no raw hex or `px` font sizes in components.
- Designed, visible focus; compositor-only motion that respects reduced motion.
- Landmarks, one `h1`, labelled controls; axe clean.
- Media dimensioned; LCP image not lazy; fonts capped.
- Both themes feel intentional if both exist.

Taste items on this list are guidance for the builder; a reviewer blocks only on an AC not
met, an AC without a test of its own behaviour, or a correctness, security or WCAG A/AA
defect (a performance miss only when an AC or the repo's budget names it).

## Done when

The direction note exists, four or more qualities are demonstrable at every checked width
(in screenshots where the repo can render them), axe (where the repo has it; otherwise the
evidence says so) and the repo's checks pass, and each AC is evidenced.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**A design-system fact this repo enforces — the token set, the brand voice, a chosen aesthetic direction, a motion philosophy, or a "never do X" visual rule.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
