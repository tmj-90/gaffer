---
name: e2e-browser-test
description: Use when a ticket asks for end-to-end or browser coverage of a user journey — sign-up, checkout, a form submission, a dashboard flow — driven through the real UI with Playwright, Cypress, or the repo's browser harness. Invoke for "add an e2e test", "cover the flow in the browser", or when an acceptance criterion can only be shown by clicking through the app.
stack: [react, web, next, vue, svelte, angular, node]
area: testing
---

# Write an end-to-end browser test

An end-to-end test proves a user journey works through the real UI against a real (or
faithfully stubbed) backend. It is the most expensive test in the suite, so it earns its
place by covering a whole journey and by being deterministic: no sleeps, no order
dependence, no reliance on data another test created.

## Steps

1. **Find the harness.** Locate the repo's browser test setup (Playwright config, Cypress
   folder, a `scripts/ui-regression` harness, a `test:e2e` script). Use it exactly; do not
   introduce a second framework. If there is none and the ticket does not ask you to add
   one, raise `request_decision` with the smallest viable setup.
2. **Define the journey as the user sees it.** Write the steps in plain words first: start
   state → actions → what the user must observe. Map each acceptance criterion to one
   observable outcome on screen or in a response.
3. **Own your data.** Create the fixtures the test needs inside the test (an API call, a
   seed script, a factory), and tear them down. Never depend on another test's leftovers
   or a shared account.
4. **Select by role and accessible name.** Prefer `getByRole`, `getByLabel`,
   `getByText` over CSS selectors and test ids; a selector that only a developer would
   write is a selector that breaks on the next refactor. Add a `data-testid` only when
   no accessible handle exists, and say why.
5. **Wait for state, never for time.** Use the framework's auto-waiting assertions
   (`expect(locator).toBeVisible()`, `toHaveText`, `waitForResponse`). Any `sleep` or
   fixed timeout in the test is a flake waiting to happen and a reviewer will send it
   back.
6. **Assert the outcome, not the implementation.** Check what the user sees and what
   the system persisted (a row, an email in the stub outbox, a redirect), not internal
   function calls or DOM structure.
7. **Capture evidence on failure.** Enable the harness's trace / screenshot / video on
   failure so a CI failure is diagnosable from the artifact.
8. **Run it three times.** Locally, headless, and in the CI command. A test that passes
   once is not done; three consecutive green runs is the bar. Evidence the command and
   result with the `record-evidence` skill (evidence type `test_output`).

## Rules

- One journey per test; keep the count small and the coverage wide.
- No fixed sleeps, no order dependence, no shared mutable fixtures.
- Selectors by role and label; test ids are the fallback, explained in a comment.
- The backend under test is real or a faithful stub declared in the test; never mock
  the browser side to make the assertion pass.
- Match the repo's harness, browser pins and CI command exactly.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While standing the app up for a browser journey you learn how it is really started, which env vars and ports it needs, and which selectors the design system exposes.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
