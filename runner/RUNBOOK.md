# Gaffer: build and run by hand (advanced)

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

- macOS or Linux. OS-level containment: `sandbox-exec` (macOS, write-only) or `docker` (any host with a daemon; read + egress isolation), auto-detected; see [docs/sandbox.md](../docs/sandbox.md)
- Node 22.22.1 or newer, or 24 (`engines` in `package.json` is enforced) · pnpm 10 · git · perl (the portable timeout shim; present on macOS and every mainstream Linux)
- The agent CLI (`claude`), only needed to run the *live* factory

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
#   views: Overview · Work · Review · Epics · Map · Specs · Memory · Squad · Floor · Health · Settings
```

Prefer `runner/gaffer dashboard`, which wires the action commands and prints the
`?token=` URL. Every data request needs the auto-provisioned bearer token (only the
SPA shell and `/healthz` are tokenless). Loopback-only by default: a bind guard refuses
non-loopback hosts unless you pass `--unsafe-bind` (or `DISPATCH_UNSAFE_BIND=1`). Run it
backgrounded with `nohup … &` to keep it up across shells.

`runner/gaffer dashboard` refuses a port that something else holds and names its pid.
`--restart` stops the running server (the one its pid file names, or the port's
listener when that is this factory's dashboard), rotates the login token and starts a
new one; `--stop` stops it. A server that does not answer within
`GAFFER_DASHBOARD_START_TIMEOUT` seconds (30 by default) is stopped and its output kept
in `.gaffer/dashboard-failed.log`; `.gaffer/dashboard.log` is only replaced once a new
server is up.

**Named credentials.** The shared token acts as one operator identity. To give each
person (or CI job) their own credential whose writes are attributed to them in the
event log, mint a principal from Settings → Access in the dashboard, or:

```bash
runner/gaffer wg principal create alice            # full: read + write
runner/gaffer wg principal create ci-viewer --read # GET routes only
runner/gaffer wg principal list
runner/gaffer wg principal revoke ci-viewer
```

The token (`gfp_…`) is printed once; only its hash is stored. `GET /api/whoami` tells
a caller which principal and capability its token carries.

**Signed principals.** Each principal is signed with the factory key when it is created.
A principal without a valid signature cannot sign in (401, as an unknown token): one
created before this was added, one restored from a backup, or one written into the
database outside the factory. `gaffer wg doctor` and Settings name them. Review them,
then re-sign the ones you recognise and revoke the rest:

```bash
runner/gaffer wg principal unsigned          # who, what it may do, where, made by whom; prints a code
runner/gaffer wg principal resign alice --confirm <its review_code>   # one, after review
runner/gaffer wg principal resign --all --confirm <code>   # the list you reviewed (creation on record)
runner/gaffer wg principal revoke stranger   # one you did not create
```

Check every row: a process that can write the database can forge a row AND a matching
creation event, so "creation on record" is not proof; only you know which sign-ins you
made. The codes change if a row is added or changed after you looked, and the re-sign then
signs nothing.

Only the operator re-signs (a principal token is refused, agents are refused by the
safety hook). After restoring the database from a backup: `gaffer wg gate-key reanchor`,
then re-sign. A lost factory key means every principal must be re-signed under the new
one (`gaffer setup` creates it), as every approval must be re-approved.

**Sealed autonomy.** Autonomy policy rows, ticket risk levels and lifts of a step-down
are signed with the factory key too. An unsigned `auto` row grants nothing (the ladder
says "Not signed: a person decides"), and a ticket whose risk is not signed is decided as
the highest risk. After an upgrade, a restore or a lost key, review and re-sign the rows
you turned on yourself:

```bash
runner/gaffer wg autonomy unsigned                        # each row: repo, risk, gate, mode, who, when; prints codes
runner/gaffer wg autonomy resign <id> --confirm <its review_code>
runner/gaffer wg autonomy risk-unsigned                   # open tickets whose risk is not signed, per risk
runner/gaffer wg autonomy risk-resign --all --confirm <code>
```

A ticket an agent created through MCP is signed at its first claim, with no act needed.
Only a person re-signs: an admin principal or the operator, never an agent (the safety
hook refuses both verbs) and never MCP.

The dashboard's action buttons (Suggest work, Merge, Poll for work, Onboard) need
their commands in the API's environment; `gaffer dashboard` wires them, and
[`.env.example`](../.env.example) lists them if you start `api/bin.js` by hand.

---

## 4. Register the MCP servers with your agent CLI

The agent works **through MCP**. The servers are **stdio**: there is no daemon to
start; the MCP client (the agent CLI) spawns them on demand. Register them once (paths
are relative to the repo root; use absolute paths if you register from elsewhere):

```bash
claude mcp add dispatch  --env DISPATCH_DB=.gaffer/dispatch.sqlite \
  -- node packages/dispatch/dist/mcp/bin.js
claude mcp add memory  --env MEMORY_DB=.gaffer/memory.sqlite \
  -- node packages/memory/dist/bin/memory-mcp.js
claude mcp add crew \
  -- node packages/crew/dist/mcp/bin.js -c .gaffer/crew.yaml   # optional: factory-level tools
```

Or use the project-local config: `runner/.mcp.json` already declares `dispatch`
+ `memory` (the runner substitutes the DB paths per tick). In the agent CLI, `/mcp`
lists the servers and their tools: `dispatch` (the generated table in
[`packages/dispatch/README.md`](../packages/dispatch/README.md#mcp-server)), `memory`
(`search_lore`, `get_lore`, `suggest_lore`, ...) and `crew` (`get_factory_status`,
`list_repos`, `get_context_packet`, `run_idle_loop`, ...).

---

## 5. Onboard a repo + build a Factory Map

**One-command onboard** (registers in Dispatch, scans stack/commands/context, seeds
tags, all in one). Repos are registered ONCE, in Dispatch; the orchestrator reads
them from there, so you don't register anywhere else:

```bash
node packages/crew/dist/cli/index.js -c .gaffer/crew.yaml \
  repo onboard /abs/path/to/repo --standalone        # or --scope <nodeId> to map it
```

(NB: `crew.yaml`'s `dispatch.local.sqlite_path` must point at the factory db:
`<repo-root>/.gaffer/dispatch.sqlite`, so onboard lands in the right place.)

**Or the minimal register + map by hand** (or the dashboard's Factory Map tab):

```bash
WG="node packages/dispatch/dist/cli/index.js --db .gaffer/dispatch.sqlite"
$WG repo add -n myservice --path ~/git/myservice --branch main --test "pnpm test"
NODE=$($WG scope node create -n "My Product" -t product | node runner/lib/json-tool.mjs expr 'd.node.id')
$WG scope repo link "$NODE" myservice --relation owns --access write
```

Unmapped repos still work: they behave as their own single-repo scope (mono-fallback).
A running dashboard sees CLI-registered repos straight away (it reads the db on every
request).

---

## 6. Run it

The rest is the same as the [quickstart](../quickstart.md#5-run-the-factory):
`runner/gaffer demo`, `runner/gaffer run --dry-run`, then `runner/gaffer run` with a
dollar cap. Strict mode and the sandbox providers are in
[docs/sandbox.md](../docs/sandbox.md).

### Abandoned delivery branches

Before a tick measures a repo's branch pressure it sweeps the `gaffer/ticket-<n>-...`
branches of tickets marked Won't do. It never deletes them. A branch is swept only when
all of these hold: the ticket reads `cancelled`, this factory's own branch ledger
(`$GAFFER_DATA/branch-ledger.tsv`) says it cut exactly that branch for that ticket (by
ticket id, so a reset factory or a second data dir on the same checkout never touches an
older factory's branch), the branch was never kept for rework or a pause (a "preserved"
row), no delivery row names it, it is unmerged, and no worktree has it checked out.
Won't do can be undone, so a swept branch is moved, not dropped: its tip is written to
`refs/gaffer/abandoned/<branch>-<sha12>` first, and the factory log says so
(`SWEEP: archived abandoned branch ...`). To bring one back:

```bash
git for-each-ref refs/gaffer/abandoned/          # list archived branches
git branch gaffer/ticket-7-add-login refs/gaffer/abandoned/gaffer/ticket-7-add-login-0123456789ab
git update-ref -d refs/gaffer/abandoned/gaffer/ticket-7-add-login-0123456789ab   # drop one for good
```

Branches cut before the ledger existed have no row and are kept; a cancelled ticket's
branch does not count toward the branch cap either way.

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
| Config + stop conditions | `runner/config/*.sh` (through `runner/factory.config.sh`); every knob, default and reader: [`docs/CONFIG.md`](../docs/CONFIG.md) |
| Event-log integrity | `dispatch events verify` (also a `dispatch doctor` check and the Health view's "Event log" card): the sha256 hash chain over `work_events` |
| One tick's trail | `dispatch events list --correlation <GAFFER_TICK_ID>`: every event the runner and the agent wrote during that tick |
| Lore history | `memory history <id>`: every earlier version of a record |

Architecture + status: [`../README.md`](../README.md) · [`runner/README.md`](README.md).
