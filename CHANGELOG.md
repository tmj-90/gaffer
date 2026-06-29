# Changelog

All notable changes to Gaffer will be documented in this file.

> For the memory package changelog, see [`packages/memory/CHANGELOG.md`](packages/memory/CHANGELOG.md).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
