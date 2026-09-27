---
name: swift-conventions
description: Use when a ticket adds or changes Swift code — iOS/macOS apps, SwiftUI or UIKit, server-side Swift — and it must follow the repo's Swift conventions — value types and protocols, optionals handled without force-unwraps, Swift concurrency (async/await, actors) used correctly, SwiftLint clean — as the language pack for any Swift change. Invoke for "build this screen in SwiftUI", "fix the retain cycle", "remove the force unwraps", or when reviewing a Swift diff.
stack: [swift, ios, macos]
area: language
---

# Write idiomatic Swift

Swift is safest when values are structs, absence is an optional you handle, and
concurrency is structured through async/await and actors. Force-unwraps, implicitly
unwrapped optionals, and ad-hoc dispatch queues are where crashes and races come from.
Match the target's conventions (SwiftUI vs UIKit, the architecture in use) and keep
SwiftLint clean.

## Steps

1. **Read the target's conventions.** Minimum OS, SwiftUI or UIKit, the architecture
   (MVVM with `@Observable`/`ObservableObject`, TCA, VIPER), DI approach, and the
   SwiftLint config. Call `search_lore`; copy a sibling feature's shape.
2. **Prefer value types and protocols.** `struct` and `enum` for models and state,
   `class` only for identity or reference semantics (and `final` unless subclassed);
   protocols with default extensions over inheritance; `enum` with associated values
   for state machines and exhaustive `switch` with no `default` where the enum is
   yours.
3. **Handle optionals honestly.** `if let`/`guard let` with early return, `??` with a
   sensible default, optional chaining; never `!` or `try!` outside an impossibility
   proven in a comment; no implicitly unwrapped optionals except `@IBOutlet`.
4. **Errors as typed throws.** `throws` with an `Error` enum per module and `do/catch`
   at the boundary; `Result` when a failure is a value passed around; never swallow
   with `try?` unless the absence is genuinely acceptable and commented.
5. **Concurrency with structure.** `async/await` and `Task` groups over completion
   handlers and `DispatchQueue`; `@MainActor` for UI state; `actor` for shared mutable
   state; `Sendable` conformance honest, never `@unchecked` without a proof;
   cancellation checked in long loops; no detached tasks without an owner.
6. **Memory and lifecycle.** `[weak self]` in escaping closures held by long-lived
   objects; break cycles between parent/child references; cancel tasks in `deinit` or
   `.task` modifiers; no work in initialisers that can fail silently.
7. **SwiftUI specifics**: small views, state owned at the right level (`@State` local,
   `@Binding` passed down, `@Observable` models injected), `.task` for async work tied to
   view lifetime, no business logic in `body`, previews for every view; UIKit: view
   controllers thin, layout in code or storyboards per the repo, Auto Layout without
   magic numbers.
8. **Test with XCTest/Swift Testing** as the repo does: unit tests for models and view
   models with async test support, UI tests only for critical flows; `swiftlint` and
   `swift build`/`xcodebuild test` on the repo's scheme. Evidence with the
   `record-evidence` skill.

## Review checklist (a Swift reviewer must check)

- No `!`, `try!`, or implicitly unwrapped optionals without a proof comment.
- Value types by default; `final class` where a class is needed.
- Exhaustive `switch` on owned enums; typed errors thrown and handled at boundaries.
- `@MainActor` on UI state; actors for shared state; no `@unchecked Sendable` without
  proof; no stray `DispatchQueue`.
- Escaping closures capture `weak self` where the owner outlives the closure.
- SwiftLint clean; previews present for new views.

## Rules

- Structs and enums first; classes are `final` and have a reason.
- Optionals handled, never force-unwrapped on reachable paths.
- Typed throws and `Result`; `try?` only with a comment.
- Structured concurrency, `@MainActor` UI, honest `Sendable`.
- SwiftLint and the repo's test scheme as CI runs them.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While matching the target you learn the architecture pattern, the DI approach and the concurrency conventions the app relies on.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
