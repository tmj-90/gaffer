---
name: csharp-conventions
description: Use when a ticket adds or changes C#/.NET code — ASP.NET Core services, libraries, workers — and it must follow the repo's C# conventions — the .NET coding conventions, nullable reference types on and honoured, async all the way with cancellation tokens, dependency injection through the container with correct lifetimes, records for values, IDisposable and thread safety handled, Roslyn analyzers and dotnet format clean — as the language pack for any C# change. Invoke for "add this in C#", "fix the async void", "the nullable warnings", or when reviewing a .NET diff.
stack: [csharp, dotnet, aspnet]
area: language
---

# Write idiomatic modern C#

Modern C# puts nullability in the type system, values in records, and asynchrony in a
first-class model with cancellation. Code that suppresses warnings, blocks on tasks, or
news up its dependencies gives that back. For the builder and the reviewer of a .NET diff; the solution's config and existing code win over it.

## Procedure

1. **Discover the solution's conventions first.** Call `search_lore` for .NET conventions.
   Read `global.json` (SDK pin), `Directory.Build.props` and `Directory.Packages.props`
   (central package versions; a new or bumped package is a blocker, see the
   `dependency-upgrade` skill), the `.csproj`
   (`TargetFramework`, `LangVersion`, `Nullable`, `TreatWarningsAsErrors`,
   `AnalysisLevel`/`AnalysisMode`, `ImplicitUsings`), `.editorconfig` (naming and
   diagnostic severities), `.config/dotnet-tools.json`, and the CI workflow. Identify the
   test framework (xUnit v2/v3, NUnit, MSTest), assertion and mocking libraries, the
   error policy (exceptions vs a `Result` type) and minimal APIs vs controllers. Copy a
   sibling class and its test.
2. **Pin the exact commands** from CI (the `run-tests` and `run-lint` skills). Use the
   defaults below only when the repo defines none.
3. **Write the change with the idioms below**, then walk the concurrency section for every
   task, disposable, shared field, `DbContext` and outbound call you touched.
4. **Test each acceptance criterion's own behaviour.** One test (or `[Theory]` row) per AC
   that fails without your change, plus its error path; `WebApplicationFactory` for API
   behaviour. If the AC involves shared state or persistence, add a test that runs N
   concurrent calls (`Task.WhenAll` over `Enumerable.Range`) and asserts the invariant.
   Use `TimeProvider`/`FakeTimeProvider` instead of real delays.
5. **Verify, then stop.** Done when: the build has no new warnings at the configured
   level, `dotnet format --verify-no-changes --no-restore` is clean, tests are green, and every AC has
   a test. Record the output with the `record-evidence` skill; the runner submits the work.

## Commands

- Build: `dotnet build --no-restore` against the already-restored packages (add
  `-warnaserror` if CI does); a failed restore is an environment problem to report, not
  a package install to attempt.
- Format and style analyzers: `dotnet format --verify-no-changes --no-restore`.
- Test: `dotnet test --no-build`; one test: `dotnet test --no-build --filter
  "FullyQualifiedName~ClassName.Method"` (VSTest), or the xUnit v3 / Microsoft.Testing.Platform
  options (`dotnet test --no-build … --filter-method`) when the repo runs on MTP; without
  `--no-build`, `dotnet test` restores and can download packages.
- Dependencies: `dotnet list package --vulnerable --include-transitive` to inspect; never
  `dotnet add package` or `dotnet tool restore`.

## Idioms that matter

- **Nullable reference types**: `<Nullable>enable</Nullable>` honoured; `?` only where
  absence is real; `ArgumentNullException.ThrowIfNull` at public boundaries; no `!`
  (null-forgiving) or `default!` without a proven reason; `[NotNullWhen]` on try-pattern
  methods.
- **Types**: `record`/`record struct` for values, `required` and `init` members instead of
  mutable DTOs, pattern matching and switch expressions over casts, enums for fixed sets.
- **Async naming and shape**: methods returning `Task` end in `Async`; `async Task`, never
  `async void` outside event handlers; a `CancellationToken` parameter threaded through
  and passed to every call; `ValueTask` only with a measured reason.
- **DI**: constructor (or primary-constructor) injection of registered services;
  `IOptions<T>` bound from a typed section; no service locator or `new` for collaborators.
- **Errors**: specific exception types; never catch `Exception` to swallow; don't treat
  `OperationCanceledException` as a failure; `ProblemDetails` for API errors.
- **Logging**: message templates (`logger.LogInformation("Claimed {TicketId}", id)`), not
  interpolated strings; no secrets or PII.
- **Naming** (.NET conventions): PascalCase types and members, camelCase locals and
  parameters, `_camelCase` private fields, `I` prefix for interfaces — or the repo's
  `.editorconfig` rules.

## Concurrency and resource safety

- **Never block on async**: `.Result`, `.Wait()` and `GetAwaiter().GetResult()` cause
  thread-pool starvation and deadlocks. Await it.
- **Fire-and-forget loses exceptions**: `_ = DoAsync();` in a request dies with the
  request scope. Hand background work to a `BackgroundService`/channel with its own scope.
- **Dispose what you own**: `using`/`await using` for streams, `DbContext` you create,
  `SemaphoreSlim`, `CancellationTokenSource`. Use `IHttpClientFactory`/typed clients; a
  new `HttpClient` per call exhausts sockets. Outbound calls have timeouts.
- **Lifetimes**: a scoped service (e.g. `DbContext`) captured by a singleton is a captive
  dependency shared across requests; `DbContext` is not thread-safe — no parallel
  operations on one instance.
- **Locks and async**: `lock` cannot contain `await`; use `SemaphoreSlim(1, 1)` with
  `try`/`finally { Release(); }`. Hold one lock across the whole read-modify-write.
  `ConcurrentDictionary.GetOrAdd` may run the factory twice; wrap costly values in `Lazy<T>`.
  Mutable `static` state and singleton fields are shared by all requests.
- **Lost updates in the database**: read-modify-write of a row needs a concurrency token
  (`[Timestamp]`/`rowversion`, `IsConcurrencyToken`) and handling of
  `DbUpdateConcurrencyException`, or an atomic `ExecuteUpdateAsync`.
- **Files other requests read**: write to `Path.Combine(dir, Path.GetRandomFileName())`
  (unique, same volume), flush, then `File.Move(tmp, target, overwrite: true)` or
  `File.Replace`. Cross-process exclusion uses `FileShare.None`, a named mutex or the
  database; a time-only lease lets a paused holder write late, so writes must check a
  version.
- **Time**: `DateTimeOffset.UtcNow` or an injected `TimeProvider`, not `DateTime.Now`.

## Review checklist — flag as defects

Walk this against the diff. An item is grounds for CHANGES only when, in changed code, it
causes a concrete failure (wrong result, crash, lost or corrupted data, security hole) or
leaves an AC's own behaviour untested: cite the line and that failure. Otherwise it is an
`(optional)` note. Formatting the tools would fix, and preferences the repo
does not enforce, are not findings. Do not patch the code under review.

- [ ] A new nullable warning, `#pragma warning disable`, `!` or `default!` without a reason;
      `Nullable` or analyzer levels lowered.
- [ ] `async void`; `.Result`/`.Wait()`; a discarded task; a `CancellationToken` accepted but
      not passed on.
- [ ] A disposable not disposed; `new HttpClient()` per call; an outbound call without a timeout.
- [ ] A scoped service captured by a singleton; a `DbContext` used concurrently; mutable
      static or singleton state without synchronisation.
- [ ] `await` needed inside a critical section but a `lock` used, or a read-modify-write
      (memory or row) without a lock, atomic update or concurrency token.
- [ ] A shared file written in place or via a fixed temp name; a time-only lock lease.
- [ ] `catch (Exception)` that swallows; cancellation logged as an error.
- [ ] Interpolated strings in log calls; secrets or PII logged.
- [ ] A package version added outside central package management when the repo uses it.
- [ ] An AC has no test, or the test replaces the behaviour under test with a mock.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While matching the solution you learn the analyzer set, the DI lifetimes and the result-versus-exception policy.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
