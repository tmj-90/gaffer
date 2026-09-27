---
name: contract-test
description: Use when a ticket changes the boundary between two components or services — an HTTP API and its client, a message producer and consumer, a public module interface — and both sides must keep agreeing. Invoke for "don't break the client", "add a contract test", a consumer-driven contract, or whenever a change touches a schema another team or repo depends on.
stack: [node, python, go, java, rust, csharp, kotlin, ruby]
area: testing
---

# Write a contract test for a boundary

A contract test pins the agreement at a boundary so either side can change safely: the
provider proves it still produces what consumers rely on, the consumer proves it still
accepts what the provider produces. It is the cheapest way to catch "we renamed a field
and broke the mobile app" before it ships.

## Steps

1. **Name the boundary and both parties.** Identify the provider (the API, the message
   producer, the exported module) and every consumer you can find: `grep` the repo, check
   `search_lore` for declared boundaries and dependents (`find_dependents` in the Memory
   MCP when the repo map has them). The contract belongs to the consumers' needs, not to
   everything the provider happens to emit.
2. **Find the existing contract artefact.** An OpenAPI/JSON Schema file, protobuf
   definitions, a Pact directory, a TypeScript type shared through a package, a
   versioned event schema. If one exists, the test validates against IT; if none exists,
   the test becomes the contract and you should propose committing a schema (see the
   `openapi-contract` skill for HTTP).
3. **Write the provider side.** For each consumer-relied-upon shape: a test that calls the
   real provider (route handler, publish function, exported API) and validates the
   response/message against the schema — field presence, types, enums, nullability,
   pagination envelope, error envelope. Cover the error responses too; consumers depend
   on them.
4. **Write the consumer side** when the consumer lives in this repo: a test that feeds
   the consumer the provider's documented examples (from the schema or recorded
   fixtures) and asserts it parses and behaves. Record fixtures from the real provider
   output, never hand-typed guesses.
5. **Make breaking changes loud.** A removed or renamed field, a narrowed enum, a changed
   status code must FAIL the test. Additive changes (a new optional field) must pass.
   Assert that explicitly with one test for each rule so the next agent knows which is
   which.
6. **Version when you must break.** If the ticket requires a breaking change, follow the
   `api-versioning` skill: a new version alongside the old, the contract test pinned to
   both, and a deprecation note; never silently change the existing contract.
7. **Run in the same command as CI**, then evidence with the `record-evidence` skill
   (evidence type `test_output`): the contract file (or test) touched, and which
   consumers it protects.

## Rules

- Contracts are written from the consumer's needs; do not enshrine incidental fields.
- Fixtures come from real provider output, recorded and committed.
- Breaking changes fail loudly; additive changes pass; both are asserted.
- Never edit a contract to make a provider change pass without a version bump and a
  decision when other repos consume it (`request_decision`).
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While pinning a boundary you learn who provides what to whom and which fields consumers actually rely on — a boundary fact no single repo states.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
