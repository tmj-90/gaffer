---
name: go-conventions
description: Use when a ticket adds or changes Go code and it must follow the repo's Go conventions — idiomatic Go, explicit error handling and wrapping, small interfaces, correct pointer-receiver rules, and table-driven tests run with the race detector. Invoke for "add this in Go", "fix the go vet/build issues", "add the handler/service", or as the language pack for any Go change.
stack: [go]
area: language
---

# Write idiomatic Go

Add Go that reads as idiomatic, handles every error explicitly, and matches the repo's
existing patterns — simple and correct, the Go way.

## Steps

1. **Read the lore first.** Call `search_lore` (Memory MCP) for the repo's Go
   conventions and respect `go.mod` (module path, Go version), the linter config
   (`golangci-lint`), and any architecture ADRs. Keep packages cohesive and named for
   what they provide.
2. **Find a sibling package** and copy its patterns — package layout, error handling,
   how interfaces are defined and consumed, and how tests are organised.
3. **Handle every error explicitly.** Never discard an `error` with `_` unless it is
   genuinely ignorable and commented why. **Wrap with context** using `fmt.Errorf("doing
   X: %w", err)` so the chain is inspectable with `errors.Is`/`errors.As`. Return early
   on error; avoid deep nesting.
4. **Keep interfaces small** and **define them at the consumer**, not the producer.
   Accept interfaces, return concrete types. Don't add an interface speculatively.
5. **Pointer-receiver rules:** be consistent within a type. Use a pointer receiver when
   the method mutates the receiver, the struct is large, or any method needs a pointer
   receiver (so the method set stays consistent); use value receivers for small immutable
   value types.
6. **Concurrency with care.** Pass `context.Context` as the first argument to anything
   that blocks or spans a request; never store a `Context` in a struct. Guard shared state;
   prefer channels/`sync` primitives over data races. Always have a defined goroutine exit.
7. **Idioms:** `defer` for cleanup, zero-value-useful structs, no naked returns in long
   functions, no stuttering names (`http.HTTPServer` → `http.Server`). Run `gofmt`/`goimports`.
8. **Test table-driven.** Use sub-tests (`t.Run`) over a `[]struct` of cases; cover error
   paths; run with `-race`. Use `t.Helper()` in assertion helpers.
9. **Verify + evidence.** Run `go vet`, `go build`, and `go test -race ./...`, record
   `test_output` via the `record-evidence` skill, and submit for review.

## Build / Test

- **Build/vet:** `go build ./...` and `go vet ./...`.
- **Lint:** `golangci-lint run` (when the repo configures it).
- **Tests:** `go test -race ./...`; coverage via `go test -cover ./...`.
- The DoD is verified by the repo's configured test/coverage commands — run them
  (with `-race`) and record the output; a clean vet + green race-tested run is the evidence.

## Review checklist (a Go reviewer must check)

- **Every error is checked** — no silently dropped `err`; ignores are explicit and commented.
- **Errors are wrapped with `%w`** and context, so `errors.Is`/`errors.As` work; no
  `fmt.Errorf("%v", err)` that breaks the chain.
- **Interfaces are small and consumer-side**; functions accept interfaces, return concrete types.
- **Receiver types are consistent** across a type's method set; pointer vs value chosen deliberately.
- **`context.Context` is the first param** of blocking/request-scoped calls and never stored in a struct.
- **No data races** — shared state is guarded; goroutines have a defined exit; `-race` passes.
- **`gofmt`/`goimports` clean** and `go vet` reports nothing.
- **Tests are table-driven** with sub-tests and cover error cases, not only the happy path.

## Rules

- Match the repo's Go version, module layout, and linter config exactly.
- Check and wrap every error (`%w`); return early; no swallowed errors.
- Small consumer-side interfaces; consistent receivers; `context.Context` first, never stored.
- Table-driven tests run with `-race`; `gofmt`/`go vet` clean before review.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**A Go convention this repo enforces beyond the obvious — an error-wrapping pattern, a package-boundary rule, a concurrency invariant, or a linter constraint.** That kind of fact is *lore* — it would have saved you time had the
previous agent recorded it, and it will save the next one. Capture it.

When you learn something that future agents on this repo should know *before they
start* — a convention, a gotcha, an architectural fact, a decision, a boundary —
call the Memory MCP `suggest_lore` tool once, at the close of your work:

- `title` — the rule/fact in a few words.
- `summary` — one self-contained paragraph: the *what* and the *why*.
- `body` — the detail and evidence that lets a human verify it.
- `repos` — the repo(s) the rule applies to.
- `tags` — lowercase (e.g. `conventions`, `gotchas`, `security`, `db`).
- `source` — a URL to the ticket/PR/ADR that justifies it (records without a
  source are lower-trust); `confidence` — `low` for an inferred convention,
  `high` only when you have a source.

**This is suggested, gated knowledge — not auto-truth.** `suggest_lore` lands a
DRAFT; a human reviews and approves it. You never approve your own lore.

**Capture reusable knowledge, not ticket noise.** Lore is a convention, gotcha,
decision, or boundary the *next* agent needs — never per-ticket trivia (what this
diff changed, a path you happened to read, transient task state). The honest test:
*would a teammate six months from now thank you for this record?* If unsure, skip —
a missing record costs one re-search; a noisy one costs every future reader.
