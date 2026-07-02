# Gaffer — Automation Testing Plan & Manual-Regression Runbook

This document is the map of Gaffer's automated test coverage, how to run the full
regression locally (including clean-clone and Linux-CI parity), and the runbook of
checks that **cannot** be automated and must be exercised by hand (or by an agent)
before a release.

Gaffer is a pnpm monorepo (`packages/dispatch`, `packages/crew`, `packages/memory`)
plus a bash orchestrator (`runner/`). Tests split along that seam: TypeScript
packages use Vitest; the runner uses plain Node (`.test.mjs`) and bash (`.test.sh`)
tests with zero framework, run under a per-test wall-clock cap.

---

## 1. What IS automated

### 1.1 Test layers

| Layer | Where | Runner | What it proves |
|---|---|---|---|
| **Unit** | `packages/*/test/*.ts` | Vitest | Pure logic: the state machine, policy packs, claim/evidence services, diff service, memory recall/ranking, crew loops, config parsing. Driven against `Dispatch.open(":memory:")` or in-process functions. |
| **Behavioral (runner)** | `runner/test/*.test.sh`, `*.test.mjs` | bash / node | Real runner functions + the real dispatch CLI against a throwaway SQLite DB and real git repos. Sources `runner/lib/*.sh` or drives `wg`/`lg`. Asserts *outcomes*, not source text. |
| **Integration** | `packages/*/test/*integration*`, `runner/test/*integration*` | Vitest / bash | Cross-component: crew↔dispatch, tick.sh DRY_RUN end-to-end, stabilisation (backpressure+hygiene), boundary. |
| **E2E lifecycle** | `runner/test/e2e-lifecycle.test.sh` | bash | One hermetic full-lifecycle run (create→claim→deliver→gates→submit→approve→merge) against the REAL state machine + runner bookkeeping verbs with a stub agent, a temp DB, and a temp git repo. |
| **Safety-hook** | `runner/safety-hook.mjs` + `runner/test/safety-hook.test.mjs` | node | The PreToolUse deny-by-default enforcer (dangerous-command classes → exit 2). **Never weaken this file.** |
| **Parity** | `packages/crew/test/safety-hook-parity.test.ts`, `root-access-parity.test.ts` | Vitest | The runtime hook (`runner/lib/dangerous-commands.mjs`) and the crew TypeScript classifier are DERIVED from one shared data module so a duplicated security control can never drift silently. |

Approximate suite sizes (keep this table honest as suites grow): dispatch ~972,
memory ~733, crew ~523 Vitest cases; runner ~58 bash + ~16 node behavioral tests.

### 1.2 Coverage map by subsystem

| Subsystem | Primary automated coverage |
|---|---|
| **Dispatch state machine** (`transitionService`, `policy`) | Unit: allowed/guarded transitions, policy gates (ready/claim/done) per pack, real-diff done-gate (`ready-for-merge.test.ts`, `m1-core.test.ts`). E2E: guarded transitions rejected end-to-end. |
| **Claims / leases** (`claimService`, `ticket_claims`) | Behavioral: `runner-claim-at-selection.test.sh` (20-way race), `parallel-claim.test.sh`, `claim-token-isolation.test.sh` (per-tick MCP runtime file), **`concurrency-bookkeeping.test.sh`** (no double-claim at scale, cross-token rejection, parallel-delivery isolation + fail-closed recovery). |
| **Runner-owned bookkeeping** (tick.sh `gaffer_release_delivery`/`gaffer_submit_delivery`/`gaffer_skip_ticket`) | Behavioral: **`tick-unrecoverable-claim-release.test.sh`** (drives the REAL extracted functions: release-to-ready, zero stranded claims, re-claimable, with a negative control), `dod-gate.test.sh` Part B (park to blocked), `park-no-false-page.test.sh`. E2E: submit completes claim, release parks to visible `blocked`. |
| **Done / delivery gates** | `dod-gate.test.sh` (tests/typecheck/lint verdicts), `hygiene.test.sh` (leak classes), `minimalism.test.sh`, `h3-ci-gate.test.sh`. E2E invokes the real DoD + hygiene functions on a live worktree. |
| **Real-diff done-gate** (`diffService`) | Unit: `ready-for-merge.test.ts` (injected git runner). E2E: empty-diff delivery DENIED (`PR_OR_DIFF_REQUIRED`), real-diff PASSES — proving the gate reads git, not agent prose. |
| **Budget / cost / model routing** | `budget-guard.test.sh`, `budget-remaining.test.sh`, `ticket-budget-enforce.test.sh`, `pause-on-cap.test.sh`, `per-repo-cap.test.sh`, `usage-ledger.test.mjs`, `resource-caps.test.sh`, `model-routing.*`, `model-tiering.test.sh`, `estimate-usage.test.mjs`. |
| **Concurrency / backpressure** | `backpressure.test.sh`, `parallel-lock.test.sh`, `parallel-regression.test.sh`, `resource-caps.test.sh`, `concurrency-bookkeeping.test.sh`. |
| **Crash / orphan / timeout safety** | `crash-cleanup.test.sh`, `orphan-recovery.test.sh`, `timeout-fail-closed.test.sh`, `timeout-reap.test.sh`, `park-no-false-page.test.sh`. |
| **Memory** (recall, ranking, cards, lore) | `packages/memory/test/*` incl. `recall-feedback.test.ts`; runner `recall-feedback.test.sh`, `file-cards-onboard.test.sh`. |
| **Crew orchestration / loops / hooks** | `packages/crew/test/*` (implementation loop, idle loops, hooks-engine, ingest, onboarding). |
| **Onboarding / intake / greenfield** | `onboard-*.test.mjs`, `greenfield.test.sh`, `inherit-repo.test.mjs`, `intake-gate.test.sh`, `decompose.test.mjs`. |
| **Safety** | `safety-hook.test.mjs`, `m5-safety.test.ts`, `self-op-ban*.test.sh`, `prompt-quarantine.test.sh`, `agent-env-scrub.test.sh`, parity tests. |

### 1.3 CI (`.github/workflows/ci.yml`)

Matrix: `{ubuntu-latest, macos-latest} × node {22, 24}`. Ordered steps: verify the
`better-sqlite3` native binding loads in each package → lint → format check →
`pnpm -r build` → `pnpm -r typecheck` + `typecheck:test` → `pnpm -r test` →
`pnpm -r test:coverage` (per-package floor gate; thresholds in each
`packages/*/vitest.config.ts`, currently lines/functions/statements 70, branches 60)
→ runner node tests (180 s/test perl-alarm cap) → runner bash tests (120 s/test cap).
Build runs **before** typecheck because crew's tests import the built `dispatch`
`dist/*.d.ts`.

---

## 2. How to run the full regression locally

### 2.1 Standard run (working tree)

```bash
pnpm install
pnpm -r build            # dispatch, crew, memory — REQUIRED before runner tests
pnpm -r test             # all package Vitest suites
pnpm -r test:coverage    # optional: enforce the coverage floor as CI does

# Runner tests (need the built dispatch CLI at packages/dispatch/dist/cli/index.js):
for t in runner/test/*.test.mjs; do echo "== $t"; node "$t" || break; done
for t in runner/test/*.test.sh;  do echo "== $t"; bash "$t" || break; done
```

Runner tests **SKIP with exit 0** (not fail) when the dispatch CLI isn't built, so
always `pnpm -r build` first or you will get false "green" from skips.

### 2.2 Clean-clone run (the pre-release gate)

CI starts from a fresh checkout; reproduce that to catch anything that only works
because of local build artifacts, uncommitted files, or a stale `dist/`:

```bash
# From a throwaway dir — NOT your working tree:
git clone --branch feat/runner-owned-bookkeeping <repo-url> gaffer-clean
cd gaffer-clean
pnpm install --frozen-lockfile
pnpm -r build
pnpm -r test && pnpm -r test:coverage
for t in runner/test/*.test.mjs; do node "$t"; done
for t in runner/test/*.test.sh;  do bash "$t"; done
```

If a test passes in your working tree but fails in the clean clone, the usual
culprits are: a file not committed, a `dist/` that wasn't rebuilt, or a test that
depends on `.dispatch/` / `.gaffer/` state left behind by a real run. The runner
tests all use `mktemp -d` scratch DBs/repos and clean up on `trap … EXIT`, so a
lingering repo-root `.dispatch/` should never affect them — if it does, that's a bug.

### 2.3 Linux-CI parity on macOS (BSD vs GNU coreutils)

The runner bash tests have hit **Linux-only** failures caused by BSD (macOS) vs GNU
(Linux CI) coreutils differences — most often `grep`/`sed`/`awk` flag and escape
semantics (e.g. `grep` treating `\t` literally vs as a tab, `sed -i` syntax, `date`
flags). To reproduce a suspected GNU-only failure locally on macOS, put the GNU
tools first on `PATH` via Homebrew's `g`-prefixed binaries:

```bash
brew install coreutils grep gnu-sed gawk   # provides ggrep, gsed, gawk, gdate, …
# Shim the GNU tools in front of the BSD ones for one shell:
SHIM="$(mktemp -d)"
ln -s "$(command -v ggrep)" "$SHIM/grep"
ln -s "$(command -v gsed)"  "$SHIM/sed"
ln -s "$(command -v gawk)"  "$SHIM/awk"
ln -s "$(command -v gdate)" "$SHIM/date"
PATH="$SHIM:$PATH" bash runner/test/<suspect>.test.sh
```

Conversely, to confirm a test is portable, run it under BOTH the BSD tools (default
macOS `PATH`) and the GNU shim above. Prefer POSIX-portable constructs in new tests
(`perl -0777` for multiline matching, `printf` over `echo -e`, `awk` over GNU-only
`grep -P`) so this shim is a diagnostic, not a requirement. The tab-in-`grep` gotcha
is the single most common offender — use `$'\t'` or a literal tab in a `printf`,
never a bare `\t` in a `grep` pattern.

---

## 3. What CANNOT be automated → manual regression by agents

The automated suite covers the state machine, bookkeeping, gates, and safety
enforcement deterministically. What it deliberately does **not** cover is anything
that needs a real model spending real tokens, a browser rendering the dashboard, a
LAN/token handshake with a phone, or a human's judgement of a delivered change.
Run this runbook against a real (small, disposable) repo before a release. Each item
lists the exact check and the pass bar.

### 3.1 Real end-to-end delivery on a sample repo (LIVE agent, spends tokens)
- **Do:** point the factory at a small sample repo, file one low-risk ticket with a
  clear acceptance criterion, and run one live tick (`DRY_RUN=0`, real `CLAUDE_BIN`).
- **Pass bar:** the runner claims at selection; the agent delivers on a `gaffer/`
  branch; the DoD gate runs the repo's real test command; the ticket reaches
  `in_review` with the AC satisfied and a non-empty real diff; **no** tokens are
  burned on a stranded/parked ticket. Confirm the sample repo's real checkout is
  clean afterward (no worktree/branch residue).
- **Why manual:** requires a live model + real tool use; non-deterministic output.

### 3.2 Dashboard panels render with real data
- **Do:** start the dispatch API/dashboard and open it in a browser against a DB with
  a few tickets in mixed states (ready, claimed, in_review, blocked, done).
- **Pass bar:** every panel renders without console errors; ticket counts match the
  DB; the review surface shows the **real git diff** inline; the "what I own" /
  failure-history / budget surfaces populate (see 3.5).
- **Why manual:** visual rendering + real-data binding; no headless assertion covers
  "looks right".

### 3.3 LAN / token flow (phone ↔ factory)
- **Do:** run the LAN pairing/approval flow end-to-end: generate a token on the host,
  connect from a phone on the same network, approve/act on a ticket from the device.
- **Pass bar:** the token authenticates over LAN; an action taken on the phone lands
  in the DB and is reflected on the dashboard; an expired/invalid token is rejected.
- **Why manual:** needs two devices + a real network; timing and transport specific.

### 3.4 Review → approve UX (the human-in-the-loop path)
- **Do:** take a ticket sitting in `in_review`, read its diff in the review surface,
  and approve it (and separately, reject one back to rework with a reason).
- **Pass bar:** approve advances `in_review → ready_for_merge` only when the done-gate
  is satisfied; reject resets the ACs and returns the ticket to `refining` with the
  reason recorded; the board reflects both immediately. An **agent** cannot approve
  (must be a human unless `DISPATCH_ALLOW_AGENT_APPROVE=1` is explicitly set).
- **Why manual:** the *experience* (readable diff, clear affordances, correct default
  actor) is a judgement call; the transitions themselves are covered by the E2E test.

### 3.5 "What I own" + failure-history + budget surfaces
- **Do:** with a human-claimed ticket, a previously-failed/blocked ticket, and a
  ticket carrying a budget, inspect the corresponding surfaces.
- **Pass bar:** "what I own" lists exactly the human-owned tickets; failure history
  shows the real rework trail + the distilled failing test/assertion; budget shows
  spend-so-far vs cap and flags an over-cap ticket. Numbers reconcile with the DB.
- **Why manual:** correctness of the *presented* aggregation + copy, not the
  underlying data (which unit/behavioral tests already cover).

### 3.6 The crew mock loop as the dry-run harness
- **Do:** keep exercising the crew mock/implementation loop and `tick.sh DRY_RUN=1`
  as the no-spend rehearsal before any live run.
- **Pass bar:** the mock loop and DRY_RUN plan match the shape of the live path
  (selection → gates → submit) without claiming, invoking a model, or mutating a repo.

---

## 4. Conventions for adding tests

- **Prefer behavioral over grep-of-source.** Drive the real function/CLI and assert
  the outcome. A grep over source is acceptable only as a *secondary* silent-revert
  guard layered on top of a behavioral assertion (see
  `tick-unrecoverable-claim-release.test.sh` and `dod-gate.test.sh`), never as the
  sole check for a real invariant.
- **Include a negative control** where feasible — prove the test *bites* (e.g. the
  stranded-claim control in the unrecoverable test, the empty-diff control in the
  E2E/done-gate).
- **Keep runner tests hermetic:** `mktemp -d` scratch DB + git repo, `trap … EXIT`
  cleanup, SKIP (exit 0) when the dispatch CLI isn't built.
- **Never weaken `runner/safety-hook.mjs`** or let the parity tests drift — the
  duplicated dangerous-command control is intentional and derived from one source.
- Keep the packages green (`pnpm -r build && pnpm -r test`) and the runner
  `.mjs`/`.sh` tests green before opening a PR, on **both** macOS and (via the shim
  in §2.3, or CI) Linux.

---

## 5. Known limitation surfaced by these tests

**Concurrent read-modify-write on the shared dispatch DB can transiently fail with
`SQLITE_BUSY`.** `packages/dispatch/src/db/connection.ts` `inTransaction` wraps writes
in a **deferred** `db.transaction(fn)` (its JSDoc says "immediate" but the code is
not). Under `GAFFER_CONCURRENCY > 1`, multiple worker *processes* share one SQLite
DB; a concurrent `recordEvidence` / `submitForReview` / transition intermittently
throws `SQLITE_BUSY: database is locked` **even though `busy_timeout = 5000ms` is
set**, because SQLite does not invoke the busy handler when a deferred transaction
must upgrade its read lock to a write lock (`SQLITE_BUSY_SNAPSHOT`). It fails **safe**
— the transaction rolls back, so no partial or cross-ticket write lands and the
ticket stays cleanly claimed and retryable — but it causes spurious delivery
failures / wasted rework under parallelism. `concurrency-bookkeeping.test.sh` (Part C)
documents this: it asserts isolation + fail-closed + recover-on-retry, and its
delivery helper retries the transient lock exactly as the runner's repeated ticks
would. **Suggested production fix (out of scope for the additive test pass):** make
`inTransaction` use `db.transaction(fn).immediate()` so `BEGIN IMMEDIATE` takes the
write lock up front and `busy_timeout` serializes concurrent writers instead of
erroring.
