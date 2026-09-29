---
name: error-handling
description: Use when a ticket touches how failures are represented, propagated, or reported — a new error type, a retry, a fallback, "handle the case where X fails", swallowed exceptions, or unclear error messages — and the result must fail loudly where it should and recover only where it can. Invoke for "handle errors properly", "don't crash on X", or when a reviewer flags an empty catch.
stack: [node, python, go, java, rust, csharp, kotlin, ruby]
area: backend
---

# Handle errors so failures are visible and recoverable

Every error is a decision: recover, translate, or propagate. An empty catch makes that
decision silently and wrongly. Design the error path with the happy path: typed errors
with stable codes, context added on the way up with the cause preserved, and one place
at the top that logs and decides what the caller sees.

## Steps

1. **Map the failure modes.** For the code the ticket touches, list what can fail:
   invalid input, not found, conflict, permission, dependency down, timeout, and bugs.
   For each, decide who must know (caller, user, operator) and whether anything can be
   done. Call `search_lore` for the repo's error base class or result type and the API
   error envelope.
2. **Use the repo's error shape.** A typed error hierarchy or result type carrying a
   stable machine code (`NOT_FOUND`, `CONFLICT`) separate from the human message. Never
   throw strings. Use return values for expected outcomes where the language favours
   them (Go `error`, Rust `Result`) and exceptions for exceptional ones elsewhere.
3. **Fail fast at boundaries.** Validate input where it enters (the
   `security-input-validation` skill) and reject with the documented code before any
   side effect. Inside the boundary, trust your own types.
4. **Wrap with context, keep the cause.** Add what the caller needs (which record, which
   operation) and preserve the original:
   - JavaScript/TypeScript: `new AppError(msg, { cause: err })`; never `throw "msg"`.
   - Python: `raise AppError(msg) from err`; `add_note()` for context.
   - Go: `fmt.Errorf("load order %s: %w", id, err)`; test with `errors.Is` / `errors.As`;
     never compare error strings.
   - Rust: `?` with `thiserror` types in libraries, `anyhow::Context` in binaries; no
     `unwrap()` on fallible runtime paths.
   - Java/Kotlin: pass the cause to the constructor; C#: `throw;` to rethrow, never
     `throw ex;` (it resets the stack trace).
5. **Recover only where recovery is real.** Retry only transient failures of idempotent
   operations, with backoff, jitter and a cap (the `idempotency-and-retries` skill).
   Fall back only when the degraded result is acceptable and is logged or counted.
   Otherwise propagate. An empty `catch`, `except: pass`, `except Exception` that
   continues, an ignored `err`, or `.catch(() => {})` is a bug: handle it or delete it.
   Do not catch an error to hide a race or a bug (e.g. retrying on a temp-file collision
   instead of fixing it with the `concurrency-and-async` skill).
6. **Leave no half-applied state.** Fail before the first side effect, or make the
   sequence atomic (one transaction), or compensate explicitly. Release resources in
   `finally` / `defer` / `using` / `with`.
7. **Report once, at the top.** The outermost handler (request middleware, job runner,
   CLI `main`) logs once with code, context, cause chain and correlation id through the
   structured logger (the `structured-logging-and-tracing` skill); intermediate layers
   wrap, they do not log and rethrow. It maps typed errors to the external contract:
   for HTTP, the repo's envelope or RFC 9457 problem details (`type`, `title`,
   `status`, `detail`) with the right status (400/422 validation, 404, 409 conflict,
   503 dependency unavailable, 500 only for bugs). Stack traces, SQL, file paths and
   secrets never reach a client. Install process-level handlers (unhandled rejection,
   uncaught exception, panic recovery at the goroutine or request boundary) that log
   and exit or fail the request, never continue in an unknown state.
8. **Test the error paths** as first-class cases, one test per AC exercising the AC's
   own behaviour: each failure mode asserts the error code or status, the body shape,
   that the cause is preserved (or logged), and that no partial write or side effect
   happened. Inject failures with fakes or fault hooks, not by editing production code.
9. **Evidence** with the `record-evidence` skill.

## Done when

- Every failure mode from step 1 has a typed error, a mapping at the top, and a test.
- No swallowed errors remain in the touched code (search for empty catches, `pass`,
  `_ = err`, `.catch(() => {})`).
- Client responses contain stable codes and no internals; each error is logged once.

## Anti-patterns

- `catch (e) { log(e); throw e; }` at every layer (the same error logged five times).
- Mapping every exception to `500`, or every exception to `400`.
- Retrying non-idempotent writes; retrying without a cap.
- Wrapping that drops the cause; matching on error message text.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While mapping failure modes you learn the repo's error codes and envelope and how each dependency actually fails.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
