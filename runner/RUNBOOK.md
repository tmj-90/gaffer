# Gaffer — build & run from fresh (advanced)

> **Advanced reference.** The canonical day-one path is the root
> [`README.md`](../README.md) → [`quickstart.md`](../quickstart.md) →
> [`SECURITY.md`](../SECURITY.md) → [`runner/README.md`](README.md). This RUNBOOK
> is the by-hand, component-by-component view for when you need to drive each
> piece directly. Everything here can also be done with `runner/setup.sh` +
> `runner/gaffer`.

Gaffer is **one monorepo**. The components live side by side under a single root;
the runner derives every path from its own location, so any checkout root works.

```
<repo-root>/
  packages/dispatch/   work control plane   — MCP · REST + web dashboard · CLI
  packages/crew/       factory runtime lib  — MCP · CLI
  packages/memory/     memory (Memory)      — MCP · CLI
  runner/              the orchestrator     — bash: tick/loop, safety hook, skills, demo
```

State (dbs, config, logs) lives **outside** the packages, in `<repo-root>/.gaffer/`.

---

## 0. Prerequisites

- macOS (Linux works; `sandbox-exec` strict mode is macOS-only — see `STRICT_MODE.md`)
- Node ≥ 20 · pnpm · git · python3 (the runner uses small python helpers)
- Claude Code CLI (`claude`) — only needed to run the *live* factory

```bash
node --version && pnpm --version && claude --version
```

---

## 1. Build the TypeScript packages

```bash
pnpm install        # one workspace — all packages, one lockfile
pnpm -r build       # builds dispatch, crew, memory
# the runner is bash — nothing to build. Verify its hook:
node runner/test/safety-hook.test.mjs
```

---

## 2. Initialise factory state

**Easy path** (does install/build + dbs + config under `<repo-root>/.gaffer/`):

```bash
runner/setup.sh        # bootstrap everything
runner/preflight.sh    # PASS/WARN/FAIL readiness report
```

**Manual equivalent** (run from the repo root):

```bash
mkdir -p .gaffer
node packages/dispatch/dist/cli/index.js --db .gaffer/dispatch.sqlite init
node packages/crew/dist/cli/index.js init -c .gaffer/crew.yaml   # writes a config template — edit repos
# memory.sqlite is created on first use (MEMORY_DB env)
```

After this, `.gaffer/` holds: `dispatch.sqlite`, `memory.sqlite`,
`crew.yaml`, `safety_policy.yaml`, `agent_id`, `factory.log`.

---

## 3. Start the dashboard (Dispatch web UI + REST)

```bash
DISPATCH_DB=.gaffer/dispatch.sqlite \
  node packages/dispatch/dist/api/bin.js --port 8787
# → http://127.0.0.1:8787
#   tabs: Dashboard · Board · Tickets · Factory Map · Decisions
```

Loopback-only by default — a bind guard refuses non-loopback hosts unless you pass
`--unsafe-bind` (or `DISPATCH_UNSAFE_BIND=1`). Run it backgrounded with `nohup … &` to
keep it up across shells.

**"Suggest work" button** (`POST /product-owner/runs`): the dashboard runs the
product-owner skill headlessly to file fresh draft tickets. It needs two env vars on
the dashboard process — `gaffer dashboard` exports both for you; if you start
`api/bin.js` by hand, set them yourself:

```bash
DISPATCH_DB=.gaffer/dispatch.sqlite \
  DISPATCH_PRODUCT_OWNER_CMD="node runner/bin/product-owner-run.mjs" \
  DISPATCH_PRODUCT_OWNER_REPO=<repo-name> \
  node packages/dispatch/dist/api/bin.js --port 8787
```

- `DISPATCH_PRODUCT_OWNER_CMD` — the headless runner the button spawns (detached).
  Unset ⇒ the button errors `NOT_CONFIGURED`. Defaulted in `factory.config.sh`.
- `DISPATCH_PRODUCT_OWNER_REPO` — the repo NAME (as registered in dispatch) to
  suggest work for; the runner resolves it to its local path via `DISPATCH_DB` and
  files 3–5 **draft** tickets against it (a human triages them on the board). The
  run is headless (never asks questions) and bounded (`GAFFER_PO_MAX_TICKETS`,
  default 5; `GAFFER_PO_TIMEOUT_MS`, default 600000).

---

## 4. Wire the MCP servers into Claude Code

The agent works **through MCP**. The servers are **stdio** — there is no daemon to
start; an MCP client (Claude Code) spawns them on demand. Register them once (paths
are relative to the repo root — use absolute paths if you register from elsewhere):

```bash
claude mcp add dispatch  --env DISPATCH_DB=.gaffer/dispatch.sqlite \
  -- node packages/dispatch/dist/mcp/bin.js
claude mcp add memory  --env MEMORY_DB=.gaffer/memory.sqlite \
  -- node packages/memory/dist/bin/memory-mcp.js
claude mcp add crew \
  -- node packages/crew/dist/mcp/bin.js -c .gaffer/crew.yaml   # optional: factory-level tools
```

Or use the project-local config: `runner/.mcp.json` already declares `dispatch`
+ `memory` (the runner substitutes the DB paths per tick). In Claude Code, check
`/mcp`:

```
dispatch   16 tools  (create_ticket, claim_ticket, get_ticket, record_ac_evidence, …)
memory    7 tools  (search_lore, get_lore, suggest_lore, …)
crew   8 tools  (get_factory_status, list_repos, get_context_packet, run_idle_loop, …)
```

---

## 5. Onboard a repo + build a Factory Map

**One-command onboard** (registers in Dispatch, scans stack/commands/context, seeds
tags — all in one). Repos are registered ONCE, in Dispatch; the orchestrator reads
them from there, so you don't register anywhere else:

```bash
node packages/crew/dist/cli/index.js -c .gaffer/crew.yaml \
  repo onboard /abs/path/to/repo --standalone        # or --scope <nodeId> to map it
```

(NB: `crew.yaml`'s `dispatch.local.sqlite_path` must point at the factory db —
`<repo-root>/.gaffer/dispatch.sqlite` — so onboard lands in the right place.)

**Or the minimal register + map by hand** (or the dashboard's Factory Map tab):

```bash
WG="node packages/dispatch/dist/cli/index.js --db .gaffer/dispatch.sqlite"
$WG repo add -n myservice --path ~/git/myservice --branch main --test "pnpm test"
NODE=$($WG scope node create -n "My Product" -t product | python3 -c 'import sys,json;print(json.load(sys.stdin)["node"]["id"])')
$WG scope repo link "$NODE" myservice --relation owns --access write
```

Unmapped repos still work — they behave as their own single-repo scope (mono-fallback).
**Note:** restart the dashboard (`api/bin.js`) after CLI-registering repos while it's
running — it reads the db at startup.

---

## 6. See the whole loop WITHOUT going live

```bash
cd runner
DRY_RUN=1 bash demo.sh   # setup + Factory Map + confirmed boundary, no agent
bash demo.sh             # live showcase (needs `claude`): scope → isolated
                                     # worktrees → real agent → tests → enforced read-only
                                     # → clean checkout → per-repo delivery evidence
```

---

## 7. Go LIVE — the actual factory

```bash
cd runner
# review claude/settings.json (permissions) and factory.config.sh first
DRY_RUN=0 bash loop.sh               # real Claude ticks; delivers ready tickets in worktrees
```

- **Safety:** the PreToolUse hook (`safety-hook.mjs`) is the boundary; the human never
  pastes code or secrets. Run **one supervised ticket** before any unattended run.
- **Isolation:** each delivery runs in a throwaway git worktree — the real checkout is
  never touched; a failed run rolls back to nothing.
- **Strict mode (optional, OS-level containment):**
  `STRICT_MODE=1 DRY_RUN=0 bash loop.sh` — see `STRICT_MODE.md` (best-effort, provider
  model; `sandbox-exec` on macOS).

---

## Reference

| Thing | Where (relative to repo root) |
|---|---|
| Dashboard | `http://127.0.0.1:8787` ← `packages/dispatch/dist/api/bin.js --port 8787` |
| Dispatch MCP | `packages/dispatch/dist/mcp/bin.js` (`DISPATCH_DB`) |
| Memory MCP | `packages/memory/dist/bin/memory-mcp.js` (`MEMORY_DB`) |
| Crew MCP | `packages/crew/dist/mcp/bin.js` (`-c crew.yaml`) |
| CLIs | `packages/<dispatch\|crew>/dist/cli/index.js` · `packages/memory/dist/bin/memory.js` |
| State (dbs/config/logs) | `<repo-root>/.gaffer/` |
| Config + stop conditions | `runner/factory.config.sh` |

Architecture + status: [`../README.md`](../README.md) · [`runner/README.md`](README.md).
