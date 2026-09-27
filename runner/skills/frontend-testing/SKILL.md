---
name: frontend-testing
description: Use when a ticket needs tests for UI code — a component's behaviour, a hook, a form, a page's states, accessibility assertions, visual regressions — below the full browser end-to-end level, using the repo's component test runner and testing-library conventions. Invoke for "add tests for the component", "cover the hook", "test the empty and error states", or when a frontend change ships without tests.
stack: [react, web, next, vue, svelte, angular]
area: testing
---

# Test frontend code by behaviour, not implementation

A good component test does what a user does — renders with realistic props, finds
things by role and label, clicks and types — and asserts what the user sees. It survives
refactors because it never reaches for internals. Full-journey coverage belongs to the
`e2e-browser-test` skill; this skill covers everything below it.

## Steps

1. **Use the repo's runner and library.** Vitest/Jest with Testing Library (React, Vue,
   Svelte, Angular flavours), the repo's render helper that wires providers (router,
   query client, theme, i18n), and its network mocking layer (MSW or fetch mocks). Call
   `search_lore` for conventions. Never add a second runner or a snapshot-everything
   habit.
2. **Render realistically.** Use the shared render helper so the component gets the
   providers it has in the app; pass realistic props from a factory (the
   `test-fixtures-and-factories` skill); mock the network at the fetch boundary, not the
   component's data hook.
3. **Query like a user.** `getByRole` with the accessible name first, then
   `getByLabelText`, `getByText`; `getByTestId` only when there is no accessible handle
   and with a comment. A query that a screen reader could not perform is a query the test
   should not perform.
4. **Cover every state the ticket introduces**: default, loading, empty, error, success,
   disabled, and each interaction path (click, type, keyboard-only, submit). Use
   `userEvent` for interactions (real event sequences), not `fireEvent`.
5. **Assert visible outcomes.** Text shown, role present, attribute set (`aria-invalid`,
   `disabled`), navigation called with the right path, mutation called with the right
   payload. Never assert on internal state, implementation-specific class names, or
   the number of renders unless the ticket is about renders.
6. **Add accessibility assertions** where UI is new: `axe` on the rendered output (the
   repo's helper), keyboard reachability of every control, focus management after
   dialogs open and close (the `frontend-a11y` skill).
7. **Use snapshots sparingly.** A small, reviewed snapshot for a stable, presentational
   fragment is fine; a 400-line snapshot of a page is noise nobody reads. Visual
   regression belongs to the repo's visual tooling if it has one.
8. **Test hooks through a component or `renderHook`**, asserting the returned behaviour;
   test async behaviour with `findBy*`/`waitFor`, never fixed timers except with fake
   timers explicitly enabled. Run the suite; evidence with the `record-evidence` skill.

## Rules

- The repo's runner, Testing Library, render helper and network mock; nothing parallel.
- Queries by role and label; test ids are justified exceptions.
- Every introduced state and interaction has a test; `userEvent` for interaction.
- Assert what the user sees or what the app called; never internals.
- Axe and keyboard checks for new UI.
- Small snapshots only; no fixed `sleep`s.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While rendering realistically you learn the render helper, the provider wiring and the network-mock conventions every UI test must use.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
