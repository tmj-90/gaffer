---
name: add-integration-test
description: Use when a ticket asks for integration or end-to-end coverage across components — an API route hitting a database, a service-to-service call, a multi-step flow — rather than a single unit. Invoke for "test the endpoint end to end", "cover the checkout flow", or "verify the migration + query together".
stack: []
area: testing
---

# Add an integration test

Add a test that exercises real wiring between components — the seams a unit test
mocks away — matching the repo's existing integration setup, not a new harness.

## Steps

1. **Read the lore first.** Call `search_lore` (Memory MCP) for the repo's
   integration-test conventions: how the test DB/containers are provisioned, fixtures,
   and where these tests live (they're often separated from unit tests).
2. **Find an existing integration test** and copy its bootstrap — the test client,
   DB setup/teardown, seeding, and how external services are stubbed at the boundary.
   Use real collaborators internally; stub only true externals (third-party APIs).
3. **Enumerate the flow** from the ticket/AC: the entry point, the path through the
   components, and the observable outcome (HTTP status + body, persisted row, emitted
   event). Cover the happy path plus at least one failure path.
4. **Write the test** in the repo's integration location and convention, with proper
   setup/teardown so it's isolated and repeatable. Assert on real outcomes, not internals.
5. **Run it** with the repo's integration command (see the context packet; it may differ
   from the unit `test` script). Iterate until green and stable.
6. **Evidence:** the command + passing summary and the new test paths. Then use the
   `record-evidence` skill to record `test_output` against the AC and submit for review.

## SQLite isolation (this repo)

The `packages/memory` suite talks to a real SQLite DB (`better-sqlite3`). Copy its
isolation conventions rather than inventing new ones:

- **Fresh DB per test, in-memory.** A `newDb()` helper builds each one from scratch —
  `new BetterSqlite3(":memory:")`, then `db.pragma("foreign_keys = ON")`, then
  `runMigrations(db)` — so every test starts on the current schema with no leaked rows.
  Prefer this over sharing one DB across a file.
- **When you need a real on-disk DB** (path handling, WAL, `openDb()`), create it under
  a temp dir in `beforeEach` — `mkdtempSync(join(tmpdir(), "memory-<area>-"))` — and tear
  it down in `afterEach` with `rmSync(dir, { recursive: true, force: true })`. `openDb(path)`
  already applies migrations and pragmas, so use it instead of hand-rolling setup.
- **Keep `foreign_keys = ON`** so the test exercises the same referential constraints
  production does; a test that silently drops them can pass on data the app would reject.
- One DB lifecycle per test (`beforeEach`/`afterEach`), never a module-level singleton —
  that's what keeps runs order-independent and repeatable.

## Rules

- Test real wiring; mock only genuine externals, not the components under test.
- Ensure isolation — no leaked state between runs, deterministic setup/teardown.
- Match the repo's integration harness; don't install or stand up a new one.
- Run on a branch (the `create-branch` skill), never a protected branch.
