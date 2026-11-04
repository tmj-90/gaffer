# Gaffer factory configuration — source-controlled defaults; override any with env.
# shellcheck shell=bash
# The operator's REAL environment, captured before this file assigns anything. The
# dashboard launcher uses it to tell an operator override (which locks a setting in
# the UI) from a value this config derived (settings.json, mode preset, default) —
# those are unset for the dashboard process so the UI can still edit them.
#
# RE-SOURCE HYGIENE. This file is sourced by a parent (gaffer, loop.sh, a daemon pass)
# and again by every child (tick.sh, worker.sh). The parent EXPORTS what it derived —
# settings.json values and exported defaults — so a child used to inherit them as if
# they were real env, and the assign-if-unset below kept the stale value: a dashboard
# edit (daily USD cap, MAX_TICKS_PER_DAY, review mode, turn cap) never reached a
# running `gaffer run --daemon` or loop until the operator restarted it. So:
#   * the operator's env is captured ONCE per process tree (_GAFFER_OPERATOR_ENV is
#     exported) — a child does not mistake its parent's derived values for overrides;
#   * at the end of this file every variable THIS source newly exported is recorded
#     with its value (_GAFFER_DV_<KEY>, exported; the `_GAFFER_` prefix keeps it out of
#     the agent env, whose allow-list is `GAFFER_*`);
#   * on a re-source, a recorded key the operator did not set and nobody has changed
#     since (value == recorded) is unset first, so settings.json, the mode preset and
#     the defaults derive it afresh. A value a parent script changed on purpose (e.g.
#     `gaffer run` passing DRY_RUN=0 to loop.sh) differs from the record and is kept.
#
# FAIL CLOSED ON AN UNREADABLE settings.json. The unset above is only safe when the
# file can be re-read: a settings.json that EXISTS but does not parse (a hand edit, a
# truncated copy) or cannot be read at all (no node on PATH) would otherwise leave
# every unset key to its default, so a running loop's MAX_TICKS_PER_DAY went back to
# 50 and GAFFER_DAILY_BUDGET_USD / GAFFER_BUDGET_USD went OFF mid-run. So the file is
# read FIRST (before anything is unset) and, when it exists but cannot be parsed:
#   * nothing is unset — inherited values (the last good settings) are kept;
#   * _GAFFER_SETTINGS_UNREADABLE=1 is exported, and every spend gate refuses new paid
#     work on it (gaffer_refresh_day_caps → loop.sh / worker.sh stop, the daemon
#     idles, tick.sh and poll-once.sh refuse) until the file parses again.
# A missing settings.json is not an error (nothing was configured in the UI).
# The path resolves EXACTLY as the RUNNER_DIR / GAFFER_HOME / GAFFER_DATA defaults
# further down do (GAFFER_DATA := $GAFFER_HOME/.gaffer, GAFFER_HOME := $RUNNER_DIR/..),
# so an operator-set GAFFER_HOME with GAFFER_DATA unset reads $GAFFER_HOME/.gaffer —
# not the runner checkout's parent — in the parent and in every child.
_gs_rd="${RUNNER_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
_gs_home="${GAFFER_HOME:-$(cd "$_gs_rd/.." && pwd)}"
_gs_file="${GAFFER_DATA:-$_gs_home/.gaffer}/settings.json"
_gs_out=""; _gs_bad=0
if [ -e "$_gs_file" ]; then
  if command -v node >/dev/null 2>&1; then
    # STRICT: the file must parse as a flat JSON object; anything else exits non-zero.
    # Parsed the way the dashboard's readSettingsFile (packages/dispatch/src/api/
    # settings.ts) reads it: a leading UTF-8 BOM is dropped and the text trimmed, and an
    # empty or whitespace-only file is {} (nothing configured) — so the runner never
    # halts on a file the Settings panel shows as fine. Unparseable or non-object → 3.
    _gs_out="$(node -e 'const fs=require("fs");let s;try{const raw=fs.readFileSync(process.argv[1],"utf8").replace(/^\uFEFF/,"").trim();if(raw==="")process.exit(0);s=JSON.parse(raw)}catch{process.exit(3)}if(!s||typeof s!=="object"||Array.isArray(s))process.exit(3);for(const[k,v]of Object.entries(s))process.stdout.write(k+"\t"+String(v).replace(/[\t\n\r]/g," ")+"\n")' "$_gs_file" 2>/dev/null)" || _gs_bad=1
  else
    _gs_bad=1
  fi
fi
if [ "$_gs_bad" = 1 ]; then
  _GAFFER_SETTINGS_UNREADABLE=1; export _GAFFER_SETTINGS_UNREADABLE
  _gs_out=""
else
  unset _GAFFER_SETTINGS_UNREADABLE
fi
if [ -n "${_GAFFER_OPERATOR_ENV+x}" ]; then
  # Re-source hygiene — skipped while settings.json is unreadable (see above), so the
  # inherited values and their records survive until the file parses again.
  if [ "$_gs_bad" != 1 ]; then
    while IFS= read -r _dv; do
      [ -n "$_dv" ] || continue
      _dk="${_dv#_GAFFER_DV_}"
      case "$_GAFFER_OPERATOR_ENV" in *" $_dk "*) unset "$_dv"; continue ;; esac
      if [ -n "${!_dk+x}" ] && [ "${!_dk}" = "${!_dv}" ]; then unset "$_dk"; fi
      unset "$_dv"
    done < <(compgen -v _GAFFER_DV_ 2>/dev/null)
    unset _dv _dk
  fi
else
  _GAFFER_OPERATOR_ENV=" $(compgen -e 2>/dev/null | tr '\n' ' ') "
  export _GAFFER_OPERATOR_ENV
fi
unset _gs_rd _gs_home _gs_file _gs_bad
_GAFFER_ENV_AT_SOURCE="$_GAFFER_OPERATOR_ENV"
# What was already exported when THIS source began (after the hygiene step): those
# are the operator's or a parent's on purpose, never recorded as derived here.
_GAFFER_EXPORTED_AT_START=" $(compgen -e 2>/dev/null | tr '\n' ' ') "

# This file lives in runner/ of the Gaffer monorepo, so RUNNER_DIR is its own dir
# and GAFFER_HOME is the mono root — which holds runner/ alongside
# packages/{dispatch,crew,memory}. Derive both from the script location
# so the suite works under any checkout root — no hardcoded /Users/<name> path.
# Still env-overridable: a side-by-side (non-mono) checkout can point these elsewhere.
: "${RUNNER_DIR:=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
: "${GAFFER_HOME:=$(cd "$RUNNER_DIR/.." && pwd)}"
: "${GAFFER_DATA:=$GAFFER_HOME/.gaffer}"                       # factory state (dbs, logs, agent id)
# ONE canonical crew events log for everything that sources this file (tick.sh,
# the gaffer CLI, fg, the dashboard it launches, onboard-run): $GAFFER_DATA, never a
# repo checkout. crew itself resolves a relative crew.yaml event_log_path against
# the factory root; this keeps runner-spawned crew calls on the one log tick reads.
export GAFFER_CREW_EVENTS="${GAFFER_CREW_EVENTS:-$GAFFER_DATA/events.jsonl}"

# CONFIG PARTS. The defaults below the prologue live in runner/config/*.sh, one file per
# area, sourced here in this FIXED order: each part reads what the parts before it set,
# and the order is the order this file had when it was one file (the map and the order
# dependencies are in runner/CLAUDE.md). Parts are sourced, never run, so they share
# this shell and the record block at the end sees every export they made. A part that
# is missing, unreadable or did not load to its last line stops the process (fail
# closed): a half-loaded config must never run a tick. The parts are found next to this
# file (symlinks resolved), not under $RUNNER_DIR, which an operator may point elsewhere.
_GAFFER_CONFIG_DIR="${BASH_SOURCE[0]}"
while [ -h "$_GAFFER_CONFIG_DIR" ]; do
  _GAFFER_CONFIG_PART="$(readlink "$_GAFFER_CONFIG_DIR")"
  case "$_GAFFER_CONFIG_PART" in
    /*) _GAFFER_CONFIG_DIR="$_GAFFER_CONFIG_PART" ;;
    *) _GAFFER_CONFIG_DIR="$(dirname "$_GAFFER_CONFIG_DIR")/$_GAFFER_CONFIG_PART" ;;
  esac
done
_GAFFER_CONFIG_DIR="$(cd "$(dirname "$_GAFFER_CONFIG_DIR")" && pwd)/config"
_GAFFER_CONFIG_PART=""
# Every part ends with `_GAFFER_CONFIG_PART=<its name>`; anything else here means it did
# not load whole.
_gaffer_config_loaded() {
  [ "${_GAFFER_CONFIG_PART:-}" = "$1" ] && { _GAFFER_CONFIG_PART=""; return 0; }
  printf 'gaffer: runner/config/%s.sh is missing, unreadable or did not load to its end (looked in %s); refusing to go on with a half-loaded config (fail closed)\n' "$1" "$_GAFFER_CONFIG_DIR" >&2
  exit 1
}
# shellcheck source=config/01-settings.sh
[ -r "$_GAFFER_CONFIG_DIR/01-settings.sh" ] && . "$_GAFFER_CONFIG_DIR/01-settings.sh"; _gaffer_config_loaded 01-settings
# shellcheck source=config/02-paths.sh
[ -r "$_GAFFER_CONFIG_DIR/02-paths.sh" ] && . "$_GAFFER_CONFIG_DIR/02-paths.sh"; _gaffer_config_loaded 02-paths
# shellcheck source=config/03-wiring.sh
[ -r "$_GAFFER_CONFIG_DIR/03-wiring.sh" ] && . "$_GAFFER_CONFIG_DIR/03-wiring.sh"; _gaffer_config_loaded 03-wiring
# shellcheck source=config/04-models.sh
[ -r "$_GAFFER_CONFIG_DIR/04-models.sh" ] && . "$_GAFFER_CONFIG_DIR/04-models.sh"; _gaffer_config_loaded 04-models
# shellcheck source=config/05-budget.sh
[ -r "$_GAFFER_CONFIG_DIR/05-budget.sh" ] && . "$_GAFFER_CONFIG_DIR/05-budget.sh"; _gaffer_config_loaded 05-budget
# shellcheck source=config/06-routing.sh
[ -r "$_GAFFER_CONFIG_DIR/06-routing.sh" ] && . "$_GAFFER_CONFIG_DIR/06-routing.sh"; _gaffer_config_loaded 06-routing
# shellcheck source=config/07-limits.sh
[ -r "$_GAFFER_CONFIG_DIR/07-limits.sh" ] && . "$_GAFFER_CONFIG_DIR/07-limits.sh"; _gaffer_config_loaded 07-limits
# shellcheck source=config/08-guards.sh
[ -r "$_GAFFER_CONFIG_DIR/08-guards.sh" ] && . "$_GAFFER_CONFIG_DIR/08-guards.sh"; _gaffer_config_loaded 08-guards
# shellcheck source=config/09-render.sh
[ -r "$_GAFFER_CONFIG_DIR/09-render.sh" ] && . "$_GAFFER_CONFIG_DIR/09-render.sh"; _gaffer_config_loaded 09-render
# shellcheck source=config/10-locks.sh
[ -r "$_GAFFER_CONFIG_DIR/10-locks.sh" ] && . "$_GAFFER_CONFIG_DIR/10-locks.sh"; _gaffer_config_loaded 10-locks
# shellcheck source=config/11-agent-env.sh
[ -r "$_GAFFER_CONFIG_DIR/11-agent-env.sh" ] && . "$_GAFFER_CONFIG_DIR/11-agent-env.sh"; _gaffer_config_loaded 11-agent-env
# shellcheck source=config/12-identity.sh
[ -r "$_GAFFER_CONFIG_DIR/12-identity.sh" ] && . "$_GAFFER_CONFIG_DIR/12-identity.sh"; _gaffer_config_loaded 12-identity
# shellcheck source=config/13-stop.sh
[ -r "$_GAFFER_CONFIG_DIR/13-stop.sh" ] && . "$_GAFFER_CONFIG_DIR/13-stop.sh"; _gaffer_config_loaded 13-stop
# shellcheck source=config/14-usage.sh
[ -r "$_GAFFER_CONFIG_DIR/14-usage.sh" ] && . "$_GAFFER_CONFIG_DIR/14-usage.sh"; _gaffer_config_loaded 14-usage
# shellcheck source=config/15-modes.sh
[ -r "$_GAFFER_CONFIG_DIR/15-modes.sh" ] && . "$_GAFFER_CONFIG_DIR/15-modes.sh"; _gaffer_config_loaded 15-modes
# shellcheck source=config/16-sandbox.sh
[ -r "$_GAFFER_CONFIG_DIR/16-sandbox.sh" ] && . "$_GAFFER_CONFIG_DIR/16-sandbox.sh"; _gaffer_config_loaded 16-sandbox
# shellcheck source=config/17-cli.sh
[ -r "$_GAFFER_CONFIG_DIR/17-cli.sh" ] && . "$_GAFFER_CONFIG_DIR/17-cli.sh"; _gaffer_config_loaded 17-cli
# shellcheck source=config/18-review.sh
[ -r "$_GAFFER_CONFIG_DIR/18-review.sh" ] && . "$_GAFFER_CONFIG_DIR/18-review.sh"; _gaffer_config_loaded 18-review
unset -f _gaffer_config_loaded
unset _GAFFER_CONFIG_DIR _GAFFER_CONFIG_PART

# Strict-execution-mode provider seam (defines sandbox_wrap_cmd). Sourced last so
# it can read the GAFFER_DATA / STRICT_* config above. Best-effort: a missing file
# must not break the suite, but it ships in-tree so this is just defensive.
# shellcheck source=lib/sandbox.sh
[ -f "$RUNNER_DIR/lib/sandbox.sh" ] && source "$RUNNER_DIR/lib/sandbox.sh"

# Worker seam (defines worker_deliver — the ONE headless `claude -p` invocation).
# Sourced after sandbox.sh so worker_deliver can rely on gaffer_timeout /
# gaffer_agent_env / CLAUDE_* being defined above. Mirrors the sandbox seam's
# fail-soft source guard; it ships in-tree so this is just defensive.
# shellcheck source=lib/worker.sh
[ -f "$RUNNER_DIR/lib/worker.sh" ] && source "$RUNNER_DIR/lib/worker.sh"

# Per-day cost guard helpers (gaffer_day_count / gaffer_bump_day_count /
# gaffer_day_cap_ok). Sourced after the config above so they read MAX_TICKS_PER_DAY
# and DAILY_COUNTER_FILE.
# shellcheck source=lib/budget.sh
[ -f "$RUNNER_DIR/lib/budget.sh" ] && source "$RUNNER_DIR/lib/budget.sh"

# Per-run state dirs (gaffer_run_state_begin / _end: every run's own skip and marker
# lists) and the dashboard Poll's lock (gaffer_poll_lock_acquire / _release).
# shellcheck source=lib/run-state.sh
[ -f "$RUNNER_DIR/lib/run-state.sh" ] && source "$RUNNER_DIR/lib/run-state.sh"

# Usage-window pause helpers (gaffer_usage_pause_record / _active / _until / _wait):
# a usage-limit or rate-limit refusal pauses admission until the window resets.
# shellcheck source=lib/usage-pause.sh
[ -f "$RUNNER_DIR/lib/usage-pause.sh" ] && source "$RUNNER_DIR/lib/usage-pause.sh"

# Auto-merge helper (defines gaffer_auto_merge). In-tree, so this is defensive.
# shellcheck source=lib/automerge.sh
[ -f "$RUNNER_DIR/lib/automerge.sh" ] && source "$RUNNER_DIR/lib/automerge.sh"

# Prompt quarantine (defines gaffer_quarantine + QUARANTINE_NOTICE) — wraps
# untrusted ticket-derived fields in a delimited envelope before they reach the
# agent prompt (P1 prompt-injection). In-tree, so this is defensive.
# shellcheck source=lib/quarantine.sh
[ -f "$RUNNER_DIR/lib/quarantine.sh" ] && source "$RUNNER_DIR/lib/quarantine.sh"

# Delivery-hygiene assertions (defines gaffer_assert_clean_delivery /
# gaffer_assert_repo_clean). HARD-FAIL guard against the unattended-run leaks.
# shellcheck source=lib/hygiene.sh
[ -f "$RUNNER_DIR/lib/hygiene.sh" ] && source "$RUNNER_DIR/lib/hygiene.sh"
# Agent-env helpers shared by every spawn site: the verified settings.json write
# and the worktree node_modules linker (see lib/agent-env.sh).
# shellcheck source=lib/agent-env.sh
[ -f "$RUNNER_DIR/lib/agent-env.sh" ] && source "$RUNNER_DIR/lib/agent-env.sh"
# Execution preflight: `npm ping` from INSIDE the agent's allowlisted env (preflight.sh
# report + the bootstrap gate in tick.sh). Fail-soft: skipped when npm is absent.
# shellcheck source=lib/registry-probe.sh
[ -f "$RUNNER_DIR/lib/registry-probe.sh" ] && source "$RUNNER_DIR/lib/registry-probe.sh"
# Claude auth preflight: is a credential visible (free), or does one tiny call work
# (GAFFER_PREFLIGHT_LIVE=1)? Report-only, used by preflight.sh.
# shellcheck source=lib/claude-auth.sh
[ -f "$RUNNER_DIR/lib/claude-auth.sh" ] && source "$RUNNER_DIR/lib/claude-auth.sh"
# Acceptance gate (runner half): the prompt block for an epic's acceptance ticket.
# shellcheck source=lib/acceptance.sh
[ -f "$RUNNER_DIR/lib/acceptance.sh" ] && source "$RUNNER_DIR/lib/acceptance.sh"

# Minimalism post-condition (defines gaffer_diff_stats / gaffer_check_minimalism).
# shellcheck source=lib/minimalism.sh
[ -f "$RUNNER_DIR/lib/minimalism.sh" ] && source "$RUNNER_DIR/lib/minimalism.sh"

# Per-agent SKILL mount + skill-selection telemetry (defines gaffer_skills_mount /
# gaffer_skills_mount_cleanup / gaffer_record_skill_usage). Mounts ONLY the
# selected + universal skill subset into an agent's .claude/skills instead of the
# whole library, so Claude Code doesn't auto-load all ~66 frontmatter blocks.
# shellcheck source=lib/skills-mount.sh
[ -f "$RUNNER_DIR/lib/skills-mount.sh" ] && source "$RUNNER_DIR/lib/skills-mount.sh"

# Shared file-card context primer (defines gaffer_prime_context_block).
# Sourced after the config above so it can use lg / MEMORY_CLI_BIN / MEMORY_DB.
# shellcheck source=lib/context-primer.sh
[ -f "$RUNNER_DIR/lib/context-primer.sh" ] && source "$RUNNER_DIR/lib/context-primer.sh"

# shellcheck source=lib/card-refresh.sh
# Memory FRESHNESS: write-through file-card refresh after a delivery merges (uses lg +
# the canonical contract, so sourced after context-primer which sets them up).
[ -f "$RUNNER_DIR/lib/card-refresh.sh" ] && source "$RUNNER_DIR/lib/card-refresh.sh"

# Definition-of-Done gate (I3): defines gaffer_run_dod_gates / gaffer_dod_enabled /
# gaffer_dod_run_one / gaffer_dod_summary_line / gaffer_dod_evidence_summary. The
# enforced, runner-run gate (tests/typecheck/lint) every delivery clears BEFORE the
# human review lane. In-tree, so this is defensive.
# GAFFER_ALLOW_NO_DOD=1 — waiver for repos with genuinely no runnable gates: a
# delivery that passes with ZERO gates executed is otherwise a hard fail (the work
# was never verified). Set only when test_command and lint_command are deliberately
# absent; without it the delivery is parked for the operator to investigate.
# GAFFER_DOD_INSTALL (default 1/ON) — before the DoD test gate runs, auto-install
# the delivery worktree's dependencies so the tests can actually run. A fresh
# throwaway worktree has no node_modules, so the first greenfield deliveries used
# to fail the gate ("tests could not run"); this removes that gotcha. Safe-soft: a
# strict no-op when node_modules already exists or the repo is not a recognised
# node project, bounded by GAFFER_DOD_INSTALL_TIMEOUT (defaults to GAFFER_DOD_TIMEOUT,
# 900s), and fail-soft — a failed/timed-out install never crashes the tick and never
# passes the gate (the gate still runs and fails loudly). Set GAFFER_DOD_INSTALL=0
# (or the existing GAFFER_GREENFIELD_INSTALL=0) for byte-identical-to-today behaviour.
# shellcheck source=lib/dod.sh
[ -f "$RUNNER_DIR/lib/dod.sh" ] && source "$RUNNER_DIR/lib/dod.sh"
# MACHINE-CHECKABLE acceptance criteria: the runner executes each AC's check_command
# in the delivery worktree after the DoD gates and records the verdict server-side.
# shellcheck source=lib/ac-checks.sh
[ -f "$RUNNER_DIR/lib/ac-checks.sh" ] && source "$RUNNER_DIR/lib/ac-checks.sh"

# Recoverable-delivery + ask-on-cap primitives (GUARD B / GUARD C): defines
# gaffer_branch_has_commits / gaffer_any_branch_has_commits (recoverable-vs-
# unrecoverable discriminator), gaffer_is_cap_hit / gaffer_cap_num_turns /
# gaffer_delivery_spend (cap detection + spend for the ask-on-cap notify).
# shellcheck source=lib/delivery-recovery.sh
[ -f "$RUNNER_DIR/lib/delivery-recovery.sh" ] && source "$RUNNER_DIR/lib/delivery-recovery.sh"

# Per-repo backpressure (defines gaffer_repo_pressure / gaffer_repo_in_backpressure).
# shellcheck source=lib/backpressure.sh
[ -f "$RUNNER_DIR/lib/backpressure.sh" ] && source "$RUNNER_DIR/lib/backpressure.sh"

# Orphaned-worktree recovery (defines gaffer_cleanup_orphaned_worktrees) — sweeps
# stale per-ticket worktrees left by killed workers (A-1 parallel execution).
# shellcheck source=lib/orphan-recovery.sh
[ -f "$RUNNER_DIR/lib/orphan-recovery.sh" ] && source "$RUNNER_DIR/lib/orphan-recovery.sh"

# Cleanup ownership (defines gaffer_note_own_claim / gaffer_cleanup_owned): a tick's
# teardown removes a worktree or branch only while this run still owns it (external
# review #8: a stopped or expired worker deleted its replacement's submitted branch).
# shellcheck source=lib/cleanup-ownership.sh
[ -f "$RUNNER_DIR/lib/cleanup-ownership.sh" ] && source "$RUNNER_DIR/lib/cleanup-ownership.sh"

# Dashboard process tracking (defines gaffer_dashboard_pid / _pidfile / _write_pid):
# precise running-detection via a recorded+validated PID instead of a broad pgrep.
# shellcheck source=lib/dashboard.sh
[ -f "$RUNNER_DIR/lib/dashboard.sh" ] && source "$RUNNER_DIR/lib/dashboard.sh"

# Greenfield bootstrap helpers (defines gaffer_bootstrap_repo_name / _repo_dir /
# _target_ok / _init / _onboard) — the create-a-repo delivery mode for bootstrap
# tickets. In-tree, so this is defensive.
# shellcheck source=lib/greenfield.sh
[ -f "$RUNNER_DIR/lib/greenfield.sh" ] && source "$RUNNER_DIR/lib/greenfield.sh"

# Clarify gate: when idle (nothing ready), run a headless clarify pass over an
# un-specified DRAFT. OFF by default — clarifying spends tokens every idle tick.
# Set to 1 for a factory you want actively refining its own backlog while idle.
: "${CLARIFY_DRAFTS_WHEN_IDLE:=0}"
: "${IDLE_DRAFT_WHEN_IDLE:=0}"
# Maintenance lane ENV override. The lane's own switch is crew.yaml's
# loops.maintenance.enabled (Settings → Idle loops). Empty (default) = crew.yaml
# decides; 0 = kill switch (an idle tick never asks crew); 1 = force the lane even
# when the crew.yaml switch is off. It only turns the LANE on: the lane rotates
# through the idle loops you enabled (each loop's own flag), so with none enabled an
# idle tick still does nothing and reports no_work.
: "${GAFFER_MAINTENANCE:=}"   # env override for the idle maintenance lane: empty = crew.yaml decides, 0 = off, 1 = force (a lane must still be enabled)

# --- H4: real PR creation (opt-in) -------------------------------------------
# When GAFFER_CREATE_PR=1 AND the primary write repo has a GitHub remote, the
# runner runs `gh pr create` after a successful delivery and records the resulting
# URL back as pr_url on the ticket. Off by default — opt in per-run or globally.
# The `gh` binary is injectable via GAFFER_GH_BIN (default: `gh`) so tests can
# stub it without a real remote.
# PR MODE lands the approved change THROUGH that PR: the dashboard merge
# (bin/merge-ticket.mjs) and the AFK merge (lib/review.sh → gaffer_pr_merge) run
# `gh pr merge <pr_url> --<GAFFER_PR_MERGE_METHOD> --delete-branch` and then
# fast-forward the local default branch from GAFFER_PR_REMOTE; a gh failure falls
# back to the local merge with the reason logged. Without a pr_url the merge is the
# local one, exactly as before.
: "${GAFFER_CREATE_PR:=0}"   # 1/true/yes/on to enable real PR creation; default OFF
: "${GAFFER_GH_BIN:=gh}"     # injectable gh binary (for tests)
: "${GAFFER_PR_MERGE_METHOD:=merge}"   # how an approved PR is landed: merge | squash | rebase
export GAFFER_CREATE_PR GAFFER_GH_BIN GAFFER_PR_MERGE_METHOD

# --- H3: CI-aware review gate (opt-in) ----------------------------------------
# When GAFFER_REQUIRE_CI=1, after the delivery branch/PR exists the runner polls
# `gh pr checks <branch>` until checks are green, then lets the ticket enter the
# human review lane. If CI goes red, the ticket is auto-rejected back to rework
# with the failing check (name + url) as evidence. On poll timeout the gate
# surfaces "CI still pending" and proceeds rather than hanging forever.
# REQUIRES GAFFER_CREATE_PR: the checks are read off the delivery PR, so with PR
# creation off there is no PR to poll — the gate then logs one clear warning per run
# and SKIPS (proceeds to review) instead of polling a PR that never exists and
# rejecting every delivery at the timeout.
# Off by default — fully backward-compatible when unset.
: "${GAFFER_REQUIRE_CI:=0}"            # 1/true/yes/on to require CI green before review (needs GAFFER_CREATE_PR)
: "${GAFFER_CI_POLL_ATTEMPTS:=20}"     # max poll cycles before "still pending" timeout
: "${GAFFER_CI_POLL_INTERVAL_SECS:=30}" # seconds between polls
export GAFFER_REQUIRE_CI GAFFER_CI_POLL_ATTEMPTS GAFFER_CI_POLL_INTERVAL_SECS

# H4 PR-creation helper (defines gaffer_create_pr / gaffer_pr_create_enabled /
# gaffer_has_github_remote / gaffer_build_pr_body). Sourced here so the functions
# are available in tick.sh which sources factory.config.sh.
# shellcheck source=lib/pr-create.sh
[ -f "$RUNNER_DIR/lib/pr-create.sh" ] && source "$RUNNER_DIR/lib/pr-create.sh"

# H3 CI-gate helper (defines gaffer_ci_gate / gaffer_ci_gate_enabled /
# gaffer_parse_checks). Sourced here for the same reason.
# shellcheck source=lib/ci-gate.sh
[ -f "$RUNNER_DIR/lib/ci-gate.sh" ] && source "$RUNNER_DIR/lib/ci-gate.sh"

# EVAL JUDGE (lib/eval-judge.sh): 1 = after every submitted delivery an independent judge
# scores the diff against the ticket on the crew rubric (AC coverage, correctness,
# minimalism, test adequacy, security) with a reason per dimension, into
# $GAFFER_DATA/eval-ledger.jsonl and onto the ticket: the Review view's verdict strip and
# `wg ticket show` carry the score and the weak dimensions' reasons. Advisory only: it
# never blocks, parks or reworks a ticket. Off by default because it is one extra paid
# model call per delivery (booked as kind eval-judge). Whether it earns that on your
# factory is measured, not assumed: after 20 or more reviewed deliveries,
# `gaffer eval agreement` pairs each score with the review outcome and says whether it
# separates the work you accepted from the work you sent back. 0 = off.
# See docs/eval-harness.md.
: "${GAFFER_EVAL_JUDGE:=0}"

# MATCHED EXPERIMENTS (runner/eval/experiment.sh, `gaffer eval experiment`): the same
# tickets under two or more arms of settings, paired differences per ticket. Stub mode (the
# default) is free and ignores the dollar cap; a LIVE run (--live) needs a hard USD cap for
# the whole run, which also caps every call, and still passes the factory's own budget
# admission and usage pause. A person starts one: the safety hook denies it to an agent.
: "${GAFFER_EXPERIMENT_MAX_USD:=}"       # Hard USD cap of one LIVE experiment run (every call is capped at what is left); required for --live, empty = live mode refuses
: "${GAFFER_EXPERIMENT_MAX_TICKETS:=5}"  # At most this many tickets in one experiment (each runs once per arm)
: "${GAFFER_EXPERIMENT_MAX_ATTEMPTS:=2}" # Attempts per ticket and arm: the first plus reworks after a failed gate, every one counted

# REVIEW RULES (dispatch): the same send-back reason or must-fix comment from a person
# (after dropping ids, paths and numbers) on this many tickets in one repo is proposed as a
# lore convention draft tagged review-rule, which a person approves (gaffer lore approve or
# the Memory view); it never auto-approves, MEMORY_AUTO_APPROVE included. Only a person's
# feedback counts, never an agent's or the tester's. 2..20; `wg review-rules` lists them.
# Read by dispatch (the dashboard server and `gaffer wg`), so it is a dashboard setting and
# exported like the other dispatch knobs: an unexported default here never reached it.
: "${GAFFER_REVIEW_RULE_REPEAT:=3}"
export GAFFER_REVIEW_RULE_REPEAT
# Post-delivery quality judging (gaffer_eval_judge_delivery): scores a submitted
# delivery on the crew rubric into the eval ledger (pass rate / cost-per-pass /
# memory score gap telemetry). Always fail-soft.
# shellcheck source=lib/eval-judge.sh
[ -f "$RUNNER_DIR/lib/eval-judge.sh" ] && source "$RUNNER_DIR/lib/eval-judge.sh"
# The pre-work scout (gaffer_scout_run, gaffer_model_scout): the deterministic packet of
# likely files and the risk classifier before each delivery; the bounded model scout is
# opt-in (GAFFER_SCOUT). Always fail-soft.
# shellcheck source=lib/scout.sh
[ -f "$RUNNER_DIR/lib/scout.sh" ] && source "$RUNNER_DIR/lib/scout.sh"
# The replay manifest of each delivery attempt (gaffer_manifest_start / _finish / _close /
# _annotate): what an offline experiment re-runs and the routing scorecard joins on.
# Measurements only; always fail-soft. Stubs keep tick.sh's calls safe without the lib.
# shellcheck source=lib/replay-manifest.sh
if [ -f "$RUNNER_DIR/lib/replay-manifest.sh" ]; then
  source "$RUNNER_DIR/lib/replay-manifest.sh"
else
  gaffer_manifest_start() { :; }; gaffer_manifest_gates() { :; }; gaffer_manifest_finish() { :; }
  gaffer_manifest_close() { :; }; gaffer_manifest_annotate() { :; }
fi

# HOST GIT NEVER RUNS REPOSITORY CODE (external review #9, finding 2). Every git the
# runner runs for bookkeeping (auto-commit, worktrees, fetch/merge/push, status) gets
# core.hooksPath=/dev/null and core.fsmonitor=false through GIT_CONFIG_COUNT, so an
# agent's edit to a tracked hook script never executes on the host. tick.sh and land.sh
# call it again with the ticket's repositories to neutralise drivers/helpers that point
# into them (lib/git-safe.mjs). The agent's own env is allowlisted, so it never sees these.
# shellcheck source=lib/git-safe.sh
if [ -f "$RUNNER_DIR/lib/git-safe.sh" ]; then
  source "$RUNNER_DIR/lib/git-safe.sh"
  gaffer_git_harden
fi

# RE-SOURCE HYGIENE (see the top of this file): record every variable this source
# newly exported, with its value, so a child's re-source can tell a stale derived
# value (unchanged → derived afresh from settings.json / the mode / the defaults) from
# one a parent changed on purpose (kept). Keep this block LAST.
while IFS= read -r _dk; do
  # GIT_CONFIG_* (lib/git-safe.sh) is a numbered list: re-deriving
  # some entries and not others would corrupt it, so they are never recorded.
  case "$_dk" in '' | _GAFFER_* | GIT_CONFIG_*) continue ;; esac
  case "$_GAFFER_EXPORTED_AT_START" in *" $_dk "*) continue ;; esac
  printf -v "_GAFFER_DV_$_dk" '%s' "${!_dk}"
  export "_GAFFER_DV_$_dk"
done < <(compgen -e 2>/dev/null)
unset _dk _GAFFER_EXPORTED_AT_START
