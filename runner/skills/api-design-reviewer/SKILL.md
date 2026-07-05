---
name: api-design-reviewer
description: Use when reviewing a PR that adds or changes API endpoints, auditing an existing API for v2 migration, or establishing REST API standards. Triggers on "API review", "REST design review", "breaking change check", "OpenAPI audit", "endpoint review", or "API consistency".
stack: []
area: review
---

# Review APIs before they ship

Catch inconsistent conventions, missing versioning, and design smells before APIs are consumed by clients. Breaking changes are permanent costs — find them in review, not after release.

## REST design principles

**Resource naming:**
- Collections: plural nouns (`/users`, `/orders`)
- Instances: `/{id}` (singular, no verb)
- Actions that don't fit: `POST /users/{id}/activate` (not `GET /activateUser`)

**HTTP method semantics:**
- `GET` — read; must be idempotent; no side effects
- `POST` — create or action; not idempotent
- `PUT` — replace the whole resource; idempotent
- `PATCH` — partial update; idempotent
- `DELETE` — remove; idempotent

**Status codes — common wrong choices:**

| Situation | Wrong | Right |
|-----------|-------|-------|
| Resource not found | 200 with `{error}` body | 404 |
| Validation failure | 500 | 400 with error detail |
| Auth failure | 404 (hiding resource) | 401 (unauthenticated) or 403 (unauthorised) |
| Created resource | 200 | 201 with `Location` header |
| Async accepted | 200 | 202 |

## Breaking change detection

These changes break existing clients and require a version bump:

- Remove an endpoint
- Remove or rename a required field
- Change a field's type
- Add a required field to a request body
- Change a status code a client depends on
- Change pagination semantics

These are safe (backward-compatible):
- Add a new optional field to a response
- Add a new endpoint
- Add a new optional query parameter

## Steps

1. **Read the OpenAPI spec or code diff.** If no spec exists, note the missing spec as a CONCERN and continue reviewing the code that exists — don't block the review on a spec that isn't there.
2. **Check resource naming.** Plural nouns, no verbs in paths (except for actions), consistent casing.
3. **Check HTTP method usage.** Every `GET` must be safe and idempotent. `POST` for creates and non-idempotent actions only.
4. **Check status codes.** Map every response to the correct 2xx/4xx/5xx. 200 for errors is an automatic BLOCK.
5. **Check for breaking changes.** Diff against the previous spec/version. List every breaking change and verify it's covered by a version bump.
6. **Check error format.** Consistent envelope: `{ "error": { "code": "...", "message": "...", "details": [...] } }` — not ad-hoc per endpoint.
7. **Check versioning.** Is the versioning strategy documented — a version prefix (`/v1/`), header-based versioning, or a deliberate no-version choice? A documented no-version API is fine; only an _undocumented_ or contradictory strategy is a finding.
8. **Emit verdict.** BLOCK / CONCERNS / CLEAN with file/line evidence for each finding.

## Review checklist

- **Resource naming consistent** — plural nouns, no verbs in paths.
- **HTTP methods correct** — no side-effecting `GET`; `PUT` is idempotent; `PATCH` is partial.
- **Status codes correct** — no 200 for errors; 201 for created resources.
- **Error format consistent** — same envelope shape across all endpoints.
- **No undocumented breaking changes** — every breaking change has a version bump.
- **Authentication documented** — every endpoint states its auth requirement.
- **Pagination consistent** — same cursor/offset pattern across all list endpoints.

## Rules

- 200 for errors is a BLOCK finding, always.
- Breaking changes without a version bump are a BLOCK finding.
- A missing spec is a CONCERN, not a blocker — record it and review the code that exists.
