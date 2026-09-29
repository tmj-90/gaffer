---
name: frontend-a11y
description: Use when a ticket requires accessibility work or when delivering UI that must be usable by everyone — keyboard navigation, screen-reader labelling, focus management, colour contrast, target size, or reduced-motion support to WCAG 2.2 AA. Invoke for "make X accessible", "fix the a11y issues", "add keyboard support", or as a companion check on any new component.
stack: []
area: frontend
---

# Make the UI accessible

Bring the UI the ticket touches to **WCAG 2.2 Level AA** and prove it with automated
checks plus a keyboard walk. Inaccessible UI is broken UI: a control a keyboard cannot
reach does not work for that user. The reviewer's `accessibility-review` lens checks the
same list below, so build to it.

## Steps

1. **Scope and conventions.** List every control, form, dialog, menu, live update and
   media element the change adds or alters. Call `search_lore` for the repo's a11y helpers
   (focus-trap, visually-hidden class, announcer) and reuse them.
2. **Native element first.** `button` for actions, `a href` for navigation, `label` +
   `input`, `fieldset`/`legend` for groups, `dialog` (opened with `showModal()`) for modals,
   `details`/`summary` for disclosure, landmarks (`header`, `nav`, `main`, `footer`), one
   `h1` and no skipped heading levels. ARIA only when no native element exists — and then
   follow the matching **WAI-ARIA Authoring Practices (APG)** pattern exactly (roles,
   states, keys). A `div onClick` is a defect. Do not use `role="menu"` for site
   navigation; APG menus are for application-style menus.
3. **Keyboard (WCAG 2.1.1, 2.1.2, 2.4.3, 2.4.7).** Everything operable with Tab,
   Shift+Tab, Enter, Space, Escape, and arrows where the APG pattern says so (tabs,
   listbox, radio group, grid use a roving `tabindex` or `aria-activedescendant`). Focus
   order follows reading order; no positive `tabindex`; no trap outside a modal.
4. **Focus visible and not hidden (2.4.7, 2.4.11 new in 2.2).** A `:focus-visible` style
   with at least 3:1 contrast against adjacent colours (1.4.11); never `outline: none`
   without a replacement. A sticky header, cookie banner or toast must not completely
   cover the focused element — add `scroll-padding-top` or move the overlay.
5. **Names, roles, states (1.1.1, 1.3.1, 4.1.2).** Every control has an accessible name
   that contains its visible label (2.5.3); icon-only buttons get `aria-label` or
   visually hidden text; decorative images `alt=""`; toggles expose `aria-pressed` or
   `aria-expanded`; errors link via `aria-describedby` and set `aria-invalid`.
6. **Dynamic changes (4.1.3).** Status messages (saved, 3 results, error) go to a live
   region that exists in the DOM **before** the text is inserted (`role="status"` polite,
   `role="alert"` only for urgent). Route changes in an SPA move focus to the new `h1` or
   announce the page title.
7. **Overlays.** On open move focus inside; keep it inside while modal (native `dialog`
   or `inert` on the background); Escape closes; on close return focus to the trigger.
8. **Pointer and target size (2.5.7, 2.5.8 new in 2.2).** Targets at least **24×24 CSS
   px** or spaced so a 24px circle does not overlap a neighbour (44×44 is the comfortable
   touch goal). Any drag interaction (reorder, slider, map pan) has a single-pointer
   alternative (buttons, click-to-place).
9. **Visual (1.4.1, 1.4.3, 1.4.11, 1.4.10, 1.4.12).** Text contrast 4.5:1 (3:1 at ≥ 24px
   or ≥ 18.66px bold); UI components and graphics 3:1; colour never the only signal;
   content reflows at 320 CSS px wide and survives WCAG text-spacing overrides.
10. **Motion (2.2.2; 2.3.3 is AAA but cheap).** Wrap non-essential animation in
    `@media (prefers-reduced-motion: no-preference)`; anything that moves for more than 5s
    can be paused.
11. **Forms and auth (3.3.1, 3.3.3, 3.3.7, 3.3.8 new in 2.2).** Errors identified in text
    with a fix suggestion; do not make users re-enter data they already gave in the flow;
    allow paste and password managers in credential fields, no puzzle-only CAPTCHA.
12. **Verify.** Run the repo's checks, then do the manual pass (below). Evidence each AC
    with the `record-evidence` skill (`test_output` for the axe, component and keyboard
    tests), then stop.

## Verification commands

Use the tools the repo already has; installs are hook-blocked, so a missing tool is
named in the evidence, not installed.

- Lint: `eslint-plugin-jsx-a11y` (React) / `eslint-plugin-vuejs-accessibility` if the repo
  has them — zero new warnings.
- Component tests: query by role and name (`getByRole('button', { name: /save/i })`); a
  test that cannot find the control by role has found a defect. `jest-axe`/`vitest-axe`
  `toHaveNoViolations()` on each new state (open, error, empty).
- E2E: `@axe-core/playwright` —
  `new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze()`
  with zero violations on the changed page.
- Keyboard walk as a test (automation finds only part of WCAG, and you have no mouse or
  screen reader to drive by hand): complete the AC's task with `userEvent.tab()` /
  `userEvent.keyboard` or Playwright `page.keyboard.press`, asserting focus
  (`toHaveFocus()`) at each step; render at 320 px width and with
  `emulateMedia({ reducedMotion: 'reduce' })` where Playwright exists. Anything you
  could not check (a screen-reader pass, a missing tool) is named in the evidence as
  unverified, never claimed.

## Done when

- Every AC task is completable by keyboard alone, with visible, unobscured focus.
- axe reports zero violations for the WCAG 2.2 A/AA tags on each new state (or the
  evidence says the repo has no axe tooling).
- Every new control is findable by role + accessible name in a test.
- Contrast, target size, reflow and reduced-motion checks above pass.

## Anti-patterns

- ARIA to repair the wrong element (`role="button"` on a `div` without key handling).
- `aria-label` that differs from the visible text; `title` as the only label.
- Placeholder as label; errors shown only in red; toasts as the only error channel.
- Live region inserted together with its message (nothing is announced).
- `tabindex="0"` sprinkled on non-interactive text; `autofocus` that skips context.
- An axe pass reported as "accessible" with no keyboard walk.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**An accessibility pattern or boundary this repo standardises on — a focus-management rule, a semantics convention, or an a11y check that must pass.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
