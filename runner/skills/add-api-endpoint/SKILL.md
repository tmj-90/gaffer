---
name: add-api-endpoint
description: Use when a ticket asks to add or extend an HTTP/API endpoint — a new route, handler, or RPC method — with request validation and a defined response. Invoke for "add a POST /things endpoint", "expose a list API", or "add a field to the X response".
stack: [node, python, go, java, rust]
area: backend
---

# Add an API endpoint

An endpoint is a contract: method, path, input schema, status codes, response and error
bodies, auth rule, and behaviour under retries and concurrent writes. Copy the repo's
conventions, validate at the boundary, and prove each acceptance criterion with a
route-level test that exercises that criterion's own behaviour.

## Steps

1. **Read the conventions.** Call `search_lore` for the routing style, response
   envelope, error format, auth pattern, pagination and idempotency rules; honour any
   ADR. Find a sibling endpoint and copy its registration, handler, schema and test
   layout. If the repo has an OpenAPI document, update it in the same change (the
   `openapi-contract` skill).
2. **Pin the contract before coding.** Write down, per AC: method and path, request
   schema, success status and body, every error status, and who may call it.
   Use HTTP semantics (RFC 9110):
   - `201 Created` + `Location` for a create; `200` with a body or `204` without.
   - `400` malformed syntax, `422` well-formed but semantically invalid (or the repo's
     single validation status), `401` unauthenticated, `403` authenticated but not
     allowed, `404` absent (or hidden from this caller), `409` state conflict, `412`
     failed `If-Match`, `429` rate-limited.
   - Never `200` with an error body; never `500` for bad client input.
3. **Validate every input at the boundary** with the repo's schema library (Zod,
   Pydantic, Bean Validation, serde): path, query, headers and body; types, ranges,
   lengths, enums. Reject unknown fields if the sibling endpoints do. Errors use the
   repo's envelope; if it has none, use RFC 9457 problem details
   (`application/problem+json`, `type`, `title`, `status`, `detail`, plus a field-level
   `errors` list) (the `security-input-validation` skill).
4. **Authorise the object, not just the route.** Check that this caller may act on this
   specific resource (tenant, owner, role) in the handler or service; filter list
   queries by the caller's scope (the `security-authz` skill). Never return fields the
   caller may not see; build response DTOs explicitly rather than serialising the model.
5. **Keep the handler thin:** parse → validate → authorise → call the service → map to
   the response. Business rules live in the service (the `backend-service` skill).
6. **Make writes safe under retries and concurrency.** POST creates that clients may
   retry take an idempotency key or rely on a natural unique constraint (the
   `idempotency-and-retries` skill). Updates that read then write use a version or
   `ETag`/`If-Match` and return `409`/`412` on conflict instead of silently overwriting.
   Anything that writes a shared file or counter follows the `concurrency-and-async`
   skill. List endpoints are paginated and bounded (the `pagination-and-filtering`
   skill).
7. **Test through the route** (the `add-integration-test` skill), one test per AC that
   exercises the AC's own behaviour, plus:
   - validation: each rejected input class returns the documented status and error body;
   - authz: unauthenticated → 401, other tenant/owner → 403/404;
   - happy path: status, headers (`Location`), exact body shape;
   - side effects: the row exists after a create, is unchanged after a rejected request;
   - where the AC involves writes: N concurrent requests to the same resource keep the
     invariant (no 500, no lost update, one row per idempotency key), built with the
     `concurrency-and-async` skill's step 9 recipe.
8. **Run the checks** (the `run-tests` and `run-lint` skills), then evidence each AC with
   the `record-evidence` skill and stop.

## Done when

- Every AC maps to a passing route-level test that would fail without the change.
- Status codes, error body and auth match siblings and RFC 9110 semantics.
- The OpenAPI document (if any) matches the implementation.
- No unrequested fields, endpoints or options were added.
- Any new auth surface or data exposure is named in the evidence summary.

## Anti-patterns

- Validating in the service but trusting the handler input; serialising ORM models.
- A single catch-all that turns every error into `500` or `400`.
- Tests that only assert `status === 200`; tests that mock the handler under test.
- Last-write-wins updates on a resource two clients can edit.
