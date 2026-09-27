---
name: openapi-contract
description: Use when a ticket adds or changes an HTTP API and the repo keeps (or should keep) a machine-readable contract — an OpenAPI/Swagger document, JSON Schemas, generated clients or types — that must stay in lockstep with the routes and be validated in CI. Invoke for "document the endpoint", "update the OpenAPI spec", "the generated client is out of date", or "add request/response schemas".
stack: [node, python, go, java, rust, csharp, kotlin, ruby]
area: backend
---

# Keep the OpenAPI contract true

An API document that is not generated from, or checked against, the code is fiction
within a month. The contract is the source of truth for clients, tests, and reviewers;
keep it precise (types, required fields, error shapes), keep it verified in CI, and
treat a divergence as a failing build.

## Steps

1. **Find how the repo produces its contract.** Generated from route schemas (the best
   case: zod/pydantic/JSON-Schema definitions rendered to OpenAPI), hand-maintained and
   checked by a test, or absent. Call `search_lore` for the convention and the check
   command (`scripts/openapi.mjs --check` in the factory itself). Follow it; never hand
   edit a generated document.
2. **Define the request and response schemas where the route validates.** The same
   schema object validates input at the boundary and renders the contract, so they
   cannot disagree. Every field typed, required/optional stated, formats declared
   (`uuid`, `date-time`), enums closed, additional properties decided.
3. **Document every response, including errors.** Success status and body; each error
   status with the repo's error envelope and its machine codes; `429` with rate-limit
   headers if the surface is limited; pagination envelope for lists. Clients are
   written against the error shapes as much as the success ones.
4. **Name operations and tag them** consistently with siblings (`listTickets`,
   `createTicket`), with a one-sentence summary and the capability it needs (public /
   read / full) so a reviewer can audit authorization from the document.
5. **Regenerate and diff.** Run the generator; read the diff as a reviewer would: is
   every change intended? Is anything removed or narrowed (breaking → the
   `api-versioning` skill)? Commit the regenerated document with the code.
6. **Keep the check green.** Run the repo's contract-freshness check and its
   two-way test (every documented path exists in the router; every router path is
   documented). If the repo has no check, add the smallest one and raise it in the
   evidence.
7. **Regenerate clients and types** when the repo derives them, in the same change, and
   run their consumers' tests. A stale generated client is the same bug as a stale doc.
8. **Evidence** with the `record-evidence` skill: the regenerated document's diff, the
   freshness check output, and the contract test run (the `contract-test` skill).

## Rules

- One source of truth: schemas at the route boundary render the document.
- Never hand-edit a generated contract; fix the source and regenerate.
- Every response documented, errors included, with the repo's envelope.
- Freshness check and two-way route↔document test pass in CI.
- A removed or narrowed shape is a versioning event, not a doc update.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While regenerating the contract you learn where it lives, how it is produced and the check that keeps it honest in CI.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
