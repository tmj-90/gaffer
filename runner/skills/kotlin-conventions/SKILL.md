---
name: kotlin-conventions
description: Use when a ticket adds or changes Kotlin code — Android, Ktor/Spring services, multiplatform modules — and it must follow the repo's Kotlin conventions — null-safety without !!, immutability by default, coroutines and Flow used correctly, sealed hierarchies for state, detekt/ktlint clean — as the language pack for any Kotlin change. Invoke for "write this in Kotlin", "fix the coroutine leak", "remove the !!", or when reviewing a Kotlin diff.
stack: [kotlin, android, jvm]
area: language
---

# Write idiomatic Kotlin

Kotlin's value is safety made concise: nullability in the type, immutability by default,
structured concurrency that cannot leak. Code that reaches for `!!`, `var`, `lateinit`,
and `GlobalScope` throws that value away. Match the module's conventions and keep
detekt/ktlint clean as CI runs them.

## Steps

1. **Read the module's conventions.** Android vs server vs multiplatform; the DI
   framework (Hilt/Koin/Spring); coroutine dispatcher injection; the architecture
   pattern (MVVM/MVI with `StateFlow`, or a service layer); the style checker config.
   Call `search_lore`; copy a sibling's shape.
2. **Design with types.** `data class` for values, `sealed interface`/`class` for
   closed state and results, `enum class` for fixed sets, `value class` for ids and
   units, `object` for singletons; exhaustive `when` over sealed types with no `else`
   branch so a new case fails to compile.
3. **Null-safety without shortcuts.** Non-null types by default; `?.`, `?:`, `let`,
   `requireNotNull` with a message at boundaries; never `!!` outside a proven-impossible
   case with a comment; avoid `lateinit` except for framework-injected fields.
4. **Immutable by default.** `val` and read-only collections (`List`, `Map`) in APIs;
   mutate locally with `buildList`/`mutableListOf` and expose the read-only view;
   `copy()` on data classes for updates.
5. **Coroutines with structure.** Every coroutine has a scope that ends (`viewModelScope`,
   `lifecycleScope`, a service's `CoroutineScope` with a `SupervisorJob` that is
   cancelled on shutdown); never `GlobalScope`; inject dispatchers for testability;
   `withContext(Dispatchers.IO)` for blocking work; `Flow` for streams with
   `flowOn`/`catch`/`collectLatest` used deliberately; `runBlocking` only in `main` and
   tests.
6. **Errors as values where they are expected.** A sealed `Result`-style hierarchy or
   `kotlin.Result` for expected failures; exceptions for bugs and boundary translation;
   never swallow `CancellationException`.
7. **Android specifics** when relevant: `StateFlow` for UI state, one-shot events via
   channels or `SharedFlow` with replay 0, `collectAsStateWithLifecycle`, no work in
   `onCreate` beyond wiring, `@Immutable`/`@Stable` where Compose needs them.
8. **Test with the repo's stack**: JUnit5/Kotest, `runTest` with the test dispatcher and
   `Turbine` for flows, MockK where a fake is not available; `./gradlew test detekt
   ktlintCheck` (or the repo's tasks). Evidence with the `record-evidence` skill.

## Review checklist (a Kotlin reviewer must check)

- No `!!`, no unexplained `lateinit`; nullability modelled in types.
- `val` and read-only collections by default; mutation is local.
- Sealed types for state with exhaustive `when` (no `else`).
- Coroutines scoped and cancellable; no `GlobalScope`; dispatchers injected;
  `CancellationException` never swallowed.
- Flows have `catch` and correct `flowOn`; UI state is a `StateFlow`.
- detekt and ktlint clean at the repo's configuration.

## Rules

- Types express nullability and closed sets; `!!` and `else` on sealed `when` are
  defects.
- Immutable APIs; local mutation only.
- Structured concurrency, injected dispatchers, no `GlobalScope`.
- Expected failures as sealed results; exceptions for bugs.
- Style checkers clean as CI runs them.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While matching the module you learn the DI framework, how dispatchers are injected and which state-holder pattern the UI uses.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
