# Gaffer — Quickstart

Stand up the factory from a clean checkout and onboard your first repo. Every command
below is the real, verified path — run them in order.

---

## Prerequisites

- **Node 22 or 24** and **[pnpm](https://pnpm.io)** (`pnpm@10.33.0`, pinned via `packageManager`)
- **Git** (the factory branches per ticket, so your target repos should be git repos)
- The **`claude` CLI**, authenticated with Anthropic — the factory spawns `claude -p` agents for planning, delivery, and repo analysis; required for live runs
- **`python3`** — used by runner helpers for JSON parsing and the portable timeout shim
- `sqlite3` is handy for poking the stores, but not required

Gaffer is **local-first**: the control plane, databases, repo state, worktrees, and evidence live on your machine, against your repos, with your keys. Live agent runs use your configured Claude Code CLI, so prompts and selected repo context are sent to that model provider — treat any connected model as part of your trust boundary.

---

## 1. Install + initialise

From the repo root:

```bash
bash runner/setup.sh
```

This one command:
- installs + builds all three packages (`dispatch`, `crew`, `memory`),
- creates fresh factory state under **`.gaffer/`** (the control-plane DB, the memory store, and `crew.yaml`),
- wires the crew config at the shared dispatch database.

> State lives in `.gaffer/` next to the repo by default (override with `GAFFER_DATA`). Delete that directory to start completely fresh.

(If you only want to build, `pnpm install && pnpm -r build` does that part on its own.)

---

## 2. Onboard your first repo

```bash
runner/gaffer onboard /path/to/your/repo
```

This scans + registers the repo **and** runs a `claude -p` analysis that writes a real
**Repo Digest** (what the codebase is + how it's structured), a **Feature ledger** (the
product capabilities it ships — not infrastructure), and grounded, cited **lore drafts**
into the memory store. Re-running it is idempotent — it refreshes rather than duplicating.

> Lore lands as **drafts** (gated). Approve what's worth keeping with the memory CLI;
> nothing is auto-promoted.

---

## 3. Open the control room

```bash
runner/gaffer dashboard --lan
```

Prints a URL (`http://<your-lan-ip>:8787`) and a bearer **token** — paste the token at the
login prompt. (`runner/gaffer dashboard` without `--lan` binds loopback-only, no token.)

> **Wiring reference — always launch the dashboard via `gaffer dashboard`.** It wires
> every action command (`DISPATCH_PRODUCT_OWNER_CMD`, `DISPATCH_MERGE_CMD`,
> `DISPATCH_TICK_CMD`, `DISPATCH_ONBOARD_CMD`, `DISPATCH_TESTER_CMD`) into the API's
> environment. An ad-hoc launch (`node packages/dispatch/dist/api/bin.js`) leaves them
> unset, so the dashboard's buttons silently no-op. The API logs a
> `dispatch-api action commands — wired: …; missing: …` line at startup so a
> mis-launched dashboard is obvious. See [`.env.example`](.env.example) for the full
> wiring + knob reference.

In the dashboard (seven views):
- **Overview** — the factory at a glance (throughput, what needs you, stale claims).
- **Work** — the ticket board (plan → implement → test → review).
- **Review** — the human gate: tickets wait here for your approval before any merge occurs. This is the structural barrier that prevents the agent from shipping its own work.
- **Epics** — group and track tickets by epic.
- **Map** — the Factory Map: repo registration, scope nodes, and unmapped repos.
- **Memory** — pick your repo to read its digest, feature ledger, and lore. The **Onboard a repo** button does step 2 from the UI.
- **Settings** — every operator knob, grouped: **autonomy**, the **delivery** cycle (auto-merge · push · PR · require-CI), **execution** & concurrency, **idle loops**, **budget & caps**, the **planning debate**, **quality gates**, the strict **sandbox**, and **notifications** — all editable, persisted to `settings.json` (a real env var always wins, and shows read-only when set).

```bash
runner/gaffer status     # what's registered + running
```

---

## 4. Run the factory

The factory works tickets through **plan → implement → test → review**, each in a throwaway
git worktree, behind a deterministic safety hook.

```bash
runner/gaffer demo                    # watch the whole loop, dry-run (never touches a repo or calls Claude)
DRY_RUN=1 bash runner/tick.sh         # preview a single tick
```

When you're ready to let it deliver for real, read **`runner/preflight.sh`** first, then:

```bash
bash runner/preflight.sh              # verify the environment
DRY_RUN=0 bash runner/loop.sh         # go live — ONE pass: drains the ready queue, then exits
runner/gaffer run --daemon            # walk away: re-runs the loop every 30s (Linux + macOS),
                                      #   honours MAX_TICKS_PER_DAY; SIGINT/SIGTERM stops cleanly
```

> **Readying a ticket needs a reviewer under the strict policy packs.** The default
> policy pack is `solo_loose`, which readies freely. But tickets under
> **`factory_strict`** or **`regulated`** — which is what the **Product Owner**
> ("Suggest work") drafts, and what you'll use for anything you actually gate —
> **must have a reviewer assigned first**, or **Mark ready** fails with
> `POLICY_DENIED … REVIEWER_REQUIRED`. Assign one from the CLI (the dashboard
> button for this is planned):
>
> ```bash
> # use the FULL ticket id (the 8-char short ref won't resolve here)
> node packages/dispatch/dist/cli/index.js ticket set-reviewer <FULL-TICKET-ID> --reviewer <your-name> --admin
> ```
>
> Then **Mark ready** succeeds, and the ticket flows plan → implement → test →
> review as normal. (The reviewer is *who owns the gate*; the agent still cannot
> approve or merge its own work.)

---

## 5. Build a whole new app from one line (greenfield)

You don't need an existing repo. From the dashboard, the **Plan a build** chat turns a
one-line brief into a phased, dependency-ordered epic — including a **bootstrap** ticket
that *creates a new repo* for the app, which the factory then onboards and delivers into.

1. **Plan it (UI).** Command palette (`Jump to…`) → **Plan a build** → keep **New app —
   greenfield** selected → type one line (e.g. *"a full-stack calculator: a backend HTTP
   API that evaluates arithmetic expressions and a web front-end that calls it"*) → send.
   Review the proposed phases → **Create these tickets** (they land as **draft**).
2. **Ready them.** Move the epic's tickets `draft → ready` (drag on the board, or
   `runner/gaffer` / the CLI). Phase 1 is the bootstrap; the rest are gated behind it.
3. **Deliver.** Run the loop (`DRY_RUN=0 bash runner/loop.sh`). The bootstrap ticket
   creates the new repo at `<repo-parent>/<slug>`, the factory registers + onboards it,
   and the dependent tickets deliver into it in dependency order.

> **The loop delivers to `in_review`; it does not merge.** Approve each ticket in the
> **Review** view (or enable the opt-in autonomy flags below for hands-off runs). The
> bootstrap ticket has no delivery branch — approving it marks it merged directly.

### Greenfield gotchas (things you currently have to do)

- **The DoD test gate's worktree dependencies now install automatically.** A feature
  ticket runs its test command in a **fresh throwaway worktree that has no `node_modules`**.
  Before the Definition-of-Done gate runs, the factory now auto-installs that worktree's
  dependencies (detecting the package manager from the lockfile — `pnpm-lock.yaml` → pnpm,
  `package-lock.json` → npm, `yarn.lock` → yarn) so the tests can actually run. It is a
  no-op when `node_modules` already exists or the repo is not a node project, is bounded by
  a timeout, and is fail-soft — a failed install never crashes the tick and never passes the
  gate (the gate still runs and fails loudly). This is **on by default** (`GAFFER_DOD_INSTALL=1`);
  set `GAFFER_DOD_INSTALL=0` (or `GAFFER_GREENFIELD_INSTALL=0`) to manage deps yourself. The
  old workaround of setting `GAFFER_ALLOW_NO_DOD=1` for the first greenfield pass is no longer
  needed just to get past missing deps.
- **Hands-off delivery is opt-in.** Without the autonomy flags, the loop stops at
  `in_review` and waits for you. For an unattended greenfield run, set
  `DISPATCH_ALLOW_AGENT_APPROVE=1` (and, if you want auto-merge, `AUTO_MERGE=1`).
- **A stuck ticket is safe to drag back.** Moving a `blocked` card to `ready` on the board
  re-queues it cleanly (its delivery claim is released), so a parked ticket never strands.

---

## Safety (read before going live)

Gaffer runs shell-capable agents, so containment is first-class — but it is **run-at-your-own-risk** software:

- A **deterministic PreToolUse safety hook** scopes writes to the per-ticket worktree, blocks secret reads, and **fails closed**.
- Every ticket runs in a **throwaway git worktree** — your real checkout is never touched.
- The **review/merge gate is server-side** — by default a human approves every merge and an agent **structurally cannot** ship its own work.

Full autonomy is **opt-in**, off by default: `DISPATCH_ALLOW_AGENT_APPROVE`, `MERGE_ON_AGENT_REVIEW`, `MEMORY_AUTO_APPROVE`. See [`SECURITY.md`](SECURITY.md) for the threat model and honest residual limits.

---

## Where things live

| Path | What |
|---|---|
| `packages/dispatch` | control plane — tickets/epics/scopes, review gate (REST + MCP + dashboard + CLI) |
| `packages/crew` | factory runtime — MCP tools, hooks, idle loops, onboarding |
| `packages/memory` | durable gated memory — digest + feature ledger + lore (`memory-mcp`) |
| `runner/` | the bash orchestrator, the skill library, the safety hook |
| `.gaffer/` | your factory state (DBs, agent id, config, token) — git-ignored |
