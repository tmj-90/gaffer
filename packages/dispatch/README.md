# Dispatch

The **control plane** of [Gaffer](../../README.md) — the "work" component of the
Dispatch / Crew / Memory suite. It owns the backlog and the human gate: tickets,
epics, acceptance criteria, the **Factory Map** of scopes, per-repo access
boundaries, decisions/blockers, lease-based claims, AC evidence, and an
append-only event log — with every status change routed through a validated
state machine and policy packs.

Two structural guarantees make it the gate the rest of the factory leans on:

- **Lease-based claims.** A ticket is claimed atomically (one active claim each,
  enforced by a partial unique index). The claim is an opaque lease token, stored
  only as a sha256 hash, kept alive by heartbeat and reaped on expiry — so a
  crashed agent never holds work hostage.
- **The review/merge gate.** `in_review → ready_for_merge` is a human approval by
  default (an agent **cannot** approve its own work), and `ready_for_merge → done`
  is a system-only merge callback — so nothing ships on the agent's word alone.

Local-first: SQLite, stdio MCP, loopback HTTP — no cloud, no network listener by
default. See `docs/` for the full specs (product, domain model, MCP tools, state
machine + policy packs, schema).

## Build & test

```bash
pnpm install                    # native better-sqlite3 build is allow-listed in package.json
pnpm --filter dispatch build    # emits dist/ (also produced by `pnpm -r build` at the root)
pnpm --filter dispatch test     # M1 core, M2 claims/evidence, M3 MCP, audit, ops, REST API + web
```

(Inside the package, `pnpm build` / `pnpm typecheck` / `pnpm test` work directly.)

## CLI

```bash
pnpm cli -- --version               # print the Dispatch version (also -v)
pnpm cli -- --db ./.dispatch/dispatch.sqlite init
pnpm cli -- ticket create -t "Add /health endpoint" -d "Expose health" -p team_light
pnpm cli -- repo add -n api --test "pnpm test"
pnpm cli -- repo link 1 api
pnpm cli -- ac add 1 -t "GET /health returns 200"
pnpm cli -- ticket ready 1          # evaluates the policy pack
pnpm cli -- ticket show 1           # ticket + AC + repos + event log
pnpm cli -- decisions list
```

Agent / claim / evidence flow (the same operations the MCP tools expose):

```bash
pnpm cli -- agent register -n bot --max-risk high
pnpm cli -- claim -a <agentId>      # atomically claim the next ready ticket → prints a claimToken
pnpm cli -- heartbeat <claimToken>  # extend the lease
pnpm cli -- evidence 1 --token <claimToken> --type test_output --summary "tests pass" --ac <acId>
pnpm cli -- submit 1 --token <claimToken>     # → in_review
pnpm cli -- block 1 --reason "needs a decision"
pnpm cli -- expire-claims            # system recovery: release stale claims
```

(Use `-- --db <path>` or `DISPATCH_DB=<path>` to choose the database;
default is `./.dispatch/dispatch.sqlite`.)

### Operational commands

```bash
pnpm cli -- doctor      # build version, schema version, table presence, counts,
                        # STALE active claims (past expiry), integrity warnings
pnpm cli -- doctor --json   # same report as machine-readable JSON (health probes)
pnpm cli -- stats       # tickets by status, open decisions, active + stale claims
pnpm cli -- stats --json
```

`doctor` exits non-zero when a FAIL-level check fires (missing schema, a DB
written by a newer build, integrity failure), so it doubles as a health gate.

## MCP server

`dispatch-mcp` (stdio, no network listener) exposes 18 agent-facing tools.
Ticket lifecycle: `create_ticket`, `add_acceptance_criterion`,
`mark_ticket_ready`, `get_ticket`. Claim + delivery (claim-scoped):
`claim_next_ticket`, `claim_ticket`, `heartbeat_claim`, `record_ac_evidence`,
`submit_ticket_for_review`, `record_delivery_artifact`, `record_repo_delivery`,
`mark_ticket_blocked`, `release_claim`. Planning + coordination: `add_dependency`,
`create_epic`, `list_pending_decisions`, `request_decision`, and the read-only
Factory-Map summary `list_scopes`. DB path from `DISPATCH_DB`.

Each tool's description **coaches the operating agent** — when to call, what to
provide, the cost asymmetry, and the failure modes to avoid (claim one ticket
and finish it; never fabricate evidence; never self-approve; block rather than
guess). Every successful result returns both human-readable `content` text and
a machine-readable `structuredContent` of the same payload.

Every MCP tool call is recorded to an append-only **audit log** (`audit.jsonl`,
beside the DB, or `DISPATCH_AUDIT`; mode `0600`). The audit log is
content-redacted by construction: it records the tool, actor, sanitised request
(bodies → character counts, claim tokens → a presence boolean), and the result
ids/count — **never** descriptions, evidence bodies, or claim tokens. A
deliberate policy-gate refusal (a `POLICY_DENIED` transition) is recorded in a
distinct `blocked` field rather than `error`, so an operator can tell a fired
gate apart from an unexpected failure. Disable with `DISPATCH_AUDIT_OFF=1`. See
[SECURITY.md](./SECURITY.md) for the full trust model.

## Web dashboard — the control room

`dispatch-api` (`pnpm build` then `node dist/api/bin.js`, or `runner/gaffer
dashboard`) serves the local HTTP control surface — a JSON REST API plus a
graphite **control-room** single-page app — over the same facade the CLI and MCP
server use. The SPA is a framework-free ES-module app (no build step) under a
self-only CSP. It binds `127.0.0.1` by default; there is **no authentication or
RBAC yet** (every caller acts as one human actor), so do not expose it beyond
localhost. `DISPATCH_API_TOKEN` adds an optional bearer token; `--unsafe-bind` /
`DISPATCH_UNSAFE_BIND=1` is required to bind anything but loopback. Tokenless
requests pass a DNS-rebinding Host/Origin check (`/healthz` is exempt; a valid
bearer token bypasses it); when fronting the API with a reverse proxy or DNS
name, allowlist those hostnames via `DISPATCH_ALLOWED_HOSTS` (comma-separated).

```bash
node dist/api/bin.js --port 8787          # or DISPATCH_API_PORT / --host
```

The dashboard's nav is seven surfaces:

- **Overview** — the stat band (tickets by status, active/stale claims, decisions),
  a "needs you" panel, the activity feed, and the redacted tool-audit tail.
- **Work** — one ticket surface, switchable **board ⇄ list**, with status columns
  and URL-persisted filters.
- **Review** — the `in_review` queue with approve/reject forms and a computed diff
  viewer (the gate verifies the real git diff, not the agent's word).
- **Epics** — build plans, phases, and dependencies.
- **Map** — the **Factory Map**: scope-graph nodes + edges + repo associations.
- **Memory** — per-repo **Repo Digest**, the **feature ledger** (Current / Building
  / Backlog), read-only **lore**, and the **"Onboard a repo"** button (POSTs
  `/repos/onboard` to scan + register a repo and build its digest + features).
- **Settings** — the UI-editable factory config (autonomy flags, caps, idle-loop
  toggles); env-locked keys render read-only because **env always wins**.

A New-ticket **Create** form and a `Cmd+K` command palette (navigate, suggest
work, plan a build, onboard a repo) round it out.

It is backed by read-model endpoints and mutating REST routes:

- `GET /api/dashboard`, `GET /api/board`, `GET /api/activity?limit=&offset=`
- `GET /api/audit?limit=` — the redacted tool-audit tail (hidden when no log exists)
- `GET /api/settings`, `POST /api/settings` — UI-editable config (env-locked keys flagged)
- `GET /api/memory/{digest,features}/:repo`, `GET /api/memory/lore` — read the Memory store
- `GET/POST /tickets`, `/tickets/:id`, plus `/tickets/:id/{acceptance-criteria,ready,move,review/approve,review/reject,diff,scopes,repo-access,dependencies}`
- `GET/POST /scope/{nodes,edges,repos}` — Factory-Map graph ops
- `POST /epics`, `POST /repos/onboard`, `POST /plan-build`, `POST /poll-work`
- `GET/POST /decisions`, `POST /decisions/:id/resolve`
- `GET /claims`, `POST /claims/:id/revoke`
- `GET /agents`, `GET /repositories`, `GET /healthz`

Errors return a structured `{ error: { code, message, details? } }` envelope with
the DispatchError code mapped to an appropriate HTTP status.

## Autonomy flags (opt-in, gated by default)

The gate is on by default: only a human/admin actor can approve a review, and
merge is a separate system-only step. Two flags relax that deliberately —

- `DISPATCH_ALLOW_AGENT_APPROVE=1` lets an `agent`-type actor approve a review
  (`in_review → ready_for_merge`). Unset, agents structurally cannot.
- `MERGE_ON_AGENT_REVIEW=1` (a UI-editable setting consumed by the runner) fires
  the merge on an agent approval rather than waiting for a human.

Both are surfaced in the Settings panel under "autonomy"; an env var overrides the
stored value and renders the key read-only in the UI. See the root
[`SECURITY.md`](../../SECURITY.md) for the trust model and when each is safe.

## How it fits the factory

Crew claims work and records evidence against Dispatch over MCP/CLI; the runner
delivers a ticket on an isolated worktree and submits it for review; a human (or,
under the flags above, an agent) approves in the dashboard; the merge step marks
it `done` and Memory's digest + feature ledger update from the merged diff.
Dispatch is the single source of truth for *what to do* and *whether it shipped*.

## Architecture

- **State machine** (`src/services/transitionService.ts`) — the only path that
  changes `ticket.status`; validates allowed transitions, evaluates the active
  policy pack (`solo_loose` / `team_light` / `factory_strict` / `regulated`),
  applies the change with optimistic concurrency, and appends an event.
- **Claims** (`src/services/claimService.ts`) — atomic claim-next using a partial
  unique index (one active claim per ticket); opaque tokens stored only as
  sha256 hashes; heartbeat + stale-claim expiry (system recovery).
- **Core facade** (`src/core.ts`) — the single entry point used by the CLI and
  the MCP server.
