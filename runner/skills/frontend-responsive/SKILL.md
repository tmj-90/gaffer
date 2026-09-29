---
name: frontend-responsive
description: Use when a ticket requires a layout to work across screen sizes — mobile/tablet/desktop, fluid typography, breakpoint or container-query behaviour, zoom and reflow, or fixing overflow and touch-target issues. Invoke for "make X responsive", "fix the mobile layout", "support tablet", or when adding any layout that must adapt.
stack: []
area: frontend
---

# Make the layout responsive

The layout must adapt from a 320 CSS px viewport to wide desktop with no horizontal
scroll, readable text at 200% zoom, and targets a thumb can hit. WCAG 2.2 AA makes most of
this testable: **1.4.10 Reflow** (usable at 320 CSS px wide without two-dimensional
scrolling), **1.4.4 Resize Text** (200%), **1.4.12 Text Spacing**, **1.3.4 Orientation**
(no portrait/landscape lock) and **2.5.8 Target Size** (24×24 CSS px minimum).

## Steps

1. **Read the scale.** Call `search_lore` and open the theme/tokens for the breakpoint
   scale, spacing tokens and whether the repo is mobile-first (`min-width` queries) or
   desktop-first. Reuse those breakpoints; do not add a new one for a single component.
2. **Choose the right query.** Page-level layout (sidebar collapses, nav becomes a
   drawer) uses viewport media queries. A component that appears in containers of
   different widths (card in a sidebar and in a main column) uses **container queries**
   (`container-type: inline-size` on the parent, `@container (min-width: …)` on the
   child) so it responds to its slot, not the window.
3. **Intrinsic layout first.** Flexbox with `flex-wrap`, Grid with
   `repeat(auto-fit, minmax(min(16rem, 100%), 1fr))`, `max-width` + `margin-inline: auto`
   for measure (45–75 characters for body text), `clamp()` for fluid type and space. A
   layout that needs five media queries usually wants one grid rule.
4. **Kill overflow at the source.**
   - Flex/grid children that contain long text get `min-width: 0` (their default
     `min-width: auto` refuses to shrink).
   - Long URLs, emails and IDs: `overflow-wrap: anywhere`.
   - Media: `max-width: 100%; height: auto`, with `width`/`height` attributes to keep
     aspect ratio and avoid layout shift.
   - Wide tables and code: wrap in a scroll container with `overflow-x: auto`, a label and
     `tabindex="0"` so keyboard users can scroll it; the page itself must not scroll
     sideways.
5. **Viewport and units.** Keep `<meta name="viewport" content="width=device-width,
   initial-scale=1">`; never `user-scalable=no` or `maximum-scale=1` (blocks zoom, fails
   1.4.4). Full-height mobile panels use `100dvh` (or `svh`) not `100vh`, which the mobile
   URL bar breaks. Type in `rem` so user font settings apply. Inputs at least 16px font to
   avoid iOS focus zoom. With `viewport-fit=cover`, pad fixed bars with
   `env(safe-area-inset-*)`.
6. **Touch and pointer.** Targets at least 24×24 CSS px with spacing (WCAG floor); aim
   for 44×44 on touch-primary UI (Apple HIG 44pt, Material 48dp). Hover-only affordances
   go behind `@media (hover: hover) and (pointer: fine)` with a tap/focus equivalent;
   primary actions never depend on hover.
7. **Reorder safely.** Visual reordering with `order`, `grid-area` or `flex-direction:
   row-reverse` must not break reading and focus order (1.3.2, 2.4.3). If the order must
   change, change the DOM.
8. **Verify across widths.** Run the repo's visual/E2E tooling at 320, 375, 768, 1024,
   1440 (or the repo's list) and assert no horizontal overflow, for example in Playwright:
   `expect(await page.evaluate(() => document.documentElement.scrollWidth <=
   window.innerWidth)).toBe(true)`. Also check 200% browser zoom at 1280 wide and a
   text-spacing override (line-height 1.5, letter-spacing 0.12em, word-spacing 0.16em,
   paragraph spacing 2em) for clipped text. Use only the browsers already installed
   (never `npx playwright install`); if none are, name the unchecked widths in the
   evidence.
9. **Evidence.** Record per-AC evidence with the `record-evidence` skill (the overflow
   assertion output, screenshot paths per width — saved only into the repo's
   git-ignored test output, never committed), then stop.

## Done when

- No horizontal page scroll at any width from 320 CSS px up; nothing clipped or overlapped
  at 200% zoom or under the text-spacing override.
- Each AC's layout behaviour is asserted at the widths the AC names.
- Touch targets meet 24×24 minimum; hover-only content has a keyboard/tap path.
- No new breakpoint values, no fixed pixel container widths, zoom not disabled.

## Anti-patterns

- `width: 1200px` containers, `height` fixed on text boxes, `overflow: hidden` on `body`
  to hide a bug.
- Hiding content on mobile that the AC needs (`display: none` is not responsive design).
- Device sniffing in JS (`window.innerWidth < 768` in render) where CSS can decide; it
  also causes hydration mismatches with server rendering.
- `100vh` full-screen sections on mobile; `vw`-only font sizes that ignore zoom.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**A responsive convention this repo follows — its breakpoint scale, a layout primitive it prefers, or a fluid-sizing rule.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
