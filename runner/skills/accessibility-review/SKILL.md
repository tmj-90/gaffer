---
name: accessibility-review
description: Use as a REVIEW LENS when judging another agent's UI diff for accessibility defects against WCAG 2.2 AA — missing labels and names, keyboard traps or unreachable controls, focus not managed or obscured, colour-only meaning, insufficient contrast, small targets, drag-only interactions, unannounced dynamic changes — before recommending approval. Invoke on every review of a ticket that adds or changes user interface; it complements review-ticket and frontend-a11y (the builder's skill), it does not replace them.
stack: [react, web, next, vue, svelte, angular, react-native, native, expo]
area: review
---

# Accessibility review lens

Inaccessible UI is a correctness defect: a control a keyboard cannot reach does not work
for that user. Judge the rendered result, not the intent — read the markup the component
produces, trace keyboard and focus behaviour through the code, and use the automated
audit the repo already has. Each finding names the control, the WCAG 2.2 success
criterion (SC) it fails, and the fix. Only Level A and AA failures on UI the ticket added
or changed can block.

## Steps

1. **Identify the UI the diff adds or changes** and how a user operates it: controls,
   forms, dialogs, menus, tabs, live regions, media, drag interactions. If the diff has no
   UI, write "no UI — n/a" and stop. Call `search_lore` for the repo's a11y conventions
   and shared components (a shared accessible `Dialog` or `Button` is usually the fix).
2. **Use the automated audit the repo provides** (jest-axe / vitest-axe in component
   tests, `@axe-core/playwright` in browser tests, eslint-plugin-jsx-a11y). Its findings
   are findings; its silence proves little — automated rules cover only part of WCAG
   (focus order, names that make sense, announcements need reading). Do not install tools; run an existing command at most once.
3. **Trace the keyboard path** through the code: Tab order follows visual order (no
   positive `tabindex`); every interactive element is focusable and operable (Enter/Space
   on buttons, arrows inside menus, tabs and listboxes per the ARIA Authoring Practices
   pattern, Escape closes); focus is visible and not hidden behind sticky headers or
   overlays; no trap; a dialog moves focus in on open, contains it, and returns it to the
   trigger on close.
4. **Read it as a screen reader would**: native elements before ARIA (`<button>`, not a
   clickable `div`); every control has an accessible name that includes its visible
   label; images meaningful `alt` or `alt=""`; icon-only buttons named; state exposed
   (`aria-expanded`, `aria-pressed`, `aria-selected`, `aria-invalid`); headings and
   landmarks structured; status changes (errors, toasts, results) announced via a live
   region or focus move.
5. **Check visuals and input**: contrast and colour, reflow, target size, dragging and
   motion as listed below.
6. **Rate each finding.** Blocking: a Level A or AA failure on a control or content the
   ticket added or changed. Note (never grounds for CHANGES unless an AC names it): a
   pre-existing A/AA failure in adjacent code the diff did not change; platform guideline
   gaps (44×44 pt iOS, 48×48 dp Android), `prefers-reduced-motion` not honoured, AAA and
   best practice beyond the ticket. Only blocking findings justify `RECOMMEND CHANGES`.
7. **Record each finding** with `record_ac_evidence` (`evidence_type: manual_note`:
   control, SC number, fix), then let the `review-ticket` verdict carry the result.

## Checklist (WCAG 2.2, Level A and AA)

- **Names and semantics**: 1.1.1 non-text content; 1.3.1 info and relationships
  (labels associated, lists, tables with headers, headings); 2.5.3 label in name;
  4.1.2 name, role, value for every custom control.
- **Keyboard and focus**: 2.1.1 keyboard; 2.1.2 no keyboard trap; 2.4.3 focus order;
  2.4.7 focus visible; **2.4.11 focus not obscured** (new in 2.2 — sticky headers,
  cookie banners, toasts must not fully hide the focused element); 3.2.1 on focus
  causes no context change.
- **Forms and errors**: 3.3.1 error identification in text; 3.3.2 labels or
  instructions; 3.3.3 error suggestion; **3.3.7 redundant entry** (do not make users
  re-enter data already given in the same process); **3.3.8 accessible authentication**
  (no cognitive test such as transcribing a code without allowing paste or a password
  manager); errors linked with `aria-describedby` and `aria-invalid`.
- **Dynamic content**: 4.1.3 status messages announced without moving focus
  (`role="status"`, `aria-live="polite"`; `alert` only for urgent errors).
- **Colour and contrast**: 1.4.1 no colour-only meaning; 1.4.3 text contrast 4.5:1
  (3:1 for large text); 1.4.11 non-text contrast 3:1 for control borders, focus
  indicators and icons that convey meaning; in every theme the repo ships.
- **Reflow and text**: 1.4.4 resize to 200%; 1.4.10 reflow at 320 CSS px wide without
  two-dimensional scrolling; 1.4.12 text spacing; 1.4.13 content on hover or focus is
  dismissible, hoverable and persistent.
- **Pointer**: **2.5.7 dragging movements** (every drag has a single-pointer
  alternative such as buttons); **2.5.8 target size minimum** 24×24 CSS px or enough
  spacing; 2.5.2 pointer cancellation (act on up-event).
- **Motion and time**: 2.2.1 timing adjustable; 2.2.2 auto-moving content over five
  seconds can be paused; 2.3.1 no more than three flashes per second.
- **Consistency**: **3.2.6 consistent help** (help links in the same relative place
  across pages); 2.4.2 page titled; 3.1.1 page language set.
- **React Native**: `accessibilityLabel`, `accessibilityRole` and `accessibilityState`
  set on custom touchables; `accessible` groups used deliberately; font scaling not
  disabled.

## Rules

- Judge the rendered markup and behaviour, not the description.
- A Level A or AA failure on changed UI blocks; AAA and platform-guideline gaps do not.
- Every finding names the control, the SC and the fix.
- You review; you do not patch. Findings go into evidence, the verdict goes through
  `review-ticket`.
