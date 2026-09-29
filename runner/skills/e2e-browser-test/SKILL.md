---
name: e2e-browser-test
description: Use when a ticket asks for end-to-end or browser coverage of a user journey — sign-up, checkout, a form submission, a dashboard flow — driven through the real UI with Playwright, Cypress, or the repo's browser harness. Invoke for "add an e2e test", "cover the flow in the browser", or when an acceptance criterion can only be shown by clicking through the app.
stack: [react, web, next, vue, svelte, angular, node]
area: testing
---

# Write an end-to-end browser test

An end-to-end test proves a user journey works through the real UI against a real (or
faithfully stubbed) backend. It is the slowest and most flake-prone test in the suite —
Google's data shows flakiness grows with test size and with WebDriver-style tooling — so
it earns its place by covering a journey no cheaper test can, and by being deterministic:
no sleeps, no order dependence, no data another test created.

## Procedure

1. **Find the harness.** Locate the repo's browser setup (`playwright.config.*`,
   `cypress/`, a `test:e2e` script). Use it exactly — its browsers, base URL, `webServer`
   block and CI command. Do not add a second framework. If none exists and the ticket does
   not ask for one, raise `request_decision` with the smallest viable setup. (Independent
   tester: never raise `request_decision`; follow `black-box-test` — scaffold a disposable
   rig in a test directory only with what the repo already has installed, run the spec
   once, and record `manual_note` rows.)
2. **Push coverage down first.** For each acceptance criterion ask whether a component or
   integration test proves it (the `frontend-testing` and `add-integration-test` skills).
   Only journeys that need the real browser, routing, cookies or the full stack belong
   here.
3. **Write the journey in plain words:** start state → user actions → what the user must
   observe. Map each AC to one observable outcome on screen or one persisted result. Name
   the test after the journey and cite the AC.
4. **Own your data.** Create what the test needs through an API call, seed script or
   factory inside the test (or a fixture), with unique values, and clean up. Never depend
   on another test's leftovers or a shared account; each test gets a fresh browser context.
   Save authenticated state once (`storageState`) rather than logging in through the UI in
   every test.
5. **Locate like a user.** `getByRole` with the accessible name, then `getByLabel`,
   `getByText`; chain and `filter({ hasText })` to scope. `getByTestId` only when no
   accessible handle exists, with a comment why. No XPath or styling-class CSS selectors.
6. **Use web-first assertions; never wait for time.** `await expect(locator).toBeVisible()`,
   `toHaveText`, `toHaveURL`, `page.waitForResponse`. Never `waitForTimeout`/`cy.wait(ms)`,
   and never `expect(await locator.isVisible()).toBe(true)` — it does not retry. Every
   Playwright call is awaited (`@typescript-eslint/no-floating-promises` catches misses).
7. **Assert the outcome, not the DOM.** What the user sees, and what the system persisted:
   reload the page or query the API to prove a save survived, check the stub outbox for the
   email. A toast saying "Saved" is not proof the data was saved.
8. **Stub only what you do not control.** Third-party services go through
   `page.route(...)`/`cy.intercept` with recorded responses; your own backend stays real.
9. **When an AC concerns concurrent users or failure,** drive it for real: two browser
   contexts editing the same record (assert the documented conflict behaviour, no silent
   overwrite); the backend returning an error or going offline via `page.route` →
   `abort()`; the user sees the documented error and can retry.
10. **Keep failures diagnosable.** Traces on first retry (`trace: 'on-first-retry'`),
    screenshots on failure. Retries may be on in CI to _collect_ traces, but a test that
    passes only on retry is flaky and not done.
11. **Run it until stable:** the spec three times in a row headless, e.g.
    `npx --no -- playwright test <spec> --repeat-each=3`, then the repo's CI command. Record the
    command and result with the `record-evidence` skill (`test_output`) per AC.

## Done when

- Each AC that needs a browser has a journey test asserting its observable outcome.
- The spec passes three consecutive headless runs without retries, and in the CI command.
- No fixed sleeps, CSS-structure selectors, shared accounts or order dependence remain.

## Rules

- One journey per test; keep the count small and the coverage wide.
- The backend under test is real or a faithful stub declared in the test; never mock the
  browser side to make the assertion pass.
- Match the repo's harness, browser pins and CI command exactly.
- Work on the delivery branch the runner prepared (the `create-branch` skill verifies),
  never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While standing the app up for a browser journey you learn how it is really started, which env vars and ports it needs, and which selectors the design system exposes.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
