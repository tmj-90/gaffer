---
name: java-conventions
description: Use when a ticket adds or changes Java code and it must follow the repo's Java conventions — Effective Java, modern Java (records, sealed types, pattern matching, switch expressions), Optional discipline, immutability, try-with-resources, thread safety and virtual threads, Spring Boot constructor injection, and JUnit 5 + Mockito tests. Invoke for "add this in Java", "fix the Java build", "add a Spring endpoint/service", or as the language pack for any Java change or Java review.
stack: [java]
area: language
---

# Write idiomatic, modern Java

Java stays correct when data is immutable, resources close themselves, absence is typed
and shared state is guarded. For the builder and the reviewer of a Java diff; the repo's config and existing code win over it.

## Procedure

1. **Discover the repo's conventions first.** Call `search_lore` for Java conventions.
   Read the build file (`pom.xml` `maven.compiler.release`, or `build.gradle(.kts)`
   toolchain) for the Java version — features below are gated on it — and the wrapper
   (`mvnw`/`gradlew`: always use it). Find the style and analysis tools: Spotless /
   google-java-format, Checkstyle, Error Prone + NullAway, SpotBugs, PMD, and the
   nullness annotations in use (JSpecify `@NullMarked`, JetBrains, jakarta). Note whether
   the repo uses Lombok (`lombok.config`) — follow the repo, do not mix styles. Copy a
   sibling class and its test.
2. **Pin the exact commands** from CI (the `run-tests` and `run-lint` skills). Use the
   defaults below only when the repo defines none.
3. **Write the change with the idioms below**, then walk the concurrency section for
   every executor, shared field, stream, connection and file you touched.
4. **Test each acceptance criterion's own behaviour.** One JUnit 5 test (or
   `@ParameterizedTest` case) per AC that fails without your change, plus its error path.
   If the AC involves shared state or persistence, add a test that runs N concurrent
   callers (an `ExecutorService` plus a `CountDownLatch` start gate) and asserts the
   invariant. Use Testcontainers for real databases where the repo does.
5. **Verify, then stop.** Done when: the formatter check and static analysis are clean, the
   build's verify/check goal is green with the repo's coverage gate, and every AC has a
   test. Record the output with the `record-evidence` skill; the runner submits the work.

## Commands

- Maven: `./mvnw -B verify` (compile, tests, coverage, checks); one test:
  `./mvnw -Dtest='ClassTest#method' test`; format: `./mvnw spotless:check`.
- Gradle: `./gradlew check` (or `build`); one test: `./gradlew test --tests 'pkg.ClassTest'`;
  format: `./gradlew spotlessCheck`; coverage: `./gradlew jacocoTestReport`.
- Dependencies: a new or bumped dependency is a blocker, not an edit to the build file
  (the `dependency-upgrade` skill); `./gradlew dependencies` or `./mvnw dependency:tree`
  shows what is already on the classpath.

## Idioms that matter

- **Records** (16+) for data carriers; validate and defensively copy in the compact
  constructor (`items = List.copyOf(items);`) — a record holding a mutable list or array
  leaks its state.
- **Sealed interfaces + pattern-matching `switch`** (21+) for closed hierarchies, with no
  `default` branch so a new subtype fails to compile.
- **Minimise mutability** (Effective Java 17): `final` fields, `List.of`/`copyOf`, no
  setters on value types; favour composition over inheritance (18).
- **`Optional`** as a return type for "may be absent" (55); never `.get()` without a
  guard (use `orElseThrow`/`map`/`orElseGet`), never for fields or parameters; return
  empty collections, not `null` (54).
- **Nullness**: honour the repo's annotations; `Objects.requireNonNull` at public boundaries.
- **Exceptions**: never ignore one (77); rethrow with the cause
  (`new ServiceException("…", e)`); catch specific types; restore the interrupt flag
  (`Thread.currentThread().interrupt()`) when catching `InterruptedException`.
- **`equals` and `hashCode` together** (11); compare strings and boxed numbers with
  `equals`, never `==`; `BigDecimal` with `compareTo`.
- **Spring**: constructor injection (no field `@Autowired`); thin controllers; `@Valid` +
  Bean Validation on request bodies; `@Transactional` does not apply to self-invocation.
- **Logging**: SLF4J parameterised (`log.info("claimed {}", id)`); no secrets or PII.

## Concurrency and resource safety

- **try-with-resources** for every `AutoCloseable`: streams, readers, JDBC connections,
  `Files.lines`/`Files.walk` streams, and `ExecutorService` (19+).
- **Spring beans are singletons**: a mutable instance field in a `@Service`/`@Controller`
  is shared by every request thread. Keep beans stateless or guard the state.
- **Atomic compound operations**: `ConcurrentHashMap` check-then-put is a race; use
  `compute`/`merge`/`putIfAbsent`; counters use `AtomicLong`/`LongAdder`; a
  read-modify-write holds one lock throughout. `HashMap`, `ArrayList` and
  `SimpleDateFormat` are not thread-safe.
- **Lost updates in the database**: read-modify-write of a row needs `@Version` optimistic
  locking, `SELECT … FOR UPDATE`, or an atomic `UPDATE … SET n = n + 1`.
- **Files other requests read**: write to `Files.createTempFile(targetDir, "x", ".tmp")`
  (unique, same filesystem), then `Files.move(tmp, target, ATOMIC_MOVE, REPLACE_EXISTING)`.
  Cross-process exclusion uses `FileChannel.lock()` or the database; a time-only lease lets
  a paused holder write late, so writes must verify a fencing token or version.
- **Virtual threads** (21+): `Executors.newVirtualThreadPerTaskExecutor()` in
  try-with-resources; never pool them; limit concurrency to a downstream with a
  `Semaphore`, not a pool size; avoid heavy `ThreadLocal` caches. Before JDK 24
  (JEP 491), blocking inside `synchronized` pins the carrier — prefer `ReentrantLock`
  around blocking I/O on 21–23.
- **`CompletableFuture`**: pass an explicit executor (the common pool is shared and small);
  join or handle every future so exceptions are not lost; set timeouts (`orTimeout`).
- **Outbound HTTP** has connect and request timeouts (`HttpClient`, `RestClient`,
  `WebClient` configuration).

## Review checklist — flag as defects

Walk this against the diff. An item is grounds for CHANGES only when, in changed code, it
causes a concrete failure (wrong result, crash, lost or corrupted data, security hole) or
leaves an AC's own behaviour untested: cite the line and that failure. Otherwise it is an
`(optional)` note. Formatting the tools would fix, and preferences the repo
does not enforce (Lombok versus records in a Lombok codebase), are not findings. Do not
patch the code under review.

- [ ] An empty or log-and-continue `catch`; a cause dropped on rethrow; an
      `InterruptedException` swallowed without restoring the flag.
- [ ] `Optional.get()` without a guard; `null` returned where the API promises a value or
      a collection.
- [ ] A resource not in try-with-resources (stream, connection, `Files.lines`, executor).
- [ ] Mutable state in a singleton bean, or a shared non-thread-safe collection/formatter.
- [ ] A check-then-act on a concurrent map, or a read-modify-write (in memory or on a
      row) without a lock, atomic operation or version check.
- [ ] A shared file written in place or via a fixed temp name; a time-only lock lease.
- [ ] A record exposing a mutable component without a defensive copy; `equals` without
      `hashCode`; `==` on strings or boxed values.
- [ ] A switch over a sealed type with a `default` that hides a missing case.
- [ ] Field injection, unvalidated request bodies, or secrets/PII in logs.
- [ ] A `CompletableFuture` never joined, on the common pool for blocking work, or without
      a timeout; an outbound call without timeouts.
- [ ] An AC has no test, or the test mocks away the behaviour the AC describes.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**A Java convention this repo enforces beyond the obvious — a target version constraint, an immutability or layering rule, a build/formatter gotcha, or a Spring wiring pattern.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
