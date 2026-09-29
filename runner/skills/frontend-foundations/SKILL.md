---
name: frontend-foundations
description: Use on any frontend delivery to hold the surface-specific quality floor that `engineering-craft` doesn't cover — intentional visual hierarchy over template defaults, accessible-by-default markup, design tokens instead of hardcoded values, reusable components matching the repo, every state designed, and compositor-friendly motion. Invoke whenever the change touches UI (a component, screen, page, or style), as the always-on companion to the deeper `frontend-design`, `frontend-component`, `frontend-a11y`, and `frontend-responsive` packs. For "make the UI production-grade", "don't ship a generic template", "is this accessible?".
stack: []
area: frontend
---

# Frontend foundations — the UI quality floor

The frontend companion to `engineering-craft`: craft holds the code bar, this holds the
surface bar. It is a short floor to check on every UI change, not the full treatment —
each item names the skill that holds the depth. It never licenses extra chrome or
animation the ticket did not ask for (the `minimalism` skill): meet the bar with the least
markup and the fewest dependencies.

## The floor

1. **Semantic and operable.** Native elements (`button`, `a href`, `label`, `nav`,
   `main`, `dialog`), one `h1`, keyboard-operable with a visible `:focus-visible` style,
   text alternatives on meaningful images and icon-only buttons, colour never the only
   signal. Depth: the `frontend-a11y` skill (WCAG 2.2 AA).
2. **Tokens, not magic values.** Colour, spacing, type, radius, shadow, duration from the
   repo's tokens or theme. A raw hex or `px` font size in a component where a token exists
   is the frontend form of duplicated logic. Depth: the `design-system` skill.
3. **The repo's components and styling system.** Reuse primitives before writing new
   ones; no second UI library, CSS approach or icon set. Depth: the
   `frontend-component` skill.
4. **Every state the ACs imply.** Loading (at final size), empty with a next action,
   error with recovery, plus hover / focus / active / disabled. A missing empty or error
   state is an unfinished component. Server-state depth: the `frontend-data-fetching`
   skill.
5. **Intentional hierarchy.** One clear primary action and a type scale with real contrast
   between levels; not a uniform grid of identical cards. If it looks like an unmodified
   starter template, it is not done. Depth: the `frontend-design` skill.
6. **Motion that explains, on the compositor.** Animate `transform` and `opacity`, not
   `width`/`height`/`top`/`margin`; 150–300 ms for UI transitions; non-essential motion
   inside `@media (prefers-reduced-motion: no-preference)`.
7. **Responsive and overflow-safe.** No horizontal scroll from 320 CSS px up, targets at
   least 24×24 CSS px, zoom not disabled. Depth: the `frontend-responsive` skill.
8. **Text is data-ready.** User-visible strings go through the repo's i18n layer if it has
   one; dates and numbers are formatted by locale. Depth: the `i18n-l10n` skill.

## Procedure (every UI change)

1. Call `search_lore` for the repo's UI conventions and open one sibling screen.
2. Build the change using the deep skill that matches the ticket's centre of gravity.
3. Walk the eight floor items against your diff. For each, either confirm it holds or fix
   it. Quick greps that catch common misses in the changed files:
   - `#[0-9a-fA-F]{3,8}\b` and `font-size:\s*\d+px` outside token files;
   - `onClick` on `div`/`span`; `outline:\s*(none|0)`;
   - `transition:.*(width|height|top|left|margin)`.
4. Check the rendered result, not the code alone, through the repo's component or
   browser tests (you have no screen to look at): Tab through it (`userEvent.tab()` or
   Playwright `page.keyboard`); render at 320 px and desktop width; drive the empty and
   error states. What the repo's tooling cannot check is named in the evidence.
5. Record the checks in your evidence (the `record-evidence` skill). When you made a
   non-obvious surface call (a new token, a motion approach, an a11y trade-off), log it in
   one line with `request_decision` at severity `log_only`, or in the evidence note.

## Done when

All eight floor items hold for the changed UI, the greps above find nothing new, and the
rendered states were exercised — or the one item that cannot hold is named with its
reason in the evidence.

## How it composes

- **With `engineering-craft`:** craft covers the component's code (units, errors, tests);
  this covers how the rendered surface looks and behaves. Both apply to a UI change.
- **With the deep packs:** this is the always-present checklist; defer to them for depth
  and do not duplicate their rules.
- **With review:** the reviewer's `accessibility-review` lens and the ticket's ACs decide
  what blocks; a floor item is a blocking finding only when it breaks an AC or a WCAG
  A/AA criterion, not as a style preference.
