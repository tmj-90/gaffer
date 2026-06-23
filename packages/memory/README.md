# Memory

The **durable, human-gated memory** of [Gaffer](../../README.md) — the "memory"
component of the Dispatch / Crew / Memory suite, and a standalone product in its
own right (npm: `memory-mcp`). It's a local-first SQLite store fronted by an MCP
server and a CLI: agents consult it *before* they implement and propose what they
learn *back* into it, but a human ratifies anything durable.

It holds two kinds of knowledge:

1. **Lore** — the gated knowledge base: conventions, decisions, gotchas, and
   cross-repo boundaries. Agent proposals land as `draft` and stay invisible to
   search until a human approves them — an agent **cannot** promote its own
   memory. This is the control that stops prompt-injected "facts" from poisoning
   future tickets.
2. **Repo Understanding** — the *Repo Digest* (a living overview / structure /
   conventions / stack TLDR, one per repo) and the *feature ledger*
   (`backlog → building → shipped`). These are factual post-merge reflections, so
   they apply directly (no draft gate) but keep a full audit trail. The digest is
   **a map, not the territory** — every digest carries the reminder to verify it
   against the actual code for high-stakes work.

## What it provides

**MCP server** (`memory-mcp`, stdio) — the agent surface:

- Lore: `search_lore`, `get_lore`, `suggest_lore` (lands a draft), `report_conflict`,
  `record_absence` (a self-expiring "we checked, no policy here" marker).
- Boundaries: `declare_boundary`, `find_dependents` (the cross-repo contract graph,
  for impact + ordering).
- Repo Understanding: `get_repo_digest`, `update_repo_digest`, `list_features`,
  `add_feature`, `advance_feature`.

**CLI** (`memory`) — the human surface. The headline command is `memory review`:
an interactive triage queue (approve / reject / edit / skip) over pending drafts,
with `memory approve <id>` / `memory reject <id>` for direct action. It also covers
`init`, `add` / `suggest` (incl. `--from-commit`), `search`, `show`, `list`,
lifecycle (`deprecate`, `supersede`, `verify`), `digest`, `feature` / `features`,
`boundary`, `impact`, `sync` (export/import `.md`), `stats`, `audit`, `doctor`, and
`setup`.

## Build & test

```bash
pnpm --filter memory-mcp build   # emits dist/bin/memory.js (CLI) + dist/bin/memory-mcp.js (MCP)
pnpm --filter memory-mcp test
```

> The pnpm filter name is **`memory-mcp`** (the package's npm name), not `memory`.
> Inside the package, `pnpm build` / `pnpm typecheck` / `pnpm test` work directly.

## Autonomous mode

For a fully hands-off factory, set:

```bash
MEMORY_AUTO_APPROVE=1
```

…and `suggest_lore` lands `active` immediately — the operator opting into trusting
agent writes (their machine, their call). **Default is governed** (draft-then-approve),
so the standalone product is unchanged. This re-opens cross-ticket memory poisoning
(fine for trusted input, not for untrusted issues); pair it deliberately and see the
package [`docs/SECURITY.md`](docs/SECURITY.md) and the root
[`SECURITY.md`](../../SECURITY.md) for the trade-off.

## How it fits — and standalone use

**In the factory:** the built `memory-mcp` server is wired into the agent via the
runner's `.mcp.json`. Agents `search_lore` before writing code and `suggest_lore`
after; onboarding and merge steps keep each repo's digest + feature ledger current.
The `memory` CLI is what a human uses to review and approve drafts.

**Standalone:** nothing here needs the rest of Gaffer. Run `memory init` in any
directory and you have a trust-gated memory MCP you can wire into any Claude Code
project — `memory setup` bootstraps the MCP server, a `CLAUDE.md` retrieval rule,
and the onboarding skill in one command. See [`CONTRIBUTING.md`](CONTRIBUTING.md)
and [`docs/`](docs/) (`PRINCIPLES.md`, `DATA-FLOW.md`, `SECURITY.md`, `adr/`) for
the design and trust model.
