---
name: error-handling
description: Use when a ticket touches how failures are represented, propagated, or reported — a new error type, a retry, a fallback, "handle the case where X fails", swallowed exceptions, or unclear error messages — and the result must fail loudly where it should and recover only where it can. Invoke for "handle errors properly", "don't crash on X", or when a reviewer flags an empty catch.
stack: [node, python, go, java, rust, csharp, kotlin, ruby]
area: backend
---

# Handle errors so failures are visible and recoverable

Every error is a decision: recover, translate, or propagate. Code that catches and
ignores makes that decision silently and wrongly. Design the error path with the same
care as the happy path: typed errors at boundaries, context added on the way up, one
place that decides what the user or operator sees.

## Steps

1. **Map the failure modes first.** For the code the ticket touches, list what can fail:
   invalid input, a dependency down, a timeout, a conflict, a bug. For each, decide who
   should know (caller, user, operator) and whether anything can be done. Call
   `search_lore` for the repo's error conventions (an error base class, a result type,
   an error envelope for the API).
2. **Use the repo's error shape.** A typed error hierarchy or a result type, with a
   stable machine code (`NOT_FOUND`, `CLAIM_INVALID`) separate from the human message.
   Never throw strings; never use exceptions for expected control flow the language
   models better with a return value.
3. **Fail fast at boundaries.** Validate input where it enters (the
   `security-input-validation` skill) and reject with the code the API contract
   documents. Inside the boundary, trust your own types.
4. **Add context, keep the cause.** When re-throwing or wrapping, add what the caller
   needs (which record, which operation) and preserve the original (`cause`, `%w`,
   `from`). A stack trace that ends in a wrapper with no cause is a debugging dead end.
5. **Recover only where recovery is real.** A retry is valid for transient, idempotent
   operations with backoff and a cap (the `idempotency-and-retries` skill); a fallback is
   valid when the degraded result is acceptable and observable. Otherwise propagate.
   An empty `catch`, a `except: pass`, an ignored `err`, a `.catch(() => {})` is a
   bug: delete it or handle it.
6. **Report once, at the top.** The outermost handler (request middleware, job runner,
   CLI main) logs the error with its code, context, and correlation id through the
   repo's structured logger (the `structured-logging-and-tracing` skill), maps it to the
   external response, and never leaks internals (stack traces, SQL, file paths) to a
   client.
7. **Test the error paths** as first-class cases: each failure mode has a test asserting
   the code, the message shape, and that side effects did not half-happen. Evidence with
   the `record-evidence` skill.

## Rules

- Typed errors with stable codes; strings are not errors.
- Never swallow: every catch handles, translates, or re-throws with cause.
- Recovery (retry/fallback) only for transient or degradable failures, and always
  bounded and observable.
- One reporting point at the top; internals never reach a client.
- No half-applied state: fail before the first side effect or make the sequence atomic.
- Error paths are tested like happy paths.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While mapping failure modes you learn the repo's error codes and envelope and how each dependency actually fails.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
