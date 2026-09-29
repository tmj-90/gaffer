---
name: typescript-conventions
description: Use when a ticket adds or changes TypeScript/JavaScript code and it must follow the repo's TS conventions — strict mode typing, typescript-eslint type-aware rules, async correctness (no floating promises, bounded fan-out), boundary validation instead of casts, module/import hygiene, Node resource and concurrency safety, and idiomatic patterns. Invoke for "add this in TypeScript", "fix the type errors", "tighten the types on X", or as the language pack for any TS/JS change or TS/JS review.
stack: [typescript, javascript, node, react, next, nextjs, vue, svelte, angular, react-native, expo]
area: language
---

# Write idiomatic, strict TypeScript

TypeScript protects you only as far as its types are honest: strict mode on, external
data validated rather than cast, and every promise awaited or handled. For the builder and the reviewer of a TS/JS diff; the repo's config and existing code win over it. UI framework patterns live in their own packs (the `react-patterns`
skill, the frontend packs).

## Procedure

1. **Discover the repo's conventions first.** Call `search_lore` for TS conventions. Read
   `tsconfig*.json` (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
   `module`/`moduleResolution`, `verbatimModuleSyntax`, `erasableSyntaxOnly`), the
   TypeScript version (6.0 turned `strict` on by default and deprecated `baseUrl`,
   `moduleResolution: node`; 7.0 removed them and ships the native `tsc`),
   `package.json` (`type`, `scripts`, `engines`, `packageManager`), the lockfile that names
   the package manager (`package-lock.json` npm, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`),
   `eslint.config.*` or `biome.json`, Prettier config, the test runner config, and
   workspace tooling (`turbo.json`, `nx.json`). Copy a sibling module and its test.
2. **Pin the exact commands** from `package.json` scripts and CI (the `run-tests` and
   `run-lint` skills). Use the defaults below only when the repo defines none.
3. **Write the change with the idioms below**, then walk the concurrency section for every
   promise, shared object, stream, timer, file and outbound call you touched.
4. **Test each acceptance criterion's own behaviour.** One test per AC that fails without
   your change, plus its error path. If the AC involves shared state or persistence, add a
   test that fires N concurrent requests (`Promise.all` over the real handler) and asserts
   the invariant — Node interleaves at every `await`, so single-threaded code still races.
5. **Verify, then stop.** Done when: the type check, lint and format check are clean with
   no new suppressions, tests (with the repo's coverage gate) are green, and every AC has
   a test. Record the output with the `record-evidence` skill; the runner submits the work.

## Commands

- Never install: `node_modules` in a delivery worktree is shared with the main checkout,
  and `npm ci`/`pnpm install`/`yarn install` are hook-blocked (the `dependency-upgrade`
  skill). Run the tools already installed. Headless, plain `npx x` downloads a missing
  package without asking (a missing `tsc` fetches an unrelated npm package), so always
  write `npx --no -- x`, which fails instead of fetching (keep the `--`: `npx --no x`
  misreads the tool name).
- Types: `npx --no -- tsc --noEmit -p .` (or `npx --no -- tsc -b` for project
  references, or the repo's `typecheck` script).
- Lint and format: the repo's `lint` script (ESLint with typescript-eslint, or
  `npx --no -- biome check`) and `npx --no -- prettier --check .`.
- Tests: the repo's `test` script (Vitest, Jest, `node --test`); one file:
  `npx --no -- vitest run path/x.test.ts` or `npx --no -- jest path/x.test.ts`.

## Idioms that matter

- **Strict stays strict**: never loosen `tsconfig` or ESLint to pass, never add
  `ignoreDeprecations`. `@ts-expect-error` with a reason beats `@ts-ignore`; both need one.
- **`unknown` over `any`** at every boundary; `catch (e)` is `unknown` — narrow it.
- **Validate, don't cast**: `await res.json() as User` and `JSON.parse(x) as T` are lies
  the compiler believes. Parse with the repo's schema library (Zod, Valibot, TypeBox) and
  derive the type from the schema.
- **Model precisely**: discriminated unions with an exhaustive `switch` (a `never` check
  in `default`); `satisfies` over `as`; no non-null `!` on values that can be absent;
  `readonly` and `as const` for data that must not change.
- **Modules**: named exports; `import type` for type-only imports (required under
  `verbatimModuleSyntax`); the repo's ESM/CJS style and path aliases; `const` over `let`,
  never `var`.
- **typescript-eslint** type-aware rules worth honouring even when not configured:
  `no-floating-promises`, `no-misused-promises`, `await-thenable`,
  `switch-exhaustiveness-check`, `no-unsafe-*`, `only-throw-error`.
- **Pitfalls**: `===` only; `arr.sort()` mutates and sorts numbers as strings (use
  `toSorted((a, b) => a - b)`); `for…in` iterates keys, not elements; money is not a float.

## Concurrency and resource safety

- **Every promise is awaited, returned, or explicitly handled** (`void p.catch(log)`).
  `array.forEach(async …)` does not wait; use `for…of` with `await` or `Promise.all`.
- **Bound fan-out**: `Promise.all` over user-sized input needs a concurrency limit
  (the repo's limiter, e.g. `p-limit`, or a worker queue); use `Promise.allSettled` when one failure must not drop
  the others' results.
- **Read-modify-write across `await`** races between concurrent requests (read, await,
  write). Serialise per key (a promise-chain mutex or queue), or do it in one database
  transaction or atomic update with a version check.
- **Files other requests read**: `fs.writeFile` is not atomic. Write to a unique temp path
  in the same directory (`${target}.${crypto.randomUUID()}.tmp`), then `fs.rename` over the
  target. Never a fixed temp name or one built from `Date.now()`. Cross-process exclusion
  uses the database or a real lock; a time-only lease lets a paused holder write late, so
  writes must check a fencing token or version.
- **`fetch`** resolves on 4xx/5xx — check `res.ok`; it has no default timeout — pass
  `signal: AbortSignal.timeout(ms)`. Propagate `AbortSignal` through long operations.
- **Streams** use `pipeline` from `node:stream/promises` so errors and cleanup propagate;
  file handles opened with `fs.promises.open` are closed in `finally`.
- **Timers and listeners** are cleared/removed when their owner ends; module-level
  mutable state in a server is shared by every request.

## Review checklist — flag as defects

Walk this against the diff. An item is grounds for CHANGES only when, in changed code, it
causes a concrete failure (wrong result, crash, lost or corrupted data, security hole) or
leaves an AC's own behaviour untested: cite the line and that failure. Otherwise it is an
`(optional)` note. Formatting the tools would fix, and preferences the repo
does not enforce, are not findings. Do not patch the code under review.

- [ ] `tsconfig`/ESLint loosened; a new `any`, `@ts-ignore`, `eslint-disable` or `!`
      without a reason.
- [ ] External data (request body, `JSON.parse`, `res.json()`, env) cast with `as` instead
      of validated.
- [ ] A floating promise; `forEach(async …)`; an async callback passed where a sync one is
      expected; an empty `catch`.
- [ ] Unbounded `Promise.all` over user-controlled input.
- [ ] A read-modify-write spanning an `await` with no per-key serialisation, transaction
      or version check; shared module-level state mutated per request.
- [ ] A shared file written in place or via a fixed or time-based temp name; a time-only
      lock lease.
- [ ] `fetch` without an `ok` check or a timeout; a stream piped without error handling; a
      timer, listener or handle never released.
- [ ] A `switch` over a union without exhaustiveness where a new member would be missed.
- [ ] An AC has no test, or the test mocks the module the AC is about.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**A TypeScript/stack convention this repo enforces beyond the obvious — an import-ordering rule, a type-modelling pattern, or a lint/tsconfig constraint.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
