---
name: csharp-conventions
description: Use when a ticket adds or changes C#/.NET code — ASP.NET Core services, libraries, workers — and it must follow the repo's C# conventions — nullable reference types on and honoured, async all the way with cancellation tokens, dependency injection through the container, records for values, analyzers clean — as the language pack for any C# change. Invoke for "add this in C#", "fix the async void", "the nullable warnings", or when reviewing a .NET diff.
stack: [csharp, dotnet, aspnet]
area: language
---

# Write idiomatic modern C#

Modern C# gives you nullability in the type system, records for values, pattern
matching, and a first-class async model. Code that turns warnings off, blocks on tasks,
or news up its dependencies gives that back. Match the solution's conventions and keep
the analyzers clean at the level the build enforces.

## Steps

1. **Read the solution's conventions.** Target framework and language version,
   `Nullable` and `TreatWarningsAsErrors` settings, the analyzer set (`.editorconfig`,
   StyleCop, Roslyn analyzers), the DI and configuration patterns, the test framework
   (xUnit/NUnit) and mocking library. Call `search_lore`; copy a sibling's shape.
2. **Model with types.** `record` (or `record struct`) for immutable values, `enum` for
   fixed sets, strongly-typed ids over raw `Guid`/`int` where the repo does so,
   `required` members and `init` setters instead of mutable DTOs; pattern matching and
   switch expressions over type checks and casts.
3. **Honour nullable reference types.** `Nullable` enabled and warnings fixed, not
   suppressed; `?` where absence is real; `ArgumentNullException.ThrowIfNull` at public
   boundaries; no `!` null-forgiving operator outside a proven case with a comment.
4. **Async all the way.** `async Task`/`Task<T>` (never `async void` outside event
   handlers), `await` not `.Result`/`.Wait()`, a `CancellationToken` parameter threaded
   through every async method and passed to every call, `ConfigureAwait(false)` in
   library code per the repo's rule, `IAsyncEnumerable` for streams, `ValueTask` only
   with a measured reason.
5. **Depend through the container.** Constructor injection of interfaces registered in
   the composition root with the right lifetime (singleton/scoped/transient — no scoped
   service captured by a singleton); `IOptions<T>` for configuration bound from a typed
   section; no static service locators or `new` for collaborators.
6. **Handle errors the .NET way.** Exceptions for exceptional paths with specific types;
   a `Result`-style type where the repo uses one for expected failures; never catch
   `Exception` to swallow; `ProblemDetails` for API errors; structured logging with
   message templates (`_logger.LogInformation("Claimed {TicketId}", id)`), never
   string interpolation into the log call.
7. **ASP.NET specifics**: minimal APIs or controllers per the repo, model validation at
   the boundary, `[Authorize]` policies not ad-hoc checks, `IHttpClientFactory` for
   outbound calls, `IHostedService`/`BackgroundService` for workers with graceful
   shutdown.
8. **Test with the repo's framework**: arrange/act/assert, `WebApplicationFactory` for
   API tests, fakes over mocks where practical; `dotnet build -warnaserror` (as
   configured), `dotnet format --verify-no-changes`, `dotnet test`. Evidence with the
   `record-evidence` skill.

## Review checklist (a C# reviewer must check)

- Nullable honoured: no suppressed warnings, no unexplained `!`.
- No `async void`, no `.Result`/`.Wait()`; cancellation tokens threaded everywhere.
- DI lifetimes correct; no captured scoped services; no service locators.
- Records for values; `required`/`init` over mutable DTOs.
- Logging uses message templates; exceptions specific and not swallowed.
- Analyzers and `dotnet format` clean at the build's level.

## Rules

- Nullable on and honoured; types model absence.
- Async end to end with cancellation; never block on tasks.
- Constructor injection with correct lifetimes; typed options.
- Records and pattern matching over mutable classes and casts.
- Analyzers, format and tests as CI runs them.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While matching the solution you learn the analyzer set, the DI lifetimes and the result-versus-exception policy.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
