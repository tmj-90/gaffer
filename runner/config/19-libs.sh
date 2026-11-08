# shellcheck shell=bash
# runner/config/19-libs.sh: the sourced helper libs (runner/lib/*.sh: sandbox, worker, budget, run state,
# usage pause and the delivery helpers), at the same point as before the split.
# Sourced by runner/factory.config.sh only, in its fixed order, never directly or on
# its own: it reads what the parts before it set. Lines moved verbatim from
# factory.config.sh. The last line tells factory.config.sh this part loaded whole.

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
# (runner/preflight.sh --live)? Report-only, used by preflight.sh.
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
# passes the gate (the gate still runs and fails loudly). Set GAFFER_DOD_INSTALL=0 to
# manage dependencies yourself (it also skips the greenfield prime).
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

_GAFFER_CONFIG_PART=19-libs
