# Runner — the orchestrator

The bash orchestrator at the heart of [Gaffer](../README.md). Claude Code is the
delivery agent; the runner is the loop that feeds it. It spawns a headless
`claude -p` per ticket, wired to the Dispatch and Memory MCP servers, with the
skill library mounted, the safety hook active, and each delivery sealed in a
throwaway git worktree —

```
            ┌─────────────────────────────┐
   humans → │  Dispatch (work)  · MCP/API/UI
            │  tickets → claim → evidence → review
            └─────────────────────────────┘
                        ▲   │ claim / evidence / submit
                        │   ▼
          ┌──────────────────────────────────┐
          │  Claude Code (the delivery agent) │  ← skills + safety hook
          └──────────────────────────────────┘
                        ▲   │ search / suggest
                        │   ▼
            ┌─────────────────────────────┐
            │  Memory (memory) · MCP    │
            │  durable, ratified knowledge │
            └─────────────────────────────┘
```

There is **no long-running app and no polling daemon**. A thin driver
(`tick.sh` + `loop.sh`, or launchd) re-invokes headless Claude Code; each tick
claims one ready ticket, consults memory, delivers it on a branch, evidences
every acceptance criterion, and submits for review — then stops. When nothing is
ready, a tick first runs the **clarify intake gate** (auto-clarifies an ambiguous
draft so it can't reach `ready` while load-bearing ambiguity remains), then idle
ticks scan the repos and draft new tickets.

### Idle maintenance lane (opt-in, deterministically prioritised)

When there are no claimable tickets, the factory can do maintenance work instead
of just polling. Set `GAFFER_MAINTENANCE=1` (OFF by default to respect token
cost) and a quiet tick runs **one** maintenance loop chosen by a **deterministic
priority + rotation scheduler — no LLM in the choice** (`fg maintain`):

- **Priority order:** `security_hotspot` → `coverage` / `test_quality` →
  `type_quality` / `tech_debt` → `documentation` / `dependency_hygiene`. Security
  findings are always reached first.
- **Rotation:** a persisted cursor (`$GAFFER_DATA/maintenance-cursor.json`) means
  a high-priority lane can't starve the lower ones and the same lane isn't picked
  on consecutive idle ticks. The cadence survives across ticks and processes.
- **Which lanes rotate:** only the idle loops you have enabled in `crew.yaml`
  (each loop's own `enabled` flag); `loops.maintenance` only gates the lane
  itself. The chosen lane + rationale are logged every tick (`maintenance lane
  chose '<lane>' (<reason>)`).
- **Observation only:** like every idle loop, the chosen lane drafts tickets and
  never edits code. The deepened `security_hotspot` lane runs three distinct
  lenses (`security-secret-handling`, `security-input-validation`,
  `security-authz`) and an adversarial default-refute verify pass before filing,
  to cut false positives.

Deferred (follow-up): dedicating a fraction of the A1 concurrency pool to the
maintenance lane so it runs alongside delivery rather than only on idle ticks.

## The two MCP servers (the async delivery plane)
- **Dispatch** — backlog/work control plane. Atomic claims/leases, evidence,
  append-only events; tools: `claim_next_ticket`, `get_ticket`, `record_ac_evidence`,
  `submit_ticket_for_review`, `mark_ticket_blocked`, … (also a REST API + web UI).
- **Memory** — durable memory (conventions, ADRs, boundaries, gotchas). Tools:
  `search_lore`, `get_lore`, `suggest_lore`, … with a suggest→ratify flow (nothing
  becomes authoritative without human review).

## How a ticket gets delivered
1. `tick.sh` asks Dispatch if anything is `ready`.
2. It reads the top ticket's repo + stack and computes **recommended skills** for it.
3. It runs `claude -p` headlessly in that repo, wired to both MCP servers, with the
   factory **skill library** mounted and the **safety hook** active.
4. Claude claims the ticket, `search_lore`s for relevant conventions, branches,
   implements using the matching skill, runs the tests, records evidence per AC,
   and submits for review. It never marks its own work `done`.
5. `loop.sh` repeats until the queue drains or the stop conditions hit.

## Setup & the `gaffer` CLI

`setup.sh` builds the three TypeScript products and initialises factory state
under `$GAFFER_DATA` (default `$GAFFER_HOME/.gaffer`, next to the repo) — the Dispatch DB, the Crew config
(pointed at the shared factory DB), and the agent identity. It does **not** need
the Claude CLI; that's only for live runs.

`gaffer` is the thin operator CLI on top:

| Command | What it does |
| --- | --- |
| `gaffer setup` | One-command bootstrap (build + init + open the dashboard). |
| `gaffer onboard <path> [--standalone]` | Register + scan a repo, run the skill-driven `claude -p` onboarding pass (real digest + feature inventory + cited lore drafts), seed tags. Advanced scope mapping is done in the Factory Map dashboard tab. |
| `gaffer dashboard [--restart\|--lan]` | Start the Dispatch control-room UI (`http://127.0.0.1:8787`). |
| `gaffer status` | One-pane roll-up: registrations, work counts, running ticks, what needs a human. |
| `gaffer demo` | The Factory-Map showcase (dry-run only). |

See [`GETTING_STARTED.md`](GETTING_STARTED.md), [`ONBOARDING.md`](ONBOARDING.md),
and [`RUNBOOK.md`](RUNBOOK.md) for the full walkthroughs.

## Worktree isolation

Delivery never touches a real repo's working tree. For each writable repo a tick
creates a **throwaway git worktree** under `$WORKTREES_BASE`, checked out on the
ticket's `gaffer/ticket-<n>-<slug>` branch. The worktree shares the real repo's
object database — so commits land on the real repo's `gaffer/*` branch — while the
repo's main working tree and current branch stay exactly as the human left them. A
rejected delivery's worktree is torn down; its commits live on the ephemeral
branch and never merge. The isolation is physical (the OS enforces it), not
trust-based.

## Model tiering

Planning and implementation run on different models, configured in
`factory.config.sh` and env-overridable:

```bash
GAFFER_PLAN_MODEL=opus      # strong, slow — plan-build, plan-change, clarify, product-owner
GAFFER_IMPL_MODEL=sonnet    # fast, cheap — delivery, bootstrap, merge-conflict, tests
```

An optional, size-gated, round-capped two-model **planning debate**
(`GAFFER_PLAN_DEBATE=1`) is OFF by default — it costs N× a single plan, and every
turn is counted in the usage ledger. Cost and usage in summaries are **relayed
from real measurements, never invented**.

## Configuration (env always wins)

Config resolves in this precedence — highest first:

1. Real environment variables.
2. `settings.json` (`$GAFFER_DATA/settings.json`) — the flat `{"KEY":"value"}` map
   the dashboard **Settings** panel writes. Applied as defaults (`:=`), validated
   to env-var-name shape, never `eval`'d.
3. `factory.config.sh` — the source-controlled defaults (paths, stop conditions,
   cost guards, model tiers, CLI helpers).

So a human can tune the factory from the dashboard, but anything exported in the
environment overrides it — and env-locked keys show read-only in the UI.

## Feature lifecycle + a fresh Repo Digest (prepare-at-delivery / apply-at-merge)
The factory keeps the memory product's **Repo Digest** current and drives the
**feature lifecycle** (`backlog → building → shipped`) as it works — *without* a fresh
`claude -p` per merge, and *without* a rejected delivery ever polluting the digest:

- **Brownfield epic → `building`.** When a brownfield (existing-repo) epic is created
  for a feature, `bin/epic-feature.mjs` either advances an existing `backlog` feature
  → `building` or `add_feature(status:"building")` with the **epic ref as provenance**.
  Deterministic, best-effort, no agent. (`node bin/epic-feature.mjs --repo <r> --epic <ref> --name <f>`)
- **Prepare at delivery.** The delivery agent — already running, already holding the
  diff — runs the **`prepare-digest-delta`** skill to record ONE inert evidence row
  (`GAFFER_DIGEST_DELTA_V1 {…}`): the digest section deltas + the feature note. Nothing
  is applied yet.
- **Apply at merge (post-review, deterministic).** On a CLEAN merge, `bin/merge-ticket.mjs`
  reads that prepared evidence and replays it as plain Dispatch CLI writes — stamping
  each digest section with `source: "merge:#<n>"` and the feature → `shipped`. **No agent
  is spawned in the merge hot path.** If no prepared delta is present it falls back to a
  minimal deterministic freshness stamp (+ feature → `shipped` when linked).

The whole path mirrors the ledger discipline: every memory write is **gated, try/caught,
and fully swallowed** — a memory-write failure NEVER fails or blocks a merge — and every
write is **idempotent** (re-running re-stamps the same `source` / re-asserts `shipped`).
See `lib/feature-digest.mjs` for the pure builders/parser and the full design note.

## Selection: how the *right* skill gets used
The library ships **31 skills** under `skills/<name>/SKILL.md` — generic delivery
(plan/clarify/branch/evidence/self-review/submit/refactor/docs), testing,
frontend, backend, security, language conventions, and review/admin.

- Each skill has a sharp **"Use when…" description**;
  Claude selects by matching the ticket's intent + acceptance criteria.
- Each skill is also **tagged in its frontmatter** by `stack` (a list of languages /
  runtimes; empty = any) and `area` (its domain pack — `frontend`, `backend`,
  `security`, `language`, `testing`, `review`, `docs`, `workflow`, …).
- The tick injects **stack/area-recommended skills** for the ticket's stack via
  `bin/select-skills.mjs` (zero-dependency), so selection is steered, not just
  guessed. A skill matches when its `stack` is empty *or* intersects the ticket's
  stack, **and** its `area` is empty *or* equals the requested area — the same rule
  the Crew registry uses, so local and registry selection agree. If the local
  library is unavailable the tick falls back to the Crew skills registry.

### Domain skill packs
Beyond the generic delivery skills, the library ships domain packs the agent selects
by stack/area:
- **frontend** — `frontend-component`, `frontend-a11y`, `frontend-responsive` (+ `brand`)
- **backend** — `add-api-endpoint`, `add-db-migration`, `backend-service`
- **security** — `security-authz`, `security-input-validation`, `security-secret-handling`
- **language** — `typescript-conventions` (`stack: [typescript, javascript, node]`)

```bash
node bin/select-skills.mjs --stack node --area security   # → the security pack
node bin/select-skills.mjs --list-areas                   # → all area packs
node test/select-skills.test.mjs                          # → selector tests
```

## Security model (deterministic, not trust-based)
The boundary is `safety-hook.mjs`, a self-contained, zero-dependency Claude Code
**PreToolUse hook** that runs before *every* tool and **blocks** (exit 2). It is
load-bearing: the model proposes, the hook decides, and it can't be talked out of
it. It enforces, deterministically:

- **Write-scoping** — writes are allowed only inside the ticket's write-roots
  (`GAFFER_WRITE_ROOTS`); reads only inside write- ∪ read-roots. Writes outside =
  block.
- **Secret-path protection** — not just direct reads of `.env*`/keys/credentials,
  but *references* to them: redirects, `source`, globs, variable indirection,
  pipes/`xargs`, command substitution, and inline-interpreter (`python -c`,
  `node -e`, heredocs) reads — so secrets never enter the model's context. Git
  secret-ops (`git diff/show/add` of a secret) are blocked too.
- **Control-plane denial** — privileged Dispatch/Crew CLI writes (review, approve,
  mark-merged, repo-access), raw `sqlite3` on the control-plane DBs, and config
  hijacks (`core.hooksPath`, `sudo`, `crontab`, …) are denied. The agent can read
  the control plane but cannot drive the gate.
- **Blanket-deny destructive ops** — force-push, protected-branch push, branch/tag
  deletion, hard reset, `rm -rf`/`shred`, destructive `find -exec`, and dependency
  installs (allowed only as a single `--ignore-scripts` install during a scoped
  bootstrap).
- **Fail-closed** — when a write's destination can't be resolved statically (a
  variable, a concatenation), the hook blocks rather than guesses.

It is **defence-in-depth, not a jail** — a fully-dynamic path assembled at runtime
can still slip past, which is why real containment is the worktree (above) plus the
optional OS sandbox (below). Every block is logged to
`$GAFFER_DATA/safety-blocks.jsonl`. Context is assembled and redacted
programmatically (Dispatch's context packet), so **no human ever pastes a repo or a
secret into a prompt.**

**Optional: strict execution mode** (`STRICT_MODE=1`, OFF by default) adds a
best-effort OS-level containment layer *on top of* the worktree + hook, via a
**provider seam** (`sandbox-exec` today; docker/lima/VM are future providers).
It is defence-in-depth, **not** a security guarantee — see
[`STRICT_MODE.md`](STRICT_MODE.md) for the provider model, the network caveat,
and per-repo config.

## Run the showcase
```bash
# 1. Build the servers
pnpm -C .. -r build   # build all three packages from the repo root

# 2. Watch a dry run (no Claude invoked, nothing mutated) — DRY_RUN=1 is the default
bash loop.sh
#   → prints each tick: what it WOULD claim, the recommended skills, the exact
#     headless-claude command, or the idle-scan it WOULD run.

# 3. Go live (only after reviewing) — claims real tickets and runs Claude
DRY_RUN=0 bash loop.sh

# 4. Unattended: render + install the launchd agent (every 15 min, keep DRY_RUN=1 first).
#    The plist is a TEMPLATE — substitute the repo + data paths, then load it (run from repo root):
OUT=~/Library/LaunchAgents/com.gaffer.factory.plist
sed -e "s#__GAFFER_REPO__#$(pwd)#g" -e "s#__GAFFER_DATA__#$(pwd)/.gaffer#g" \
  runner/launchd/com.gaffer.factory.plist.template > "$OUT"
launchctl load "$OUT"
```
Config + stop conditions (cost guards) live in `factory.config.sh`. Logs land in
`<repo-root>/.gaffer/factory.log`; the full audit trail is Dispatch's event log
(`dispatch ticket show <n>`) and its web UI.

## Files
- `factory.config.sh` — paths, identity, **DRY_RUN**, stop conditions, CLI helpers
- `tick.sh` / `loop.sh` — one tick / the driver loop
- `safety-hook.mjs` — the PreToolUse safety boundary
- `lib/sandbox.sh` — strict-mode provider seam (`sandbox_wrap_cmd`); sourced by `factory.config.sh`
- `lib/budget.sh` — per-day cost guard (`MAX_TICKS_PER_DAY`); halts the loop across runs; sourced by `factory.config.sh`
- `STRICT_MODE.md` — optional OS-level containment: provider model, caveats, config
- `claude/settings.json` — wires the hook into Claude Code
- `claude/CLAUDE.md` — the delivery-agent brief
- `.mcp.json` — Dispatch + Memory MCP wiring
- `skills/` — the curated skill library (each `SKILL.md` tagged by `stack` + `area`)
- `bin/select-skills.mjs` — stack/area skill selector (used by `tick.sh`; zero-dep)
- `lib/feature-digest.mjs` — feature-lifecycle + Repo-Digest wiring: pure builders/parser for the prepare-at-delivery / apply-at-merge mechanism (zero-dep)
- `bin/epic-feature.mjs` — brownfield epic → feature(`building`) hook (`node bin/epic-feature.mjs --repo <r> --epic <ref> --name <f>`)
- `skills/prepare-digest-delta/SKILL.md` — the delivery-side **prepare** skill (records the inert `GAFFER_DIGEST_DELTA_V1` evidence the merge applies)
- `test/feature-digest.test.mjs` — feature-lifecycle + digest wiring tests, incl. apply-on-merge + brownfield-building, no live claude (`node test/feature-digest.test.mjs`)
- `test/select-skills.test.mjs` — selector tests (`node test/select-skills.test.mjs`)
- `test/strict-mode.test.sh` — strict-mode provider/profile validation (`bash test/strict-mode.test.sh`)
- `test/budget-guard.test.sh` — per-day cost-guard validation (`bash test/budget-guard.test.sh`)
- `test/intake-gate.test.sh` — clarify intake-gate wiring (`bash test/intake-gate.test.sh`)
- `lib/hygiene.sh` — delivery-hygiene assertions: hard-fail guard against the leaks an unattended run produced (copied src tree, leaked `.crew/events.jsonl`, self-referential/broken symlinks, `node_modules` added/deleted)
- `lib/minimalism.sh` — minimalism post-condition (smallest-change note required; oversized diffs flagged `needs_human_review: oversized_diff`)
- `lib/dod.sh` — **enforced Definition of Done (I3)**: the runner (never the agent) runs the enabled DoD gates — **tests / typecheck / lint** — deterministically in each write repo's delivery worktree, each under `gaffer_timeout`, BEFORE a ticket may rest in the human review lane. ALL pass/skip → proceed; ANY fail → **auto-reject back to refining** (the same path R-6/HYGIENE hardened) with the failing gate name + an output tail recorded as `test_output` evidence (the Review view renders the ✓/✗ checklist). A gate with **no configured command is SKIPPED, not failed** (and logged). Configurable per repo + factory-wide (`definition_of_done` in `crew.yaml`); `GAFFER_DOD=0` disables enforcement (today's behaviour). Commands come from each repo's dispatch `test_command`/`lint_command` (+ `GAFFER_DOD_TYPECHECK_CMD` for typecheck, which has no dispatch field). **Ships:** tests · typecheck · lint. **Deferred follow-ups (NOT yet gates):** coverage-did-not-decrease (needs a stored baseline), SAST/SCA (needs I2), CI-green (H3), docs-updated.
- `lib/backpressure.sh` — per-repo backpressure (unmerged `gaffer/*` branches + in_review tickets + active claims vs cap)
- `run-summary.sh` — end-of-run report (landed / failed-safe / parked / re-queued / oversized / per-repo pressure / cleanup state); printed by `loop.sh`
- `test/hygiene.test.sh` — delivery-hygiene validation (`bash test/hygiene.test.sh`)
- `test/minimalism.test.sh` — minimalism post-condition validation (`bash test/minimalism.test.sh`)
- `test/backpressure.test.sh` — per-repo backpressure validation (`bash test/backpressure.test.sh`)
- `test/run-summary.test.sh` — run-summary report validation (`bash test/run-summary.test.sh`)
- `test/stabilisation-integration.test.sh` — end-to-end proof the hygiene + backpressure gates fire against real `tick.sh` (`bash test/stabilisation-integration.test.sh`)
- `test/dod-gate.test.sh` — Definition-of-Done validation: a failing `test_command` fails the gate; all-pass proceeds; an un-configured gate is skipped not failed; a disabled gate is not run; an unrunnable command is a fail not a crash; `GAFFER_DOD=0` disables enforcement; and (against the **real dispatch CLI**) a DoD failure review-rejects an in_review ticket to refining with the checklist recorded as evidence (`bash test/dod-gate.test.sh`)
- `test/self-op-ban.test.sh` — self-operation ban unit tests for `gaffer_is_self_target` + tick.sh wiring (`bash test/self-op-ban.test.sh`)
- `test/self-op-ban-integration.test.sh` — end-to-end proof the self-op ban refuses a delivery whose target is a Gaffer component, honours `GAFFER_ALLOW_SELF_DELIVERY=1`, and leaves a non-Gaffer target unaffected (`bash test/self-op-ban-integration.test.sh`)
- `launchd/com.gaffer.factory.plist.template` — scheduled-run template with `__GAFFER_REPO__` / `__GAFFER_DATA__` placeholders (disabled by default; render with `sed` before loading)
