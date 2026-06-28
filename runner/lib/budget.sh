#!/usr/bin/env bash
# Per-day cost guard for unattended factory runs. MAX_TICKS bounds a SINGLE
# loop.sh invocation, but launchd re-runs loop.sh on a schedule — so MAX_TICKS
# alone can't bound a full day's spend. This tracks a per-CALENDAR-DAY tick count
# persisted in GAFFER_DATA (DAILY_COUNTER_FILE), surviving across loop.sh runs, so
# an overnight factory hard-stops once the day's cap is hit. Each tick invokes
# `claude -p` (real cost), so the count is per tick regardless of result.
# shellcheck shell=bash

# Echo today's persisted tick count — 0 if there is no record, or the record is
# from an earlier day (a new calendar day resets the count).
gaffer_day_count() {
  local today d c
  today="$(date +%Y-%m-%d)"
  if [ -f "$DAILY_COUNTER_FILE" ]; then
    read -r d c < "$DAILY_COUNTER_FILE" || true
    if [ "$d" = "$today" ]; then echo "${c:-0}"; return; fi
  fi
  echo 0
}

# Increment and persist today's tick count. The read-modify-write below is NOT
# atomic on its own, so under GAFFER_CONCURRENCY>1 two workers bumping at once
# could both read the same count and clobber each other — LOSING a tick from the
# denial-of-wallet ledger (the cap could then never advance). We serialise the
# whole RMW under a dedicated lock when gaffer_with_lock is available (it is, via
# factory.config.sh). At concurrency 1 there is no contention so the lock is taken
# and released with no wait — behaviour is byte-identical to before.
gaffer_bump_day_count() {
  if declare -F gaffer_with_lock >/dev/null 2>&1; then
    gaffer_with_lock "${GAFFER_DATA:-$(dirname "$DAILY_COUNTER_FILE")}/.daycount.lock" \
      _gaffer_bump_day_count_unlocked
  else
    _gaffer_bump_day_count_unlocked
  fi
}

# The raw read-modify-write, run while holding .daycount.lock (or directly when no
# lock primitive is defined, e.g. a unit test sourcing budget.sh standalone).
_gaffer_bump_day_count_unlocked() {
  local today c
  today="$(date +%Y-%m-%d)"
  c=$(( $(gaffer_day_count) + 1 ))
  printf '%s %s\n' "$today" "$c" > "$DAILY_COUNTER_FILE"
}

# Return 0 (true) if running another tick today stays within the cap. A cap of
# 0 (or less) means unlimited — the guard is disabled.
gaffer_day_cap_ok() {
  [ "${MAX_TICKS_PER_DAY:-0}" -le 0 ] && return 0
  [ "$(gaffer_day_count)" -lt "$MAX_TICKS_PER_DAY" ]
}
