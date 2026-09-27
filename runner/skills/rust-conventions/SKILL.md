---
name: rust-conventions
description: Use when a ticket adds or changes Rust code and it must follow the repo's Rust conventions — ownership and borrowing done right, explicit error handling with Result and typed errors, no needless unsafe or clones, idiomatic traits and iterators, clippy-clean — as the language pack for any Rust change. Invoke for "add this in Rust", "fix the borrow checker error", "remove the unwraps", or when reviewing a Rust diff.
stack: [rust]
area: language
---

# Write idiomatic, safe Rust

Rust rewards code that makes ownership and failure explicit and punishes code that
fights the compiler with clones, `unwrap`, and `unsafe`. Match the crate's existing
structure, let the type system carry invariants, and keep `clippy` and `rustfmt` clean
in the same configuration CI uses.

## Steps

1. **Read the crate's conventions.** Edition, MSRV, error strategy (`thiserror` for
   libraries, `anyhow` at the binary edge, or a hand-rolled enum), async runtime
   (`tokio` vs `async-std`), module layout, and feature flags. Call `search_lore`; copy
   a sibling module's shape.
2. **Model with types.** Newtypes for ids and units, enums for closed sets, `Option`
   for absence, builders or typed state for multi-step construction; make invalid
   states unrepresentable rather than validated at runtime everywhere.
3. **Own and borrow deliberately.** Take `&str`/`&[T]`/`impl AsRef` in APIs, return owned
   values when the caller needs them; avoid `clone()` to appease the borrow checker —
   restructure ownership or use references/`Rc`/`Arc` where sharing is real. Lifetimes in
   signatures only when elision cannot express them.
4. **Handle errors with `Result`.** Library code returns typed errors (`thiserror`
   enums with context); binaries may use `anyhow` with `.context()`; `?` everywhere;
   `unwrap`/`expect` only where impossibility is proven and stated in the `expect`
   message; never `panic!` on user or network input.
5. **Prefer iterators and the standard library.** Iterator chains over index loops;
   `match`/`if let`/`let else` over nested conditionals; `impl Trait` and generics over
   `dyn` unless dynamic dispatch is needed; no `unsafe` without a `// SAFETY:` comment
   proving the invariant and a test.
6. **Async correctly.** No blocking calls in async contexts (`spawn_blocking`);
   `Send` bounds where tasks cross threads; cancellation-safe futures; bounded channels
   and `select!` with care for lost data.
7. **Test in the Rust way.** Unit tests in `#[cfg(test)] mod tests`, integration tests in
   `tests/`, doc tests for public APIs, property tests with `proptest` where inputs are
   wide (the `property-based-test` skill). `cargo test`, `cargo clippy -- -D warnings`
   (or the repo's level), `cargo fmt --check`, and `cargo doc` for public items.
8. **Evidence** with the `record-evidence` skill: the test, clippy and fmt runs.

## Review checklist (a Rust reviewer must check)

- No `unwrap`/`expect` on fallible paths reachable from input; `expect` messages state
  the invariant.
- Errors are typed with context; `?` used; no stringly-typed errors.
- No gratuitous `clone()`; ownership restructured instead.
- `unsafe` has a `// SAFETY:` proof and a test, or does not exist.
- No blocking in async; bounds and cancellation handled.
- Public items documented; clippy and rustfmt clean at the repo's level.

## Rules

- Types carry invariants; enums and newtypes over primitives.
- `Result` and `?`; panics only for proven-impossible states.
- Borrow first, clone with a reason, `Arc` when sharing is real.
- No `unsafe` without proof; no blocking in async.
- Clippy, rustfmt and tests as CI runs them.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While matching the crate you learn its error strategy, its async runtime and its policy on unsafe.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
