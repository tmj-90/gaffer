# Crew

The **factory runtime** of [Gaffer](../../README.md) — the "behaviour" component
of the Dispatch / Crew / Memory suite. It orchestrates Dispatch (work) and Memory
(memory): config + repo/agent registries, safety guards, context-packet assembly,
factory-level MCP tools, a lifecycle **hooks engine**, the repo **onboarding**
flow, and the implementation + idle coverage loops.

Crew never stores ticket or lore content — it drives them. Everything it does is
read-only or draft-only: the only state it ever writes is **draft** tickets and
**draft** lore suggestions, both of which a human ratifies later. See the numbered
specs in this package — [`01-product-spec.md`](01-product-spec.md),
[`02-runtime-architecture.md`](02-runtime-architecture.md),
[`03-safety-policies.md`](03-safety-policies.md),
[`04-loops-hooks-skills.md`](04-loops-hooks-skills.md), and
[`05-agent-and-repo-registry.md`](05-agent-and-repo-registry.md) — for the details.

## Build & test

```bash
pnpm install                 # depends on the sibling `dispatch` (workspace:*)
pnpm --filter dispatch build # the real Dispatch adapter imports the built package — build it first
pnpm --filter crew build     # emit dist/ (the `crew` + `crew-mcp` bins)
pnpm --filter crew test      # full suite incl. the end-to-end MVP integration test
```

(Inside the package, `pnpm build` / `pnpm typecheck` / `pnpm test` work directly.)

## End-to-end MVP demo

Proves the suite's first proof point — a ticket created by the idle loop is
refined, claimed, given a context packet, worked on a prefixed branch, evidenced
and moved to review, with no hand-edited DB rows:

```bash
pnpm -C ../dispatch build
pnpm exec tsx scripts/mvp-demo.ts
```

## CLI

```bash
crew init                       # scaffold crew.yaml + safety_policy.yaml
crew doctor                     # readiness pre-flight (see below)
crew stats                      # snapshot: repos, skills, idle loops, recent run outcomes
crew scan                       # scan configured repos (branch + stack)
crew run -a <agentId> --dry-run # one implementation-loop tick
crew idle                       # run every enabled idle loop (drafts only)
crew maintain                   # idle MAINTENANCE LANE: ONE scheduler-chosen loop (priority+rotation)
crew skills --capability tests  # list skills by stack/capability
crew safety check --command "git push --force"   # explain a safety decision
```

`doctor` and `stats` render human-readable output by default; pass `--json` for
the structured form.

### `crew maintain` — the idle maintenance lane

`crew idle` runs *every* enabled idle loop. `crew maintain` instead runs the
**one** maintenance loop chosen by a **deterministic priority + rotation
scheduler — no LLM in the choice** (audit item A4). It is the "factory improves
the longer it runs" promise made literal: every quiet tick spends its tokens on
the highest-leverage maintenance lane that is due.

- **Priority:** `security_hotspot` → `coverage` / `test_quality` →
  `type_quality` / `tech_debt` → `documentation` / `dependency_hygiene`.
- **Rotation:** a persisted cursor (`loops.maintenance.cursor_path`, default
  `$GAFFER_DATA/maintenance-cursor.json`) stops a high-priority lane starving the
  rest and stops the same lane being picked twice in a row. The cadence survives
  across ticks/processes.
- **Enabled flags respected:** the lane only rotates through loops whose own
  `enabled` flag is on; `loops.maintenance.enabled` gates the lane itself. OFF by
  default. Wire it into the runner with `GAFFER_MAINTENANCE=1`.

### `crew doctor`

A readiness pre-flight that answers *"is this factory actually ready to run?"*.
Each check is independent and degrades to a `warn` or a `fail` with an actionable
`fix`. It exits non-zero only on a hard `fail`, so it slots straight into CI as a
gate. The checks:

- **Config valid** — the loaded `crew.yaml` parsed and its mode.
- **Repos resolve** — every configured repo path exists on disk (`fail` if missing).
- **Active agents** — at least one agent is `status: active` to claim work.
- **Dispatch reachable** — opens the store *and issues a real read* (`listReady`),
  so a locked/corrupt DB or a schema mismatch surfaces as a `fail` rather than a
  vacuously-passing bare open.
- **Memory reachable** — the MCP memory server connects, or a clean "not
  configured (offline Null client)" when lore is intentionally absent.
- **Skills loaded** — the built-in skill registry is populated.
- **Safety policy sane** — flags relaxed guardrails (force-push allowed, no
  protected branches, redaction off).
- **Audit log** — the log path is writable, and when it already exists, its file
  mode is owner-only `0600` under a `0700` directory (warns if looser, with a
  `chmod` fix).

### `crew stats`

A factory snapshot: configured repos, skills grouped by capability, idle loops and
their target repos, and recent run outcomes read back from the audit log.

## MCP server

`crew-mcp` exposes the factory to an agent over stdio. Each tool's
description coaches the agent on when to call it, how to read the result, and what
to do on empty/failed results. Every tool returns both a text payload and a
matching `structuredContent` object. Tools are read-only or draft-only — the only
mutating tool, `run_idle_loop`, creates **draft** tickets and never edits code.

```bash
crew-mcp -c /path/to/crew.yaml   # or set CREW_CONFIG
```

The tools:

| Tool | What it does |
| --- | --- |
| `get_factory_status` | Factory mode, repo/agent/skill counts, subsystem reachability. |
| `list_agents` | Configured agents with capabilities, risk ceiling and status. |
| `list_repos` | Configured repos; optionally `scan` for live branch + stack. |
| `get_context_packet` | The full context packet for a ticket (AC, paths, policy, lore). |
| `run_idle_loop` | The one mutating tool — drafts observation-only tickets. |
| `explain_safety_policy` | The effective git/fs/command/secret guardrails. |
| `check_command_allowed` | Classify a command: `allowed` / `needs_approval` / `denied`. |
| `check_path_write_allowed` | Whether a path is writable under the repo's fs guard. |

If the server can't start, it writes a code-specific, multi-line diagnostic to
stderr (which MCP clients surface on a launch failure) and exits cleanly — e.g. a
missing config points you at `crew init`, an unbuilt Dispatch at
`pnpm -C ../dispatch build`, and anything unknown at `crew doctor`.

Every MCP tool call is recorded to an append-only, **content-redacted** audit log
(tool name + ids/counts, never prompts/contents/secrets) at `GAFFER_AUDIT`, else
`<factory>/audit.jsonl`, else `~/.crew/audit.jsonl`. Disable with
`GAFFER_AUDIT_OFF=1`. See [SECURITY.md](./SECURITY.md) for the full trust model.

## Design

- **Safety** (`src/safety/`) — three-valued decisions (`allowed` /
  `needs_approval` / `denied`): git guard (force-push, protected-branch push),
  filesystem guard (`.env`/secret files, writes outside the repo root), command
  classifier (risky installs need approval), branch policy, secret redaction.
- **Context packet** (`src/context/packet.ts`) — ticket + AC + repo paths/commands
  + branch policy + forbidden actions + relevant Memory records, with every
  free-text field run through secret redaction.
- **Dispatch boundary** (`src/dispatch/`) — Crew codes against a
  `DispatchClient` interface; `FakeDispatchClient` in tests, `RealDispatchClient`
  (thin adapter over the `dispatch` package, with camelCase↔snake_case + evidence
  vocabulary mapping) in production.
- **Loops** (`src/loops/`) — the **implementation loop** (claim → packet → branch →
  runtime → evidence → review) and the **idle loops** that run only when nothing is
  claimable and file observation-only DRAFT tickets per repo (they skip entirely
  while ready work exists): `coverage`, `test_quality`, `documentation`,
  `dependency_hygiene`, and `security_hotspot` (sync), plus the async `lore_gap`
  (proposes durable lore where Memory shows a convention gap) and `feature_backlog`
  (pulls one ledger feature and decomposes it into an epic).

  > **Where the real code-writing happens.** The implementation loop's `runtime`
  > seam is an `AgentRuntime` interface. Crew's own CLI wires the **`MockAgentRuntime`**
  > — a no-op that emits one evidence item per acceptance criterion to exercise the
  > loop end-to-end; it does **not** call a model or edit files. Real, model-backed
  > delivery is orchestrated by the **Runner** (`runner/`), which spawns a headless
  > `claude -p` agent per ticket inside a git-worktree under the safety hook. So Crew
  > here is the loop *scaffolding* and policy; the Runner is what actually writes code.
- **Hooks engine** (`src/hooks/`) — advisory, non-mutating hooks fired at lifecycle
  points (`before_claim`, `after_claim`, `after_tests`, `before_submit_review`,
  `on_blocked`, `on_failure`, `after_ticket_done`, …). Hooks report — they never
  act: a veto is honoured only at `before_claim`, elsewhere it degrades to a
  warning, and any override is *requested* for a human, never applied. The built-in
  set includes the **lore-capture reflection hook** (`after_ticket_done`), which
  prompts the agent to call Memory's `suggest_lore` for anything reusable it
  learned — landing a **draft** for human approval, never recording lore directly.
- **Audit** (`src/audit/`) — append-only, content-redacted JSONL of MCP tool
  calls (`0600` under a `0700` dir); the write side never blocks a tool call, the
  read side feeds `stats`.
- **Ops** (`src/ops/`) — `doctor` (readiness checks with actionable fixes,
  including audit-log writability and `0600`/`0700` file-mode hygiene) and `stats`
  (factory snapshot), reused by the CLI.
- **Onboarding** (`src/onboarding/`) — scans a repo (path, branch, remote, stack,
  build/test commands — never secrets), registers it in Dispatch, persists a
  non-committed per-repo context store, and derives a repo digest + feature
  inventory to flush to Memory. The repo itself is never modified.
- **MCP diagnostics** (`src/mcp/diagnostics.ts`) — maps each known startup-failure
  code to a concrete next step so a launch failure is self-explanatory.

## How it fits the factory

Crew sits between the runner and the two stores. It reads ready tickets from
**Dispatch**, assembles a redacted context packet (ticket + AC + repo
paths/commands + policy + relevant **Memory** lore), hands it to an agent runtime,
and writes the evidence back to Dispatch for the human review gate. When the queue
is empty its idle loops keep the backlog warm and its hooks keep Memory honest —
all without ever editing code or promoting its own writes.
