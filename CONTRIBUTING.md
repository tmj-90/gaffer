# Contributing to Gaffer

Thanks for your interest in Gaffer — a local-first autonomous software factory. By participating you agree to the project's [Code of Conduct](CODE_OF_CONDUCT.md).

If you'd like to understand how the system fits together before diving in, read [ARCHITECTURE.md](ARCHITECTURE.md) first.

## Repository layout

Gaffer is a pnpm monorepo plus a bash orchestrator:

```
packages/
  dispatch/   control plane  (REST + MCP + dashboard + CLI)
  crew/       factory runtime (MCP + hooks + idle loops)
  memory/     durable gated memory — npm package name: memory-mcp
runner/       bash orchestrator, skill library, safety hook
```

## Getting started

Requires Node 22 or 24 and [pnpm](https://pnpm.io) (`pnpm@10.33.0`, pinned via
`packageManager`).

```bash
pnpm install            # install all workspace deps
pnpm -r build           # build dispatch, crew, memory
pnpm -r test            # run all package test suites
```

Runner tests run directly with Node and bash:

```bash
for t in runner/test/*.test.mjs; do node "$t"; done
for t in runner/test/*.test.sh;  do bash "$t"; done
```

## Ground rules

- **Never weaken `runner/safety-hook.mjs`.** It is the containment boundary that
  keeps shell-capable agents from doing harm. The crew-side mirror of the
  classifier and its parity tests are intentional — keep them in sync, do not
  delete them. Changes that loosen the classifier will be rejected.
- Keep packages green: `pnpm -r build && pnpm -r test` must pass before you open
  a PR, and the runner `.mjs`/`.sh` tests must pass too.
- Add or update tests for any behaviour you change.

## Commit style

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(dispatch): add claim-expiry sweep
fix(crew): guard against missing dist on cold import
test(memory): cover idle-loop coverage gate
```

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`, `ci`, `build`.

## Pull requests

1. Fork and branch off `main`.
2. Make focused, atomic commits.
3. Ensure CI is green. `pnpm check` runs the TypeScript-side gate in one shot
   (lint → format:check → build → typecheck → typecheck:test → test); run the runner
   tests separately (last bullet). A plain `tsc --noEmit` is **not** enough:
   `typecheck:test` uses `tsconfig.test.json` with `noUncheckedIndexedAccess`, and
   `format:check` is a root script, so both catch things `tsc --noEmit` and per-package
   runs miss. The individual checks CI runs, in order:
   - `pnpm lint` (ESLint)
   - `pnpm format:check` (Prettier `--check .`, run at the ROOT)
   - `pnpm -r build` (TypeScript packages build clean)
   - `pnpm -r typecheck` (source type-check)
   - `pnpm -r typecheck:test` (STRICTER test type-check — `noUncheckedIndexedAccess`)
   - `pnpm -r test` (all package test suites)
   - `pnpm -r test:coverage` (per-package coverage floor)
   - Runner tests: `for t in runner/test/*.test.mjs; do node "$t"; done && for t in runner/test/*.test.sh; do bash "$t"; done`
4. Open a PR describing **why**, not just what. Use the PR template in `.github/PULL_REQUEST_TEMPLATE.md`.

Bug reports and feature requests: open an issue using the templates in [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/).
