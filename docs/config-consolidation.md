# Config consolidation — audit, classification & reduction plan

Audit of the Gaffer factory configuration surface: `runner/factory.config.sh`
(the env-override defaults) vs `packages/dispatch/src/api/settings.ts` (the
UI-editable allow-list). Goal: replace "83 flat knobs" with the *right* config
UX — a mode selector + a short base list, everything else auto-derived or
advanced-only.

## Measured counts (reproducible)

| Metric | Count | How measured |
|---|---|---|
| Knobs defined in `factory.config.sh` (`: "${KEY…}"`) | **84** | `grep -E '^\s*:\s*"\$\{[A-Za-z_]' … \| sort -u` (see note) |
| UI allow-list keys (`SETTING_DEFS`) | **48** (52 after this pass) | `grep -E '^\s*key: "'` |
| factory.config knobs shown in UI | **38** (42 after this pass) | `comm -12` |
| factory.config knobs NOT in UI | **46** (42 after this pass) | `comm -23` |
| UI keys living outside factory.config.sh | **10** | `comm -13` |

**Note on 84 vs the briefed "83":** the reproducible `: "${…}"` scan yields 84
distinct identifiers. The difference is bookkeeping, not a missing knob:
`GAFFER_BUDGET_REMAINING` is defined twice (one `:=` per if/else branch — it is a
single knob), and `RUNNER_DIR` (line 9) is a pure self-location derivation some
counts exclude. The 10 UI-only keys — `DISPATCH_ALLOW_AGENT_APPROVE`,
`MEMORY_AUTO_APPROVE`, `GAFFER_TESTING`, `GAFFER_IDLE_FEATURE_BACKLOG`,
`GAFFER_IDLE_MODE`, and the five `GAFFER_NOTIFY_*` — are real operator knobs
consumed by dispatch/crew/memory/notify, not by the runner config, so they are
correctly in the UI without a `factory.config.sh` default.

**Classification totals (of the 84):** operator **49** · internal **32** ·
redundant-or-derivable **3**. No dead knobs — every one of the 84 has a live
consumer (verified by grep across `runner/` + `packages/`).

---

## The right config UX (design proposal — for human review, NOT implemented)

Do not ask the operator to reason about ~50 individual behavioural knobs. Give
them **one mode selector + a short base list**, with everything else auto-derived
or hidden behind an "Advanced" reveal.

### 1. Autonomy modes (named presets that move a group of knobs together)

The UI already frames autonomy as "Supervised / …". Make that the primary
control. Selecting a mode sets a whole cluster of knobs at once; an explicit
individual override always wins (see composition rule below).

| Mode | Posture | Knobs it sets |
|---|---|---|
| **supervised** (default, safe) | Human approves every merge | `REVIEW_MODE=human` · `DISPATCH_ALLOW_AGENT_APPROVE=0` · `MERGE_ON_AGENT_REVIEW=0` · `AUTO_MERGE=0` · `GAFFER_AUTO_PUSH=0` · `MEMORY_AUTO_APPROVE=0` |
| **autonomous** (walk-away / AFK) | Agent-approve + auto-merge, no human in the loop | `REVIEW_MODE=agent` · `DISPATCH_ALLOW_AGENT_APPROVE=1` · `MERGE_ON_AGENT_REVIEW=1` · `AUTO_MERGE=1` · `GAFFER_AUTO_PUSH=1` (opt) · `MEMORY_AUTO_APPROVE=1` |
| **strict** (autonomous + containment) | Autonomous, plus OS-level sandbox | everything in *autonomous* + `STRICT_MODE=1` (+ `SANDBOX_PROVIDER`, `STRICT_ALLOW_NETWORK`, `STRICT_ALLOW_HOME` become relevant) |

**Composition rule (mode + individual override):** a mode writes its cluster to
`settings.json` as *mode defaults*. Precedence stays exactly the runner's current
`env > file` model, extended to `env > explicit-file-key > mode-default > config
default`. An operator who flips a single knob (e.g. keeps *autonomous* but sets
`GAFFER_AUTO_PUSH=0`) pins that key; re-selecting a mode re-applies the cluster
but leaves explicitly-pinned keys unless the operator resets them. Implement by
tagging each persisted key with its origin (`mode` vs `explicit`) so the UI can
show "set by autonomous mode" vs "you changed this".

### 2. Tier the config into system / base / advanced

- **system** — internal wiring (paths, bins, DBs, cmd strings, lock/reap/claim
  internals). Auto-derived from `GAFFER_HOME` / `GAFFER_DATA`. **Never shown, never
  a knob.** A fresh user never sees or sets these. (32 knobs today.)
- **base** — the handful of sensible defaults that Just Work; most users never
  touch them. Surfaced compactly (or only in the mode summary).
- **advanced** — genuinely tunable operator knobs, behind an "Advanced" reveal.

### 3. Ideal Settings surface (mock)

```
┌─ Settings ─────────────────────────────────────────────┐
│ Autonomy mode:  ( ) Supervised  (•) Autonomous  ( ) Strict │
│   Autonomous: agents approve reviews, approved work auto-  │
│   merges & pushes. Individual overrides below still win.   │
│                                                            │
│ ── Base ────────────────────────────────────────────────  │
│ Dry run                     [ off ]   safety: preview only │
│ Budget ceiling (USD)        [ 20  ]   biases cheaper as low │
│ Max ticks / day             [ 50  ]                        │
│ Concurrent ticks            [ 1   ]                        │
│                                                            │
│ ▸ Advanced  (models, retries, caps, quality gates, sandbox,│
│             notifications, idle loops)  — 40 knobs hidden  │
│                                                            │
│ System wiring: auto-derived from GAFFER_HOME — not shown.  │
└────────────────────────────────────────────────────────────┘
```

Target: **operator sees 1 mode selector + ~4 base fields**; ~40 advanced knobs
one click away; 32 system knobs never rendered; 3 derivable knobs removed as
inputs entirely.

---

## Full knob index (all 84)

Category ∈ {operator, internal, redundant-or-derivable}.
Tier ∈ {mode, base, advanced, system, derive, delete}. `UI?` = present in
`SETTING_DEFS` (✓ = already; **＋** = added in this pass).

### Operator — belongs in the UI (49)

| Knob | Line | Default | Purpose | UI? | Tier |
|---|---|---|---|---|---|
| REVIEW_MODE | 1057 | human | Who reviews before merge: human/agent/both | ✓ | mode |
| AUTO_MERGE | 1068 | 0 | Safe-merge approved branch into default branch | ✓ | mode |
| MERGE_ON_AGENT_REVIEW | 1083 | 0 | Let an agent approval (not just human) fire the merge | ✓ | mode |
| GAFFER_AUTO_PUSH | 1091 | 0 | Push default branch to origin after auto-merge | ✓ | mode |
| GAFFER_ALLOW_SELF_DELIVERY | 925 | 0 | Permit factory to deliver into its own source | ✓ | advanced |
| GAFFER_TESTING* | — | — | Route testable tickets through the black-box test lane | ✓ | mode |
| DISPATCH_ALLOW_AGENT_APPROVE* | — | — | Allow agent actor to approve a review | ✓ | mode |
| MEMORY_AUTO_APPROVE* | — | — | Accept memory drafts without human review | ✓ | mode |
| DRY_RUN | 962 | 1 | Print actions, never invoke Claude / mutate a repo | ✗ | base |
| MAX_TICKS | 963 | 5 | Hard cap on ticks per run | ✓ | base |
| MAX_TICKS_PER_DAY | 969 | 50 | Per-calendar-day tick cap across runs | ✓ | base |
| TICK_SLEEP | 965 | 30 | Seconds between ticks | ✓ | advanced |
| EMPTY_POLL_LIMIT | 964 | 2 | Consecutive no-work polls before stop/idle | ✓ | advanced |
| GAFFER_CONCURRENCY | 982 | 1 | Parallel worker processes | ✓ | base |
| MAX_CONCURRENT_TICKETS_PER_REPO | 999 | 1 | In-flight tickets per repo | ✓ | advanced |
| MAX_CANDIDATES | 1004 | 25 | Ready candidates scanned per tick | ✓ | advanced |
| GAFFER_TICK_TIMEOUT | 341 | 1800 | Wall-clock cap per `claude -p` call | ✓ | base |
| GAFFER_MAX_TURNS | 342 | 200 | Agent turn cap per call | ✓ | advanced |
| GAFFER_MAX_DELIVERY_ATTEMPTS | 359 | 3 | Rework attempts before park-to-blocked | ✓ | advanced |
| GAFFER_MAX_NOCOMMIT_FAILURES | 404 | =attempts | Cross-run bound on no-commit crash re-picks | **＋** | advanced |
| GAFFER_REWORK_BUDGET_USD | 391 | =BUDGET_USD | Per-ticket rework spend ceiling | **＋** | advanced |
| GAFFER_MAX_RESUMES_PER_TICK | 477 | 1 | Resume-requested paused tickets re-entered/tick | ✓ | advanced |
| GAFFER_PAUSE_ON_CAP | 473 | 1 | Pause+keep worktree on cap-hit vs park+teardown | ✓ | advanced |
| GAFFER_CAP_DETECT_TURNS | 464 | =MAX_TURNS | num_turns ≥ this ⇒ treated as cap-hit | ✗ | advanced |
| GAFFER_BUDGET_USD | 130 | (empty) | Total spend ceiling (USD) | ✓ | base |
| GAFFER_BUDGET_LOW_THRESHOLD | 185 | 0/derived | Headroom at which routing biases cheaper | ✓ | advanced |
| GAFFER_CHEAP_PHASES | 196 | (empty) | Phases biased to the cheap tier | ✓ | advanced |
| GAFFER_PLAN_MODEL | 73 | opus | Model for plan/decompose phases | ✗ | advanced |
| GAFFER_IMPL_MODEL | 74 | sonnet | Model for implement/test phases | ✗ | advanced |
| GAFFER_REWORK_STRONG_MODEL | 382 | =PLAN_MODEL | Model the final rework attempt escalates to | ✗ | advanced |
| GAFFER_PLAN_DEBATE | 318 | 0 | Two-model adversarial planning debate | ✓ | advanced |
| GAFFER_PLAN_DEBATE_MODELS | 319 | opus,sonnet | Proposer,critic models | ✓ | advanced |
| GAFFER_PLAN_DEBATE_MAX_ROUNDS | 320 | 2 | Plan-producing rounds cap | ✓ | advanced |
| GAFFER_PLAN_DEBATE_MIN_ESTIMATE | 327 | 0 | Min size signal to trigger a debate | ✓ | advanced |
| GAFFER_CREATE_PR | 1324 | 0 | Open a real GitHub PR after delivery | ✓ | advanced |
| GAFFER_REQUIRE_CI | 1335 | 0 | Require CI green before the review lane | ✓ | advanced |
| GAFFER_CI_POLL_ATTEMPTS | 1336 | 20 | Max CI poll cycles | ✓ | advanced |
| GAFFER_CI_POLL_INTERVAL_SECS | 1337 | 30 | Seconds between CI polls | ✓ | advanced |
| MAX_OPEN_AGENT_BRANCHES_PER_REPO | 1174 | 3 | Backpressure: unmerged gaffer/* branches/repo | ✓ | advanced |
| MAX_OPEN_AGENT_PRS_PER_REPO | 1175 | 3 | Backpressure: in_review tickets/repo | ✓ | advanced |
| HYGIENE_ENFORCE | 1129 | 1 | Hard-fail deliveries touching forbidden paths | ✓ | advanced |
| HYGIENE_FORBIDDEN_PATHS | 1142 | node_modules … | Glob fragments that fail the hygiene check | ✗ | advanced |
| MINIMALISM_ENFORCE | 1149 | 1 | Require a smallest-change note per delivery | ✓ | advanced |
| OVERSIZED_MAX_LINES | 1150 | 400 | Changed-line count that flags oversized_diff | ✓ | advanced |
| OVERSIZED_MAX_FILES | 1151 | 12 | Changed-file count that flags oversized_diff | ✓ | advanced |
| CLARIFY_DRAFTS_WHEN_IDLE | 1315 | 0 | Clarify vague drafts when idle | ✓ | advanced |
| IDLE_DRAFT_WHEN_IDLE | 1316 | 0 | Propose new draft tickets when idle | ✓ | advanced |
| GAFFER_IDLE_FEATURE_BACKLOG* | — | — | Mine repos for backlog candidates when idle | ✓ | advanced |
| GAFFER_IDLE_MODE* | — | — | Idle-loop depth: observe/draft/ready | ✓ | advanced |
| STRICT_MODE | 1097 | 0 | Wrap `claude -p` in the OS sandbox | ✓ | mode |
| STRICT_ALLOW_NETWORK | 1110 | 1 | Allow outbound network inside the sandbox | ✓ | advanced |
| SANDBOX_PROVIDER | 1103 | sandbox-exec | OS-containment backend (sandbox-exec/none/…) | **＋** | advanced |
| STRICT_ALLOW_HOME | 1114 | ~/.claude ~/.cache | HOME paths the sandbox may write to | **＋** | advanced |
| GAFFER_BOOTSTRAP_ROOT | 1162 | $HOME/git | Parent dir new bootstrap repos are created under | ✗ | advanced |
| GAFFER_NOTIFY_WEBHOOK_URL* | — | — | POST human-gate events to a webhook | ✓ | advanced |
| GAFFER_NOTIFY_SLACK_URL* | — | — | Slack incoming-webhook for gates | ✓ | advanced |
| GAFFER_NOTIFY_DESKTOP* | — | — | Native desktop banner on each gate | ✓ | advanced |
| GAFFER_NOTIFY_EVENTS* | — | — | Allow-list of gate kinds to notify on | ✓ | advanced |
| GAFFER_NOTIFY_REDACT* | — | — | Send a minimal (redacted) webhook body | ✓ | advanced |

`*` = lives outside `factory.config.sh` (dispatch/crew/memory/notify); listed here
because it is an operator knob and already in the UI. Not part of the 84.

### Internal — wiring, must NOT be a UI knob; auto-derive (32)

| Knob | Line | Derives from | Purpose | Tier |
|---|---|---|---|---|
| RUNNER_DIR | 9 | script location | Runner dir (self-location) | system |
| GAFFER_HOME | 10 | RUNNER_DIR/.. | Monorepo root | system |
| GAFFER_DATA | 11 | GAFFER_HOME/.gaffer | Factory state dir | system |
| DISPATCH_DIR | 31 | GAFFER_HOME | dispatch package dir | system |
| CREW_DIR | 32 | GAFFER_HOME | crew package dir | system |
| MEMORY_DIR | 33 | GAFFER_HOME | memory package dir | system |
| DISPATCH_DB | 36 | GAFFER_DATA | Dispatch sqlite path | system |
| MEMORY_DB | 37 | GAFFER_DATA | Memory sqlite path | system |
| CREW_CONFIG | 38 | GAFFER_DATA | crew.yaml path | system |
| GAFFER_ESTIMATE_LIB | 45 | RUNNER_DIR | Shared usage-ledger reader | system |
| MCP_CONFIG | 49 | RUNNER_DIR | .mcp.json path | system |
| CLAUDE_SETTINGS | 50 | RUNNER_DIR | Claude settings.json path | system |
| SKILLS_DIR | 51 | RUNNER_DIR | Skills library dir | system |
| CLAUDE_BIN | 52 | `claude` | Worker CLI binary | system |
| CLAUDE_FLAGS | 53 | --permission-mode acceptEdits | Worker CLI flags | system |
| GAFFER_MODEL_REGISTRY | 113 | RUNNER_DIR | model-registry.json path | system |
| DISPATCH_PRODUCT_OWNER_CMD | 887 | RUNNER_DIR | "Suggest work" button command | system |
| DISPATCH_ONBOARD_CMD | 897 | RUNNER_DIR | "Onboard repo" button command | system |
| DISPATCH_TESTER_CMD | 907 | RUNNER_DIR | Black-box tester runner command | system |
| GAFFER_AGENT_NAME | 910 | gaffer-factory | Registered agent name | system |
| GAFFER_AGENT_ID_FILE | 911 | GAFFER_DATA | Persisted agent id file | system |
| GAFFER_LOG | 912 | GAFFER_DATA | Factory log path | system |
| DAILY_COUNTER_FILE | 970 | GAFFER_DATA | Per-day tick counter file | system |
| GAFFER_USAGE_LEDGER | 1018 | GAFFER_DATA | Usage-ledger JSONL path | system |
| MEMORY_CLI_BIN | 1183 | MEMORY_DIR | memory CLI bin | system |
| MEMORY_MCP_BIN | 1184 | MEMORY_DIR | memory MCP bin | system |
| DISPATCH_MCP_BIN | 1185 | DISPATCH_DIR | dispatch MCP bin | system |
| GAFFER_GH_BIN | 1325 | `gh` | Injectable gh binary (tests) | system |
| GAFFER_DASHBOARD_URL | 497 | persisted/port | Dashboard deep-link base URL | system |
| GAFFER_REAP_GRACE | 509 | 30 | TERM→KILL grace for the reaper | system |
| GAFFER_LOCK_TIMEOUT | 622 | 30 | Max wait for a contended lock | system |
| GAFFER_LOCK_STALE | 623 | 120 | mkdir-lock staleness window | system |

### Redundant-or-derivable — collapse (3)

| Knob | Line | Purpose | Recommendation | Risk |
|---|---|---|---|---|
| GAFFER_BUDGET_REMAINING | 167/171 | Live USD headroom, **computed** from the ledger each source | Not an input — remove as a `:=` knob; keep the computed export only. Never expose. | low |
| GAFFER_CLAIM_TTL | 360 | Lease TTL = attempts × timeout + 300 | Keep the derivation; drop as an advertised operator knob (it must track the attempts/timeout math). | low |
| GAFFER_TICK_OUTER_TIMEOUT | 375 | Outer per-tick bound = attempts × timeout + 120 | Same: keep derived, do not surface. | low |

---

## Reduction plan (prioritized)

### A. Delete (dead / no consumer)
**None.** Every one of the 84 knobs has a live consumer (grep-verified across
`runner/` + `packages/`, excluding the config file itself). This is a healthy
signal — the surface is large but not rotten.

### B. Auto-derive / stop-advertising (collapse to system tier) — low risk
Move to a non-knob "system" tier, still env-overridable for the rare
side-by-side checkout, but never rendered and never documented as a tuning knob:

1. **All 32 internal knobs** (paths/bins/DBs/cmd-strings/lock+reap internals).
   They already derive from `GAFFER_HOME`/`GAFFER_DATA`/`RUNNER_DIR`; the change
   is *presentational* — a `SYSTEM_DEFS` block the UI never shows. Rationale: a
   fresh operator should never see `DISPATCH_MCP_BIN`. Risk: low (behaviour
   unchanged; only visibility).
2. **`GAFFER_BUDGET_REMAINING`** (lines 167/171) — it is computed, not set.
   Remove the `:=` framing; keep the computed `export`. Risk: low.

### C. Keep-derived, stop-surfacing (2) — low risk
`GAFFER_CLAIM_TTL` (360) and `GAFFER_TICK_OUTER_TIMEOUT` (375) are pure functions
of `GAFFER_MAX_DELIVERY_ATTEMPTS` × `GAFFER_TICK_TIMEOUT`. Leave the arithmetic;
do not expose them (an operator tunes attempts/timeout, and these follow).

### D. Merge into modes (mode-controlled) — medium risk
Six autonomy knobs always move together and should be driven by the mode
selector, not toggled individually by default:
`REVIEW_MODE` · `DISPATCH_ALLOW_AGENT_APPROVE` · `MERGE_ON_AGENT_REVIEW` ·
`AUTO_MERGE` · `GAFFER_AUTO_PUSH` · `MEMORY_AUTO_APPROVE` (+ `STRICT_MODE` for
strict). Risk: medium — needs the origin-tagging (mode vs explicit) so an
override still wins. Design above; **not implemented**.

### E. Operator knobs missing from the UI (11) — expose behind Advanced
| Knob | Line | Why expose | Risk | Status |
|---|---|---|---|---|
| GAFFER_REWORK_BUDGET_USD | 391 | Mirrors `GAFFER_BUDGET_USD` (already in UI); read directly in tick.sh | low | **added** |
| GAFFER_MAX_NOCOMMIT_FAILURES | 404 | Mirrors `GAFFER_MAX_DELIVERY_ATTEMPTS` (in UI); a real cost bound | low | **added** |
| SANDBOX_PROVIDER | 1103 | Completes the sandbox group (had only 2 of 4 knobs) | low | **added** |
| STRICT_ALLOW_HOME | 1114 | Completes the sandbox group | low | **added** |
| GAFFER_CAP_DETECT_TURNS | 464 | Advanced cap-hit threshold; niche | low | proposal |
| GAFFER_BOOTSTRAP_ROOT | 1162 | Where greenfield repos are created — operator-meaningful path | med | proposal |
| GAFFER_PLAN_MODEL | 73 | Core model tiering | **med** | proposal — see caveat |
| GAFFER_IMPL_MODEL | 74 | Core model tiering | **med** | proposal — see caveat |
| GAFFER_REWORK_STRONG_MODEL | 382 | Escalation model | low | proposal (needs a "models" group) |
| HYGIENE_FORBIDDEN_PATHS | 1142 | Safety-critical glob list | **med** | proposal — editing it can weaken a safety gate |
| DRY_RUN | 962 | The core safety switch | **med** | proposal — usually env-set by the launcher (→ env-locked), and turning it off from a web UI is a footgun; expose read-only or with a confirm |

**Model-knob caveat (`GAFFER_PLAN_MODEL` / `GAFFER_IMPL_MODEL`):** these interact
with the `*_MODEL_EXPLICIT` detection (lines 70–72). The runner treats a value set
*in the environment* as an operator override that pins the model and **disables**
the risk/attempt-aware router. Because `settings.json` values are applied as
defaults at the top of the file (lines 22–28) *before* the EXPLICIT capture, a
UI-set value would also read as EXPLICIT and silently switch off smart routing. A
dedicated "models" group is the right home, but exposing these needs the EXPLICIT
logic reworked first — hence proposal-only, not this pass.

### F. Projected result
- **83/84 → 84 knobs still exist in the file** (we delete nothing; config edits
  can break the factory). The win is *presentation + grouping*, not raw count.
- **Operator-visible surface: 1 mode selector + ~4 base fields**, with ~40
  advanced knobs behind a reveal.
- **32 system knobs never rendered**; 3 derivable knobs (`GAFFER_BUDGET_REMAINING`,
  `GAFFER_CLAIM_TTL`, `GAFFER_TICK_OUTER_TIMEOUT`) removed as *inputs*.
- **Operator UI coverage: 49/49** operator knobs are exposable — 42 in the UI
  after this pass, 7 remaining (the medium-risk proposals above), so the operator
  surface becomes fully UI-covered once the model-group + safety-confirm work
  lands.

---

## Implemented in this pass (conservative — UI coverage only)

Added to `packages/dispatch/src/api/settings.ts` (`SETTING_DEFS`), matching the
existing style, using only pre-existing groups so no `app.js` group-title change
is needed:

- `GAFFER_MAX_NOCOMMIT_FAILURES` (int, budget)
- `GAFFER_REWORK_BUDGET_USD` (string, budget)
- `SANDBOX_PROVIDER` (string, sandbox)
- `STRICT_ALLOW_HOME` (string, sandbox)

Verification: `pnpm --filter dispatch build` passes; the settings test suites
(`settings`, `api-settings`, `web-settings-view`, `web-autonomy-enable`) stay
green (15 tests). No knob deletions, no `factory.config.sh` changes, no
auto-derive/merge — those remain proposals for human review.
