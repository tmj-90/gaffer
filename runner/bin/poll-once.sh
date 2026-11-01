#!/usr/bin/env bash
# One-shot "poll for work" — the entrypoint the dashboard's Poll-for-work button
# spawns (via DISPATCH_TICK_CMD). Starts a fresh run with its own empty skip lists (so a
# previously parked/failed ticket gets a fresh attempt), waiting first for a live Poll
# that is still running, then runs a SINGLE tick. Never loops,
# so it can't run away; the button is an explicit "go deliver the next ready ticket".
#
# Runs LIVE by default (the button is a deliberate user action); pass DRY_RUN=1 to
# preview. The dashboard spawns this detached, fire-and-gaffert, with the factory env.
#
# B28(c): the button used to BYPASS every cap the loop enforces — no MAX_TICKS_PER_DAY
# / GAFFER_DAILY_BUDGET_USD check, no day-count bump, and no outer wall-clock bound
# (a hung dashboard-spawned tick was never reaped). A poll is a tick like any other,
# so it now goes through the SAME gate → run-under-timeout → bump sequence as
# loop.sh's serial path: a cap that is already hit refuses the poll cleanly (logged,
# `TICK_RESULT=no_work`, exit 0), the tick runs under GAFFER_TICK_OUTER_TIMEOUT, and
# a tick that may have spent advances the day counter (a `no_work` poll does not).
set -uo pipefail
export DRY_RUN="${DRY_RUN:-0}"   # explicit poll = live unless the caller overrides
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../factory.config.sh
source "$HERE/factory.config.sh"
mkdir -p "$GAFFER_DATA"
# The tick script to run — a seam for the runner tests (a stub that emits a
# TICK_RESULT line); the dashboard never sets it.
: "${GAFFER_POLL_TICK_SH:=$HERE/tick.sh}"

# One cleanup for every exit: this run's state dir, the poll lock, the tee'd output.
_POLL_OUT=""
_poll_cleanup() {
  declare -F gaffer_run_state_end >/dev/null 2>&1 && gaffer_run_state_end
  declare -F gaffer_poll_lock_release >/dev/null 2>&1 && gaffer_poll_lock_release
  [ -n "${_POLL_OUT:-}" ] && rm -f "$_POLL_OUT"
  return 0
}
trap '_poll_cleanup' EXIT

# POLL LOCK (lib/run-state.sh): one live Poll at a time per factory. A Poll pressed
# while the previous one is still finishing (parking an empty delivery, tearing down a
# worktree) WAITS for it, then runs: two Polls ticking at once could act on the same
# ticket's worktree and branch, and the second one's caps must see what the first
# spent. Taken before the caps below; a preview never spends or claims, so it never
# waits. Held until this script exits.
if [ "$DRY_RUN" != "1" ] && declare -F gaffer_poll_lock_acquire >/dev/null 2>&1; then
  if ! gaffer_poll_lock_acquire; then
    echo "gaffer poll: another poll (pid ${_GAFFER_POLL_LOCK_HOLDER:-unknown}) is still running after ${GAFFER_POLL_WAIT_TIMEOUT}s — not polling." >&2
    echo "TICK_RESULT=no_work"; exit 0
  fi
fi
# PER-RUN STATE (lib/run-state.sh): this Poll's own skip and marker lists, in a fresh
# dir no other run reads or writes (exploratory finding poll-race: a Poll used to
# delete the SHARED lists and a still-running run then wrote into the new Poll's).
if declare -F gaffer_run_state_begin >/dev/null 2>&1 && ! gaffer_run_state_begin poll; then
  echo "gaffer poll: ERROR — could not create this run's state dir under $GAFFER_DATA/run-state — not polling." >&2
  echo "TICK_RESULT=error"; exit 1
fi

# Same caps as loop.sh, checked BEFORE any paid work. DRY_RUN never spends, so it is
# never gated (a preview must always be possible).
_day_reserved=0
# An existing settings.json that does not parse leaves the caps it holds unknown
# (factory.config.sh FAIL CLOSED): refuse, preview included — DRY_RUN itself may be
# one of the settings that could not be read.
if declare -F gaffer_settings_readable >/dev/null 2>&1 && ! gaffer_settings_readable; then
  echo "gaffer poll: settings.json ($GAFFER_DATA/settings.json) cannot be read — not polling." >&2
  echo "TICK_RESULT=no_work"; exit 0
fi
# A live poll needs a dollar cap like any live run (lib/budget.sh gaffer_spend_cap_ok).
# The line ends "— not polling." so the dashboard reads it as a REFUSED run and toasts it.
if declare -F gaffer_spend_cap_ok >/dev/null 2>&1 && ! gaffer_spend_cap_ok; then
  echo "gaffer poll: $(gaffer_spend_cap_hint) — not polling." >&2
  echo "TICK_RESULT=no_work"; exit 0
fi
# CLAUDE AUTH (lib/claude-auth.sh): no visible credential → refuse before any claim.
if declare -F gaffer_claude_auth_gate >/dev/null 2>&1 && ! gaffer_claude_auth_gate; then
  echo "gaffer poll: $(gaffer_claude_auth_hint) — not polling." >&2
  echo "TICK_RESULT=no_work"; exit 0
fi
if [ "$DRY_RUN" != "1" ]; then
  # USAGE WINDOW (lib/usage-pause.sh): refuse at once, like a one-shot `gaffer run`
  # (exploratory finding fresh-user/F-13). The tick's own gate would also refuse, but
  # only after a day-cap slot was reserved and with no line the dashboard toasts.
  if declare -F gaffer_usage_pause_active >/dev/null 2>&1 && _up_line="$(gaffer_usage_pause_active)"; then
    echo "gaffer poll: $_up_line — not polling." >&2
    echo "TICK_RESULT=no_work"; exit 0
  fi
  if declare -F gaffer_day_usd_cap_ok >/dev/null 2>&1 && ! gaffer_day_usd_cap_ok; then
    echo "gaffer poll: per-day USD cap (GAFFER_DAILY_BUDGET_USD=${GAFFER_DAILY_BUDGET_USD:-}, spent \$$(gaffer_day_usd_spent)) reached — not polling." >&2
    echo "TICK_RESULT=no_work"; exit 0
  fi
  if declare -F gaffer_budget_headroom_ok >/dev/null 2>&1 && ! gaffer_budget_headroom_ok; then
    echo "gaffer poll: lifetime budget (GAFFER_BUDGET_USD=${GAFFER_BUDGET_USD:-}, headroom \$${GAFFER_BUDGET_REMAINING:-unknown}) exhausted — not polling." >&2
    echo "TICK_RESULT=no_work"; exit 0
  fi
  # ATOMIC ADMISSION (lib/budget.sh): reserve today's slot in one locked
  # read-modify-write BEFORE the tick — a Poll racing a daemon loop (or a pool) used
  # to check-then-bump and both admitted themselves against the same last slot. A
  # no_work poll hands the slot back below.
  _day_rsv_on="$(gaffer_reserve_day_tick)"; _rsv=$?
  case "$_rsv" in
    0) _day_reserved=1 ;;
    1) echo "gaffer poll: per-day cap (MAX_TICKS_PER_DAY=$MAX_TICKS_PER_DAY, used $(gaffer_day_count)) reached — not polling." >&2
       echo "TICK_RESULT=no_work"; exit 0 ;;
    *) echo "gaffer poll: ERROR — could not persist the per-day tick count; the day cap can no longer be enforced — not polling." >&2
       echo "TICK_RESULT=error"; exit 1 ;;
  esac
fi
# R-10: fail closed before spawning — the tick's own agent calls need a timeout
# primitive, and so does the outer bound below.
gaffer_timeout_preflight || { echo "gaffer poll: aborting — no timeout primitive (setup error)." >&2; echo "TICK_RESULT=error"; exit 1; }

# Fresh poll: nothing skipped from a prior run. The run-state dir above starts empty, so
# no list carries over: not the failed / reviewed / clarified / tested lists, the
# backpressure report or the warned-once markers, and not the merge lane's held list (a
# ticket whose landing was held earlier, one repo landed and another's checkout dirty or
# its branch unavailable, is merge work again for this poll: external review #7, Poll for
# work reported no_work while `gaffer merge` would finish the second repo).
wg expire-claims >/dev/null 2>&1 || true   # reap any stale claim before polling
# Sweep worktrees no live or paused delivery owns (a Stopped pause, a killed worker),
# as loop.sh does at the start of every run: a factory driven only by this button
# otherwise never reaps them. Never touches a claimed/in_progress/paused ticket's.
# Every worktree the sweep KEPT (an UNKNOWN status from a failed dispatch read, a
# non-terminal ticket, uncommitted work) is named with its reason, as loop.sh does — a
# poll used to discard those notes, so a preserved worktree was silent.
if declare -F gaffer_cleanup_orphaned_worktrees >/dev/null 2>&1; then
  _reclaim_err="$(mktemp "${TMPDIR:-/tmp}/gaffer-reclaim.XXXXXX" 2>/dev/null || echo /dev/null)"
  _reclaimed="$(gaffer_cleanup_orphaned_worktrees 2>"$_reclaim_err" | tr '\n' ' ')"
  [ -n "${_reclaimed// /}" ] && echo "gaffer poll: reclaimed orphaned worktree(s) for ticket(s): ${_reclaimed% }"
  [ -s "$_reclaim_err" ] && sed 's/^gaffer: orphan-recovery: /gaffer poll: worktree preserved: /; s/^gaffer poll: worktree preserved: DRY_RUN: /gaffer poll: DRY_RUN: /' "$_reclaim_err" >&2
  [ "$_reclaim_err" = /dev/null ] || rm -f "$_reclaim_err"
fi

# Run the ONE tick under the same outer wall-clock cap as loop.sh / worker.sh (sized
# for the whole rework ladder) so a wedged dashboard-spawned tick is reaped, not left
# to burn wall-clock forever. Output streams through (the dashboard's run tracker
# captures it live) and is tee'd so the result line can be read back afterwards.
_POLL_OUT="$(mktemp "${TMPDIR:-/tmp}/gaffer-poll.XXXXXX")" || _POLL_OUT=""
gaffer_timeout "$GAFFER_TICK_OUTER_TIMEOUT" bash "$GAFFER_POLL_TICK_SH" | tee "${_POLL_OUT:-/dev/null}"
rc="${PIPESTATUS[0]}"
res="$(sed -n 's/^TICK_RESULT=//p' "${_POLL_OUT:-/dev/null}" 2>/dev/null | tail -1)"
# CLAUDE AUTH: the delivery call could not authenticate (a key that is visible but
# rejected gets past the gate above). Say so on the line the dashboard reads as a
# refused run and toasts (POLL_REFUSAL_RE), or the poll read as a success while the
# ticket went quietly back to ready (exploratory finding fresh-user/F-06).
if [ "$res" = auth_error ]; then
  echo "gaffer poll: aborting — claude could not authenticate: $(gaffer_claude_auth_hint 2>/dev/null || echo 'run `claude /login`'); the ticket went back to ready, no attempt counted" >&2
fi

# Persist the day count for a tick that may have spent — the same rule as loop.sh
# (gaffer_tick_counts_toward_day_cap: a no_work poll is exempt). A failed bump is
# logged loudly: the cap can no longer be enforced for this day.
# The slot was reserved up front; a poll that provably spent nothing gives it back.
if [ "$_day_reserved" = 1 ] && ! gaffer_tick_counts_toward_day_cap "$res"; then
  gaffer_refund_day_tick "$_day_rsv_on" || true
fi
exit "$rc"
