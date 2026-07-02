---
name: frontend-a11y
description: Use when a ticket requires accessibility work or when delivering UI that must be usable by everyone — keyboard navigation, screen-reader labelling, focus management, colour contrast, or reduced-motion support. Invoke for "make X accessible", "fix the a11y issues", "add keyboard support", or as a companion check on any new component.
stack: []
area: frontend
---

# Make the UI accessible

Bring the affected UI to WCAG 2.2 AA: operable by keyboard, understandable to
assistive tech, and tolerant of user preferences — proven, not assumed.

## Steps

1. **Read the lore first.** Call `search_lore` (Memory MCP) for the repo's
   accessibility conventions and any design-system a11y primitives already in use.
2. **Use semantic HTML before ARIA.** Reach for the native element (`button`, `a`,
   `label`, `nav`, `dialog`) first; add ARIA roles/attributes only to fill real gaps.
3. **Make it keyboard operable.** Every interactive element must be focusable and
   activatable by keyboard, in a logical tab order, with a visible focus indicator.
4. **Label everything.** Associate inputs with `label`s, give icon-only controls an
   accessible name, and announce dynamic changes with live regions where needed.
5. **Manage focus** for overlays/dialogs/menus: move focus in on open, trap it while
   open, restore it on close.
6. **Respect preferences.** Honour `prefers-reduced-motion`; ensure text/background
   contrast meets AA (4.5:1 body, 3:1 large text).
7. **Verify + evidence.** Run the repo's automated a11y checks and exercise keyboard
   flow; record the results via the `record-evidence` skill and submit for review.

## Rules

- Native semantics over ARIA; never use ARIA to paper over the wrong element.
- No keyboard trap, no focus loss, no invisible focus.
- Don't remove focus outlines without a compliant replacement.
- Colour is never the only signal — pair it with text or icon.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**An accessibility pattern or boundary this repo standardises on — a focus-management rule, a semantics convention, or an a11y check that must pass.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
