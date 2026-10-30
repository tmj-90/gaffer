#!/usr/bin/env bash
# A-1: a single factory WORKER. Under GAFFER_CONCURRENCY>1, loop.sh spawns a pool
# of these in parallel; each one loops claim→deliver by invoking tick.sh UNCHANGED
# until a tick reports no claimable work, then exits. tick.sh already does all the
# real work (candidate selection, atomic claim, worktree-isolated delivery,
# review/clarify, cleanup); the worker just drives it in a loop and tallies
# results. Parallelism is safe because:
#   • claims are atomic (partial unique index → exactly one winner under a race);
#   • candidates are dependency-gated transactionally;
#   • each ticket delivers in its own deterministic worktree on its own branch;
#   • the shared mutable state (day-cap counter, usage ledger, skip/log/bp files)
#     is serialised with gaffer_with_lock inside tick.sh / budget.sh / factory.config.sh.
#
# The worker does NOT hold any lock around a whole tick — that would serialise all
# delivery and defeat the point. It only relies on the fine-grained locks tick.sh
# already takes around the specific shared-state mutations.
#
# Each tick runs under the SAME outer wall-clock cap loop.sh uses for the serial
# path (GAFFER_TICK_OUTER_TIMEOUT — sized for the whole rework ladder), so a
# wedged tick in one worker can't burn unbounded wall-clock.
#
# Usage: worker.sh <worker-id>
#   Writes "<worked> <reviewed> <clarified> <idle> <nowork> <error> <ticks>" to
#   $GAFFER_DATA/.workers/<worker-id>.result for loop.sh to aggregate.
#
# Stop conditions per worker:
#   • EMPTY_POLL_LIMIT consecutive no_work ticks (the queue is drained for us), or
#   • the shared per-run MAX_TICKS budget is exhausted (one counter for the whole
#     pool, reserved atomically per tick — GAFFER_RUN_TICKS_FILE; a hand-run worker
#     without it falls back to its static WORKER_MAX_TICKS share), or
#   • the per-day tick cap (gaffer_day_cap_ok) or the per-day USD cap
#     (gaffer_day_usd_cap_ok, GAFFER_DAILY_BUDGET_USD) is hit.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=factory.config.sh
source "$HERE/factory.config.sh"
mkdir -p "$GAFFER_DATA"

WORKER_ID="${1:-0}"
WORKERS_DIR="$GAFFER_DATA/.workers"
mkdir -p "$WORKERS_DIR"
RESULT_FILE="$WORKERS_DIR/$WORKER_ID.result"

# Per-worker tick budget: loop.sh passes WORKER_MAX_TICKS (the shared MAX_TICKS
# divided across the pool, rounded up) so the pool's TOTAL ticks still honour
# MAX_TICKS. Fall back to MAX_TICKS if unset (e.g. a worker run by hand).
W_MAX_TICKS="${WORKER_MAX_TICKS:-$MAX_TICKS}"

worked=0; reviewed=0; clarified=0; idle=0; nowork=0; errors=0; ticks=0
empties=0

# STOP (loop.sh STOPPABLE POOL). loop.sh TERMs every worker on INT/TERM/HUP and writes
# the pool stop file. The in-flight tick runs in the BACKGROUND (+ `wait`) so this trap
# fires at once instead of after the whole tick: it TERMs the tick's process group (the
# outer gaffer_timeout records its PGID in this worker's own file), the tick's crash
# trap releases its claim, and no further tick is reserved. Ctrl-C normally reaches us
# as loop.sh's TERM: bash starts a background worker with SIGINT ignored, and then the
# INT trap below is a no-op. Where the worker does receive INT itself (bash 3.2 on
# macOS), it stops the same way instead of dying and orphaning its tick's wrapper.
_stop=0
_tick_pid=""
_TICK_PGID_FILE="$WORKERS_DIR/$WORKER_ID.tick-pgid"
_TICK_OUT="$WORKERS_DIR/$WORKER_ID.tick-out"
_worker_stop() {
  _stop=1
  local _pg
  _pg="$(cat "$_TICK_PGID_FILE" 2>/dev/null || true)"
  case "$_pg" in ''|*[!0-9]*) ;; *) kill -TERM -- "-$_pg" 2>/dev/null || true ;; esac
  # The tick's wrapper (perl) if it started but has not recorded the group yet.
  [ -n "$_tick_pid" ] && command -v pkill >/dev/null 2>&1 && pkill -TERM -P "$_tick_pid" 2>/dev/null
  return 0
}
trap '_worker_stop' TERM HUP INT
# True when this worker must not start another tick: told to stop, the pool stop file
# exists, or the loop that spawned us is gone (killed with SIGKILL, so no TERM came).
_should_stop() {
  [ "$_stop" = 1 ] && return 0
  [ -n "${GAFFER_POOL_STOP_FILE:-}" ] && [ -e "$GAFFER_POOL_STOP_FILE" ] && return 0
  [ -n "${GAFFER_LOOP_PID:-}" ] && ! kill -0 "$GAFFER_LOOP_PID" 2>/dev/null && return 0
  return 1
}

# Shared per-run budget (loop.sh exports GAFFER_RUN_TICKS_FILE): each tick is RESERVED
# atomically against MAX_TICKS before it starts, so the pool total is bounded exactly.
# Without the shared counter (a worker run by hand) the static per-worker share applies.
_reserve_run_tick() {
  if [ -n "${GAFFER_RUN_TICKS_FILE:-}" ]; then
    gaffer_reserve_run_tick "$GAFFER_RUN_TICKS_FILE" "$MAX_TICKS"
  else
    [ "$ticks" -lt "$W_MAX_TICKS" ]
  fi
}
_refund_run_tick() { [ -n "${GAFFER_RUN_TICKS_FILE:-}" ] && gaffer_refund_run_tick "$GAFFER_RUN_TICKS_FILE" || true; }

while ! _should_stop && _reserve_run_tick; do
  # Per-day cost cap is a SHARED guard — honour it inside every worker so the pool
  # can't collectively blow past MAX_TICKS_PER_DAY. ATOMIC ADMISSION: the slot is
  # reserved in one locked read-modify-write BEFORE the tick (lib/budget.sh); the old
  # check-then-bump let N workers all admit themselves against the same last slot.
  # DRY_RUN ticks never spend, so they neither reserve nor count (BUG 6).
  _day_reserved=0
  if [ "${DRY_RUN:-0}" != "1" ]; then
    _day_rsv_on="$(gaffer_reserve_day_tick)"; _rsv=$?
    case "$_rsv" in
      0) _day_reserved=1 ;;
      1) echo "worker $WORKER_ID: per-day cap reached — stopping." >&2; _refund_run_tick; break ;;
      *) echo "worker $WORKER_ID: ERROR — could not persist per-day tick count; stopping." >&2; _refund_run_tick; break ;;
    esac
  fi
  # B28(d): the per-UTC-day USD ceiling (GAFFER_DAILY_BUDGET_USD) is a SHARED guard
  # too. loop.sh's serial path and the daemon consulted it, but a worker pool did not
  # — so at GAFFER_CONCURRENCY>1 the USD cap was silently ignored. Same clean stop.
  if declare -F gaffer_day_usd_cap_ok >/dev/null 2>&1 && ! gaffer_day_usd_cap_ok; then
    echo "worker $WORKER_ID: per-day USD cap (GAFFER_DAILY_BUDGET_USD=${GAFFER_DAILY_BUDGET_USD:-}, spent \$$(gaffer_day_usd_spent)) reached — stopping." >&2
    [ "$_day_reserved" = 1 ] && gaffer_refund_day_tick "$_day_rsv_on" || true
    _refund_run_tick
    break
  fi
  ticks=$((ticks + 1))

  # Same outer wall-clock cap as loop.sh's serial path: a wedged tick in this
  # worker is reaped, not left to burn wall-clock. FINDING-6 (a): sized for the
  # whole rework ladder (attempts × GAFFER_TICK_TIMEOUT + margin), matching the
  # claim-TTL math — the inner per-call GAFFER_TICK_TIMEOUT still bounds each
  # individual claude -p first.
  : > "$_TICK_OUT"
  GAFFER_TIMEOUT_PGID_FILE="$_TICK_PGID_FILE" gaffer_timeout "$GAFFER_TICK_OUTER_TIMEOUT" bash "$HERE/tick.sh" > "$_TICK_OUT" &
  _tick_pid=$!
  # `wait` returns early when the stop trap fires; keep waiting until the tick is gone.
  while kill -0 "$_tick_pid" 2>/dev/null; do wait "$_tick_pid" 2>/dev/null; done
  _tick_pid=""
  out="$(cat "$_TICK_OUT" 2>/dev/null)"
  res="$(echo "$out" | sed -n 's/^TICK_RESULT=//p' | tail -1)"

  # A tick that may have spent (invoked claude -p) counts against the shared per-day
  # ledger. gaffer_bump_day_count is lock-serialised (budget.sh) so concurrent
  # workers never lose a count.
  # BUG 6 fix: DRY_RUN ticks never call claude -p so must not consume the daily
  # budget — skip the bump entirely when DRY_RUN=1.
  # B28: a `no_work` tick spawned no agent either — it is exempt, so an idle pool
  # cannot burn the day cap (gaffer_tick_counts_toward_day_cap, lib/budget.sh).
  # The slot was reserved up front (atomic admission); a tick that provably spent
  # nothing (`no_work`) gives it back so the counter still means "may have paid".
  if [ "$_day_reserved" = 1 ] && ! gaffer_tick_counts_toward_day_cap "$res"; then
    gaffer_refund_day_tick "$_day_rsv_on" || true
  fi
  case "${res:-unknown}" in
    worked)            worked=$((worked + 1)); empties=0 ;;
    reviewed)          reviewed=$((reviewed + 1)); empties=0 ;;
    clarified)         clarified=$((clarified + 1)); empties=0 ;;
    idle_drafted)      idle=$((idle + 1)); empties=0 ;;
    # BUG 5 fix: maintenance_drafted / maintenance_ran are productive results
    # emitted by the maintenance lane in tick.sh (~line 1898-1899). Without
    # these cases they fell through to *) and were miscounted as errors.
    maintenance_drafted|maintenance_ran) idle=$((idle + 1)); empties=0 ;;
    # PAUSE-ON-CAP: a cap-hit delivery paused IN PLACE (partial work preserved on a
    # live worktree) is PRODUCTIVE, not an error — it produced committed work and is
    # awaiting a human Continue/Stop. Count it with `worked`.
    paused)            worked=$((worked + 1)); empties=0 ;;
    no_work)           nowork=$((nowork + 1)); empties=$((empties + 1)) ;;
    *)                 errors=$((errors + 1)); empties=0 ;;
  esac
  echo "worker $WORKER_ID: tick $ticks → ${res:-unknown}" >&2
  # SETUP ERROR (tick.sh gaffer_abort_setup): systemic — every worker's next tick would
  # fail the same way. Stop the whole pool; loop.sh reports it and exits 3.
  if [ "$res" = "setup_error" ]; then
    echo "worker $WORKER_ID: setup error — stopping the pool." >&2
    [ -n "${GAFFER_POOL_STOP_FILE:-}" ] && : > "$GAFFER_POOL_STOP_FILE"
    break
  fi

  # A worker stops once the queue is drained FOR IT: EMPTY_POLL_LIMIT consecutive
  # no_work ticks. (Other workers may still be delivering; the pool-level wait in
  # loop.sh joins them all.)
  if [ "$res" = "no_work" ] && [ "$empties" -ge "$EMPTY_POLL_LIMIT" ]; then
    echo "worker $WORKER_ID: $empties consecutive empty polls — stopping." >&2
    break
  fi
  _should_stop && break
  sleep "$TICK_SLEEP" &
  wait "$!" 2>/dev/null
done
rm -f "$_TICK_OUT" "$_TICK_PGID_FILE" 2>/dev/null

printf '%s %s %s %s %s %s %s\n' "$worked" "$reviewed" "$clarified" "$idle" "$nowork" "$errors" "$ticks" > "$RESULT_FILE"
echo "worker $WORKER_ID: done after $ticks tick(s) (worked=$worked reviewed=$reviewed clarified=$clarified idle=$idle no_work=$nowork error=$errors)." >&2
