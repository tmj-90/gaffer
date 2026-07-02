---
name: frontend-component
description: Use when a ticket asks to add or change a UI component — a new widget, a reusable element, a page section, or a state/variant of one — in a frontend stack. Invoke for "add a Card component", "build the settings panel", or "add a loading state to X". Match the repo's component conventions; do not introduce a new UI framework.
stack: []
area: frontend
---

# Add or change a UI component

Build a component that follows the repo's existing composition, styling, and state
conventions, with the behaviour proven by tests and the markup kept accessible.

## Steps

1. **Read the lore first.** Call `search_lore` (Memory MCP) for the repo's
   component conventions: framework idioms, styling system (CSS modules, tokens,
   utility classes), state management, and file organisation. Honour any ADRs.
2. **Find a sibling component** and copy its shape — props/typing, file layout,
   styling approach, and how it is exported and consumed.
3. **Keep it presentational where possible.** Push data loading and side effects to
   a container/hook; let the component render from props so it stays pure and testable.
4. **Use semantic HTML and design tokens.** Prefer real elements (`button`, `nav`,
   `header`) over generic `div` stacks, and reference the repo's spacing/colour/type
   tokens instead of hardcoded values.
5. **Design the states.** Cover hover/focus/active, loading, empty, and error states
   the ticket implies — not just the happy path.
6. **Test the behaviour** with the repo's component test tooling (e.g. Testing
   Library): render, assert on roles/labels and interaction, not on brittle markup.
7. **Verify + evidence.** Run the repo's tests and lint, then use the
   `record-evidence` skill to record `test_output` against the AC and submit for review.

## Rules

- Match the existing framework and styling system — never add a competing one.
- No hardcoded palette/spacing/type; use the project's tokens.
- Animate compositor-friendly properties (`transform`, `opacity`) — avoid layout-bound ones.
- Keep components focused; extract sub-components rather than growing one file past ~200 lines.
- Pair with the `frontend-a11y` and `frontend-responsive` skills for non-trivial UI.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**A UI convention this repo enforces — the styling system, the token set, a component-structure rule, or a framework-specific gotcha.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
