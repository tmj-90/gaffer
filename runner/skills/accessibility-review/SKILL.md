---
name: accessibility-review
description: Use as a REVIEW LENS when judging another agent's UI diff for accessibility defects — missing labels and names, keyboard traps or unreachable controls, focus not managed, colour-only meaning, insufficient contrast, motion without reduced-motion, unannounced dynamic changes — before recommending approval. Invoke on every review of a ticket that adds or changes user interface; it complements review-ticket and frontend-a11y (the builder's skill), it does not replace them.
stack: [react, web, next, vue, svelte, angular, react-native, native, expo]
area: review
---

# Accessibility review lens

Inaccessible UI is a correctness defect: a control a keyboard cannot reach does not
work for that user. The reviewer checks the rendered result, not the intent: open the
component, tab through it, read what a screen reader would announce, and run the axe
audit the repo provides. Findings are concrete (which control, what is missing, what
to add) and WCAG 2.1 A/AA failures block.

## Steps

1. **Identify the UI the diff adds or changes** and how a user would operate it:
   controls, forms, dialogs, menus, live regions, media. If the diff is not UI, say so.
   Call `search_lore` for the repo's a11y conventions and helpers.
2. **Run the automated audit** the repo provides (axe in the component tests or the
   browser regression). Automated findings are findings; the absence of automated
   findings proves little — continue.
3. **Operate it with the keyboard**, in your head or in the test harness: Tab order
   follows the visual order; every interactive element is reachable and operable
   (Enter/Space for buttons, arrows for menus and tabs, Escape closes dialogs); focus is
   visible; no trap; focus moves into a dialog on open and returns on close.
4. **Read it as a screen reader would**: every control has an accessible name (label,
   `aria-label`, `aria-labelledby`); images have meaningful `alt` or are decorative
   (`alt=""`); icons-only buttons are named; headings are hierarchical; landmarks present;
   dynamic changes (errors, toasts, loading results) are announced via live regions or
   focus; form errors are linked to fields with `aria-describedby`/`aria-invalid`.
5. **Check the visuals**: text contrast ≥ 4.5:1 (3:1 for large text and UI components);
   meaning never carried by colour alone (status also has text or an icon); content
   reflows at 320px and 200% zoom without loss; motion respects
   `prefers-reduced-motion`; targets ≥ 24×24 CSS px (44 on mobile).
6. **Rate each finding.** Blocking: a WCAG A/AA failure on a control or content the
   ticket added or changed (unreachable, unnamed, unannounced, contrast failure, trap).
   Should-fix: AA best-practice gaps on adjacent code the ticket touched. Note:
   improvements beyond the ticket. Only blocking and should-fix findings justify
   `RECOMMEND CHANGES`.
7. **Record the findings as evidence** with `record_ac_evidence` (`manual_note` per
   finding: control, criterion, fix), then let the `review-ticket` verdict carry the
   result.

## Checklist

- Accessible name on every interactive element and image; decorative images hidden.
- Keyboard: reachable, operable, visible focus, logical order, no traps; dialogs manage
  focus in and out.
- Semantics: native elements over `div` roles; correct `role`/`aria-*` where custom;
  headings and landmarks structured.
- Forms: labels associated; required and errors in text; errors linked and announced.
- Dynamic content: live regions or focus for results, errors, and status changes.
- Colour and contrast: ratios met; no colour-only meaning; visible in high-contrast and
  dark modes the repo supports.
- Reflow and zoom: usable at 320px and 200%; targets large enough; no horizontal scroll
  of text.
- Motion and time: reduced-motion respected; no auto-playing media without controls;
  no time limits without extension.
- Mobile (React Native): `accessibilityLabel`/`accessibilityRole` set; touch targets
  sized; dynamic type honoured.

## Rules

- Check the rendered result by operating it, not the intent in the description.
- WCAG A/AA failures on changed UI always block; they are correctness defects.
- Findings name the control, the criterion, and the fix.
- You review; you do not patch. Findings go into evidence, the verdict goes through
  `review-ticket`.
