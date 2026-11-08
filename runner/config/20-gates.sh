# shellcheck shell=bash
# runner/config/20-gates.sh: idle lanes and the opt-in gates: PR creation, the CI gate, the eval judge,
# matched experiments, review rules; then the pr-create, ci-gate, eval-judge,
# scout, replay-manifest and git-safe libs.
# Sourced by runner/factory.config.sh only, in its fixed order, never directly or on
# its own: it reads what the parts before it set. Lines moved verbatim from
# factory.config.sh. The last line tells factory.config.sh this part loaded whole.

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
GAFFER_GH_BIN="${GAFFER_GH_BIN:-gh}"     # injectable gh binary (for tests)
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

_GAFFER_CONFIG_PART=20-gates
