---
name: typescript-conventions
description: Use when a ticket adds or changes TypeScript/JavaScript code and it must follow the repo's TS conventions — strict typing, async correctness, module/import hygiene, and idiomatic patterns. Invoke for "add this in TypeScript", "fix the type errors", "tighten the types on X", or as the language pack for any TS/JS change.
stack: [typescript, javascript, node]
area: language
---

# Write idiomatic, strict TypeScript

Add TypeScript that type-checks under strict mode, models data precisely, and matches
the repo's existing idioms — provably correct, not just compiling.

## Steps

1. **Read the lore first.** Call `search_lore` (Memory MCP) for the repo's TS
   conventions and respect its `tsconfig.json` (never weaken `strict` or `paths`),
   `eslint`/`prettier` config, and module style (ESM vs CJS).
2. **Find a sibling module** and copy its patterns — file layout, export style
   (prefer named exports), error handling, and how types are organised.
3. **Type precisely.** Model nullability explicitly; prefer `unknown` over `any`
   (justify any `any` in a comment); use discriminated unions and `satisfies` over
   type assertions. Validate external data at the boundary (e.g. Zod) rather than casting.
4. **Get async right.** Use `async/await` over `.then()` chains; `await` or
   deliberately handle every promise; never leave a floating promise or empty catch.
5. **Keep imports tidy.** Order external → internal aliases → relative, alphabetised
   within groups; `const` over `let`, never `var`.
6. **Type-check and test.** Run the project's type-check (e.g. `tsc --noEmit`) and
   tests; fix the cause of errors rather than casting them away.
7. **Verify + evidence.** Run tests + lint, record `test_output` via the
   `record-evidence` skill, and submit for review.

## Build / Test

- **Type check:** `tsc --noEmit` (or the repo's script) — fix the cause, never widen `tsconfig`.
- **Lint/format:** the repo's ESLint + Prettier scripts; fix, don't suppress.
- **Tests:** the repo's runner (Vitest/Jest); coverage via its coverage script.
- The DoD is verified by the repo's configured test/coverage commands — run them and
  record the output; a green type-check + tested run is the evidence.

## Review checklist (a TS reviewer must check)

- **Strict mode intact** — no weakened `tsconfig`, no stray `@ts-ignore`/`@ts-expect-error`
  without justification.
- **`unknown` over `any`** — every `any` is justified in a comment; `satisfies` used instead
  of type assertions where possible.
- **External input validated** at the boundary (e.g. Zod), not cast.
- **No floating promises**, no empty catch blocks — every promise is awaited/handled and
  errors are handled or rethrown.
- **Named exports** by default; imports ordered external → internal alias → relative,
  alphabetised; `const` over `let`, no `var`.
- **Lint/format clean** — matches the repo's ESLint + Prettier config exactly.

## Rules

- Strict mode stays on; no widening `tsconfig` to silence errors.
- `unknown` over `any`; `satisfies` over assertions; validate external input.
- No floating promises, no empty catch blocks — handle or rethrow explicitly.
- Match the repo's lint/format config exactly; named exports by default.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**A TypeScript/stack convention this repo enforces beyond the obvious — an import-ordering rule, a type-modelling pattern, or a lint/tsconfig constraint.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
