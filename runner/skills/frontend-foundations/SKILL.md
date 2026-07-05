---
name: frontend-foundations
description: Use on any frontend delivery to hold the surface-specific quality floor that `engineering-craft` doesn't cover — intentional visual hierarchy over template defaults, accessible-by-default markup, design tokens instead of hardcoded values, reusable components matching the repo, and compositor-friendly motion. Invoke whenever the change touches UI (a component, screen, page, or style), as the always-on companion to the deeper `frontend-design`, `frontend-component`, `frontend-a11y`, and `frontend-responsive` packs. For "make the UI production-grade", "don't ship a generic template", "is this accessible?".
stack: []
area: frontend
---

# Frontend foundations — the UI quality floor

The frontend companion to `engineering-craft`. Craft holds the *code* bar (structure,
errors, tests); this holds the *surface* bar — the things that separate a real product UI
from a working-but-generic one. It is a floor and a lens, not the full treatment: for
depth, invoke the deep packs it points to. Apply it on any change that touches UI, and
confirm it in `self-review`.

Composes with `minimalism` the same way craft does: this is never a licence to add
chrome or animation the ticket didn't ask for — it's the quality bar for whatever UI you
*are* building.

## The floor (hold all of these on UI work)

1. **Hierarchy over template defaults.** The surface should look intentional — clear
   scale/weight contrast so the eye lands on the right thing first, not uniform cards in a
   uniform grid. If it looks like an unmodified starter template, it isn't done. Depth →
   `frontend-design`.
2. **Accessible by default, not as a retrofit.** Semantic elements (`button`, `nav`,
   `main`, `label`) before `div` soup; every interactive element reachable and operable by
   keyboard with a visible focus state; images/icons have text alternatives; colour is
   never the only signal. Depth → `frontend-a11y`.
3. **Tokens, not magic values.** Use the repo's design tokens / theme variables for
   colour, spacing, type, and radius. Do not hardcode hex codes or `px` font sizes when a
   token exists — that's the frontend form of the DRY rule.
4. **Reusable components, the repo's way.** Build a component that composes and takes
   props for its variants/states — but match the existing component conventions and do
   NOT introduce a new UI framework or styling system. Reuse the repo's primitives before
   adding one. Depth → `frontend-component`.
5. **Every meaningful state is designed.** Handle and style loading, empty, and error
   states, plus hover / focus / active / disabled — not just the happy, populated view. A
   missing empty or error state is an unfinished component.
6. **Motion clarifies, on the compositor.** Animate `transform` / `opacity` (and
   `clip-path`/`filter` sparingly), not layout-bound properties (`width`, `top`,
   `margin`, `font-size`). Respect `prefers-reduced-motion`. Motion should explain a
   change, never decorate for its own sake.
7. **Responsive and overflow-safe.** Verify the real breakpoints (e.g. 320 / 768 / 1024 /
   1440); no horizontal overflow, touch targets large enough to hit. Depth →
   `frontend-responsive`.

## How it composes

- **With `engineering-craft`:** craft covers the component's *code* (small units, honest
  props, error handling, tests); this covers how the rendered surface *looks and behaves*.
  Both apply to a UI change.
- **With the deep frontend packs:** this is the always-present checklist; `frontend-design`
  / `frontend-a11y` / `frontend-component` / `frontend-responsive` are the depth you invoke
  when the ticket centres on that dimension. Don't duplicate them — defer to them.
- **With `minimalism`:** the floor is about *quality*, not *quantity*. Meet the bar with
  the least markup and the fewest dependencies that clear it.

## Marker

When you make a non-obvious surface call — chose a token scale, added an empty/error
state, picked a motion approach, made an a11y tradeoff — note it in one line via
`request_decision` at `log_only` or in your `record-evidence` notes, so the choice is
visible and the skill's application is auditable. One line, real calls only.
