# Gaffer

[![CI](https://github.com/tmj-90/gaffer/actions/workflows/ci.yml/badge.svg)](https://github.com/tmj-90/gaffer/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

**A local-first, supervised software factory.** Gaffer works a backlog of tickets into delivered, tested, reviewed code — on your own machine, against your own repos, under a human gate you control. It runs supervised by default; hands-off autonomy is opt-in.

It isn't a chat assistant that writes code. It's a *factory*: a control plane, a runtime, durable memory, and an orchestrator that works tickets through **plan → implement → test → review** and delivers each as a git branch or PR with evidence — then loops on rejection until it's right. Vague or blocked tickets park for a human rather than being forced through.

<p align="center">
  <img src="docs/img/overview.png" alt="The Gaffer control room — live Overview" width="900">
  <br><sub><em>The control room: throughput, what needs you now, and per-repo pressure at a glance. (Demo data.)</em></sub>
</p>

---

## Why Gaffer

Most coding agents are stateless renters: every run starts cold, the "memory" is a vendor black box, and the only proof a task passed is a log the agent wrote about itself. Gaffer inverts all three:

- **It builds you an asset.** Every review verdict, every piece of evidence, every learned convention persists in a control plane (Dispatch) and a gated memory (Memory) that you own and can carry between repos. The factory's hit-rate, safety, and cost-efficiency improve the longer it runs.
- **It runs on your machine.** Local-first: the control plane, databases, repo state, worktrees, and evidence all live on your box — no per-seat cloud, fully auditable. Live agent runs use your configured Claude Code CLI, so prompts and selected repo context are sent to that model provider. Treat any connected model as part of your trust boundary.
- **You hold the gate.** By default a human approves every merge and the agent *structurally cannot* ship its own work. Opt-in flags unlock full hands-off autonomy when you actually want it.

## Architecture

![The Gaffer work board](docs/img/board.png)
*The work board — tickets across draft → ready → in-progress → review, each with a risk badge and acceptance-criteria progress. (Demo data.)*

Four components, one workspace:

| Component | Role |
|---|---|
| **Dispatch** · `packages/dispatch` | The control plane — tickets, epics, scopes, per-repo access, the review gate. REST API + MCP server + web dashboard + CLI. |
| **Crew** · `packages/crew` | The factory runtime — factory-level MCP tools, a hooks engine, and idle loops that draft work, ingest issues, and self-improve. |
| **Runner** · `runner/` | The orchestrator — bash that spawns a `claude -p` agent per ticket, with a 31-skill library, a deterministic safety hook, git-worktree isolation, and model tiering (plan on a strong model, implement on a fast one). |
| **Memory** · `packages/memory` | The durable, human-gated memory the factory learns into — the lore knowledge base plus the Repo Understanding engine (digest + feature ledger). *(Also usable standalone — see [`packages/memory/README.md`](packages/memory/README.md).)* |

```
  ticket ──▶ Runner spawns an agent ──▶ plan ▸ implement ▸ test ▸ self-review
                │                                          │
                │  (worktree-isolated, safety-hooked)      ▼
   Memory ◀──┴── learns conventions          deliver branch/PR + evidence
   (memory)                                                │
   Dispatch ◀─────────────────────────────────────────────┘
   (control plane: human review gate → merge)
```

## The Repo Understanding engine

Gaffer doesn't re-learn a repo from cold on every run. Memory keeps a living **Repo Digest** (a TLDR of overview / structure / conventions / stack) and a **feature ledger** (`backlog → building → shipped`) per repo, seeded at onboarding and refreshed deterministically as tickets merge — alongside the gated **lore** knowledge base (conventions, decisions, gotchas, cross-repo boundaries). Onboarding runs a skill-driven `claude -p` pass that produces a real digest, a feature inventory, and cited lore drafts grounded in the actual code.

The digest is **a map, not the territory** — a fast orientation that the factory verifies against the real code for high-stakes work, never a substitute for it.

![Gaffer repo memory](docs/img/memory.png)
*Repo memory for an onboarded project — the generated digest, the feature ledger (shipped / building / backlog), and gated lore. (Demo data.)*

## Install

**Prerequisites:**
- **Node 20 or 22** and **pnpm** (`pnpm@10.33.0`, pinned via `packageManager`)
- **Git** (the factory branches per ticket)
- **`claude` CLI**, authenticated with Anthropic — required for live agent runs; the factory spawns `claude -p` for planning, delivery, and repo analysis
- **`python3`** — used by runner helpers for JSON parsing and the portable timeout shim

```bash
git clone https://github.com/tmj-90/gaffer gaffer && cd gaffer
pnpm install      # one workspace — all components, one lockfile
pnpm -r build     # build the TypeScript packages
```

See [`quickstart.md`](quickstart.md) for a guided first run.

## Quickstart

```bash
runner/setup.sh                 # initialise factory state (DBs, config, agent identity)
DRY_RUN=1 runner/tick.sh        # preview one tick — never invokes Claude or touches a repo
runner/gaffer dashboard          # open the control-room dashboard
runner/loop.sh                  # run the factory loop (DRY_RUN=1 by default)
```

See [`quickstart.md`](quickstart.md) for the guided walkthrough and [`runner/README.md`](runner/README.md) for the full runbook.

## Safety

Gaffer runs shell-capable agents, so containment is first-class:

- a **deterministic PreToolUse safety hook** scopes writes to the worktree, blocks secret reads, denies the control-plane CLI, and **fails closed**;
- every ticket runs in a **throwaway git worktree** — the real checkout is never touched;
- an optional **OS sandbox** (sandbox-exec today; container/VM providers via a seam) adds a kernel-level write boundary;
- the **review gate is enforced server-side** — an agent can't approve or merge its own work, and the merge gate verifies the *real git diff*, not the agent's word for it.

Opt-in autonomy, to be used deliberately: `DISPATCH_ALLOW_AGENT_APPROVE`, `MERGE_ON_AGENT_REVIEW`, `MEMORY_AUTO_APPROVE`. Full threat model and honest residual limits: [`SECURITY.md`](SECURITY.md).

## Layout

```
gaffer/
├── packages/
│   ├── dispatch/    control plane  (REST + MCP + dashboard + CLI)
│   ├── crew/   factory runtime (MCP + hooks + idle loops)
│   └── memory/    durable gated memory + repo understanding (MCP)
├── runner/           bash orchestrator, 31-skill library, safety hook
├── pnpm-workspace.yaml
└── package.json
```

## Status — `0.1.0` alpha

Run-at-your-own-risk, local-first software. You run it on your machine, with your keys, against your repos — see [`SECURITY.md`](SECURITY.md) before pointing it at anything untrusted. Licensed under [Apache-2.0](LICENSE).

**What works today:**
- Dispatch queue, tickets, epics, scopes, review gate (REST + MCP + CLI)
- Crew MCP tool server (factory tools, hooks engine, idle loops, repo onboarding)
- Memory embeddings, Repo Digest, feature ledger, gated lore
- Runner factory loop with 31-skill library and model tiering
- Deterministic safety hook (`runner/safety-hook.mjs`) — worktree isolation, fails closed
- Web dashboard with all seven views: Overview, Work, Review, Epics, Map, Memory, Settings

**Not yet / honest limits:**
- Container sandbox is a stub — worktree isolation plus `sandbox-exec` (macOS only, Apple-deprecated) is the current boundary; no per-subprocess network isolation
- No REST RBAC (the API token is shared; no per-user or per-scope permissions)
- Safety hook is tested on macOS; non-macOS behaviour is best-effort and untested
- No automatic plugin or skill marketplace — skills are bash/markdown files you add manually
