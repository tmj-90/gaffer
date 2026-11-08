# Dispatch

The **control plane** of [Gaffer](../../README.md): the "work" component of the
Dispatch / Crew / Memory suite. It owns the backlog and the human gate: tickets,
epics, acceptance criteria, the **Factory Map** of scopes, per-repo access
boundaries, decisions/blockers, lease-based claims, AC evidence, and an
append-only event log, with every status change routed through a validated
state machine and policy packs.

Two structural guarantees make it the gate the rest of the factory leans on:

- **Lease-based claims.** A ticket is claimed atomically (one active claim each,
  enforced by a partial unique index). The claim is an opaque lease token, stored
  only as a sha256 hash, kept alive by heartbeat and reaped on expiry, so a
  crashed agent never holds work hostage.
- **The review/merge gate.** `in_review → ready_for_merge` is a human approval by
  default (an agent **cannot** approve its own work), and `ready_for_merge → done`
  is a system-only merge callback, so nothing ships on the agent's word alone.

Local-first: SQLite, stdio MCP, loopback HTTP, no cloud, no network listener by
default. The live MCP tool list is the generated table under
[MCP server](#mcp-server), and the REST contract is
[`docs/openapi.json`](../../docs/openapi.json).

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
pnpm cli -- ticket create -t "Fix login" --repo api   # with its write repo in one step (repeatable)
pnpm cli -- repo add -n api --test "pnpm test"
pnpm cli -- repo link 1 api
pnpm cli -- ac add 1 -t "GET /health returns 200"
pnpm cli -- ticket ready 1          # evaluates the policy pack
pnpm cli -- ticket show 1           # ticket + AC + repos + event log
pnpm cli -- ticket edit 1 -d "why"  # title / description / policy / priority (until claimed)
pnpm cli -- ac edit 1 1 --verify "unit test"   # criterion 1 by position, or its id
pnpm cli -- ac rm 1 2
pnpm cli -- block 1 --reason "waiting on infra"   # as you ($USER); `unblock 1` returns it
pnpm cli -- decisions list
```

A ticket's contract (title, description, policy, criteria, check commands) is editable
in draft, refining, ready and blocked; from claimed on every contract edit, `ac add`
included, is refused with `CONTRACT_FROZEN`. The test contract (`ticket test-contract`)
stays editable through `in_review` and is frozen from `in_testing` on.

Agent / claim / evidence flow (the same operations the MCP tools expose):

```bash
pnpm cli -- agent register -n bot --max-risk high
pnpm cli -- claim -a <agentId>      # atomically claim the next ready ticket → prints a claimToken
pnpm cli -- heartbeat <claimToken>  # extend the lease
pnpm cli -- evidence 1 --token <claimToken> --type test_output --summary "tests pass" --ac <acId>
pnpm cli -- submit 1 --token <claimToken>     # → in_review
pnpm cli -- block 1 --token <claimToken> --reason "needs a decision"   # the agent's own claim
pnpm cli -- expire-claims            # system recovery: release stale claims
```

(Use `-- --db <path>` or `DISPATCH_DB=<path>` to choose the database;
default is `./.dispatch/dispatch.sqlite`.)

### Startup

The runner spawns `dispatch` dozens of times per tick, so its startup is kept small.
`--version` and `-v` print before anything else loads. The command tree (every name,
option and help line) is built from light modules only, so `--help` and
`help <command>` never load the database layer or zod. An action loads those in a
preAction hook just before it runs (`src/cli/runtime.ts`); a new command module
imports only light modules and reaches the database through `runtime.ts`
(`test/cli-lazy-load.test.ts` fails otherwise). The CLI, API and MCP entries turn on
Node's compile cache first. It lives in this package's own
`node_modules/.cache/node-compile-cache`, not in the temp dir: Node runs whatever
bytecode it finds there, so the cache has to be exactly as writable as `dist/`, and a
strict-mode agent may write the temp dirs. `$NODE_COMPILE_CACHE` overrides the place
(only point it somewhere no agent can write), `NODE_DISABLE_COMPILE_CACHE=1` turns it
off, and an install the user cannot write just runs uncached. A database already at
the current schema version opens without running any schema SQL unless a table or
index is missing. `node scripts/bench-cli.mjs` prints the median startup of the common
calls.

A read command still takes about 220 ms of CPU, against a 120 ms target. Measured on a
loaded 4-CPU box (CPU medians, compile cache warm), what is left and what it would take:

- Loading the action modules (`src/cli/heavy.ts`) costs about 160 ms over a bare
  `node`: zod with the zod 3 error map about 40 ms, the domain schemas another 20 to
  25 ms, the rest of the core about 100 ms.
- zod's locales: 64 of the 95 zod modules are locales its entry re-exports. Stubbing
  them out saved 10 to 30 ms per command. It needs every `from "zod"` (the MCP
  schemas and the zod 3 error map included) to go through an entry that does not
  re-export them, so it is not a CLI-only change.
- Building the domain schemas lazily (they are built when `src/domain/schemas.ts`
  loads) would save most of those 20 to 25 ms, but every service validates with them:
  a refactor of the domain layer.
- Bundling the action modules with esbuild took `ticket list` from 239 to 173 ms (a
  quarter). Left out because a bundle duplicates the classes the unbundled error
  boundary matches with `instanceof` (DispatchError, ZodError) unless the whole CLI is
  bundled with code splitting, it adds a build step and a dependency, and
  `src/version.ts` reads `package.json` relative to its own file.

### Output, errors and exit codes

Every command prints JSON on stdout, except `doctor`, `stats`, `human-queue` and the
`events` commands, which print text unless given `--json`. Every command accepts
`--json`, so a script can pass it everywhere; where JSON is already the default it
changes nothing.

A failure is one JSON line on stderr, the same shape for every command:

```json
{"ok":false,"code":"VALIDATION_ERROR","message":"--priority must be a whole number between 0 and 1000","details":{"issues":[{"path":["priority"],"message":"Expected number, received nan"}]}}
```

`code` is stable (the same codes the REST API uses), `message` is for a person and
`details` (when present) carries the machine-readable rest, such as the raw validation
`issues`. Exit codes: `0` done, `1` refused or failed (the error line says why), `2` a
usage error: an unknown command or option, a missing argument or required option, or no
database at `--db` (only `init`, and `import` restoring into a new file, create one). A database another process holds locked for
more than 5 s is `DB_BUSY`: retry. A reader that stops early (`| head -1`) is not an error: the command
keeps its own exit code and prints no `EPIPE` trace.

#### CLI and REST key names

`ticket show` and `GET /tickets/:id` return the same data under different key names:
the CLI prints Dispatch's own view object (camelCase), the REST API snake_case. I have
kept both as they are, since scripts already read each; map them when you switch:

| `ticket show` (CLI)  | `GET /tickets/:id` (REST)                                   |
| -------------------- | ----------------------------------------------------------- |
| `acceptanceCriteria` | `acceptance_criteria`                                       |
| `blockingDecisions`  | `blocking_decisions`                                        |
| `reworkTrail`        | `rework_trail`                                              |
| `landing`            | `ticket.landing_state` (approved and held tickets only)     |
| (not printed)        | `agent_display` (display names of the agents it names)      |
| `resolvedDecisions`, `testContract` | not in this response                         |

`ticket`, `repositories`, `scopes`, `dependencies`, `evidence` and `events` have the
same name in both.

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

`dispatch-mcp` (stdio, no network listener) exposes the agent-facing tools below.
DB path from `DISPATCH_DB`. Claim-scoped writes (evidence, block, submit,
delivery artifact) need the claim token; in the factory (`GAFFER_FACTORY=1`)
claiming, readying and submitting are runner-owned, and every other ticket write
is bound to the ticket the runner mounted the server for. The table is generated
from the code (`node scripts/mcp-tools-doc.mjs`; a test fails when it drifts):

<!-- mcp-tools:start -->
<!-- generated by scripts/mcp-tools-doc.mjs from src/mcp/tools.ts + src/mcp/server.ts — do not edit by hand -->

24 tools:

| Tool | Arguments | What it is for |
| --- | --- | --- |
| `create_ticket` | `title`, `description?`, `priority?`, `risk_level?`, `policy_pack?`, `repo?` | Create a unit of work as a DRAFT. |
| `add_acceptance_criterion` | `ticket_id`, `text`, `verification_method?`, `evidence_required?`, `check_command?` | Add ONE concrete, checkable acceptance criterion to a draft ticket. |
| `mark_ticket_ready` | `ticket_id` | Promote a fully-specified ticket from draft to 'ready' (claimable). |
| `claim_next_ticket` | `agent_id`, `ttl_seconds?`, `capabilities?` | Claim exactly ONE ticket, then work it to completion before claiming again. Do NOT hoard. |
| `claim_ticket` | `ticket_id`, `agent_id`, `ttl_seconds?`, `capabilities?` | Claim a SPECIFIC, chosen ticket — use this when you've already selected the ticket you intend to work, not just 'whatever's next'. |
| `get_ticket` | `ticket_id` | Read the full picture of one ticket before acting on it |
| `heartbeat_claim` | `claim_token` | Extend your claim's lease during long work — call it BEFORE the lease expires, not after. |
| `record_ac_evidence` | `claim_token?`, `ticket_id`, `ac_id?`, `repo_id?`, `evidence_type`, `summary`, `uri?`, `payload?` | Record REAL, verifiable evidence for the work you actually did — one call per acceptance criterion you're satisfying. |
| `mark_ticket_blocked` | `claim_token?`, `ticket_id`, `reason` | Block the ticket when you're genuinely stuck on something you cannot and should not decide yourself |
| `submit_ticket_for_review` | `claim_token?`, `ticket_id`, `reason?` | Submit your claimed ticket for human review once every acceptance criterion is satisfied with real evidence. |
| `record_delivery_artifact` | `claim_token`, `ticket_id`, `branch_name?`, `pr_url?`, `commit?`, `diff_summary?` | Record WHERE you delivered the work — the branch and/or PR — so reviewers read it from Dispatch instead of grepping. |
| `record_repo_delivery` | `ticket_id`, `repo_id`, `branch_name?`, `commit_sha?`, `pr_url?`, `status?`, `evidence_ref?` | Record WHERE one repo's slice of a multi-repo ticket was delivered — its branch, commit, PR and a delivery `status`. |
| `add_dependency` | `ticket`, `depends_on` | Declare that one ticket must wait for another to be `done` before it can be claimed. |
| `set_ticket_testable` | `ticket_id`, `can_be_tested` | Mark a ticket eligible (or not) for the independent black-box testing lane. |
| `set_test_contract` | `ticket_id`, `changed_surfaces?`, `runtime_deps?`, `env_vars?`, `run_command?`, `harness_ready?`, `profile?` | Record the testing HANDOVER the independent tester reads to stand the system up and probe the changed surfaces — never the implementation diff. |
| `create_epic` | `epic`, `tickets` | Create a whole dependency-ordered plan in one atomic call: an `epic` scope node that groups N draft tickets, with their acceptance criteria, per-ticket priority/risk/repo, an optional `bootstrap` (greenfield) marker, and the dependency edges between them. |
| `create_spec` | `title`, `brief?`, `clauses?`, `target_repo?`, `scope_node_id?` | Draft a spec — an AI-drafted, human-edited statement of product intent that sits in front of decompose. |
| `get_spec` | `spec_id` | Read a spec by id. |
| `freeze_spec` | `spec_id` | Freeze a draft spec — take an immutable snapshot of the intent. |
| `list_pending_decisions` | — | List the decisions awaiting a human/product answer. |
| `request_decision` | `title`, `question`, `severity?`, `ticket_id?` | Escalate a real decision to a human — a product, architectural, or security question that is not yours to answer. |
| `release_claim` | `claim_token?`, `claimToken?` | Voluntarily give a claim back when you can't continue and blocking isn't right |
| `list_scopes` | — | Read the Factory Map: the product/system scope nodes and which repos sit in each, with the default access (write/read/test/none) that scope grants. |
| `get_squad` | — | Read the squad: the club name and each registered agent's display name, shirt number and role. |

<!-- mcp-tools:end -->

### MCP error model

A failed tool call returns `isError: true` and a structured body (the same
payload in `structuredContent` and as JSON text in `content`):

```json
{
  "error": {
    "code": "CLAIM_INVALID",
    "message": "Claim token does not match an active claim on this ticket.",
    "details": {}
  }
}
```

Invalid arguments are `VALIDATION_ERROR` with the zod `issues`. The codes are the
closed `DISPATCH_ERROR_CODES` list in `src/util/errors.ts`; the ones an agent
meets most often:

```text
NOT_FOUND
VALIDATION_ERROR
POLICY_DENIED
ILLEGAL_TRANSITION
STATE_CONFLICT
CONCURRENCY_CONFLICT
CLAIM_INVALID
CLAIM_REQUIRED
TICKET_NOT_CLAIMABLE
DEPENDENCY_BLOCKED
AGENT_NOT_ELIGIBLE
ACTOR_NOT_PERMITTED
FACTORY_RUNNER_OWNED
```

Each tool's description **coaches the operating agent**: when to call, what to
provide, the cost asymmetry, and the failure modes to avoid (claim one ticket
and finish it; never fabricate evidence; never self-approve; block rather than
guess). Every successful result returns both human-readable `content` text and
a machine-readable `structuredContent` of the same payload.

Every MCP tool call is recorded to an append-only **audit log** (`audit.jsonl`,
beside the DB, or `DISPATCH_AUDIT`; mode `0600`). The audit log is
content-redacted by construction: it records the tool, actor, sanitised request
(bodies → character counts, claim tokens → a presence boolean), and the result
ids/count, **never** descriptions, evidence bodies, or claim tokens. A
deliberate policy-gate refusal (a `POLICY_DENIED` transition) is recorded in a
distinct `blocked` field rather than `error`, so an operator can tell a fired
gate apart from an unexpected failure. Disable with `DISPATCH_AUDIT_OFF=1`. See
the root [SECURITY.md](../../SECURITY.md) for the full trust model.

## Web dashboard

`dispatch-api` (`pnpm build` then `node dist/api/bin.js`, or `runner/gaffer
dashboard`) serves the local HTTP control surface: a JSON REST API plus the Match Day
single-page app, over the same facade the CLI and MCP server use. The SPA is a
framework-free ES-module app (no build step) under a self-only CSP. It binds
`127.0.0.1` by default. The shared token acts as one operator; named principals
(`dispatch principal create <name> [--read] [--admin] [--repo <name>] [--ticket <n>]`)
give each person or bot its own identity, capability and scope (see the root
[SECURITY.md](../../SECURITY.md#dashboard-api-and-identity)). There is no TLS, so do not
expose it beyond localhost without a TLS-terminating proxy. Auth is a bearer token,
and it gates **every data-returning request**, whatever the token's provenance, the
HTTP method or the bind:

- `dispatch-api` **auto-provisions** a token at startup when `DISPATCH_API_TOKEN`
  is unset, a fresh 256-bit token persisted 0600 to `$GAFFER_DATA/dashboard-token`
  (an operator-set `DISPATCH_API_TOKEN` wins if present). A token is therefore
  configured in normal operation.
- **Every request that returns control-plane data must present
  `Authorization: Bearer <token>`**, including read-only GET/HEAD on a loopback
  bind. Only the public bootstrap surface (the static SPA shell + `/healthz`) is
  served tokenless, so every request that reaches the auth gate is data-bearing and
  needs the token. This is the structural stop on a same-user process (e.g. a
  token-scrubbed, prompt-injected delivery agent limited to loopback) reading
  `/api/tickets` (or self-approving over the REST API). The dashboard SPA sends the
  bearer on every call, adopting it from the `?token=` URL or the login gate.

Auth is disabled entirely only when *no* token is configured (the dev/embedder path
where the server is constructed directly).

`--unsafe-bind` / `DISPATCH_UNSAFE_BIND=1` is required to bind anything but
loopback. Tokenless requests pass a DNS-rebinding Host/Origin check (`/healthz`
is exempt; a valid bearer token bypasses it); when fronting the API with a
reverse proxy or DNS name, allowlist those hostnames via
`DISPATCH_ALLOWED_HOSTS` (comma-separated).

```bash
node dist/api/bin.js --port 8787          # or DISPATCH_API_PORT / --host
```

SIGTERM or SIGINT stops the server within about 2 seconds: it ends any open event
stream (the dashboard reconnects and loses nothing), gives in-flight requests a
short grace, then closes the database. On the way out it removes the pid file the
launcher wrote (`DISPATCH_PID_FILE`, default `$GAFFER_DATA/dashboard.pid`, which
`runner/gaffer dashboard` records), but only when the file names this process, so
a newer server's record survives an old one's exit.

The nav has eleven views: Overview, Work, Review, Epics, Map, Specs, Memory, Squad,
Floor, Health and Settings, with a Create form and a `Cmd+K` command palette (navigate,
suggest work, plan a build, onboard a repo). [docs/FEATURES.md](../../docs/FEATURES.md)
walks through each.

It is backed by read-model endpoints and mutating REST routes; the full contract is
[`docs/openapi.json`](../../docs/openapi.json). The main ones:

- `GET /api/dashboard`, `GET /api/board`, `GET /api/activity?limit=&offset=`
- `GET /api/audit?limit=`: the redacted tool-audit tail (hidden when no log exists)
- `GET /api/settings`, `POST /api/settings`: UI-editable config (env-locked keys flagged)
- `GET /api/memory/{digest,features}/:repo`, `GET /api/memory/lore`: read the Memory store
- `GET/POST /tickets`, `/tickets/:id`, plus `/tickets/:id/{acceptance-criteria,ready,move,review/approve,review/reject,diff,scopes,repo-access,dependencies}`
- `GET/POST /scope/{nodes,edges,repos}`: Factory-Map graph ops
- `POST /epics`, `POST /repos/onboard`, `POST /plan-build`, `POST /poll-work`
- `GET/POST /decisions`, `POST /decisions/:id/resolve`
- `GET /claims`, `POST /claims/:id/revoke`
- `GET /agents`, `GET /repositories`, `GET /healthz`

Errors return a structured `{ error: { code, message, details? } }` envelope with
the DispatchError code mapped to an appropriate HTTP status.

### The SPA's modules

The SPA lives in `src/api/web/`. `app.js` is the entry the page loads: it imports the
modules under `js/`, registers the page's load-time listeners and starts the router.
The server serves `/app.js`, `/js/*.js` and `/js/views/*.js` as same-origin scripts,
which `script-src 'self'` covers. A first load fetches 56 scripts instead of 2: `theme.js`,
`app.js` and its 54 modules, found in four waves (the entry's 10 imports, then 27, then 17),
all served `no-store`. On loopback the page's DOMContentLoaded moves from about 170-195 ms to
about 310 ms; the Overview itself still renders in about one second either way, bound by its
API reads.

| Module | What it holds |
| --- | --- |
| `js/api.js`, `js/state.js` | the API client and token helpers; the few bindings several modules assign |
| `js/dom.js`, `js/icons.js`, `js/format.js` | `el`/`field` and mount points; icons, glyphs, shirts, crest; formatting |
| `js/club.js`, `js/access.js`, `js/kit.js` | club and squad state; read-only and scoped access; kit colours |
| `js/toast.js`, `js/login.js`, `js/status.js` | toasts and guarded actions; the login gate; status vocabulary and ticket action sets |
| `js/components.js`, `js/sheet.js`, `js/sheets.js` | view scaffolding; the detail sheet; the action sheets |
| `js/router.js`, `js/freshness.js`, `js/chrome.js`, `js/live.js`, `js/palette.js` | routing and tab titles; Data as of; header and nav; auto refresh and the live stream; the command palette |
| `js/matchday.js`, `js/charts.js`, `js/panels.js`, `js/runs.js`, `js/diff.js` | reads shared by the views; SVG charts; shared panels; Running now; the diff |
| `js/views/*.js` | one module per view or view part: overview, teamsheet, tactics, programme, fitness, work, board, ticket, ticket-cards, acceptance, repo-panel, create, settings, formation, autonomy, health, review, review-comments, review-packet, map, scope-node, repo, epics, plan, spec-build, specs, memory, onboarding, squad, floor |

The DOM tests boot the SPA afresh per test with `import(app.js?t=<n>)`;
`test/setup-web-modules.ts` carries that query onto every module the entry imports, so
each boot gets its own instance of every module.

## Autonomy flags (opt-in, gated by default)

The gate is on by default: only a human/admin actor can approve a review, and
merge is a separate system-only step. Two flags relax that deliberately:

- `DISPATCH_ALLOW_AGENT_APPROVE=1` lets an `agent`-type actor approve a review
  (`in_review → ready_for_merge`). Unset, agents structurally cannot.
- `MERGE_ON_AGENT_REVIEW=1` (a UI-editable setting consumed by the runner) lets
  `AUTO_MERGE` land an agent-approved ticket too; it needs `AUTO_MERGE=1` as well, and on
  its own merges nothing.

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

- **State machine** (`src/services/transitionService.ts`): the only path that
  changes `ticket.status`; validates allowed transitions, evaluates the active
  policy pack (`solo_loose` / `team_light` / `factory_strict` / `regulated`),
  applies the change with optimistic concurrency, and appends an event.
- **Claims** (`src/services/claimService.ts`): atomic claim-next using a partial
  unique index (one active claim per ticket); opaque tokens stored only as
  sha256 hashes; heartbeat + stale-claim expiry (system recovery).
- **Core facade** (`src/core.ts`): the single entry point used by the CLI, the
  REST API, the MCP server and the dashboard. The `Dispatch` class opens the
  database, builds the repositories and services, and keeps every public method,
  but holds no logic of its own: each method is a one-line call into a service.
  Where a method composes several services, its body is a plain function in a
  module under `src/services/` (for example `landingFactsService.ts`,
  `reviewLifecycleService.ts`, `ticketReadService.ts`) that takes the `Dispatch`
  instance, typed as a `Pick` of exactly the members it reads, and the
  instance's private state when it needs it (`dispatchInternals.ts`). Calls
  between public methods still go through the instance. Types the services own
  stay importable from `core.ts`.
- **Review gate** (`src/services/reviewGateService.ts`): approve, the tester lane,
  required CI, landing and send-backs. `ReviewGateService` keeps its constructor,
  its deps and result types and every public method; each method is one call into
  a module under `src/services/reviewGate/`, which takes the instance (a `Pick` of
  the public methods it calls) and its private state (`internals.ts`) the same way:

  | Module | Lines | Holds |
  |---|---|---|
  | `approval.ts` | 407 | `approveReview` (human-only by default, agent-approve policy, observed-risk ceiling, reviewer is not the author), `unavailableWriteRepos`, `unavailableRepoRemedy` |
  | `staleness.ts` | 241 | reviewed heads, the shown-commit check (`stale_revision`), review and reject pins, `approvalUnchanged` |
  | `ci.ts` | 264 | `ciStatus`, `recordCiResult`, `recordCiRequired`, `approveCiHold`, the CI hold on approve and tester PASS |
  | `landing.ts` | 683 | `landingStatus`, `recordLanding`, `approvalRef`, `beginLanding`, `landingsStarted`, `markMerged`, the landed guards |
  | `sendBack.ts` | 327 | `rejectReview` (retry cap), `wontDo`, `reopenFromWontDo`, `reopenForReview`, `holdForHuman` |
  | `tester.ts` | 620 | `laneApplies`, `approveRoutesToTesting`, `testerCoverage`, `routeToTester`, `testerRoutePlan`, `routeAllToTester`, `recordTesterReplay` |
  | `testerVerdict.ts` | 599 | `testerPass`, `testerFail`, the verdict binding, `recordAcCheck` |
  | `shared.ts` | 35 | `capRetry`, the reviewer patch |
  | `internals.ts` | 41 | the facade's private state (deps and the live retry cap) |
