---
name: engineering-craft
description: Use on every code delivery to hold the structural-quality bar — reusability where repetition is real, clear boundaries, explicit error handling, focused units, honest names, and tests for real logic. Invoke whenever you implement a claimed ticket and want the change to read like production code the repo's maintainers would approve, not a quick hack that merely passes. A cross-cutting lens that composes with `minimalism` (least code) and whatever build skill the ticket needs. For "make this reusable / well-structured", "production quality", "don't leave a hack".
stack: []
area: quality
---

# Engineering craft — code the maintainers would approve

The counterpart to `minimalism`. Minimalism asks "is this the least code that works?";
craft asks "is the code that remains correct, honest and safe to change?" The target is
the smallest change a careful reviewer approves without asking for a redo. This is a
lens: apply it while you implement and confirm it in the `self-review` skill.

Craft never licenses extra code. When craft and minimalism seem to disagree, rule 1
settles structure (minimalism wins) and rules 3–5 settle guarantees (craft wins).

## The craft bar (walk it against your diff)

1. **Reuse only real repetition.** Extract when the same logic already exists in two or
   three places you can point at, not for a second caller that does not exist yet. No
   base class, generic, plugin point or config system "for later".
2. **Boundaries at the edges.** Keep transport (HTTP/CLI), domain logic and persistence
   separable; no SQL or `fetch` in the middle of a business rule. Use the seams the repo
   already has; do not invent a new layering.
3. **No silent failures.** No empty `catch`, swallowed promise rejection, ignored return
   code or `|| true` that hides a real error. Handle the error meaningfully or propagate
   it with context; user-facing paths get a clear message, server paths log the detail.
   Never catch an error to make a test pass.
4. **Validate untrusted input at the boundary** — request bodies, CLI args, file
   contents, external API responses — with the repo's existing validator (zod, pydantic,
   bean validation) where there is one. Fail fast with a message that names the field.
5. **Shared state is written safely.** This is the defect class that twice passed every
   review in this factory, so check it on any code that writes files, rows, caches,
   counters or locks:
   - concurrent writers never share a temp name — use a unique name (`mkstemp`,
     `crypto.randomUUID()`), write, then atomically rename into place;
   - read-modify-write of shared data happens under a lock, inside a transaction, or as
     a compare-and-swap (version column, ETag, `If-Match`); never a bare read then write;
   - a time-based lock or lease is not safety on its own: a holder that pauses past the
     expiry (GC, SIGSTOP, a slow disk) will still write. Check ownership at the moment of
     the write — a fencing token or a conditional write that fails for a stale holder —
     and never acknowledge success before the write is durable;
   - a test drives two writers at once and a stalled holder, and asserts no lost update.
   The `concurrency-and-async` and `idempotency-and-retries` skills hold the patterns.
6. **Small, focused units.** A function does one thing; a file stays cohesive. Split a
   function that has grown a second responsibility or deep nesting — for clarity, not to
   hit a number. Prefer early returns to nested conditionals.
7. **Honest names.** Names say what a thing is or does; booleans read as
   `is/has/should/can`; units are in the name (`timeoutMs`). No `data2`, `tmp`, `helper`,
   `doStuff`.
8. **Do not mutate what you do not own.** Treat arguments and shared state as read-only
   unless mutation is the point, within the language's idiom (an in-place sort in hot Go
   code is fine).
9. **Composition over inheritance.** A function, a small object, or an injected
   dependency before a class hierarchy.
10. **Tests are part of the change.** Every AC has a test that exercises that AC's own
    behaviour, plus the boundaries and the error path of the logic you added (the
    `add-unit-test` and `add-integration-test` skills). A test that only asserts "no
    exception" or a status code is not coverage of an AC about data.
11. **Match the repo, do not reform it.** Your addition should be indistinguishable from
    well-written code around it. A repo-wide cleanup is a separate ticket.

## How it composes

- **Build skills** (`backend-service`, `add-api-endpoint`, `frontend-component`, …) say
  what to build for the domain; craft is how well. On UI work `frontend-foundations` adds
  the surface-specific bar.
- **`self-review`:** walk this list against your final diff before recording evidence.

## Marker

When you make a non-obvious structural call — extracted a shared unit, chose a boundary,
declined an abstraction, added validation at a particular edge — record it in one line:
`request_decision` at `log_only`, or a line in the evidence you record with the
`record-evidence` skill. Only real calls, not running commentary.

## For reviewers using this lens

A craft finding is grounds for CHANGES only when it is a concrete defect under the
review bar: an AC not met, a missing or failing test for an AC's own behaviour, or a
correctness or security bug — rules 3, 4, 5 and 10 usually produce these (a swallowed
error that hides a failure, unvalidated input reaching a query, a racy shared write, an
untested AC). Name the file, the line and the single fix. Rules 1, 2, 6–9 and 11 are
style and structure: list them as "(optional)" notes, never as a reason to reject.
