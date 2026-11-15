#!/usr/bin/env bash
# =====================================================================
# THE TICK CAP AND THE DOLLAR CAP SHARE ONE DAY: UTC (audit finding 8b).
# ---------------------------------------------------------------------
# The day tick counter (MAX_TICKS_PER_DAY, lib/budget.sh _gaffer_today) keyed on the
# host's LOCAL date while the dollar cap (GAFFER_DAILY_BUDGET_USD) and the usage ledger
# key on the UTC date, so on a host outside UTC the two caps rolled over hours apart.
#   U1  under a zone far east (UTC+14) and far west (UTC-12) of UTC, at least one of which
#       is on another calendar date than UTC right now, the tick day is the UTC date
#   U2  a reserved day slot is recorded under the UTC date, and the count reads back
#   U3  the counter and the dollar cap's day agree (gaffer_day_usd_spent keys on UTC)
#   U4  an upgrade mid-day: a record the old runner wrote under the LOCAL date still counts
#       today (no second day's ticks), and a UTC-keyed record never carries into the next
#       UTC day because its day equals the local date
# Run: bash test/budget-day-utc.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/budget-day-utc.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT

echo "== U1: the tick day is the UTC date whatever the host's zone =="
differs=0
for tz in Pacific/Kiritimati Etc/GMT+12; do
  utc="$(date -u +%Y-%m-%d)"
  loc="$(TZ="$tz" date +%Y-%m-%d)"
  [ "$loc" != "$utc" ] && differs=1
  got="$(TZ="$tz" bash -c 'unset GAFFER_TODAY_OVERRIDE; source "$1/lib/budget.sh"; _gaffer_today' _ "$RUNNER_DIR")"
  [ "$got" = "$utc" ] && ok "U1 TZ=$tz (local $loc): the tick day is $got, the UTC date" \
    || fail "U1 TZ=$tz: the tick day is $got, UTC is $utc (local $loc)"
done
[ "$differs" = 1 ] && ok "U1 one of the zones is on another date than UTC right now (the check means something)" \
  || fail "U1 neither zone differs from UTC (cannot happen: they are 26 hours apart)"

echo "== U2: a reserved day slot is booked under the UTC date =="
out="$(TZ=Pacific/Kiritimati bash -c '
  unset GAFFER_TODAY_OVERRIDE
  gaffer_with_lock() { shift; "$@"; }
  _gaffer_locked() { shift; "$@"; }
  export DAILY_COUNTER_FILE="$2/.daily-ticks" MAX_TICKS_PER_DAY=5 GAFFER_DATA="$2"
  source "$1/lib/budget.sh"
  gaffer_reserve_day_tick >/dev/null
  echo "count=$(gaffer_day_count)"
  cat "$DAILY_COUNTER_FILE"' _ "$RUNNER_DIR" "$WORK")"
utc="$(date -u +%Y-%m-%d)"
case "$out" in *"count=1"*"$utc 1"*) ok "U2 the slot is recorded as '$utc 1' and reads back as 1" ;;
  *) fail "U2 got: $(printf '%s' "$out" | tr '\n' ' ')" ;; esac

echo "== U3: the tick day and the dollar cap's day are the same day =="
grep -q 'date -u +%Y-%m-%d' "$RUNNER_DIR/lib/budget.sh" && ! grep -qE '^_gaffer_today\(\).*[^-]date \+%Y-%m-%d' "$RUNNER_DIR/lib/budget.sh" \
  && ok "U3 both caps key on date -u" || fail "U3 the tick day still reads the local date"

echo "== U4: an operator upgrading mid-day does not get a second day's ticks =="
for tz in Pacific/Kiritimati Etc/GMT+12; do
  utc="$(date -u +%Y-%m-%d)"; loc="$(TZ="$tz" date +%Y-%m-%d)"
  [ "$loc" != "$utc" ] || continue
  # The old runner's record: the local date, no "utc" mark, 7 ticks spent today.
  printf '%s 7\n' "$loc" > "$WORK/legacy"
  got="$(TZ="$tz" bash -c 'unset GAFFER_TODAY_OVERRIDE; export DAILY_COUNTER_FILE="$2"; source "$1/lib/budget.sh"; gaffer_day_count' _ "$RUNNER_DIR" "$WORK/legacy")"
  [ "$got" = 7 ] && ok "U4 TZ=$tz: the pre-upgrade local-date record ($loc 7) still counts 7 today" \
    || fail "U4 TZ=$tz: the pre-upgrade record read as $got, not 7 (a second day's ticks)"
  # A record this runner wrote (UTC-keyed) on a day that happens to be the local date is
  # an earlier UTC day: it must not carry.
  printf '%s 7 utc\n' "$loc" > "$WORK/tagged"
  got="$(TZ="$tz" bash -c 'unset GAFFER_TODAY_OVERRIDE; export DAILY_COUNTER_FILE="$2"; source "$1/lib/budget.sh"; gaffer_day_count' _ "$RUNNER_DIR" "$WORK/tagged")"
  [ "$got" = 0 ] && ok "U4 TZ=$tz: a UTC-keyed record of another UTC day reads 0" \
    || fail "U4 TZ=$tz: a UTC-keyed record of another UTC day read $got"
done

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS: $PASS checks"; exit 0; fi
echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1
