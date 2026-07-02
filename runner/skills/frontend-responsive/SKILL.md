---
name: frontend-responsive
description: Use when a ticket requires a layout to work across screen sizes — mobile/tablet/desktop, fluid typography, breakpoint behaviour, or fixing overflow and touch-target issues. Invoke for "make X responsive", "fix the mobile layout", "support tablet", or when adding any layout that must adapt.
stack: []
area: frontend
---

# Make the layout responsive

Make the affected UI adapt cleanly from small to large viewports with no overflow,
readable type at every size, and touch-friendly targets.

## Steps

1. **Read the lore first.** Call `search_lore` (Memory MCP) for the repo's
   breakpoint scale, spacing tokens, and responsive conventions (container queries,
   grid system, mobile-first vs desktop-first).
2. **Work mobile-first.** Start from the smallest target and layer enhancements up
   through the repo's existing breakpoints — don't invent new ones.
3. **Prefer fluid layout primitives** (flex/grid, `clamp()` type and spacing,
   intrinsic sizing) over fixed pixel widths and one-off media queries.
4. **Kill overflow.** Constrain media and long text (`max-width`, `min-width: 0`,
   wrapping); verify no horizontal scroll at any width.
5. **Size for touch.** Interactive targets ≥ 44×44px on touch; verify tap spacing.
6. **Verify across widths.** Check the breakpoints the repo cares about (e.g. 320,
   375, 768, 1024, 1440); confirm no overflow and that content reflows sensibly.
7. **Evidence.** Record the verification (screenshots or assertions) via the
   `record-evidence` skill, run tests + lint, and submit for review.

## Rules

- Mobile-first; reuse the repo's breakpoint scale and tokens — no magic pixel values.
- No horizontal overflow at any supported width.
- Fluid primitives over a thicket of fixed media queries.
- Pair with `frontend-a11y` so responsive changes keep focus order and labels intact.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**A responsive convention this repo follows — its breakpoint scale, a layout primitive it prefers, or a fluid-sizing rule.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
