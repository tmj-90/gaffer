# Gaffer — Architecture

A concise map of how the system fits together.

---

## The four components

| Component | Package | Role |
|---|---|---|
| **Dispatch** | `packages/dispatch` | Control plane — tickets, epics, scopes, per-repo access, the review gate. REST API + MCP server + web dashboard (7 views) + CLI. |
| **Crew** | `packages/crew` | Factory runtime — MCP tool server, hooks engine, idle loops (draft work, ingest issues, self-improve), repo onboarding. |
| **Memory** | `packages/memory` | Durable, human-gated knowledge — lore knowledge base, Repo Digest, feature ledger, grounded lore drafts. Also usable standalone as `memory-mcp`. |
| **Runner** | `runner/` | Bash orchestrator — spawns a `claude -p` agent per ticket, 66-skill library, deterministic safety hook, git-worktree isolation, model tiering. |

All four live in a single pnpm monorepo. The runner derives every path from its own location (`runner/factory.config.sh`) so any checkout root works.

---

## A ticket's lifecycle

```
DRAFT  ──▶  READY  ──▶  CLAIMING  ──▶  IN PROGRESS  ──▶  IN REVIEW  ──▶  DONE
                                             │                  │
                                    Runner spawns          Human approval
                                    claude -p agent        (or DISPATCH_ALLOW_AGENT_APPROVE=1)
                                             │                  │
                                    plan ▸ implement           merge
                                    ▸ test ▸ self-review       (AUTO_MERGE=1 optional)
                                             │
                                    delivers branch/PR
                                    + evidence bundle
```

1. **plan** — a strong model (default: `opus`) decomposes the ticket into a concrete implementation plan. With `GAFFER_PLAN_DEBATE=1`, two models run a bounded adversarial debate before the plan is finalised.
2. **implement** — a fast model (default: `sonnet`) executes the plan in a throwaway git worktree.
3. **test** — the delivery agent runs the repo's test/build commands and records evidence.
4. **self-review** — the agent checks its own diff for hygiene violations and minimalism compliance.
5. **human gate** — the ticket lands in the Review tab. A human approves or rejects. On rejection the ticket re-queues for refinement.

Vague or blocked tickets park as `DRAFT` rather than being forced through.

---

## The safety boundary

The two enforced boundaries are:

### 1. Deterministic PreToolUse safety hook (`runner/safety-hook.mjs`)

- Scopes **all writes** to the active worktree (`GAFFER_WRITE_ROOTS`).
- Denies reads of secret files by path.
- Denies the control-plane CLI and raw DB access to the agent.
- Blocks force-push, `git config` history-execution, and scheduled-execution primitives.
- Resolves wrapped/assignment-prefixed commands (`env tee`, `VAR=1 mv`, `sh -c '…'`) so they cannot smuggle a verb past the check.
- **Fails closed**: when it cannot prove a target is in scope, it blocks.

A crew-side mirror of the classifier keeps parity. Do not weaken either side.

### 2. Server-side review gate (Dispatch)

- An `agent`-type actor **cannot** approve a review or merge its own work — this is enforced in the control plane, not by convention.
- The gate verifies the **real `git diff`**, not an agent-authored evidence string.
- `DISPATCH_ALLOW_AGENT_APPROVE` and `MERGE_ON_AGENT_REVIEW` relax this — they are **off by default** and removing the human gate is a conscious trust decision.

Optional third layer: OS sandbox (`STRICT_MODE=1`, macOS only today via `sandbox-exec`) adds a kernel-level write boundary. Container/VM providers exist as a seam in `runner/lib/sandbox.sh` but are stubs on non-macOS.

---

## Data stores

| Store | What lives there |
|---|---|
| SQLite (`dispatch.sqlite`) | Dispatch state — tickets, epics, scopes, reviews, claims, access grants |
| SQLite (`memory.sqlite`) | Memory — lore, repo digests, feature ledgers, draft queue |
| Git worktrees | Per-ticket isolated checkouts (torn down after delivery) |
| `crew.yaml` | Crew config — dispatch DB path, MCP wiring |
| `usage-ledger.jsonl` | Per-call token/cost records (best-effort, never blocks a tick) |

All state lives under `GAFFER_DATA` (default: `<repo-root>/.gaffer/`). Delete that directory to reset completely. Chroma/pgvector embedding backends are a planned extension for the memory package.

---

## MCP servers

Two MCP servers run during a ticket's agent session (wired via `runner/.mcp.json`):

- **Crew MCP** (`packages/crew`) — exposes factory-level tools to the Claude agent: ticket reads, evidence recording, lore store/recall, repo context queries, hygiene checks.
- **Memory MCP** (`packages/memory`) — exposes `recall` and `store` for the agent to read and write durable knowledge. Two trust tiers:
  - **Gated (draft → human approve).** Interpretive claims — lore (`suggest_lore`) and cross-repo boundaries (`declare_boundary`) — land as **drafts**, invisible to default retrieval until a human runs `memory review` / `approve` (unless `MEMORY_AUTO_APPROVE=1`).
  - **Direct-apply (bounded + quarantined).** Factual/proposal records — the repo digest (`update_repo_digest`), the feature ledger (`add_feature` / `advance_feature`), and file cards — apply directly (a digest is a post-merge reflection of real code, not an opinion to ratify). Because these are agent-writable and ungated, agent input is **length-bounded and sanitised on write**, and ALL agent-facing memory responses (cards, digest, lore, features) wrap agent-derived free text in a `<untrusted-…>` **quarantine envelope** so it reaches a future agent as data, never as instructions. File-card model fields additionally pass a mechanical validation + fail-closed semantic-review gate before they are ever served.

The Dispatch REST API and MCP server are for humans and the dashboard, not the delivery agent. The safety hook explicitly denies the control-plane CLI and DB access to the agent.

---

## Contributor extension points

### Add a skill

Create `runner/skills/<name>/SKILL.md`. The runner's 66-skill library is loaded from this directory. Each skill is a structured markdown prompt fragment that the agent receives for specific task types. No TypeScript compilation needed.

### Add a Dispatch route

Extend the HTTP API in `packages/dispatch/src/` (TypeScript, Hono). Run `pnpm -r build` to rebuild.

### Add a Crew MCP tool

Extend the tool registry in `packages/crew/src/` (TypeScript). Run `pnpm -r build` to rebuild. Keep the safety hook's classifier in sync with any new tool that touches the filesystem.

### Customise the idle loop / factory knobs

All runtime knobs live in `runner/factory.config.sh` (sourced by every runner script). Override any variable with a real env var — env always wins over the file's `:=` defaults. The dashboard Settings panel writes to `$GAFFER_DATA/settings.json`, which `factory.config.sh` applies as a lower-priority layer before its own defaults. See `.env.example` for the full list of knobs.

---

## See also

- [`SECURITY.md`](SECURITY.md) — threat model, honest residual limits, and what each defence actually does
- [`quickstart.md`](quickstart.md) — guided first run
- [`runner/ONBOARDING.md`](runner/ONBOARDING.md) — onboarding a repo
- [`runner/RUNBOOK.md`](runner/RUNBOOK.md) — full operational reference
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to contribute
