# Changelog

All notable changes to Gaffer will be documented in this file.

> For the memory package changelog, see [`packages/memory/CHANGELOG.md`](packages/memory/CHANGELOG.md).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Dispatch API auth posture (S-M1)**: every request that returns control-plane data now requires the bearer token — including read-only GET/HEAD on a loopback bind (board, run detail, plan-session transcripts, human queue, cost) — regardless of whether the token was operator-set or auto-provisioned. Only the public bootstrap surface (the static SPA shell + `/healthz`) is served tokenless. This closes the hole where a same-user process (e.g. a token-scrubbed, prompt-injected delivery agent limited to loopback) could `GET /api/tickets` and read the whole backlog. Previously the auto-provisioned dashboard token kept tokenless loopback reads open.
- **Notify redaction is now the default** (security): outbound webhook/Slack bodies are redacted to a minimal body (kind · ticket number · status · dashboard URL) by default, dropping the agent-influenceable ticket `title`/`detail`. Opt into the full body with `GAFFER_NOTIFY_FULL_PAYLOAD=1`. The old opt-in-to-redaction `GAFFER_NOTIFY_REDACT` is deprecated; `GAFFER_NOTIFY_REDACT=0` is still honoured as a full-payload request. Previously the full body was sent by default.
- **Autonomy now requires containment** (security, enforced in code): enabling any agent ship/mutate flag (`DISPATCH_ALLOW_AGENT_APPROVE`, `MERGE_ON_AGENT_REVIEW`, `AUTO_MERGE`, `MEMORY_AUTO_APPROVE`, or `GAFFER_MODE=autonomous`/`strict`) now auto-defaults `GAFFER_STRICT_REQUIRE=1`, so the runner fails closed when no OS sandbox provider is available instead of running unattended with only the deterministic hook. Set `GAFFER_STRICT_REQUIRE=0` explicitly (logged loudly) to opt out when you supply containment out-of-band. Docs also reframe the current OS sandbox as a **write sandbox** — it bounds writes, not reads or network egress.
- **Dispatch bouncing-tickets query**: the cross-ticket rework signal (`bouncingTickets`) now computes the per-ticket gate breakdown, ranking, and limit in a single SQL statement instead of one query per candidate ticket with the limit applied after enrichment. Behaviour unchanged.

### Fixed

- **Dispatch human queue**: a `factory_strict` draft with no reviewer now surfaces a reviewer-assignment item in the human queue. The policy ready-gate requires a reviewer for `factory_strict` as well as `regulated`, but the queue item was packed only for `regulated`, so a `factory_strict` draft blocked invisibly.

## [0.1.0] - 2026-06-17

### Added

Initial public release of Gaffer — a local-first, supervised software factory.

**Dispatch** (`packages/dispatch`) — the control plane. Manages tickets, epics, scopes, and per-repo access. Exposes a REST API, an MCP server, a web dashboard, and a CLI. Enforces the server-side review/merge gate: by default, an agent actor cannot approve or merge its own work.

**Crew** (`packages/crew`) — the factory runtime. An MCP tool server that exposes factory-level tools to Claude agents, plus a hooks engine and idle loops for drafting work, ingesting issues, and repo onboarding.

**Memory** (`packages/memory`) — durable, human-gated knowledge. A knowledge base (lore) plus the Repo Understanding engine: Repo Digest, feature ledger, and grounded lore drafts. Seeded at onboarding; refreshed as tickets merge. Also usable standalone as `memory-mcp`.

**Runner** (`runner/`) — the bash orchestrator. Spawns a `claude -p` agent per ticket with a 66-skill library. Includes a deterministic PreToolUse safety hook (`safety-hook.mjs`) that scopes writes to the per-ticket git worktree and fails closed. Model tiering: planning on a strong model, implementation on a fast one. Per-call resource caps (wall-clock timeout + agent turn cap).

**Web dashboard** — seven views: Overview, Work, Review, Epics, Map, Memory, Settings. Review is the human gate where tickets wait for approval before any merge occurs.

**Safety boundary** — worktree isolation (every ticket in a throwaway git worktree), deterministic regex-based safety hook, server-side human review gate. Autonomy flags (`DISPATCH_ALLOW_AGENT_APPROVE`, `MERGE_ON_AGENT_REVIEW`, `MEMORY_AUTO_APPROVE`) are opt-in and off by default.

[Unreleased]: https://github.com/tmj-90/gaffer/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/tmj-90/gaffer/releases/tag/v0.1.0
