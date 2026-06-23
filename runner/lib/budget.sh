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

# Increment and persist today's tick count.
gaffer_bump_day_count() {
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
