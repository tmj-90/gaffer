---
name: openapi-contract
description: Use when a ticket adds or changes an HTTP API and the repo keeps (or should keep) a machine-readable contract — an OpenAPI/Swagger document, JSON Schemas, generated clients or types — that must stay in lockstep with the routes and be validated in CI. Invoke for "document the endpoint", "update the OpenAPI spec", "the generated client is out of date", or "add request/response schemas".
stack: [node, python, go, java, rust, csharp, kotlin, ruby]
area: backend
---

# Keep the OpenAPI contract true

An API document that is not generated from, or checked against, the running code is
fiction within a month. Keep it precise, prove the implementation matches it in tests,
and treat drift or an unannounced breaking change as a failing build. Sources: OpenAPI
Specification 3.1.x (3.2.0 published September 2025), JSON Schema 2020-12, RFC 9457
(problem details), RFC 9110 (HTTP semantics).

## Steps

1. **Find how the repo produces its contract.** Generated from route schemas (best:
   zod/pydantic/JSON Schema rendered to OpenAPI), hand-maintained and checked by a
   test, or absent. Call `search_lore` for the convention and the check command (in
   the factory itself: `node scripts/openapi.mjs --check`). Never hand-edit a generated
   document; fix the source and regenerate.
2. **Respect the document's version.** Write for the `openapi:` version the repo
   declares; do not bump it unless every consumer tool supports the new one. In 3.1,
   schemas are full JSON Schema 2020-12: use `type: [string, "null"]` not `nullable`,
   numeric `exclusiveMinimum`, `examples` (array) in schemas, and the top-level
   `webhooks` map for outbound events. 3.0 documents keep 3.0 idioms.
3. **Define the schemas where the route validates.** The same schema object validates
   input at the boundary and renders the contract, so they cannot disagree. Every field
   typed; `required` stated; formats declared (`uuid`, `date-time`, `email`); enums
   closed; string lengths and array sizes bounded; `readOnly`/`writeOnly` for
   server-set and secret fields. Request bodies reject unknown properties
   (`additionalProperties: false`) where the repo validates strictly; response schemas
   document every field the server emits.
4. **Document every response, errors included.** Success status and body; each error
   status with the repo's error envelope (RFC 9457 `application/problem+json` if the
   repo uses it) and its machine codes; `401/403` where auth applies; `422`/`400` for
   validation; `429` with rate-limit headers when limited (the `rate-limiting` skill);
   the pagination envelope and parameters for lists (the `pagination-and-filtering`
   skill); `Idempotency-Key` where accepted.
5. **Name, tag and secure operations.** Unique `operationId` consistent with siblings
   (`listTickets`, `createTicket`), a one-sentence summary, tags, and a `security`
   requirement per operation (or the global default, stated) so a reviewer can audit
   authorisation from the document alone. In the factory's own API every endpoint in
   `packages/dispatch/src/api/openapi/spec.ts` declares its capability tier
   (`public` / `read` / `full`); set it for each new route.
6. **Regenerate, lint, and diff for breaks.** Run the generator; lint with the repo's
   linter only if it is already installed (`npx --no-install @redocly/cli lint`,
   `npx --no-install @stoplight/spectral-cli lint`); never fetch one.
   Compare with the base branch without writing a file outside the worktree (the safety
   hook blocks that): `oasdiff breaking <(git show <base>:<path>) <path>` if oasdiff is
   installed, otherwise read `git diff <base> -- <path>`. Breaking:
   removing a path, operation, field or enum value from a response; adding a required
   request field; narrowing a type or constraint; changing a status code or auth. Any
   break is a versioning event (the `api-versioning` skill), not a doc update.
7. **Prove the code matches the document.** Run the repo's freshness check and its
   two-way route test (every documented path is routed; every routed path is
   documented). Validate real responses against the schema in integration tests (a
   response validator, or Schemathesis-style property tests if the repo has them), so
   a handler that returns an undocumented field or status fails. If the repo has no
   check, add the smallest one and name it in the evidence.
8. **Regenerate derived clients and types** in the same change and run their
   consumers' tests; a stale generated client is the same bug as a stale document.

## Done when

The regenerated document is committed with the code, the freshness check and lint
pass, the break comparison is clean (or the break is versioned), response validation
covers the changed operations, and each acceptance criterion has evidence via the
`record-evidence` skill (document diff, check output, contract test run — the
`contract-test` skill).

## Review checklist

- [ ] One source of truth; no hand-edited generated file.
- [ ] Every new or changed operation has typed, bounded request and response schemas.
- [ ] Every response documented, errors and `429` included, in the repo's envelope.
- [ ] `operationId` unique; `security` stated per operation.
- [ ] No unversioned breaking change against the base branch.
- [ ] Tests validate actual responses against the document; freshness check green.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While regenerating the contract you learn where it lives, how it is produced and the check that keeps it honest in CI.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
