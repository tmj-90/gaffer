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
# Each tick runs under the SAME per-call wall-clock cap loop.sh uses for the serial
# path, so a wedged tick in one worker can't burn unbounded wall-clock.
#
# Usage: worker.sh <worker-id>
#   Writes "<worked> <reviewed> <clarified> <idle> <nowork> <error> <ticks>" to
#   $GAFFER_DATA/.workers/<worker-id>.result for loop.sh to aggregate.
#
# Stop conditions per worker:
#   • EMPTY_POLL_LIMIT consecutive no_work ticks (the queue is drained for us), or
#   • MAX_TICKS ticks (shared per-run cost guard, divided across the pool by
#     loop.sh — see WORKER_MAX_TICKS), or
#   • the per-day cap (gaffer_day_cap_ok) is hit.
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

while [ "$ticks" -lt "$W_MAX_TICKS" ]; do
  # Per-day cost cap is a SHARED guard — honour it inside every worker so the pool
  # can't collectively blow past MAX_TICKS_PER_DAY.
  if ! gaffer_day_cap_ok; then
    echo "worker $WORKER_ID: per-day cap reached — stopping." >&2
    break
  fi
  ticks=$((ticks + 1))

  # Same per-call wall-clock cap as loop.sh's serial path: a runaway tick in this
  # worker is reaped, not left to burn wall-clock.
  out="$(gaffer_timeout "$((GAFFER_TICK_TIMEOUT + 60))" bash "$HERE/tick.sh")"

  # Each tick spends (invokes claude -p), so it counts against the shared per-day
  # ledger. gaffer_bump_day_count is lock-serialised (budget.sh) so concurrent
  # workers never lose a count.
  if ! gaffer_bump_day_count; then
    echo "worker $WORKER_ID: ERROR — could not persist per-day tick count; stopping." >&2
    break
  fi

  res="$(echo "$out" | sed -n 's/^TICK_RESULT=//p' | tail -1)"
  case "${res:-unknown}" in
    worked)       worked=$((worked + 1)); empties=0 ;;
    reviewed)     reviewed=$((reviewed + 1)); empties=0 ;;
    clarified)    clarified=$((clarified + 1)); empties=0 ;;
    idle_drafted) idle=$((idle + 1)); empties=0 ;;
    no_work)      nowork=$((nowork + 1)); empties=$((empties + 1)) ;;
    *)            errors=$((errors + 1)); empties=0 ;;
  esac
  echo "worker $WORKER_ID: tick $ticks → ${res:-unknown}" >&2

  # A worker stops once the queue is drained FOR IT: EMPTY_POLL_LIMIT consecutive
  # no_work ticks. (Other workers may still be delivering; the pool-level wait in
  # loop.sh joins them all.)
  if [ "$res" = "no_work" ] && [ "$empties" -ge "$EMPTY_POLL_LIMIT" ]; then
    echo "worker $WORKER_ID: $empties consecutive empty polls — stopping." >&2
    break
  fi
  [ "$ticks" -lt "$W_MAX_TICKS" ] && sleep "$TICK_SLEEP"
done

printf '%s %s %s %s %s %s %s\n' "$worked" "$reviewed" "$clarified" "$idle" "$nowork" "$errors" "$ticks" > "$RESULT_FILE"
echo "worker $WORKER_ID: done after $ticks tick(s) (worked=$worked reviewed=$reviewed clarified=$clarified idle=$idle no_work=$nowork error=$errors)." >&2
