---
name: frontend-component
description: Use when a ticket asks to add or change a UI component — a new widget, a reusable element, a page section, or a state/variant of one — in a frontend stack. Invoke for "add a Card component", "build the settings panel", or "add a loading state to X". Match the repo's component conventions; do not introduce a new UI framework.
stack: []
area: frontend
---

# Add or change a UI component

Build a component that looks like it was always part of the repo: same framework idioms,
same styling system, same file shape — with a small, honest API, every state the ticket
implies, and tests that exercise each acceptance criterion's own behaviour.

## Steps

1. **Read the conventions.** Call `search_lore` for the component rules (styling system,
   tokens, state library, folder layout, Storybook or not). Open two sibling components and
   the design-system primitives (`Button`, `Input`, `Stack`…). Reuse a primitive before
   writing a new one; a second button implementation is a defect.
2. **Write the API before the markup.** List props with types. Rules that keep APIs small:
   - Name props for meaning (`variant="danger"`), not appearance (`red`); one `variant`
     enum instead of several booleans that can conflict (`primary` + `secondary`).
   - Content goes through `children` or named slots, not string props that later need
     markup.
   - Form-like components support controlled use (`value` + `onChange`) and match the
     repo's uncontrolled convention if it has one.
   - Forward the ref and spread remaining native attributes onto the root element so
     callers can add `id`, `aria-*`, `data-testid`, `className` (React 19: `ref` is a
     normal prop; earlier versions use `forwardRef`).
   - Callbacks are named for the event (`onSelect`, `onDismiss`) and receive data, not the
     DOM event, unless the sibling components do otherwise.
3. **Keep it presentational.** Data loading, mutations and routing live in a container,
   hook or route loader (the `frontend-data-fetching` skill); the component renders from
   props. Global stores are read at the container level (the
   `frontend-state-management` skill).
4. **Semantic markup and tokens.** Real elements (`button`, `a`, `ul`, `label`), the right
   heading level passed in or derived, and only design tokens for colour, space, type,
   radius, shadow, motion (the `design-system` skill). No raw hex or pixel font sizes.
5. **Enumerate and build the states.** From the ACs and the sibling components list which
   apply: default, hover, focus-visible, active, disabled, loading, empty, error, overflow
   (very long text, 0 and 1000 items), and right-to-left if the repo supports RTL. Each
   listed state renders deliberately; state precedence is disabled > loading > error >
   default.
6. **Accessibility in the same change.** Keyboard operation, accessible name, focus
   handling and APG pattern for any composite widget (the `frontend-a11y` skill).
7. **Test per AC.** With the repo's runner and Testing Library (the `frontend-testing`
   skill): for each AC, a test that renders the component in the AC's situation and
   asserts the user-visible outcome — found by role and name, driven by `userEvent`.
   Include the non-happy states the ACs name. If the repo uses Storybook, add a story per
   state; if it runs visual regression, update baselines only for intended changes.
8. **Verify and evidence.** Run the repo's type-check, lint and tests (the `run-tests` and
   `run-lint` skills). Record per-AC `test_output` with the `record-evidence` skill, then
   stop.

## Review checklist

Walk it before recording evidence. A reviewer blocks on an item only when it breaks an AC,
leaves an AC untested, or is a correctness or WCAG A/AA defect; the rest is guidance.

- Reuses existing primitives; no second styling system, icon set or UI library.
- Props are typed, minimal, meaning-named; no conflicting boolean variants.
- Ref forwarded and native attributes passed through on the root element.
- No data fetching or global-store writes inside a presentational component.
- Tokens only; no hardcoded colours, spacing or font sizes.
- Every state the ACs imply is rendered and tested; tests query by role, not class or
  test id when a role exists.
- Animation uses `transform`/`opacity` and respects `prefers-reduced-motion`.
- File stays focused (roughly one screenful); sub-parts extracted when it grows.

## Done when

Each AC has a passing test that exercises that AC's behaviour through the rendered
component; lint, types and the existing suite are green; the component is exported the
way siblings are and used at the call site the ticket names.

## Anti-patterns

- `isPrimary`, `isSecondary`, `isLarge`, `isCompact` accumulating on one component.
- Copying a sibling and diverging silently instead of extending the shared primitive.
- `useEffect` fetching inside a leaf component; props mirrored into state.
- Tests that assert on class names or snapshot the whole tree as the only proof.
- `div` with `onClick` for a button; `outline: none` without a focus replacement.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**A UI convention this repo enforces — the styling system, the token set, a component-structure rule, or a framework-specific gotcha.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
