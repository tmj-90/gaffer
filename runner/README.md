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
draft so it can't reach `ready` while load-bearing ambiguity remains; a draft with
no linked repo on disk is logged and skipped for the run, so it cannot stall the
gate for the drafts behind it), then the opt-in **feature backlog** step
(`GAFFER_IDLE_FEATURE_BACKLOG`, the Settings "Feature backlog" toggle: plan one memory
`backlog` feature as a draft epic via `fg feature-backlog`, one paid
`decompose.mjs --force-plan` call), then idle ticks scan the repos and draft new
tickets.

### Idle maintenance lane (opt-in, deterministically prioritised)

When there are no claimable tickets, the factory can do maintenance work instead
of just polling. Turn the lane on in **Settings → Idle loops** (crew.yaml
`loops.maintenance.enabled`; OFF by default) **and enable at least one lane** —
the lane only rotates through the idle loops you enabled, so the switch alone
does nothing. A quiet tick then runs **one** maintenance loop chosen by a
**deterministic priority + rotation scheduler — no LLM in the choice** (`fg
maintain`). `GAFFER_MAINTENANCE` in the runner's env is only an override: `0` =
never run the lane, `1` = run it even while the switch is off, empty = the
switch decides.

- **Priority order:** `security_hotspot` → `coverage` / `test_quality` →
  `type_quality` / `tech_debt` → `documentation` / `dependency_hygiene`. Security
  findings are always reached first.
- **Rotation:** a persisted cursor (`$GAFFER_DATA/maintenance-cursor.json`) means
  a high-priority lane can't starve the lower ones and the same lane isn't picked
  on consecutive idle ticks. The cadence survives across ticks and processes.
- **Which lanes rotate:** only the idle loops you have enabled in `crew.yaml`
  (each loop's own `enabled` flag); `loops.maintenance` only gates the lane
  itself. The chosen lane + rationale are logged every tick (`maintenance lane
  chose '<lane>' (<reason>)`). The coverage lane needs a repo `coverage_command`
  (`wg repo set-commands <repo> --coverage '<cmd>'`) and files only when the
  parsed total is below `minimum_gap_threshold`; the dependency lane finds
  outdated / vulnerable packages only with an `audit_command` (the panel's
  field), otherwise it flags floating ranges only.
- **Also on the same tick:** GitHub / Jira issue ingest (`ingest.*.enabled`)
  and the **lore-gap** loop (`loops.idle_lore_gap`) run alongside the chosen
  lane; the **feature backlog** (`loops.idle_feature_backlog`) runs just before
  it as its own step (`fg feature-backlog`, above), and the later `fg maintain` /
  `fg idle` are told not to run it again that tick. Both use the factory's own
  memory server and planner — no `memory.mcp` or `decompose_script`
  hand-wiring. The feature backlog is the one idle step that
  spends a model call (one planning call per feature, counted against
  `MAX_TICKS_PER_DAY`). The planner runs unattended, so it is told to plan now
  (`--force-plan`) rather than ask clarifying questions nobody would answer. A
  failed plan releases the feature back to `backlog`; after
  `loops.idle_feature_backlog.max_plan_failures` (default 2) failed plans in a row
  idle ticks stop claiming it, so a feature the planner cannot plan does not buy a
  planner call on every tick. The counts live in
  `$GAFFER_DATA/feature-backlog-failures.json` (a filed epic clears them; delete an
  entry to let idle ticks retry), and the tick log says when a feature is parked.
- **Observation only:** like every idle loop, the chosen lane drafts tickets and
  never edits code. The deepened `security_hotspot` lane runs three distinct
  lenses (`security-secret-handling`, `security-input-validation`,
  `security-authz`) and an adversarial default-refute verify pass before filing,
  to cut false positives.
- **Results and caps:** a tick that filed something is `maintenance_drafted`
  (productive). A tick whose scans found nothing new is `no_work`: the scans
  call no model, so it counts as an empty poll (`EMPTY_POLL_LIMIT` drains the
  pool) and stays off the day cap. Only a tick that ran the paid backlog planner
  and filed nothing is `maintenance_ran` — counted against the day cap, but an
  empty poll for draining. A backlog step that filed an epic reports
  `idle_drafted` before the lane runs.
- **Strict containment:** under `GAFFER_STRICT_REQUIRE=1` the idle loops refuse
  to run repo commands on the host (`coverage_command`, `audit_command`, the
  tsc/semgrep oracles) unless `GAFFER_IDLE_HOST_EXEC=1`; the in-process scans
  still run.

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
| `gaffer onboard <path> [--standalone]` | Register + scan a repo, run the `claude -p` onboarding pass (real digest + feature inventory + cited lore drafts; the card-generation / card-review skills are inlined into its prompt, and its lore rules are a distillation of the memory-onboard skill's hard rules, pinned by `test/onboard-memory-rules-sync.test.mjs`), seed tags. Advanced scope mapping is done in the Factory Map dashboard tab. |
| `gaffer dashboard [--restart\|--lan]` | Start the Dispatch control-room UI (`http://127.0.0.1:8787`). |
| `gaffer status` | One-pane roll-up: registrations, work counts, running ticks, what needs a human (reviews, blocked, unmerged approvals, decisions, paused deliveries awaiting Continue/Stop). Finds a `--foreground` dashboard (no pid file) by probing its `/healthz`. |
| `gaffer demo` | The Factory-Map showcase (dry-run only). |

See the root [`quickstart.md`](../quickstart.md) (the canonical first run), [`ONBOARDING.md`](ONBOARDING.md),
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
environment overrides it — and env-locked keys show read-only in the UI. "The
environment" means the operator's REAL environment, captured once when the first
process sources `factory.config.sh` (`_GAFFER_OPERATOR_ENV`): the values a parent
(gaffer, `loop.sh`, a daemon pass) derived and exported are re-derived by each child,
so a dashboard edit reaches the next tick of a running loop or `gaffer run --daemon`
without a restart, and the dashboard launched by `gaffer dashboard` shows its own
defaults as editable, not env-locked. The day caps (`MAX_TICKS_PER_DAY`,
`GAFFER_DAILY_BUDGET_USD`) are re-read from the current config by `loop.sh` and every
pool `worker.sh` before each admission (`gaffer_refresh_day_caps`, lib/budget.sh), so
lowering one stops a running loop at its next tick; a cap that cannot be re-read
stops the run (fail closed). A `settings.json` that exists but does not parse as a
flat JSON object (a hand edit, a truncated copy), or that cannot be read because
`node` is missing, never drops a cap to its default: the re-source keeps the
inherited values and sets `_GAFFER_SETTINGS_UNREADABLE=1`, a running `loop.sh` / pool
worker stops with an `ERROR` line naming the file, `gaffer run --daemon` runs no pass,
and `tick.sh` (setup error) and Poll for work refuse new work until the file parses
again. The file is read the way the dashboard reads it: it lives at
`$GAFFER_DATA/settings.json` (default `$GAFFER_HOME/.gaffer`, so an operator-set
`GAFFER_HOME` is honoured in every process), a leading UTF-8 BOM and surrounding
whitespace are ignored, and an empty or whitespace-only file means "nothing
configured" (`{}`), not unreadable. The run-shape knobs a loop reads once at start —
`MAX_TICKS`, `GAFFER_CONCURRENCY`, `TICK_SLEEP`, `EMPTY_POLL_LIMIT` — apply from the
next loop pass (the next daemon pass, or the next run).

## Feature lifecycle + a fresh Repo Digest (prepare-at-delivery / apply-at-merge)
The factory keeps the memory product's **Repo Digest** current and drives the
**feature lifecycle** (`backlog → building → shipped`) as it works — *without* a fresh
`claude -p` per merge, and *without* a rejected delivery ever polluting the digest:

- **Brownfield epic → `building`.** When a brownfield epic is created through the
  dispatch API (`POST /epics`, which the dashboard's plan confirm calls) and every one
  of its tickets targets ONE existing registered repo, the API spawns
  `DISPATCH_EPIC_FEATURE_CMD` (`bin/epic-feature.mjs`, wired by `gaffer dashboard`;
  detached, no shell, request values as discrete argv). It either advances an existing
  feature of that name (`backlog` → `building`, memory dedupes by repo + name) or
  `add_feature(status:"building")`, with the **epic ref as provenance**. A feature that is
  already `building` or `shipped` is left as it is (memory only replaces a feature's
  summary / provenance on a re-add that advances its status, and a blank epic
  description never wipes a recorded summary). Deterministic,
  best-effort, no agent: the epic is created either way. A greenfield, mixed-repo or
  bootstrap plan writes no feature row. (`node bin/epic-feature.mjs --repo <r> --epic <ref> --name <f>`)
- **Prepare at delivery.** The delivery agent — already running, already holding the
  diff — runs the **`prepare-digest-delta`** skill to record ONE inert evidence row
  (`GAFFER_DIGEST_DELTA_V1 {…}`): the digest section deltas + the feature note. Nothing
  is applied yet.
- **Conflicts (never a force-merge).** When the landing conflicts, `bin/merge-ticket.mjs`
  spawns the resolver agent once, in a throwaway worktree of the delivery branch, then
  **re-gates** the committed resolution with `bin/dod-regate.sh` — no conflict markers
  introduced, and the repo's DoD gates (tests · typecheck · lint, same runner, toggles,
  install step, sandbox and zero-gates rule as the delivery gate) green on a fresh detached
  checkout of the branch's committed head (never the resolver's worktree: an uncommitted fix
  or a file it never added is discarded, not gated) — before `wg ticket reopen-for-review` sends it back for re-review with that fresh
  checklist as evidence. A failing resolution is parked on
  `refs/gaffer/conflict-resolved/<n>`, the branch restored, and the ticket held for a human.
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
The library ships **118 skills** under `skills/<name>/SKILL.md`, each tagged in its
frontmatter by `stack` (languages / runtimes; empty = any) and `area` (its bucket:
universal delivery mechanics, task packs, stack packs, off-domain packs). Every agent
role gets its own mount from `bin/select-skills.mjs --role <role>` (delivery, review,
clarify, test, plan, spec, product, merge, bootstrap): task packs are broad-inclusion,
language and surface packs follow the stack (fail-open on an unknown stack),
off-domain packs are opt-in by tag, `--area` or the ticket text, and role-only /
user-only skills stay with their role. The full model, the per-role table and who
mounts what: [docs/skill-selection-and-stacks.md](../docs/skill-selection-and-stacks.md).

```bash
node bin/select-skills.mjs --stack typescript --text "Add an orders endpoint"   # delivery
node bin/select-skills.mjs --role review --stack python                          # a role
node bin/select-skills.mjs --list-areas                                           # buckets
node test/select-skills.test.mjs                                                  # tests
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
**provider seam** (`sandbox-exec` and `docker` today; a microVM provider is a design sketch).
It is defence-in-depth, **not** a security guarantee — see
[`STRICT_MODE.md`](STRICT_MODE.md) for the provider model, the network caveat,
and per-repo config.

## Run the showcase
```bash
# 1. Build the servers
pnpm -C .. -r build   # build all three packages from the repo root

# 2. Watch a dry run (no Claude invoked, nothing mutated)
./gaffer run --dry-run
#   → prints each tick: what it WOULD claim, the recommended skills, the exact
#     headless-claude command, or the idle-scan it WOULD run.

# 3. Go live (only after reviewing) — claims real tickets and runs Claude.
#    `gaffer run` is LIVE by default (only --dry-run / DRY_RUN=1 keeps it a preview).
./gaffer run

# 4. Unattended: render + install the launchd agent (every 15 min, keep DRY_RUN=1 first).
#    The plist is a TEMPLATE — substitute the repo + data paths, then load it (run from repo root):
OUT=~/Library/LaunchAgents/com.gaffer.factory.plist
sed -e "s#__GAFFER_REPO__#$(pwd)#g" -e "s#__GAFFER_DATA__#$(pwd)/.gaffer#g" \
  runner/launchd/com.gaffer.factory.plist.template > "$OUT"
launchctl load "$OUT"
```
Config + stop conditions (cost guards) live in `factory.config.sh`; the full
knob-by-knob reference is generated into [`docs/CONFIG.md`](../docs/CONFIG.md)
(`node scripts/config-reference.mjs`). Logs land in
`<repo-root>/.gaffer/factory.log`; the full audit trail is Dispatch's event log
(`./gaffer wg ticket show <n>`) and its web UI.

## Files
- `factory.config.sh` — paths, identity, **DRY_RUN**, stop conditions, CLI helpers
- `tick.sh` / `loop.sh` — one tick / the driver loop
- `safety-hook.mjs` — the PreToolUse safety boundary
- `lib/sandbox.sh` — strict-mode provider seam (`sandbox_wrap_cmd`); sourced by `factory.config.sh`
- `lib/agent-env.sh` — the ONE agent-directory installer every spawn site uses (`gaffer_install_agent_dir`: skills mount, rendered + VERIFIED `.claude/settings.json`, workspace trust, brief — fail closed) and the worktree `node_modules` linker; sourced by `factory.config.sh`
- `lib/ac-checks.sh` — machine-checkable acceptance criteria: runs each AC's `check_command` in the delivery worktree after the DoD gates and records the verdict through `dispatch ac check-result`
- `lib/budget.sh` — per-day cost guard (`MAX_TICKS_PER_DAY`); halts the loop across runs; sourced by `factory.config.sh`
- `STRICT_MODE.md` — optional OS-level containment: provider model, caveats, config
- `claude/settings.json` — wires the hook into Claude Code
- `claude/CLAUDE.md` — the delivery-agent brief
- `.mcp.json` — Dispatch + Memory MCP wiring
- `skills/` — the curated skill library (each `SKILL.md` tagged by `stack` + `area`)
- `bin/select-skills.mjs` — stack/area skill selector (used by `tick.sh`; zero-dep)
- `lib/feature-digest.mjs` — feature-lifecycle + Repo-Digest wiring: pure builders/parser for the prepare-at-delivery / apply-at-merge mechanism (zero-dep)
- `bin/epic-feature.mjs` — brownfield epic → feature(`building`) hook, spawned by the dispatch API's `POST /epics` (`DISPATCH_EPIC_FEATURE_CMD`) (`node bin/epic-feature.mjs --repo <r> --epic <ref> --name <f>`)
- `skills/prepare-digest-delta/SKILL.md` — the delivery-side **prepare** skill (records the inert `GAFFER_DIGEST_DELTA_V1` evidence the merge applies)
- `test/feature-digest.test.mjs` — feature-lifecycle + digest wiring tests, incl. apply-on-merge + brownfield-building, no live claude (`node test/feature-digest.test.mjs`)
- `test/select-skills.test.mjs` — selector tests (`node test/select-skills.test.mjs`)
- `test/strict-mode.test.sh` — strict-mode provider/profile validation (`bash test/strict-mode.test.sh`)
- `test/budget-guard.test.sh` — per-day cost-guard validation (`bash test/budget-guard.test.sh`)
- `test/intake-gate.test.sh` — clarify intake-gate wiring (`bash test/intake-gate.test.sh`)
- `lib/hygiene.sh` — delivery-hygiene assertions: hard-fail guard against the leaks an unattended run produced (copied src tree, leaked `.crew/events.jsonl`, self-referential/broken symlinks, `node_modules` added/deleted)
- `lib/minimalism.sh` — minimalism post-condition (a missing smallest-change note is flagged `needs_human_review`, or sent back to rework under `MINIMALISM_REQUIRE_NOTE=1`; an oversized diff is flagged `needs_human_review: oversized_diff` whatever the note verdict, never failed)
- `lib/dod.sh` — **enforced Definition of Done (I3)**: the runner (never the agent) runs the enabled DoD gates — **tests / typecheck / lint** — deterministically in each write repo's delivery worktree, each under `gaffer_timeout`, BEFORE a ticket may rest in the human review lane. ALL pass/skip → proceed; ANY fail → **auto-reject back to refining** (the same path R-6/HYGIENE hardened) with the failing gate name + an output tail recorded as `test_output` evidence (the Review view renders the ✓/✗ checklist). A gate with **no configured or detected command is SKIPPED, not failed** (and logged). Toggled only by env: `GAFFER_DOD=0` disables enforcement, `GAFFER_DOD_TESTS` / `GAFFER_DOD_TYPECHECK` / `GAFFER_DOD_LINT` (default 1) toggle each gate (`docs/CONFIG.md`). crew.yaml's `definition_of_done` block (factory-wide or per repo) is **not read** by the runner, and `crew doctor` warns when it is changed. Commands come from each repo's dispatch `test_command`/`lint_command` ; typecheck (no dispatch field) runs `GAFFER_DOD_TYPECHECK_CMD`, else the repo's package.json typecheck script (`typecheck` / `type-check` / `check-types` / `types:check`, or a bare `tsc --noEmit` script), auto-detected from the base branch first by `gaffer_dod_typecheck_cmd`. A repo's `coverage_command` is not a DoD gate (it feeds the idle coverage loop). **Gate integrity:** each row also carries the base COMMIT the delivery was cut from (tick.sh captures the commit at the moment `worktree add -B` cuts the branch — `_BRANCH_CUT_SHAS`, also on a retry that re-cuts — resolves it with `gaffer_delivery_base_sha`, and records it on the repo delivery with `wg ticket repo-delivery record --base-sha`, adding `--base-recut` only for a fresh cut; a kept or resumed branch and an in-tick retry that builds on the previous attempt keep the commit already known, never the branch tip; dispatch refuses to replace a stored base without `--base-recut`; a branch name, the older contract, is resolved by merge-base) and the human's `allow_test_changes`; with them, `gaffer_dod_resolve_cmd` reads a package-script gate command's body from the **base commit** (a delivery that rewrote `scripts.test`, added or changed a `pre`/`post` hook, or changed a script reached through `test: npm run unit` runs the base expansion: source `base-pinned`), each GATE row gains a 7th `source` column, and `gaffer_dod_integrity_row` appends one `integrity` row per repo — PASS, or FLAG for deleted/renamed test files, added skip/focus markers (including node:test `{ skip: true }` options, `t.skip()` / `this.skip()` / `ctx.skip()`, `it.concurrent.skip`, and a marker after a comment on the same line), any change/removal/addition among the scripts the gate scripts reach (hooks, `npm run X`, `run-s` words), touched test config, or a package-manager rc file (`.npmrc`, `.yarnrc`, `.yarnrc.yml`, `bunfig.toml`) added, changed, deleted or renamed — read from git and from the worktree on disk, so a git-ignored `.npmrc` counts (the typed seam is `packages/crew` `runtime/dod/gateIntegrityCli.js`, running dispatch's `testIntegrity` classifier, the same one behind the server's `test-modified` risk flag). A FLAG never fails the run and the integrity row never counts as an executed gate; `allow=1` turns it into PASS with a note; no base or no crew dist FLAGs (never a silent pass). `GAFFER_TEST_PATH_RE` adds test paths. **Ships:** tests · typecheck · lint · integrity (flag only). **Deferred follow-ups (NOT yet gates):** coverage-did-not-decrease (needs a stored baseline), SAST/SCA (needs I2), CI-green (H3), docs-updated.
- `lib/tester.sh` — the independent black-box tester pass (in_testing → `bin/tester-run.mjs --live`). A ticket the tester cannot decide (no verdict token, the tester changed implementation files, a PASS that failed its clean replay) is HELD in_testing: the tester-run's own reason is logged and attached as a `tester held: <reason>` manual_note, and the hold is remembered in `$GAFFER_DATA/.tester-held` for that stay in_testing so later runs do not pay to re-test it (`test/tester-held.test.sh`)
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
