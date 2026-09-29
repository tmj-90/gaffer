---
name: go-conventions
description: Use when a ticket adds or changes Go code and it must follow the repo's Go conventions — idiomatic Go (Effective Go), explicit error handling and wrapping, small interfaces, correct pointer-receiver rules, goroutines with an owner and an exit, and table-driven tests run with the race detector; go vet / staticcheck / golangci-lint clean. Invoke for "add this in Go", "fix the go vet/build issues", "add the handler/service", "fix the goroutine leak", or as the language pack for any Go change or Go review.
stack: [go]
area: language
---

# Write idiomatic Go

Go rewards plain code: every error checked and wrapped, small interfaces, goroutines
that always end. For the builder and the reviewer of a Go diff; the repo's config and existing code win over it.

## Procedure

1. **Discover the repo's conventions first.** Call `search_lore` for Go conventions.
   Read `go.mod` (the `go` directive gates features: per-iteration loop variables need
   ≥ 1.22, `wg.Go` and `testing/synctest` ≥ 1.25), `go.work`, `.golangci.yml` (v2 files
   start `version: "2"`), `staticcheck.conf`, the `Makefile`, and the CI workflow. Open
   the nearest sibling package and its `_test.go` and copy their layout, error style,
   logging (`log/slog` or the repo's logger) and test helpers. Never hand-edit a file
   headed `// Code generated … DO NOT EDIT.`; change its source and run `go generate`.
2. **Pin the exact commands** from CI or the `Makefile` (the `run-tests` and `run-lint`
   skills). Use the defaults below only when the repo defines none.
3. **Write the change with the idioms below**, then walk the concurrency section for
   every goroutine, shared value, file and outbound call you touched.
4. **Test each acceptance criterion's own behaviour.** One test (or `t.Run` case) per AC
   that fails without your change, plus its error path — table-driven with `t.Run`, and
   `t.Helper()` in assertion helpers. If the AC involves shared state
   or persistence, add a test that runs N goroutines against it concurrently under
   `-race` and asserts the invariant (no lost update, no error, exactly one winner).
5. **Verify, then stop.** Done when: `gofmt -l .` prints nothing, build/vet/lint are clean
   at the repo's configuration, `go test -race` is green, `go mod tidy -diff` is empty, and
   every AC has a test. Record the output with the `record-evidence` skill; the runner
   submits the work.

## Commands

- Format: `gofmt -l .` (or `goimports -l .`) must print nothing.
- Build and vet: `go build ./...` and `go vet ./...`.
- Lint: `golangci-lint run ./...` when configured, else `staticcheck ./...` when configured.
- Test: `go test -race -count=1 ./...`; one case: `go test -race -run 'TestX/case' ./pkg/x`.
- Dependencies: `go mod tidy -diff` (Go 1.23+) reports drift without rewriting
  `go.mod`/`go.sum`. Never `go get` or let `go mod tidy` add a module: a new or bumped
  dependency is a blocker (the `dependency-upgrade` skill). `govulncheck ./...` if
  installed.
- Do not run `go fix ./...` (Go 1.26 modernizers) across the tree unless the ticket asks;
  it rewrites unrelated code.

## Idioms that matter

- **Errors are values.** Check every one; return early; wrap with context of what you
  were doing: `fmt.Errorf("load config %s: %w", path, err)`. Match with
  `errors.Is`/`errors.As`, never `==` or string comparison. Handle an error once:
  log it or return it, not both. `panic` only for programmer errors.
- **Interfaces**: small, defined where they are consumed; accept interfaces, return
  concrete types; no interface with one implementation "for later".
- **`context.Context`** is the first parameter (`ctx`) of anything that blocks or does
  I/O, is never stored in a struct, and is passed down, not replaced with
  `context.Background()` mid-request.
- **Receivers**: pointer receivers when the method mutates or the type holds a mutex or
  is large; keep one kind across a type's method set.
- **Names**: initialisms upper-case (`ID`, `URL`), no stutter (`user.Service`, not
  `user.UserService`), no `util`/`common` packages.

## Concurrency and resource safety

- **Every goroutine has an owner and an exit.** Start it under `errgroup.WithContext` or a
  `sync.WaitGroup` (`wg.Go` on 1.25+, otherwise `wg.Add` *before* `go`, never inside the
  goroutine), and make it return on `ctx.Done()`. A send on an unbuffered channel whose
  receiver has timed out blocks forever: buffer it or `select` on `ctx.Done()`.
- **Maps are not safe for concurrent writes** (the runtime aborts the process). Guard shared
  maps and slices with a `sync.Mutex`; never copy a struct that contains one (`go vet`
  copylocks).
- **Read-modify-write under one critical section.** A `Load` then a separate `Store`, or
  two lock scopes around read and write, loses updates. Use one lock across the whole
  operation, `atomic.Int64`/CompareAndSwap, or a database transaction/version check.
- **Files other requests read**: `os.WriteFile` is not atomic. Write to
  `os.CreateTemp(filepath.Dir(dst), ".name-*")` (unique name, same filesystem), `Sync`,
  check the `Close` error, then `os.Rename`. Never a fixed temp name or one built from a
  timestamp or PID.
- **Cross-process locks** use an OS lock or the database. A lease that expires on
  wall-clock time alone lets a paused holder write after another took over; the write
  must check a fencing token or version.
- **Close what you open**: `defer resp.Body.Close()` after the error check, `rows.Close()`
  plus `rows.Err()`, `defer cancel()` for every `WithTimeout`/`WithCancel` (vet
  lostcancel), `ticker.Stop()`. A `defer` inside a loop runs only at function return:
  extract the loop body.
- **Outbound HTTP** needs a timeout (`http.Client{Timeout: …}` or a deadline on the
  request context); `http.DefaultClient` has none. Servers set `ReadHeaderTimeout`.
- **Aliasing**: `append` may write into a caller's backing array; `slices.Clone` before
  retaining or mutating a slice you were given.

## Review checklist — flag as defects

Walk this against the diff. An item is grounds for CHANGES only when, in changed code, it
causes a concrete failure (wrong result, crash, lost or corrupted data, security hole) or
leaves an AC's own behaviour untested: cite the line and that failure. Otherwise it is an
`(optional)` note. Formatting the tools would fix, and preferences the repo
does not enforce, are not findings. Do not patch the code under review.

- [ ] An `error` is ignored, assigned to `_` without a reason, or shadowed by `:=` in an
      inner scope so the outer function returns nil.
- [ ] An error is wrapped with `%v` (or compared with `==`) where callers use
      `errors.Is`/`errors.As`.
- [ ] A function returns a typed nil pointer as `error`, so `err != nil` is true.
- [ ] A goroutine has no exit path or owner, `wg.Add` runs inside the goroutine, or a
      fan-out is unbounded.
- [ ] A map, slice or struct is written from more than one goroutine without a lock, or a
      read-modify-write is split across lock scopes.
- [ ] A body, rows, file or ticker is not closed; a writable file's `Close` error is
      ignored; a cancel func is dropped; `defer` accumulates in a loop.
- [ ] `context.Background()` replaces the request context, or a context is stored in a struct.
- [ ] A shared file is overwritten in place or through a fixed temp name; a lock relies on
      a time-only lease with no fencing check.
- [ ] An outbound call has no timeout.
- [ ] A generated file was edited by hand, or `go.mod`/`go.sum` are not tidy.
- [ ] An AC has no test, the test does not reach the AC's code path, or a concurrency AC
      has no concurrent test run with `-race`.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**A Go convention this repo enforces beyond the obvious — an error-wrapping pattern, a package-boundary rule, a concurrency invariant, or a linter constraint.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
