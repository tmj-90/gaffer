#!/usr/bin/env bash
# The factory driver: run ticks until the stop conditions hit. This is the whole
# "keeps running" mechanism — a thin loop around headless Claude ticks. Re-run it
# from cron/launchd to keep the factory alive across sittings.
#
# Stop conditions (factory.config.sh): MAX_TICKS, EMPTY_POLL_LIMIT, TICK_SLEEP.
# DRY_RUN=1 (default) makes every tick a no-op print.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=factory.config.sh
source "$HERE/factory.config.sh"
mkdir -p "$GAFFER_DATA"
rm -f "$GAFFER_DATA/.failed-tickets" "$GAFFER_DATA/.reviewed-tickets" "$GAFFER_DATA/.clarified-tickets" \
      "$GAFFER_DATA/.backpressure-repos"   # fresh run: nothing skipped / no backpressure recorded yet

echo "gaffer factory: starting (DRY_RUN=$DRY_RUN, max_ticks=$MAX_TICKS, stop_after_empty=$EMPTY_POLL_LIMIT, max_ticks_per_day=$MAX_TICKS_PER_DAY)"
wg expire-claims >/dev/null 2>&1 || true   # reap any stale claims from a prior interrupted run
ticks=0
empties=0
RUN_STARTED="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"   # run start, for the trust report's run-scoping
while [ "$ticks" -lt "$MAX_TICKS" ]; do
  if ! gaffer_day_cap_ok; then
    echo "gaffer factory: per-day cap (MAX_TICKS_PER_DAY=$MAX_TICKS_PER_DAY, used $(gaffer_day_count)) reached — stopping."
    break
  fi
  ticks=$((ticks + 1))
  # Wrap the whole tick in the same per-call wall-clock cap so a runaway claude -p
  # (or a tick wedged anywhere) can't burn unbounded wall-clock. A small slack is
  # added over GAFFER_TICK_TIMEOUT so the inner per-call timeout fires first (and is
  # logged with context) before this outer guard reaps the tick.
  out="$(gaffer_timeout "$((GAFFER_TICK_TIMEOUT + 60))" bash "$HERE/tick.sh")"
  gaffer_bump_day_count
  res="$(echo "$out" | sed -n 's/^TICK_RESULT=//p' | tail -1)"
  echo "tick $ticks/$MAX_TICKS → ${res:-unknown}"

  if [ "$res" = "no_work" ]; then
    empties=$((empties + 1))
    if [ "$empties" -ge "$EMPTY_POLL_LIMIT" ]; then
      echo "gaffer factory: $empties consecutive empty polls — stopping."
      break
    fi
  else
    empties=0
  fi

  [ "$ticks" -lt "$MAX_TICKS" ] && sleep "$TICK_SLEEP"
done
echo "gaffer factory: done after $ticks tick(s)."

# End-of-run report: landed / failed-safe / parked / re-queued / oversized /
# per-repo pressure / cleanup state. Best-effort — never let a reporting hiccup
# change the loop's exit status.
if [ -f "$HERE/run-summary.sh" ]; then
  echo
  SUMMARY_SINCE="$RUN_STARTED" bash "$HERE/run-summary.sh" || true
fi
