# Changelog

All notable changes to Gaffer will be documented in this file.

> For the memory package changelog, see [`packages/memory/CHANGELOG.md`](packages/memory/CHANGELOG.md).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Machine-checkable acceptance criteria.** An AC may now carry a `check_command` (`dispatch ac add --check '<cmd>'`, `POST /tickets/:id/acceptance-criteria`, MCP `add_acceptance_criterion`). After the DoD gates the **runner** executes each check in the primary delivery worktree (bounded by `GAFFER_DOD_TIMEOUT`) and records the verdict through the trusted `dispatch ac check-result` path: exit 0 ⇒ `satisfied` with `verified_by = runner:check` plus a `test_output` evidence row carrying the exit code and output tail; non-zero ⇒ `failed` and the delivery is auto-rejected to rework with the failing output as feedback, exactly like a failing DoD gate. The done gate (which fires at approval) refuses a checked AC the runner has not passed — an agent marking it satisfied via `record_ac_evidence` does not count. Prose ACs are unchanged. Schema v21 adds the nullable column with a NULL backfill. See `runner/lib/ac-checks.sh`.
- **Live event stream — `GET /api/events/stream?since=<seq>`.** The control plane pushes its append-only `work_events` log as Server-Sent Events (metadata-only, the same safe shape as `/api/activity`; a `seq` cursor for resume). The dashboard subscribes with `fetch` (so the bearer token travels in the header, never a URL) and re-renders the current view within a second of a transition instead of on a blind 3-second interval; the interval remains as the fallback when the stream is unavailable.
- **Event-derived cycle time and a real flow efficiency.** `/api/health` takes each ticket's completion time from its last `ticket.transitioned → done` event rather than `updated_at` (which moves on any patch and inflated cycle time or bucketed the ship on the wrong day), and gains `flow_efficiency.median_pct`: the median over shipped tickets of time in active states divided by lead time, from the transition log — `null` until a shipped ticket carries the signal. The Overview reads it; the former client number was a WIP ratio, not flow efficiency.

### Security

- **Autonomy really requires containment now.** `GAFFER_MODE=autonomous` (and `lite`, and every single ship/mutate flag) exported `GAFFER_STRICT_REQUIRE=1` and printed "fails closed without an OS sandbox", but the sandbox was consulted only under `STRICT_MODE=1`, which only `GAFFER_MODE=strict` defaulted on — so the agent launched uncontained. Autonomy now defaults `STRICT_MODE=1` as well, `tick.sh` consults the provider whenever strict is on **or required**, and the worker seam (`runner/lib/worker.sh`) derives and enforces the wrap for **every** spawn site — bootstrap, reviewer, clarify and eval judge were previously never sandboxed even under `STRICT_MODE=1`. A required-but-unavailable sandbox now refuses to spawn (rc 75, no envelope). New test: `runner/test/autonomy-containment.test.sh`.
- **Reviewer ≠ author is enforced server-side.** `approveReview` refuses an `agent` actor whose id equals the agent on the ticket's most recent claim, even when an autonomy flag permits agent approval. The runner's AFK review pass approves as a distinct `<agent>/reviewer` principal. Previously the "agent cannot approve its own work" guarantee rested on the runner's bash hook denying the CLI.
- **Notify URLs pass an SSRF policy.** Webhook/Slack sink URLs (env or dashboard settings) must be http(s) and must not target loopback, link-local, unspecified or private-range hosts; refused URLs are skipped loudly and never build a sink. Opt a LAN relay back in with `GAFFER_NOTIFY_ALLOW_PRIVATE=1`. Dashboard settings also now type-check `int`/`boolean` values.
- **Ticket-close lore distillation is gated by default.** The distilled requirement (from the agent-influenceable ticket title + ACs) landed ACTIVE in the factory regardless of the memory gate. It now follows `MEMORY_AUTO_APPROVE` (draft in supervised/lite/graduated; active in autonomous/strict), overridable with `GAFFER_MEMORY_AUTO_PROMOTE`.
- **Memory write hygiene on every path.** Envelope-delimiter stripping for the repo digest and feature ledger moved into the memory core, so the CLI path (`memory digest set` / `feature add`, used by crew onboarding and the post-merge rollup) is sanitised like the MCP tools.

### Fixed

- **Post-merge card refresh no longer wipes file summaries.** `gaffer_refresh_cards` re-upserted each changed file without a model summary, and the upsert wrote `tldr = NULL, model_status = 'absent'` — so a repo's file cards decayed to mechanical-only after their first edit. `memory card upsert --keep-model` (new) carries the existing model half forward on a mechanical-only refresh; the refresh uses it.
- **Docker sandbox provider can now run a delivery.** The container mounts `$GAFFER_HOME/packages` and `$GAFFER_HOME/node_modules` (read-only) so the dispatch/memory MCP servers start, follows each worktree's `node_modules` symlinks to their targets so the DoD test gate can run, and invokes the image's own `claude` with a container HOME/PATH instead of the host's binary path. `GAFFER_SANDBOX_DRY_RUN=1` prints the assembled `docker run` argv for testing. The CI containment job fails (rather than skips green) when the gate could not run on a push to `main`.
- **Docs corrected to match the code**: ARCHITECTURE (no Hono — `node:http`; docker provider is real; no embeddings; Crew MCP is not connected to the delivery agent), README ("memory embeddings"), quickstart/`gaffer dashboard`/RUNBOOK (the token is required for reads too; Node ≥ 22), `.env.example` (not the full knob list; `GAFFER_NOTIFY_REDACT` deprecated), the runtime-migration doc's status line, and the memory README's "default is governed" (now true for the factory too). Retired the obsolete vitest-2 entries from the audit allowlist. Internal trackers moved to `docs/archive/`.

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
