---
name: test-fixtures-and-factories
description: Use when tests need realistic data — users, orders, records, files — and the ticket or the existing suite calls for fixtures, factories, builders, seed data, or test databases that stay readable and isolated. Invoke for "add a factory for X", "the tests share state", "set up a test DB", or when you find yourself copy-pasting the same object literal into a third test.
stack: []
area: testing
---

# Build test fixtures and factories that stay honest

Good test data is minimal, explicit about what matters, and impossible to share by
accident. A factory gives every test a valid object with one line and lets it override
only the fields the test is about; a fixture that is a 200-line JSON blob nobody
understands is a liability.

## Steps

1. **Find the repo's existing pattern.** Look for a `factories/`, `fixtures/`,
   `testing/`, or `__fixtures__/` directory, builder helpers, a seed script, or a
   test-database setup (in-memory SQLite, a per-test schema, Testcontainers). Match it.
   Call `search_lore` for testing conventions before inventing one.
2. **Prefer factories over static fixtures** for domain objects. A factory
   (`makeUser({ role: "admin" })`) builds a valid default and applies overrides, so each
   test states only what it cares about. Keep defaults boring and valid; randomise only
   where uniqueness is required (ids, emails) and make that randomness seedable.
3. **Keep static fixtures for recorded external shapes** — a webhook payload, an API
   response, a file. Record them from the real source, commit them, and name them after
   the scenario (`stripe-invoice-paid.json`), not after the test.
4. **Isolate state.** Every test gets fresh data and leaves none behind: a transaction
   rolled back per test, a fresh in-memory DB, a unique prefix, or explicit teardown.
   Tests must pass in any order and in parallel; if they only pass sequentially, the
   isolation is broken.
5. **Never reach for production data.** Fixtures contain no real personal data, no real
   secrets, no real tokens; use obviously fake values (`user-1@example.com`, `sk_test_...`
   shaped placeholders). This is a security rule, not a style preference.
6. **Make the test readable at a glance.** The test body should show the inputs that
   matter to the assertion; everything else lives in the factory default. If a reader
   needs to open the factory to understand the test, the override list is wrong.
7. **Type the data.** Factories return the real domain type (or the schema-validated
   shape) so a schema change breaks the factory at compile/parse time, not silently in
   a test that now asserts nonsense.
8. **Run the suite in parallel and shuffled** where the runner supports it, to prove
   isolation. Evidence with the `record-evidence` skill (evidence type `test_output`).

## Rules

- One factory per domain object, in the repo's testing directory; no ad-hoc literals
  copied across tests.
- Defaults valid and boring; randomness only for uniqueness and always seedable.
- Fresh state per test; passing in parallel and in any order is the bar.
- No production data, personal data or real credentials in fixtures, ever.
- Recorded fixtures come from the real source and are named by scenario.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While building fixtures you learn how this repo isolates test state — its factories, its test database strategy, its rule for recording external payloads.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
