#!/usr/bin/env bash
# One-shot "poll for work" — the entrypoint the dashboard's Poll-for-work button
# spawns (via DISPATCH_TICK_CMD). Clears the per-run skip files (so a previously
# parked/failed ticket gets a fresh attempt) then runs a SINGLE tick. Never loops,
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

# Same caps as loop.sh, checked BEFORE any paid work. DRY_RUN never spends, so it is
# never gated (a preview must always be possible).
if [ "$DRY_RUN" != "1" ]; then
  if ! gaffer_day_cap_ok; then
    echo "gaffer poll: per-day cap (MAX_TICKS_PER_DAY=$MAX_TICKS_PER_DAY, used $(gaffer_day_count)) reached — not polling." >&2
    echo "TICK_RESULT=no_work"; exit 0
  fi
  if declare -F gaffer_day_usd_cap_ok >/dev/null 2>&1 && ! gaffer_day_usd_cap_ok; then
    echo "gaffer poll: per-day USD cap (GAFFER_DAILY_BUDGET_USD=${GAFFER_DAILY_BUDGET_USD:-}, spent \$$(gaffer_day_usd_spent)) reached — not polling." >&2
    echo "TICK_RESULT=no_work"; exit 0
  fi
fi
# R-10: fail closed before spawning — the tick's own agent calls need a timeout
# primitive, and so does the outer bound below.
gaffer_timeout_preflight || { echo "gaffer poll: aborting — no timeout primitive (setup error)." >&2; echo "TICK_RESULT=error"; exit 1; }

# Fresh poll: nothing skipped from a prior run (mirrors what loop.sh clears).
rm -f "$GAFFER_DATA/.failed-tickets" "$GAFFER_DATA/.reviewed-tickets" \
      "$GAFFER_DATA/.clarified-tickets" "$GAFFER_DATA/.backpressure-repos" \
      "$GAFFER_DATA/.ci-gate-needs-pr-warned" "$GAFFER_DATA/.autonomy-policy-inert-warned"
wg expire-claims >/dev/null 2>&1 || true   # reap any stale claim before polling

# Run the ONE tick under the same outer wall-clock cap as loop.sh / worker.sh (sized
# for the whole rework ladder) so a wedged dashboard-spawned tick is reaped, not left
# to burn wall-clock forever. Output streams through (the dashboard's run tracker
# captures it live) and is tee'd so the result line can be read back afterwards.
_POLL_OUT="$(mktemp "${TMPDIR:-/tmp}/gaffer-poll.XXXXXX")" || _POLL_OUT=""
trap 'rm -f "${_POLL_OUT:-}"' EXIT
gaffer_timeout "$GAFFER_TICK_OUTER_TIMEOUT" bash "$GAFFER_POLL_TICK_SH" | tee "${_POLL_OUT:-/dev/null}"
rc="${PIPESTATUS[0]}"
res="$(sed -n 's/^TICK_RESULT=//p' "${_POLL_OUT:-/dev/null}" 2>/dev/null | tail -1)"

# Persist the day count for a tick that may have spent — the same rule as loop.sh
# (gaffer_tick_counts_toward_day_cap: a no_work poll is exempt). A failed bump is
# logged loudly: the cap can no longer be enforced for this day.
if [ "$DRY_RUN" != "1" ] && gaffer_tick_counts_toward_day_cap "$res"; then
  gaffer_bump_day_count \
    || echo "gaffer poll: ERROR — could not persist the per-day tick count; the day cap can no longer be enforced." >&2
fi
exit "$rc"
