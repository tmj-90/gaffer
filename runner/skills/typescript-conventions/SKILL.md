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

## Rules

- Strict mode stays on; no widening `tsconfig` to silence errors.
- `unknown` over `any`; `satisfies` over assertions; validate external input.
- No floating promises, no empty catch blocks — handle or rethrow explicitly.
- Match the repo's lint/format config exactly; named exports by default.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**A TypeScript/stack convention this repo enforces beyond the obvious — an import-ordering rule, a type-modelling pattern, or a lint/tsconfig constraint.** That kind of fact is *lore* — it would have saved you time had the
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
