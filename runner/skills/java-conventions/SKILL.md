---
name: java-conventions
description: Use when a ticket adds or changes Java code and it must follow the repo's Java conventions — modern Java (records, sealed types, pattern matching, switch expressions), Optional discipline, immutability, Spring Boot constructor injection, and JUnit 5 + Mockito tests. Invoke for "add this in Java", "fix the Java build", "add a Spring endpoint/service", or as the language pack for any Java change.
stack: [java]
area: language
---

# Write idiomatic, modern Java

Add Java that uses the current language toolset, models data immutably, and matches the
repo's existing idioms — provably correct and conventional, not just compiling.

## Steps

1. **Read the lore first.** Call `search_lore` (Memory MCP) for the repo's Java
   conventions and target version, and respect the build config (`pom.xml` /
   `build.gradle`), the formatter (Spotless / google-java-format), and any
   architecture ADRs. Match the Java version the project already compiles against —
   do not assume the newest.
2. **Find a sibling class** and copy its patterns — package layout, naming, error
   handling, how DTOs/entities are modelled, and how tests are organised.
3. **Use modern language features where the version allows.** Prefer **records** for
   data carriers over hand-written getters/setters or Lombok `@Data`/`@Value`/`@Builder`.
   Use **sealed** interfaces + **pattern matching** and **switch expressions** to model
   closed hierarchies exhaustively; use text blocks for multi-line literals.
4. **Discipline with `Optional`.** Represent absence with `Optional` rather than `null`;
   never call `.get()` without an `isPresent()` guard — prefer `.map()`, `.orElseThrow()`,
   `.orElseGet()`. Never use `Optional` for fields or method parameters.
5. **Favour immutability.** Final fields, immutable collections (`List.copyOf`),
   defensive copies at boundaries. Prefer composition over inheritance; extract an
   interface when it improves testability.
6. **Spring Boot idioms (if applicable).** Constructor injection (no field `@Autowired`);
   keep controllers thin and push logic to services; validate request bodies at the
   boundary (`@Valid` + Bean Validation). Log via **SLF4J** (`LoggerFactory.getLogger`) —
   **never log secrets, tokens, or PII**.
7. **Streams over loops** where readability isn't sacrificed; keep methods small and
   single-purpose.
8. **Test with JUnit 5 + Mockito.** Use `@ExtendWith(MockitoExtension.class)`, `@Mock`/
   `@InjectMocks`, AssertJ-style assertions, and cover happy path, edge cases, and error
   conditions. Use Testcontainers for integration tests touching real infrastructure.
9. **Verify + evidence.** Run the build's test goal, record `test_output` via the
   `record-evidence` skill, and submit for review.

## Build / Test

- **Maven:** `mvn test` (unit), `mvn verify` (full, incl. coverage), `mvn package`.
- **Gradle:** `./gradlew test`, `./gradlew jacocoTestReport`, `./gradlew build`.
- The DoD is verified by the repo's configured test/coverage commands — run them and
  record the output; a green run with coverage is the evidence, not a claim that it passes.
- Follow the Google Java Style Guide; run the project's formatter (Spotless /
  google-java-format) so the diff is style-clean before review.

## Review checklist (a Java reviewer must check)

- **Records over Lombok** for data carriers; no new `@Data`/`@Value`/`@Builder`.
- **`Optional` used correctly** — no unguarded `.get()`, no `Optional` fields/params,
  no `null` where `Optional` fits.
- **Sealed hierarchies are exhaustive** — switch expressions over a sealed type have no
  default that hides a missing case.
- **Immutability** — fields `final` where possible, collections defensively copied at
  boundaries; no leaking internal mutable state.
- **Spring:** constructor injection (not field `@Autowired`); controllers thin; inputs
  validated; no business logic in controllers.
- **Logging:** SLF4J, parameterised (`log.info("x={}", x)`), and **no secrets/PII** in
  logs or exception messages.
- **No swallowed exceptions** — caught exceptions are handled or rethrown with context,
  never silently dropped.
- **Tests** use JUnit 5 + Mockito (`@ExtendWith(MockitoExtension.class)`) and cover error
  paths, not only the happy path.

## Rules

- Match the repo's Java version, build tool, and formatter exactly — never widen them to
  silence an error.
- Records over Lombok; `Optional` not `null`; sealed + pattern matching for closed sets.
- Constructor injection in Spring; never log secrets or PII.
- No empty catch blocks — handle or rethrow with context.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**A Java convention this repo enforces beyond the obvious — a target version constraint, an immutability or layering rule, a build/formatter gotcha, or a Spring wiring pattern.** That kind of fact is *lore* — it would have saved you time had the
previous agent recorded it, and it will save the next one. Capture it.

When you learn something that future agents on this repo should know *before they
start* — a convention, a gotcha, an architectural fact, a decision, a boundary —
call the Memory MCP `suggest_lore` tool once, at the close of your work:

- `title` — the rule/fact in a few words.
- `summary` — one self-contained paragraph: the *what* and the *why*.
- `body` — the detail and evidence that lets a human verify it.
- `repos` — the repo(s) the rule applies to.
- `tags` — lowercase (e.g. `conventions`, `gotchas`, `security`, `db`).
- `source` — a URL to the ticket/PR/ADR that justifies it (records without a
  source are lower-trust); `confidence` — `low` for an inferred convention,
  `high` only when you have a source.

**This is suggested, gated knowledge — not auto-truth.** `suggest_lore` lands a
DRAFT; a human reviews and approves it. You never approve your own lore.

**Capture reusable knowledge, not ticket noise.** Lore is a convention, gotcha,
decision, or boundary the *next* agent needs — never per-ticket trivia (what this
diff changed, a path you happened to read, transient task state). The honest test:
*would a teammate six months from now thank you for this record?* If unsure, skip —
a missing record costs one re-search; a noisy one costs every future reader.
