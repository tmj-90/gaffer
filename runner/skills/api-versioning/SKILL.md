---
name: api-versioning
description: Use when a ticket must change an API in a way clients might notice — renaming or removing a field, changing a type or status code, altering semantics — and the change must be made compatibly or through an explicit version with a deprecation path, never as a silent break. Invoke for "change the response shape", "rename the field", "we need v2", "deprecate the old endpoint", or when a contract test fails on purpose.
stack: [node, python, go, java, rust, csharp, kotlin, ruby]
area: backend
---

# Version an API change

The clients of an API are code you do not control, running versions you cannot see.
The default is to change compatibly: add, do not remove; widen, do not narrow. When a
breaking change is unavoidable, make it a new version that coexists with the old, tell
consumers, and retire the old on a published date.

## Steps

1. **Classify the change.** Additive (a new optional field, a new endpoint, a new enum
   value the client tolerates) is compatible. Removing or renaming a field, changing a
   type, narrowing an enum, changing a status code or error shape, altering meaning
   without altering shape: breaking. When in doubt, it is breaking. Call `search_lore`
   for the repo's versioning scheme and declared consumers; run `find_dependents` where
   the repo map has them.
2. **Prefer the compatible path.** Add the new field alongside the old; accept both
   inputs; default new inputs; deprecate the old with a header or a doc note. Most
   "we need v2" tickets are an additive change plus a deprecation.
3. **If you must break, use the repo's versioning mechanism** — URL prefix (`/v2/`), a
   header, or a dated version — never invent a second one. The new version ships
   alongside the old; both are served by the same code with an adapter at the edge,
   not by a copy-pasted handler tree.
4. **Pin both versions with contract tests** (the `contract-test` skill): the old
   version's shape must not change; the new version's shape is asserted. Update the
   OpenAPI document (the `openapi-contract` skill) for both.
5. **Deprecate visibly.** `Deprecation` and `Sunset` headers on the old version, a
   warning log with the caller identity so you can find stragglers, a CHANGELOG entry,
   and a removal date agreed through `request_decision` when external consumers exist.
6. **Migrate the consumers you own** in the same epic where possible; a version that
   no in-house client has moved to is untested in anger.
7. **Retire on the date.** The `deprecate-and-remove` skill handles the removal: usage
   confirmed zero, old version returns a clear `410 Gone` with a pointer, code deleted.
8. **Evidence** with the `record-evidence` skill: the classification, the consumer
   search, both contract tests passing, and the deprecation headers in a sample response.

## Rules

- Additive by default; breaking only with a version and a decision.
- Never silently change an existing version's shape, semantics, or status codes.
- One versioning mechanism per API; both versions served from one code path via an
  adapter.
- Contract tests pin every live version; the OpenAPI doc matches.
- Deprecation is announced in headers, logs, and the changelog, with a date.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While classifying the change you learn the versioning scheme, who consumes each version and the deprecation dates already promised.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
