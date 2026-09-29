---
name: contract-test
description: Use when a ticket changes the boundary between two components or services — an HTTP API and its client, a message producer and consumer, a public module interface — and both sides must keep agreeing. Invoke for "don't break the client", "add a contract test", a consumer-driven contract (Pact), schema validation against OpenAPI/JSON Schema/protobuf, or whenever a change touches a schema another team or repo depends on.
stack: [node, python, go, java, rust, csharp, kotlin, ruby]
area: testing
---

# Write a contract test for a boundary

A contract test pins the agreement at a boundary so either side can change safely: the
provider proves it still produces what consumers rely on; the consumer proves it still
handles what the provider produces. It catches "we renamed a field and broke the mobile
app" before deploy, without a slow end-to-end environment.

A contract test checks the **shape and meaning of messages**, not side effects. Pact's
own guidance: contract tests are not functional tests of the provider — whether the order
was actually persisted, or every validation rule, belongs in the provider's own
integration tests (the `add-integration-test` skill). Mixing them makes contracts brittle
and still leaves the behaviour untested.

## Procedure

1. **Name the boundary and every consumer.** Identify the provider (API, producer,
   exported module) and each consumer: `grep` the repo, call `search_lore` for declared
   boundaries, and `find_dependents` (Memory MCP) where the repo map has them. The
   contract is the union of what consumers actually use, not everything the provider
   emits.
2. **Find the existing contract artefact** and test against it: OpenAPI/JSON Schema,
   protobuf/Avro, a Pact directory or broker, a shared TypeScript type package, a versioned
   event schema. If none exists, the test becomes the contract and you should propose
   committing a schema (the `openapi-contract` skill for HTTP).
3. **Choose the style that fits.**
   - _Consumer-driven (Pact):_ both sides are under your control, consumers are
     identifiable, and the provider can set up state per interaction ("given a user
     Mary exists"). The consumer test generates the pact; the provider verifies it
     against the real service with provider states.
   - _Schema-based:_ public or many-consumer APIs, or a provider you cannot seed through
     anything but the API under test. Validate real responses against the published
     schema; consumers validate against the same schema.
4. **Write the provider side.** Call the real handler/publisher with each consumer-relied
   request and validate the response or message: field presence, types, enums,
   nullability, pagination and error envelopes (RFC 9457 problem details if the repo uses
   them), status codes. Cover error responses — consumers branch on them.
5. **Write the consumer side** when the consumer lives here: feed it the provider's
   examples (from the schema or recorded from the real provider, never hand-typed guesses)
   and assert it parses and behaves, including an unknown extra field, which it must
   ignore (tolerant reader).
6. **Match loosely, assert what matters.** Use type/regex matchers for values the
   consumer does not branch on (ids, timestamps); exact values only where the consumer
   depends on them (an enum, a status). Over-specified contracts break on harmless changes.
7. **Make the compatibility rules executable** — one test each:
   - removed or renamed field, narrowed enum, changed type, changed status code → FAIL;
   - new optional field, widened enum the consumer tolerates → PASS.
8. **Version when you must break.** Follow the `api-versioning` skill: a new version
   beside the old, contract tests pinned to both, a deprecation note. When another repo
   consumes the contract, raise `request_decision` before changing it. (Independent
   tester: you never change a contract or raise `request_decision`; follow
   `black-box-test` and record a break as a FAIL finding.)
9. **Run in the same command CI runs**, then record evidence with the `record-evidence`
   skill (`test_output`): the contract file or tests touched and which consumers they
   protect. Publishing to a Pact broker and `can-i-deploy` are CI's job; you have no
   broker credentials and no deploy step.

## Done when

- Every consumer-relied field, status and error shape is asserted on the provider side.
- A deliberately removed field makes the provider test fail; an added optional field
  does not.
- The consumer (if in this repo) is tested against recorded provider output.

## Anti-patterns

- Enshrining incidental fields no consumer reads.
- Hand-typed fixtures that drift from what the provider really sends.
- Using contract tests (or Pact mocks) as a general stub for UI or end-to-end tests.
- Editing the contract to make a provider change pass, without a version bump.
- Testing a pass-through proxy's contract instead of the real downstream one.

## Rules

- Contracts come from the consumer's needs; fixtures come from real provider output.
- Breaking changes fail loudly; additive changes pass; both are asserted.
- Work on the delivery branch the runner prepared (the `create-branch` skill verifies),
  never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While pinning a boundary you learn who provides what to whom and which fields consumers actually rely on — a boundary fact no single repo states.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
