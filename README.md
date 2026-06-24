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

## What it does

> The screenshots below are a neutral **demo dataset** — a fake "TaskFlow" task-management product (an API and a web client). Not anyone's real repos.

### Plan → a dependency-ordered epic of tickets

This is the headline. You give Gaffer a one-line brief — *"add recurring tasks"*, *"build an app that summarises PDFs"* — and it **decomposes it into a phased, dependency-ordered epic of tickets**, each ready to be worked through plan → implement → test → review.

It is not a single prompt that dumps a wall of code. The planner has a conversation: it asks a few **clarifying questions**, then proposes a plan where every ticket carries its own description, acceptance criteria, target repo, and an explicit **`dependsOn`** edge — so the work is *gated phase by phase* (the API can't start until the data model lands; docs come last). Nothing is created until you confirm; confirmed tickets land as **draft** for you to ready. If you'd rather skip the questions, **"Build the tickets"** forces the best plan from what it has so far — you're never stuck clarifying.

It works in two directions:

- **Greenfield** — no target repo: the plan opens with a single bootstrap ticket (`git init` + scaffold) that every other ticket depends on, so a one-liner becomes a brand-new, properly-structured repo.
- **Brownfield** — an existing repo or scope: zero bootstrap, every ticket stamped onto the target repo, so the plan *extends* what's already there instead of rebuilding it.

<p align="center">
  <img src="docs/img/plan-build.png" alt="The Plan-a-build chat decomposing a brief into a dependency-ordered epic" width="900">
  <br><sub><em>Plan a build — a one-line brief mid-decompose into the proposed <strong>Recurring tasks</strong> epic: each ticket has its own acceptance criteria and an explicit <code>depends&nbsp;on&nbsp;#1</code> edge. Proposes only; nothing runs until you confirm. (Demo data.)</em></sub>
</p>

Once confirmed, the epic is a first-class object: phases, member tickets, and the dependency graph the board enforces.

<p align="center">
  <img src="docs/img/epics.png" alt="The Epics view showing a phased, dependency-ordered epic" width="900">
  <br><sub><em>The same epic as a phased plan: Phase 1 (data model) → Phase 2 (API, gated on phase 1) → Phase 3 (worker + UI) → Phase 4 (docs). A phase can't start until the one before it is done. (Demo data.)</em></sub>
</p>

### The work board

Every ticket moves through **draft → ready → in-progress → review** lanes, each tagged with a risk badge, a priority, acceptance-criteria progress, and the agent that claimed it. Vague tickets sit in draft until a human shapes them; blocked tickets surface rather than being forced through.

<p align="center">
  <img src="docs/img/board.png" alt="The Gaffer work board" width="900">
  <br><sub><em>The work board — tickets across the lanes with risk badges and acceptance-criteria progress; one ticket claimed and in progress, one delivered and awaiting review. (Demo data.)</em></sub>
</p>

### The human review gate

When an agent delivers, the ticket lands in **Review** — and this is a *structural* barrier, not a courtesy. The agent **cannot approve or merge its own work**. The diff you sign off on is the **real `git diff`, computed server-side** against the delivery branch — never the agent's word for what it changed — and the Approve button stays disabled until that diff actually loads. Approve sends it to merge; reject loops it back for rework with your reason attached.

<p align="center">
  <img src="docs/img/review.png" alt="The Review gate with a server-computed diff and approve/reject" width="900">
  <br><sub><em>The review gate: an in-review ticket with its evidence, satisfied acceptance criteria, and the server-verified diff — Approve / send-back are yours alone. (Demo data.)</em></sub>
</p>

### The Factory Map

Repos rarely live alone. The **Factory Map** groups them into **scope nodes** (products, systems, capabilities) so the factory understands *which repos make up a product* and *what access it has to each* — `write`, `read`, `test`, or `none`. A ticket scoped to a product can reach exactly the repos that product owns, at exactly the access it's granted.

<p align="center">
  <img src="docs/img/factory-map.png" alt="A Factory Map scope node with its mapped repos and per-repo access" width="900">
  <br><sub><em>The TaskFlow scope node and its two mapped repos, each with its relation and default access. Per-repo access is a boundary the runner enforces. (Demo data.)</em></sub>
</p>

### Durable repo memory

Gaffer doesn't re-learn a repo from cold on every run. **Memory** keeps a living **Repo Digest** (overview / structure / conventions / stack) and a **feature ledger** (`backlog → building → shipped`) per repo, plus a gated **lore** knowledge base — the team's recorded conventions, decisions, and cross-repo boundaries. It's the Repo Understanding engine, and it's read-only in the product: lore is curated through the memory CLI's review gate, not silently rewritten by agents.

<p align="center">
  <img src="docs/img/memory.png" alt="A repo's digest and feature ledger in the Memory view" width="900">
  <br><sub><em>The Repo Digest for an onboarded repo — overview, structure, conventions and stack, with a freshness stamp and the honest "verify against code for high-stakes work" caveat. (Demo data.)</em></sub>
</p>

### Control you opt into

The factory is **supervised by default**: a human readies tickets, a human approves merges, memory drafts wait for review. **Settings** is where you loosen that — every autonomy flag is **off until you turn it on** (let an agent approve reviews, auto-merge on agent review, auto-approve memory). The same panel controls the idle loops that mine backlog work between tickets and the planning-debate depth.

<p align="center">
  <img src="docs/img/settings.png" alt="The Settings panel with autonomy flags, idle loops and planning debate" width="900">
  <br><sub><em>Settings — autonomy flags (all opt-in, shown off), idle loops, and planning debate. Nothing here is on by default. (Demo data.)</em></sub>
</p>

For a longer walkthrough of each surface, see [`docs/FEATURES.md`](docs/FEATURES.md).

## Architecture

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

The digest is **a map, not the territory** — a fast orientation that the factory verifies against the real code for high-stakes work, never a substitute for it. (See it in the [Durable repo memory](#durable-repo-memory) screenshot above.)

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
- No third-party skill *marketplace* yet. The 31 bundled skills load automatically — the factory injects the whole library into every ticket's agent, and `gaffer skills install` adds them to your own Claude Code. Authoring a new skill is still just dropping a `SKILL.md` into `runner/skills/`.
