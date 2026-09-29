---
name: kotlin-conventions
description: Use when a ticket adds or changes Kotlin code — Android, Ktor/Spring services, multiplatform modules — and it must follow the repo's Kotlin conventions — the Kotlin coding conventions, null-safety without !!, immutability by default, coroutines and Flow used with structured concurrency and correct cancellation, sealed hierarchies for state, detekt/ktlint clean — as the language pack for any Kotlin change. Invoke for "write this in Kotlin", "fix the coroutine leak", "remove the !!", or when reviewing a Kotlin diff.
stack: [kotlin, android, jvm]
area: language
---

# Write idiomatic Kotlin

Kotlin's value is safety made concise: nullability in the type, immutability by default,
structured concurrency that cannot leak. For the builder and the reviewer of a Kotlin diff; the module's config and existing code win over it.

## Procedure

1. **Discover the module's conventions first.** Call `search_lore` for Kotlin conventions.
   Read `build.gradle.kts`, `gradle/libs.versions.toml` (Kotlin, coroutines, AGP versions),
   `jvmToolchain`, whether `explicitApi()` is on, `.editorconfig` (ktlint reads
   `ktlint_code_style` and rule toggles there), `detekt.yml` and its baseline, and Android
   `lint.xml`. Identify Android vs server vs multiplatform, the DI framework
   (Hilt/Koin/Spring), how dispatchers are injected, and the state pattern (MVVM/MVI with
   `StateFlow`, or a service layer). Copy a sibling class and its test.
2. **Pin the exact commands** from CI (the `run-tests` and `run-lint` skills). Use the
   defaults below only when the repo defines none; never add to a detekt baseline to pass.
3. **Write the change with the idioms below**, then walk the concurrency section for every
   coroutine, flow, shared value and resource you touched.
4. **Test each acceptance criterion's own behaviour.** One test per AC that fails without
   your change, plus its error path, using `runTest` with the test dispatcher and Turbine
   for flows. If the AC involves shared state or persistence, add a test that launches N
   concurrent coroutines on a multi-threaded dispatcher (`Dispatchers.Default`) and
   asserts the invariant.
5. **Verify, then stop.** Done when: ktlint and detekt are clean at the repo's config, the
   compiler reports no new warnings where `allWarningsAsErrors` is set, tests are green,
   and every AC has a test. Record the output with the `record-evidence` skill; the runner
   submits the work.

## Commands

- All checks: `./gradlew check` (runs tests plus wired-in linters).
- Style: `./gradlew ktlintCheck` (ktlint Gradle plugin) or `ktlint "src/**/*.kt"`;
  `./gradlew detekt`.
- Tests: `./gradlew test`; one class: `./gradlew test --tests 'pkg.ClassTest'`.
- Android: `./gradlew lint testDebugUnitTest` (or the repo's variant).
- Dependencies: a new or bumped entry in `libs.versions.toml` or the build file is a
  blocker (the `dependency-upgrade` skill).

## Idioms that matter

- **Types**: `data class` for values, `sealed interface` for closed state and results,
  `enum class` for fixed sets, `@JvmInline value class` for ids and units; exhaustive
  `when` over sealed types with no `else`, so a new case fails to compile.
- **Null-safety**: non-null by default; `?.`, `?:`, `requireNotNull(x) { "why" }` at
  boundaries; no `!!` on reachable paths; `lateinit` only for framework-injected fields.
  Java calls return platform types (`String!`): give them an explicit nullable or
  non-null type at the boundary.
- **Immutability**: `val` and read-only `List`/`Map` in APIs; build with
  `buildList { }` locally; update data classes with `copy()`. A `data class` with `var`
  properties used as a map key or set element breaks lookups when mutated.
- **Preconditions** with `require` (arguments), `check` (state), `error(...)` (unreachable).
- **Resources**: `use { }` on every `Closeable`.
- **Coding conventions** (kotlinlang.org): expression bodies for one-liners, named
  arguments for boolean and same-typed parameters, scope functions (`let`/`apply`/`also`)
  only where they read better than a local.

## Concurrency and resource safety

- **Structured concurrency**: every coroutine runs in a scope that ends
  (`viewModelScope`, `lifecycleScope`, a service scope with a `SupervisorJob` cancelled on
  shutdown). No `GlobalScope`; no `runBlocking` outside `main` and tests.
- **Cancellation is an exception — do not eat it.** `catch (e: Exception)` and
  `runCatching { suspendCall() }` also catch `CancellationException`, so the coroutine
  keeps running after it was cancelled. Rethrow it (or catch narrower types); in loops call
  `ensureActive()`; cleanup that must suspend goes in `withContext(NonCancellable)`.
- **Dispatchers are injected**; blocking I/O uses `withContext(ioDispatcher)`; never block
  `Dispatchers.Main` or `Default`.
- **`async` without `await`** loses its exception until someone awaits; use `launch` for
  fire-and-forget within a scope, and `coroutineScope { }` to fan out and fail together.
- **Shared mutable state**: `MutableStateFlow.value = value + 1` is a lost-update race; use
  `update { it + 1 }`. Guard other state with `kotlinx.coroutines.sync.Mutex` (a
  `synchronized` block cannot contain a suspension point) and hold it across the whole
  read-modify-write; bound fan-out with `Semaphore`.
- **Flows**: `flowOn` for upstream context, `catch` for upstream errors, `stateIn`/`shareIn`
  in a scope that ends; UI collects with `collectAsStateWithLifecycle` or
  `repeatOnLifecycle`; one-shot events via `Channel` or `SharedFlow(replay = 0)`.
- **Files other requests read** (server/JVM): write to
  `Files.createTempFile(targetDir, …)` then `Files.move(…, ATOMIC_MOVE, REPLACE_EXISTING)`;
  never a fixed temp name. Cross-process exclusion uses a file lock or the database; a
  time-only lease lets a paused holder write late, so writes must check a fencing token or
  version.

## Review checklist — flag as defects

Walk this against the diff. An item is grounds for CHANGES only when, in changed code, it
causes a concrete failure (wrong result, crash, lost or corrupted data, security hole) or
leaves an AC's own behaviour untested: cite the line and that failure. Otherwise it is an
`(optional)` note. Formatting the tools would fix, and preferences the repo
does not enforce, are not findings. Do not patch the code under review.

- [ ] `!!` on a reachable path; an unexplained `lateinit`; a Java platform type flowing
      into Kotlin unannotated.
- [ ] `else` on a `when` over a sealed type the module owns.
- [ ] `GlobalScope`, a scope never cancelled, or `runBlocking` in production code.
- [ ] `CancellationException` swallowed by `catch (e: Exception)` or `runCatching` around
      suspend calls.
- [ ] Blocking I/O on Main/Default; a hard-coded dispatcher where the module injects them.
- [ ] A read-modify-write on shared state (`StateFlow.value`, a map, a counter) without
      `update`, a `Mutex` or an atomic; a check-then-act across a suspension point.
- [ ] A `Closeable` not in `use { }`; a flow collected outside a lifecycle-aware scope.
- [ ] A shared file written in place or via a fixed temp name; a time-only lock lease.
- [ ] Mutable collections or `var`s exposed from a public API.
- [ ] A new detekt/ktlint suppression or baseline entry without a reason.
- [ ] An AC has no test, or a coroutine test uses real delays or `Thread.sleep` instead
      of the test dispatcher.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While matching the module you learn the DI framework, how dispatchers are injected and which state-holder pattern the UI uses.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
