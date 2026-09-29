---
name: test-fixtures-and-factories
description: Use when tests need realistic data — users, orders, records, files — and the ticket or the existing suite calls for fixtures, factories, builders, seed data, temp directories or test databases that stay readable and isolated. Invoke for "add a factory for X", "the tests share state", "set up a test DB", or when you find yourself copy-pasting the same object literal into a third test.
stack: []
area: testing
---

# Build test fixtures and factories that stay honest

Good test data is minimal, explicit about what matters, and impossible to share by
accident. A factory gives every test a valid object in one line and lets it override only
the fields the test is about; a 200-line JSON blob nobody understands is a liability.
Isolation is not optional: tests that share state pass alone and fail in parallel, or —
worse — pass because an earlier test left the data they needed.

## Procedure

1. **Find the repo's pattern.** Look for `factories/`, `fixtures/`, `testing/`,
   `__fixtures__/`, `conftest.py`, builder helpers, a seed script, or a test-database setup
   (in-memory SQLite, per-test schema or transaction, Testcontainers). Call `search_lore`
   for conventions. Match what exists; add a library (fishery, factory_boy, `@faker-js`)
   only if the repo already uses it. (Independent tester: only paths the runner counts as
   tests survive — a `test/`, `tests/`, `__tests__/`, `spec(s)/`, `e2e/` or `fixture(s)/`
   directory, `*.test.*`/`*.spec.*` JS/TS files, or `test_*`/`test-*`/`test.*` files. A
   new file under `factories/`, `testing/` or `__fixtures__/`, or a root `conftest.py`,
   counts as implementation and HOLDS the run; keep factories inside your test
   directory — see `black-box-test`.)
2. **Prefer factories for domain objects.** `makeUser({ role: "admin" })` builds a valid
   default and applies overrides. Keep defaults boring and valid. Generate uniqueness with
   a per-run sequence (`user-${seq}@example.com`) rather than randomness; where randomness
   is used, it is seeded and the seed logged. Provide builders for related graphs
   (`makeOrder({ user })`) rather than hidden auto-creation that surprises the test.
3. **Keep static fixtures for recorded external shapes** — a webhook payload, an API
   response, a sample file. Record them from the real source, redact secrets and personal
   data, commit them, and name them by scenario (`stripe-invoice-paid.json`).
4. **Isolate every resource a test touches:**
   - _Database:_ fresh in-memory DB with real migrations per test, or a transaction rolled
     back per test, or a unique schema; never a module-level connection shared by tests.
   - _Files:_ a unique temp dir per test (`mkdtempSync(join(tmpdir(), "x-"))`, pytest
     `tmp_path`, Go `t.TempDir()`), removed in teardown — never a fixed path like
     `./data` or `/tmp/test.db`.
   - _Ports and processes:_ bind to port 0 and read the assigned port; teardown kills every
     spawned process even when the test fails.
   - _Globals:_ env vars, clocks, module caches and singletons restored after each test.
5. **Support concurrency and persistence tests.** When an AC is about concurrent writers,
   restarts or crashes, fixtures must make the real schedule easy: a helper that starts the
   app as a separate process on a temp data dir and returns `{ url, stop, kill, pause,
   resume }` (SIGTERM, SIGKILL, SIGSTOP, SIGCONT), and a helper that fires N operations
   together. Shared on-disk state is then deliberate and scoped to one test — not leaked
   between tests.
6. **Never use production data or secrets.** No real personal data, no real tokens or
   keys; use obviously fake values (`user-1@example.com`, `sk_test_placeholder`). This is a
   security rule.
7. **Make the test readable at a glance.** The test body shows the inputs its assertion
   depends on; everything else lives in the factory default. If a reader must open the
   factory to understand the assertion, move that field into the override list.
8. **Type the data.** Factories return the real domain type or a schema-validated shape,
   so a schema change breaks the factory at compile/parse time instead of silently making
   a test assert nonsense.
9. **Prove isolation.** Run the suite shuffled and in parallel where the runner supports it
   (Vitest `--sequence.shuffle`, Jest default workers, pytest-randomly / `-n auto` if the
   repo has those plugins, `go test -shuffle=on -count=1`), then run one changed test alone. Record evidence with
   the `record-evidence` skill (`test_output`).

## Done when

- Every test you added or changed builds its data through a factory or a scenario-named
  fixture; no object literal is copied across three tests.
- The suite passes shuffled, in parallel, and each changed test passes alone.
- No fixed temp paths, fixed ports, shared connections, real personal data or real secrets
  remain.

## Rules

- One factory per domain object, in the repo's testing directory (independent tester:
  inside a directory the runner treats as tests).
- Defaults valid and boring; randomness only for uniqueness and always seedable.
- Work on the delivery branch the runner prepared (the `create-branch` skill verifies),
  never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While building fixtures you learn how this repo isolates test state — its factories, its test database strategy, its rule for recording external payloads.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
