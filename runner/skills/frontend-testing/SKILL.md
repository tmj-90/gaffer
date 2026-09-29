---
name: frontend-testing
description: Use when a ticket needs tests for UI code — a component's behaviour, a hook, a form, a page's states, accessibility assertions, visual regressions — below the full browser end-to-end level, using the repo's component test runner and testing-library conventions. Invoke for "add tests for the component", "cover the hook", "test the empty and error states", or when a frontend change ships without tests.
stack: [react, web, next, vue, svelte, angular]
area: testing
---

# Test frontend code by behaviour, not implementation

Testing Library's guiding principle: the more your tests resemble the way your software
is used, the more confidence they give you. A good component test renders with realistic
props and providers, finds things by role and label, clicks and types, and asserts what
the user sees or what the app sent. It survives refactors because it never reaches for
internals. Full journeys belong to the `e2e-browser-test` skill; this covers everything
below it, where most UI confidence is cheapest to buy.

## Procedure

1. **Use the repo's runner and library.** Vitest/Jest with Testing Library (React, Vue,
   Svelte, Angular flavours) or the framework's own harness, the repo's render helper that
   wires providers (router, query client, store, theme, i18n), and its network mock layer
   (MSW or a fetch mock). Call `search_lore` for conventions. Never add a second runner.
2. **Map each acceptance criterion to a user-visible outcome** — "shows an error under
   the email field when it is invalid", "disables Submit while saving". Each gets a test
   named after that outcome; that test must fail if the criterion's behaviour breaks.
3. **Render realistically.** The shared render helper, realistic props from a factory
   (the `test-fixtures-and-factories` skill), the network mocked at the fetch/HTTP
   boundary — not the component's own data hook, which would skip the code under test.
4. **Query like a user**, in Testing Library's priority order: `getByRole` with `name`,
   `getByLabelText`, `getByPlaceholderText`, `getByText`, `getByDisplayValue`; then
   `getByAltText`/`getByTitle`; `getByTestId` last, with a comment. Use `getBy*` when the
   element must exist, `queryBy*` only to assert absence, `findBy*` for anything async.
5. **Interact with `userEvent`** (`const user = userEvent.setup()`; `await user.click`,
   `await user.type`, `await user.keyboard('{Tab}')`) rather than `fireEvent`, so focus,
   keyboard and pointer sequences are real.
6. **Cover every state the ticket introduces:** default, loading, empty, error, success,
   disabled, and each interaction path including keyboard-only and submit. For data
   components, make the mocked request fail (500, network error) and assert the error UI
   and the retry path, not only the happy render.
7. **Cover the async races the UI can hit** when an AC touches them: a double-click on
   Submit sends one request; a slow response for an old search does not overwrite a newer
   one (resolve mocked responses out of order); unmounting mid-request produces no update
   or warning; optimistic updates roll back when the request fails.
8. **Assert visible outcomes.** Text, roles, `aria-invalid`, `disabled`, focus position,
   navigation to the right path, the request sent with the right payload. Never internal
   state, CSS class names, or render counts (unless the ticket is about renders).
9. **Add accessibility checks for new UI:** the repo's `axe` helper on each new state,
   keyboard reachability of every control, focus moved into and restored after dialogs
   (the `frontend-a11y` skill). Axe finds a subset of issues; it does not replace the
   role-based queries above.
10. **Keep snapshots small.** A reviewed snapshot of a stable presentational fragment is
    fine; a page-sized snapshot nobody reads is noise. Visual regression belongs to the
    repo's visual tooling.
11. **Test hooks through a component or `renderHook`**, asserting returned behaviour; async
    with `findBy*`/`waitFor`, fake timers only when explicitly enabled and advanced.
    Run the suite, then record evidence with the `record-evidence` skill (`test_output`).

## Done when

- Every AC in scope has a named test asserting its user-visible outcome.
- Every introduced state (including error and empty) and interaction path is covered.
- New UI has axe and keyboard checks; the suite passes with no `act()` warnings, no
  unhandled promise rejections and no fixed sleeps.

## Rules

- The repo's runner, Testing Library, render helper and network mock; nothing parallel.
- Queries by role and label; test ids are justified exceptions.
- Assert what the user sees or what the app sent; never internals.
- Work on the delivery branch the runner prepared (the `create-branch` skill verifies),
  never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While rendering realistically you learn the render helper, the provider wiring and the network-mock conventions every UI test must use.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
