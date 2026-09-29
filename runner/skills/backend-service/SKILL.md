---
name: backend-service
description: Use when a ticket asks for backend business logic that isn't itself an endpoint or a migration — a service/use-case, a domain operation, a background job, or orchestration across repositories. Invoke for "add a service to do X", "implement the use-case", or "extract the business logic out of the handler".
stack: [node, python, go, java, rust]
area: backend
---

# Add a backend service

A service owns one use-case: it receives validated input, enforces the business rules,
defines the transaction boundary, and returns a domain result or a typed error.
Transport (HTTP, CLI, queue) and storage details stay at the edges so the logic can be
tested directly and reused by every entry point.

## Steps

1. **Read the conventions.** Call `search_lore` for the layering (handler → service →
   repository), error model, transaction handling and dependency-injection style; honour
   any ADR. Find a sibling service and copy its construction, collaborator injection,
   return and error types, file location and test layout.
2. **Write the use-case contract.** Inputs (already validated types), outputs, each
   typed failure (`NotFound`, `Conflict`, `Forbidden`, `ValidationFailed`), and the
   invariants that must hold afterwards (e.g. "a user has at most one active
   subscription"). Map each AC to the invariant or behaviour it tests.
3. **Keep it transport-agnostic.** No request/response objects, status codes, SQL
   strings or framework types in the service signature. Take repositories, clients, the
   clock and ID generators as injected dependencies so tests can control time and IDs.
4. **Own the transaction boundary.** One use-case = one unit of work: all writes
   commit together or not at all. Do not call external services (HTTP, email, payment)
   inside an open database transaction; record the intent in an outbox row in the same
   transaction and deliver after commit (the `background-jobs` and
   `event-driven-messaging` skills).
5. **Enforce invariants where concurrency cannot break them.** "Check, then insert"
   in application code races with a second request. Back each uniqueness or count
   invariant with a database constraint, a conditional update (`… WHERE version = ?`),
   or a row lock, and translate the resulting violation into the typed `Conflict` error.
   Shared files or in-memory state written by concurrent callers follow the
   `concurrency-and-async` skill.
6. **Handle failure explicitly.** Return or raise typed errors with context and the
   original cause; never swallow an exception, return an ambiguous `null`, or leave a
   half-applied change (the `error-handling` skill). Operations callers may retry are
   idempotent (the `idempotency-and-retries` skill).
7. **Test the behaviour, one test per AC**, exercising that AC's own rule:
   - unit tests with in-memory fakes for branches, typed errors and edge cases, using a
     fixed clock and deterministic IDs;
   - an integration test against the real database for anything relying on a
     constraint, transaction or lock (a fake repository cannot prove atomicity);
   - a rollback test: when a later step fails, earlier writes are not persisted;
   - where an invariant can be raced, N concurrent calls keep it (exactly one winner,
     the losers get `Conflict`), using the `concurrency-and-async` skill's step 9 recipe.

   Use the repo's fixtures (the `test-fixtures-and-factories` skill).
8. **Run the checks** (the `run-tests` and `run-lint` skills), then evidence each AC
   with the `record-evidence` skill and stop.

## Done when

- The service has one responsibility and no transport or storage types in its API.
- Every invariant is enforced by the database or a lock, not only by an `if`.
- Each AC has a passing test that fails without the change, including the rollback and
  concurrency cases where they apply.

## Anti-patterns

- Business rules left in the handler "for now"; a service that returns HTTP codes.
- Mocking the repository to test a uniqueness rule the database enforces.
- An HTTP call or email send inside a database transaction.
- `new Date()` / `time.Now()` called directly inside logic under test.

Pair with the `add-api-endpoint` skill for the HTTP edge and the `add-db-migration`
skill for schema changes.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**A service-layer convention or stack rule this repo follows — error-handling shape, transaction boundary, dependency-injection pattern, or a framework gotcha.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
