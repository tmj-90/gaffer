---
name: rust-conventions
description: Use when a ticket adds or changes Rust code and it must follow the repo's Rust conventions — ownership and borrowing done right, explicit error handling with Result and typed errors, no needless unsafe or clones, idiomatic traits and iterators per the Rust API Guidelines, async/tokio used without blocking or lock-across-await bugs, clippy- and rustfmt-clean — as the language pack for any Rust change. Invoke for "add this in Rust", "fix the borrow checker error", "remove the unwraps", or when reviewing a Rust diff.
stack: [rust]
area: language
---

# Write idiomatic, safe Rust

Rust rewards code that makes ownership and failure explicit and punishes code that
fights the compiler with clones, `unwrap` and `unsafe`. For the builder and the reviewer of a Rust diff; the crate's config and existing code win over it.

## Procedure

1. **Discover the crate's conventions first.** Call `search_lore` for Rust conventions.
   Read `Cargo.toml` (`edition`, `rust-version` MSRV, `[lints]`/`[workspace.lints]`,
   features), `rust-toolchain.toml`, `clippy.toml`, `rustfmt.toml`, `deny.toml`,
   `.cargo/config.toml` and the CI workflow. Identify the error strategy (`thiserror`
   enums in libraries, `anyhow` at the binary edge, or hand-rolled), the async runtime,
   and the policy on `unsafe` (`#![forbid(unsafe_code)]`?). Copy a sibling module and its
   tests.
2. **Pin the exact commands** from CI, `Makefile`/`justfile` or `xtask` (the `run-tests`
   and `run-lint` skills). Use the defaults below only when the repo defines none; match
   CI's feature flags.
3. **Write the change with the idioms below**, then walk the concurrency section for
   every task, lock, channel, file and outbound call you touched.
4. **Test each acceptance criterion's own behaviour.** One test per AC that fails without
   your change, plus its error path. If the AC involves shared state or persistence, add
   a test that spawns N threads or tasks against it and asserts the invariant; use
   `proptest` for wide inputs (the `property-based-test` skill).
5. **Verify, then stop.** Done when: `cargo fmt --check` and clippy are clean at CI's
   level, tests pass with CI's features, public items are documented, and every AC has a
   test. Record the output with the `record-evidence` skill; the runner submits the work.

## Commands

- Format: `cargo fmt --all -- --check`.
- Lint: `cargo clippy --all-targets --all-features -- -D warnings` (or CI's feature set).
- Test: `cargo test --all-features` (or `cargo nextest run` where configured; nextest
  skips doctests, so also run `cargo test --doc`); one test: `cargo test name -- --exact`.
- Docs: `cargo doc --no-deps` with `RUSTDOCFLAGS="-D warnings"` if CI sets it.
- Dependencies: never `cargo add`/`cargo update`; a new or bumped crate is a blocker (the
  `dependency-upgrade` skill). `cargo deny check` where CI runs it.
- Unsafe: `cargo +nightly miri test` for code with `unsafe`, only if the repo uses Miri
  and the nightly toolchain is already installed.

## Idioms that matter

- **Types carry invariants**: newtypes for ids and units, enums for closed sets, `Option`
  for absence, constructors that validate so invalid states cannot be built.
- **Borrow in, own out**: take `&str`, `&[T]`, `impl AsRef<Path>`; return owned values;
  restructure instead of `clone()` to appease the borrow checker; `Arc` only when sharing
  is real.
- **Errors**: `Result` and `?`; library errors are typed (`thiserror`), implement
  `std::error::Error + Send + Sync + 'static`, and carry context; `anyhow::Context` at the
  binary edge. `unwrap`/`expect` only for proven-impossible states, with the invariant in
  the `expect` message; never panic on input from users, files or the network.
- **API Guidelines naming**: `as_` (cheap borrow), `to_` (costly conversion), `into_`
  (consuming); `iter`/`iter_mut`/`into_iter`; derive the common traits (`Debug`, `Clone`,
  `PartialEq`, `Default` where meaningful); document `# Errors`, `# Panics` and `# Safety`
  on public functions.
- **Iterators and pattern matching** over index loops; `let … else` for early return;
  generics/`impl Trait` over `dyn` unless dynamic dispatch is needed.
- **Integer arithmetic** on untrusted values uses `checked_`/`saturating_` methods (release
  builds wrap silently); `as` casts that can truncate use `try_from`.
- **`unsafe`** only with a `// SAFETY:` comment proving each invariant and a test.

## Concurrency and resource safety

- **No blocking in async**: file I/O, `std::thread::sleep`, CPU-heavy work and sync
  clients go through `tokio::task::spawn_blocking` or async equivalents.
- **No lock guard across `.await`**: holding a `std::sync::Mutex` guard over an await can
  deadlock and makes the future `!Send` (clippy `await_holding_lock`). Scope the guard
  so it drops first, or use `tokio::sync::Mutex` when the lock must span the await.
- **Read-modify-write in one critical section**: read, compute and write under the same
  guard, or use atomics/`compare_exchange`; releasing between read and write loses updates.
- **`tokio::select!`** drops the losing branches: only use cancel-safe futures there
  (the tokio docs list which methods are), or pin the future outside the loop.
- **Tasks have owners**: a dropped `JoinHandle` does not cancel the task; keep handles in a
  `JoinSet` or abort them, propagate shutdown with a `CancellationToken`, and bound channels.
- **Files other requests read**: `std::fs::write` is not atomic. Use
  `tempfile::NamedTempFile::new_in(dir)` (unique, same filesystem), write, `sync_all`,
  then `persist(target)`. Flush `BufWriter` explicitly: its `Drop` swallows write errors.
  Cross-process exclusion needs an OS lock or the database; a time-only lease lets a paused
  holder write late, so writes must check a fencing token or version.
- **`RefCell`/`RwLock` re-entry** panics or deadlocks; never re-borrow inside a borrow.

## Review checklist — flag as defects

Walk this against the diff. An item is grounds for CHANGES only when, in changed code, it
causes a concrete failure (wrong result, crash, lost or corrupted data, security hole) or
leaves an AC's own behaviour untested: cite the line and that failure. Otherwise it is an
`(optional)` note. Formatting the tools would fix, and preferences the crate
does not enforce, are not findings. Do not patch the code under review.

- [ ] `unwrap`/`expect`/indexing/`panic!` reachable from external input.
- [ ] An error is discarded (`let _ =` on a `Result`, `.ok()` dropping the cause) or
      stringly typed where callers need to match on it.
- [ ] A lock guard is held across `.await`; blocking I/O runs on the async runtime.
- [ ] A read-modify-write releases its lock between read and write; shared state is
      mutated without synchronisation through `unsafe` or interior mutability.
- [ ] A non-cancel-safe future sits in `select!`; a spawned task is detached with no
      shutdown path; a channel is unbounded on user-driven input.
- [ ] A shared file is written in place or through a fixed temp name; `BufWriter` is not
      flushed; a lock relies on a time-only lease.
- [ ] `unsafe` without a `// SAFETY:` proof and a test.
- [ ] Unchecked arithmetic or truncating `as` on untrusted values.
- [ ] A new `#[allow(clippy::…)]` without a reason, or lints loosened in config.
- [ ] An AC has no test, or the test does not exercise the AC's code path.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While matching the crate you learn its error strategy, its async runtime and its policy on unsafe.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
