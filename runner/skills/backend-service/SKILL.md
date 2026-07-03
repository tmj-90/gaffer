---
name: backend-service
description: Use when a ticket asks for backend business logic that isn't itself an endpoint or a migration — a service/use-case, a domain operation, a background job, or orchestration across repositories. Invoke for "add a service to do X", "implement the use-case", or "extract the business logic out of the handler".
stack: [node, python, go, java, rust]
area: backend
---

# Add a backend service

Implement domain logic as a focused, testable service that keeps transport (HTTP)
and persistence (DB) concerns at the edges, following the repo's layering.

## Steps

1. **Read the lore first.** Call `search_lore` (Memory MCP) for the repo's
   layering (controller → service → repository), error model, transaction handling,
   and dependency-injection conventions. Honour any ADRs.
2. **Find a sibling service** and copy its shape — constructor/factory, injected
   collaborators, return/error types, and where it lives.
3. **Keep the service transport-agnostic.** It receives validated inputs and returns
   domain results or typed errors — no HTTP request/response objects, no SQL strings.
4. **Depend on abstractions.** Take repositories/clients via interfaces so the logic
   is unit-testable with fakes; favour immutable inputs and outputs.
5. **Handle failure explicitly.** Map domain failures to typed errors/results; never
   swallow exceptions or return ambiguous nulls.
6. **Test the logic in isolation.** Unit-test happy path, branches, and error cases
   with collaborators faked; add an integration test if it crosses real boundaries.
7. **Verify + evidence.** Run tests and lint, then record `test_output` via the
   `record-evidence` skill and submit for review.

## Rules

- One responsibility per service; keep methods small and the file cohesive.
- No transport or storage details leaking into the service layer.
- Immutable inputs/outputs; explicit error handling, no silent failures.
- Pair with `add-api-endpoint` for the HTTP edge and `add-db-migration` for schema.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**A service-layer convention or stack rule this repo follows — error-handling shape, transaction boundary, dependency-injection pattern, or a framework gotcha.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
