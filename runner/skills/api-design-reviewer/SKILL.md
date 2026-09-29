---
name: api-design-reviewer
description: Use when reviewing a PR that adds or changes API endpoints, auditing an existing API for v2 migration, or establishing REST API standards — HTTP semantics, status codes, RFC 9457 problem-details errors, breaking-change detection, pagination, idempotency and concurrency control. Triggers on "API review", "REST design review", "breaking change check", "OpenAPI audit", "endpoint review", or "API consistency".
stack: []
area: review
---

# Review APIs before they ship

An API is a contract other code depends on; a breaking change costs every client and
cannot be recalled after release. Review new and changed endpoints against HTTP
semantics (RFC 9110), the error format (RFC 9457), and the compatibility rules of the
Google API Improvement Proposals (AIP-180) and the Microsoft REST API Guidelines. When
used as a review lens, a finding blocks only when it is a concrete defect: a broken
existing contract, wrong semantics a client will act on, or an AC not met. Consistency
wishes on new endpoints are notes.

## Steps

1. **Find the contract.** Read the OpenAPI/proto spec diff if one exists, else the route
   and handler diff. Call `search_lore` for the repo's API conventions (error envelope,
   pagination style, versioning, casing). A missing spec is a note, not a blocker.
2. **List every changed operation** as `METHOD path → statuses, request shape, response
   shape`, and mark each new, changed or removed.
3. **Check compatibility** of every changed or removed operation against the breaking
   list below. For each break, is there a new version, a deprecation path, or an AC that
   explicitly asks for it? If not, it is blocking.
4. **Check semantics** — methods, status codes, errors, pagination, idempotency and
   concurrency — against the checklist, for new and changed operations.
5. **Check tests reach the contract.** Each AC about an endpoint has a test that calls it
   over its real interface and asserts status and body, including the error case the AC
   names (the `contract-test` skill when a spec exists).
6. **Rate and record.** Blocking: an unversioned breaking change; a success status on a
   failure (a client will treat an error as success); a side-effecting `GET`; a
   documented behaviour the diff contradicts. Should-fix: wrong status on a new
   endpoint that clients will branch on; an error body that departs from the envelope the
   repo's clients already parse. Note: naming, style and other consistency wishes. As
   a lens, record each finding with `record_ac_evidence` (`evidence_type: manual_note`:
   operation, rule, fix) and let `review-ticket` carry the verdict; outside a Gaffer
   review, emit BLOCK / CONCERNS / CLEAN with file and line.

## Breaking changes (need a new version or explicit AC)

- Removing or renaming an operation, field, query parameter, header or enum value.
- Changing a field's type, format, units, default or meaning.
- Making an optional request field required, or tightening validation (shorter max
  length, narrower range, new required header).
- Adding a required request field or a new required query parameter.
- Changing a status code, error `type`/code, or the auth requirement clients rely on.
- Changing pagination, sort order or filtering semantics; changing an idempotent
  operation into a non-idempotent one.
- Adding an enum value to a **response** where clients were not told enums are open
  (Microsoft guidelines treat this as breaking unless the enum is declared extensible).

Safe: new operations, new optional request fields, new response fields clients must
ignore, relaxed validation.

## Checklist

- **Resources and methods**: plural nouns for collections, ids for instances, custom
  actions as `POST /things/{id}:action` or `/things/{id}/action` per repo convention.
  `GET`/`HEAD` safe with no side effects; `PUT` full replacement and idempotent;
  `DELETE` idempotent; `PATCH` partial — not idempotent by definition (RFC 5789), so a
  retried `PATCH` must be made safe with a precondition or an idempotency key.
- **Status codes**: 201 plus `Location` on create; 202 for accepted async work with a
  status URL; 204 for no body; 400 malformed; 401 unauthenticated with
  `WWW-Authenticate`; 403 forbidden — or 404 to avoid revealing that a resource exists
  (RFC 9110 permits this); 404 missing; 409 state conflict; 412 failed precondition;
  415 wrong media type; 422 semantically invalid content; 429 with `Retry-After`; 5xx
  only for server faults. Never 200 with an error body.
- **Errors**: one shape everywhere, preferably RFC 9457 `application/problem+json` with
  `type`, `title`, `status`, `detail`, `instance`, plus field-level errors as an
  extension member; no stack traces or SQL in `detail`.
- **Concurrency control**: updates to a resource several clients edit support
  `ETag` + `If-Match` (412 on mismatch) or a version field, so a read-modify-write
  cannot silently lose another client's update (the `concurrency-review` skill).
- **Idempotency**: `POST` that creates payments, orders or other effects accepts an
  `Idempotency-Key` (or a client-supplied id) enforced atomically, returning the original
  result on replay (the `idempotency-and-retries` skill).
- **Pagination and filtering**: every list paginated with a max page size; cursor
  (opaque `next_page_token`) for large or changing sets; stable sort; same pattern on
  every list endpoint (AIP-158).
- **Versioning and deprecation**: one documented strategy (path `/v1`, header, or
  deliberately unversioned with additive-only changes); deprecated operations signalled
  (`Deprecation`/`Sunset` headers or spec flags) before removal (the `api-versioning`
  skill).
- **Security surface**: every operation states its auth requirement; object-level
  authorization on ids in paths (the `security-review` skill).

## Rules

- An unversioned breaking change to an existing contract always blocks.
- A success status on a failure always blocks; other status choices on new endpoints
  are should-fix at most.
- Missing spec, naming and envelope preferences are notes, never grounds for CHANGES.
