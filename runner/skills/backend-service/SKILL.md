---
name: backend-service
description: Use when a ticket asks for backend business logic that isn't itself an endpoint or a migration — a service/use-case, a domain operation, a background job, or orchestration across repositories. Invoke for "add a service to do X", "implement the use-case", or "extract the business logic out of the handler".
stack: []
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
**A service-layer convention or stack rule this repo follows — error-handling shape, transaction boundary, dependency-injection pattern, or a framework gotcha.** That kind of fact is *lore* — it would have saved you time had the
previous agent recorded it, and it will save the next one. Capture it.

When you learn something that future agents on this repo should know *before they
start* — a convention, a gotcha, an architectural fact, a decision, a boundary —
call the Memory MCP `suggest_lore` tool once, at the close of your work:

- `title` — the rule/fact in a few words.
- `summary` — one self-contained paragraph: the *what* and the *why*.
- `body` — the detail and evidence that lets a human verify it.
- `repos` — the repo(s) the rule applies to.
- `tags` — lowercase (e.g. `conventions`, `gotchas`, `security`, `db`).
- `source` — a URL to the ticket/PR/ADR that justifies it (records without a
  source are lower-trust); `confidence` — `low` for an inferred convention,
  `high` only when you have a source.

**This is suggested, gated knowledge — not auto-truth.** `suggest_lore` lands a
DRAFT; a human reviews and approves it. You never approve your own lore.

**Capture reusable knowledge, not ticket noise.** Lore is a convention, gotcha,
decision, or boundary the *next* agent needs — never per-ticket trivia (what this
diff changed, a path you happened to read, transient task state). The honest test:
*would a teammate six months from now thank you for this record?* If unsure, skip —
a missing record costs one re-search; a noisy one costs every future reader.
