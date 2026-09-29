---
name: swift-conventions
description: Use when a ticket adds or changes Swift code — iOS/macOS apps, SwiftUI or UIKit, server-side Swift — and it must follow the repo's Swift conventions — the Swift API Design Guidelines, value types and protocols, optionals handled without force-unwraps, Swift 6 strict concurrency (async/await, actors, Sendable) used correctly, SwiftLint/swift-format clean — as the language pack for any Swift change. Invoke for "build this screen in SwiftUI", "fix the retain cycle", "remove the force unwraps", "fix the Sendable/data-race errors", or when reviewing a Swift diff.
stack: [swift, ios, macos]
area: language
---

# Write idiomatic Swift

Swift is safest when values are structs, absence is an optional you handle, and
concurrency is checked by the compiler through actors and `Sendable`. For the builder and the reviewer of a Swift diff; the target's settings and existing code win over it.

## Procedure

1. **Discover the target's conventions first.** Call `search_lore` for Swift conventions.
   Read `Package.swift` (`swift-tools-version`, `swiftLanguageModes`, `swiftSettings`
   such as upcoming features or `defaultIsolation(MainActor.self)`), or the Xcode build
   settings (`SWIFT_VERSION`, `SWIFT_STRICT_CONCURRENCY`, `SWIFT_DEFAULT_ACTOR_ISOLATION`,
   approachable-concurrency flags), `project.yml` (XcodeGen/Tuist), `.swiftlint.yml`,
   `.swift-format`, and the minimum OS. The language mode decides the rules: in Swift 6
   mode data-race diagnostics are errors; with default MainActor isolation (6.2) code is
   main-actor unless marked otherwise. Identify SwiftUI vs UIKit, the architecture
   (`@Observable` MVVM, TCA), and XCTest vs Swift Testing. Copy a sibling feature and test.
2. **Pin the exact commands** from CI, `Makefile` or fastlane (the `run-tests` and
   `run-lint` skills), including the scheme and simulator destination. Use the defaults
   below only when the repo defines none.
3. **Write the change with the idioms below**, then walk the concurrency section for every
   task, actor, closure, file and shared object you touched.
4. **Test each acceptance criterion's own behaviour.** One test per AC that fails without
   your change, plus its error path (`@Test(arguments:)` for tables). If the AC involves
   shared state or persistence, add a test that runs N concurrent calls in a
   `withTaskGroup` and asserts the invariant.
5. **Verify, then stop.** Done when: the build has no new warnings in the configured
   language mode, SwiftLint/swift-format are clean, tests are green on the repo's
   destination, and every AC has a test. Record the output with the `record-evidence`
   skill; the runner submits the work.

## Commands

- SwiftPM: `swift build` and `swift test` (one test: `swift test --filter Suite/test`).
  Never `swift package update` or edit `Package.resolved`; a new or bumped package is a
  blocker (the `dependency-upgrade` skill).
- Xcode: `xcodebuild -list`, then `xcodebuild test -scheme <Scheme> -destination
  '<CI destination>'`.
- Lint: `swiftlint lint --strict` (if configured); `swift format lint --strict
  --recursive Sources Tests` (swift-format ships with the Swift 6 toolchain).

## Idioms that matter

- **API Design Guidelines**: clarity at the point of use; name by role, not type; omit
  needless words; argument labels that read as phrases (`insert(_:at:)`); mutating/
  non-mutating pairs `sort()`/`sorted()`; Booleans read as assertions (`isEmpty`); a
  documentation comment on every public declaration; note complexity when a computed
  property is not O(1).
- **Value types first**: `struct`/`enum` for models and state; `class` only for identity,
  and `final` unless designed for subclassing; protocols with extensions over inheritance.
- **Optionals**: `guard let` with early return, `??` with a real default, optional
  chaining. No `!`, `try!` or implicitly unwrapped optionals on reachable paths (only
  `@IBOutlet`).
- **Errors**: `throws` with a module error enum (typed `throws(MyError)` where the repo uses
  it), handled at the boundary; `try?` only where absence is acceptable, with a comment.
- **Exhaustive `switch`** on enums the module owns, with no `default`.
- **SwiftUI**: small views; state owned at the right level (`@State` local, `@Binding`
  down, `@Observable` models injected); `.task` for async work tied to view lifetime; no
  side effects in `body`.

## Concurrency and resource safety

- **Isolation is the lock.** UI state is `@MainActor`; shared mutable state lives in an
  `actor`. `Sendable` conformances are honest: no `@unchecked Sendable`,
  `nonisolated(unsafe)` or `MainActor.assumeIsolated` without a written proof.
- **Actor reentrancy**: an actor method that awaits can be interleaved with other calls on
  the same actor, so state read before an `await` may be stale after it — a lost update
  inside an actor. Re-check invariants after each `await`, or finish the read-modify-write
  synchronously before suspending, or dedupe in-flight work with a stored `Task`.
- **Unstructured tasks** (`Task { }`, `Task.detached`) are not cancelled with their creator:
  keep the handle and cancel it (in `deinit`, `onDisappear`, or by using `.task`). Prefer
  `async let` and task groups. Long loops call `try Task.checkCancellation()`.
- **Offloading work**: CPU-heavy or blocking work does not run on the main actor; mark it
  `@concurrent` (6.2) or move it to a non-main actor. Never `DispatchQueue.main.sync`
  from the main thread; never block a task on a semaphore waiting for another task.
- **Continuations** (`withCheckedThrowingContinuation`) resume exactly once on every path.
- **Memory**: `[weak self]` in escaping closures stored by objects that `self` owns
  (timers, observers, publishers); break parent/child reference cycles; `defer` to release
  resources.
- **Files other readers use**: write with `data.write(to: url, options: .atomic)` (temp file
  plus rename) or `FileManager.replaceItemAt`; never a fixed temp name. Cross-process
  exclusion needs a file lock or the database; a time-only lease lets a suspended holder
  write late, so writes must check a version.

## Review checklist — flag as defects

Walk this against the diff. An item is grounds for CHANGES only when, in changed code, it
causes a concrete failure (wrong result, crash, lost or corrupted data, security hole) or
leaves an AC's own behaviour untested: cite the line and that failure. Otherwise it is an
`(optional)` note. Formatting the tools would fix, and preferences the repo
does not enforce, are not findings. Do not patch the code under review.

- [ ] `!`, `try!` or an implicitly unwrapped optional on a reachable path; `try?` silently
      discarding an error the caller needed.
- [ ] `@unchecked Sendable`, `nonisolated(unsafe)` or a lowered strict-concurrency setting
      without a proof; UI state mutated off the main actor.
- [ ] Actor state read before an `await` and written after it without re-checking.
- [ ] An unstructured `Task` never cancelled; missing cancellation checks in long work.
- [ ] Blocking or heavy work on the main actor; `DispatchQueue.main.sync` or a semaphore
      wait inside async code; a continuation resumed zero or two times.
- [ ] A reference cycle through an escaping closure or delegate held strongly.
- [ ] A shared file written in place or via a fixed temp name; a time-only lock lease.
- [ ] `default` on a `switch` over an enum the module owns, hiding a future case.
- [ ] A new SwiftLint `disable` without a reason.
- [ ] An AC has no test, or an async test waits with sleeps instead of awaiting or
      `confirmation`/expectations.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While matching the target you learn the architecture pattern, the DI approach and the concurrency conventions the app relies on.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
