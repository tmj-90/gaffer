---
name: api-versioning
description: Use when a ticket must change an API in a way clients might notice — renaming or removing a field, changing a type or status code, altering semantics — and the change must be made compatibly or through an explicit version with a deprecation path, never as a silent break. Invoke for "change the response shape", "rename the field", "we need v2", "deprecate the old endpoint", or when a contract test fails on purpose.
stack: [node, python, go, java, rust, csharp, kotlin, ruby]
area: backend
---

# Version an API change

API clients are code you do not control, running versions you cannot see. Change
compatibly by default: add, do not remove; widen what you accept, do not narrow what you
return. When a break is unavoidable, ship a new version beside the old one, announce the
deprecation in machine-readable headers, and remove the old version only on a
published date.

## Steps

1. **Classify the change** against Google AIP-180 and the Microsoft REST guidelines.
   Compatible: a new endpoint; a new optional request field whose absence keeps the old
   behaviour; a new response field; accepting more input. Breaking:
   - removing or renaming a field, endpoint, enum value or query parameter;
   - changing a type, format, unit, or the serialisation of a value;
   - making an optional request field required, or adding a required one;
   - changing a default, a status code, an error code or the error body shape;
   - no longer populating a field that used to be populated;
   - same shape, different meaning (semantic break).
   A new value in a response enum breaks clients with exhaustive switches unless the
   contract already says the enum is extensible. When in doubt, it is breaking.
2. **Find the consumers.** Call `search_lore` for the versioning scheme and declared
   consumers, and `find_dependents` for the declared cross-repo consumers of the contract
   (an empty result is not proof of safety). Use the Grep tool for in-repo callers,
   generated clients and contract tests. Record who is affected.
3. **Take the compatible path when one exists.** Add the new field beside the old and
   populate both; accept old and new inputs; keep old defaults. Most "we need v2"
   tickets are an additive change plus a deprecation.
4. **If you must break, use the repo's one versioning mechanism** (URL major version
   `/v2/`, a header, or a dated `api-version` parameter); never add a second scheme.
   The versions share one domain implementation with a thin adapter per version at the
   edge, not a copied handler tree. An unsupported version gets a clear error listing
   the supported ones, in the repo's envelope (e.g. `400` for a bad `api-version`
   value, `404` for an unknown `/vN/` prefix).
5. **Pin every live version with contract tests** (the `contract-test` skill): the old
   version's response is asserted unchanged (field names, types, status codes, error
   body), and the new version's shape is asserted. Update the OpenAPI document for each
   version (the `openapi-contract` skill).
6. **Deprecate in machine-readable form.** On every response from the deprecated
   version or endpoint: `Deprecation: @<unix-seconds>` (RFC 9745), `Sunset: <HTTP-date>`
   (RFC 8594), and `Link: <doc-url>; rel="deprecation"`. Log each deprecated call with
   the caller identity so stragglers can be found; add a CHANGELOG entry. When external
   consumers exist, get the removal date through `request_decision`; do not invent one.
7. **Migrate the in-repo consumers you own** in the same epic; a version no internal
   client uses is untested.
8. **Retire only on the date**, via the `deprecate-and-remove` skill: usage confirmed
   zero, the old version answers `410 Gone` with a pointer to the replacement, then the
   code is deleted.
9. **Evidence** with the `record-evidence` skill: the classification and why, the
   consumer list, both contract tests passing, and a sample response showing the
   deprecation headers.

## Done when

- The change is classified in writing, with the consumer search attached.
- No existing version changed shape, semantics, status codes or error body.
- Each live version has a passing contract test and an accurate OpenAPI entry.
- Deprecated surfaces emit `Deprecation`, `Sunset` and `Link` headers; the date was
  decided, not assumed.

## Anti-patterns

- "It's only a rename" shipped in place; changing a default "because it's better".
- Returning `null` for a field that used to be populated to "remove" it.
- A `v2` directory that copy-pastes every handler and drifts from `v1`.
- Removing the old version before usage logs show zero callers.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While classifying the change you learn the versioning scheme, who consumes each version and the deprecation dates already promised.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
