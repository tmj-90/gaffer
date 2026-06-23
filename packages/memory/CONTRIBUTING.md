# Contributing to memory

Thanks for taking a look. memory is small, focused, and finished on
purpose — contributions that keep it that way are very welcome.

## Development setup

memory ships inside the Gaffer monorepo (`packages/memory`). Work on it from there:

```bash
git clone https://github.com/tmj-90/gaffer.git
cd gaffer
pnpm install                      # builds the better-sqlite3 native binding
pnpm --filter memory-mcp build    # compiles to dist/ and chmods the bin entries
pnpm --filter memory-mcp test     # run this package's suite
```

Useful scripts:

| Command | What it does |
| --- | --- |
| `pnpm typecheck` | `tsc --noEmit` (strict, `noUncheckedIndexedAccess`, etc.) |
| `pnpm test` | full vitest run |
| `pnpm test:watch` | vitest in watch mode |
| `pnpm build` | clean compile to `dist/` |
| `pnpm dev:cli` | run the CLI from source via tsx |
| `pnpm dev:mcp` | run the MCP server from source via tsx |

Before opening a PR, make sure `pnpm typecheck && pnpm test && pnpm build`
all pass. `prepublishOnly` runs typecheck + tests, so a broken build
can't reach npm.

## Where things live

- `src/core/` — the lore data model, lifecycle, search, absence markers.
  The trust logic lives here.
- `src/mcp/` — the MCP server and its trust-boundary helpers
  (`redact.ts` is where the gating logic is, with matching tests).
- `src/cli/` — the human-facing CLI commands.
- `src/db/` — SQLite open/migrations.
- `test/` — vitest suites, one per concern.
- `docs/` — principles, security model, data flow, ADRs.

## The trust model is the product — don't break it

memory's whole value is that agents *suggest* and humans *approve*.
A change that weakens any of these will be sent back:

- **Agent-facing writes land as drafts.** Nothing an agent submits via
  MCP becomes trusted lore without human approval.
- **Confidence is clamped.** Drafts can't claim `high`; records without
  a source can't claim `high`.
- **Restricted records are gated.** Excluded from default search and
  env-gated for direct fetch over MCP; `report_conflict` against a
  restricted record is always refused.
- **The audit log is sanitised per tool** — sensitive fields are stored
  as character counts, never raw text.

If your change touches a trust boundary, add or update a test in
`test/` that would fail if the guarantee were silently removed. See
`test/mcp-redaction.test.ts` for the pattern.

## Commit & PR style

- Conventional-commit-ish prefixes: `feat:`, `fix:`, `docs:`, `chore:`,
  `test:`, `refactor:`.
- Keep the subject under ~70 chars; explain the *why* in the body.
- One logical change per PR where practical.

## Reporting bugs / proposing features

Use the issue templates under `.github/ISSUE_TEMPLATE/`. For anything
security-sensitive, see [`docs/SECURITY.md`](docs/SECURITY.md).

## License

By contributing you agree your contributions are licensed under the
project's [Apache-2.0 License](../../LICENSE).
