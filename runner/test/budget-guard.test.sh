#!/usr/bin/env bash
# =====================================================================
# Per-day cost-guard validation (lib/budget.sh).
# ---------------------------------------------------------------------
# Proves, with a REAL temp DAILY_COUNTER_FILE, that the configurable
# per-day cap halts the loop when exceeded:
#   1. Fresh state: count is 0 and the cap is OK.
#   2. Bumping persists today's count and survives a re-source (i.e.
#      across loop.sh runs, the launchd path the guard exists for).
#   3. Once the count reaches MAX_TICKS_PER_DAY the cap is NOT OK — this
#      is the hard stop loop.sh acts on.
#   4. A counter file from an earlier day resets to 0 (new-day rollover).
#   5. MAX_TICKS_PER_DAY=0 disables the guard (always OK).
# Zero deps. Run: bash test/budget-guard.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/budget-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
export DAILY_COUNTER_FILE="$WORK/.daily-ticks"

# shellcheck source=../lib/budget.sh
source "$RUNNER_DIR/lib/budget.sh"

echo "== fresh state =="
export MAX_TICKS_PER_DAY=3
[ "$(gaffer_day_count)" = "0" ] && ok "fresh count is 0" || fail "fresh count should be 0 (got $(gaffer_day_count))"
gaffer_day_cap_ok && ok "cap OK while under limit" || fail "cap should be OK while under limit"

echo "== bump + persistence =="
gaffer_bump_day_count
gaffer_bump_day_count
[ "$(gaffer_day_count)" = "2" ] && ok "two bumps → count 2" || fail "count should be 2 (got $(gaffer_day_count))"
grep -q "$(date +%Y-%m-%d) 2" "$DAILY_COUNTER_FILE" && ok "today's count persisted to file" || fail "file should hold today's date + count"
# Re-source to simulate a fresh loop.sh run reading the same persisted file.
source "$RUNNER_DIR/lib/budget.sh"
[ "$(gaffer_day_count)" = "2" ] && ok "count survives re-source (across runs)" || fail "count should survive re-source"

echo "== hard stop at the cap =="
gaffer_bump_day_count          # count → 3 == MAX_TICKS_PER_DAY
[ "$(gaffer_day_count)" = "3" ] && ok "third bump → count 3 (== cap)" || fail "count should be 3 (got $(gaffer_day_count))"
if gaffer_day_cap_ok; then fail "cap should NOT be OK once count reaches the limit"; else ok "cap NOT OK at the limit — loop halts"; fi

echo "== new-day rollover =="
printf '2000-01-01 999\n' > "$DAILY_COUNTER_FILE"
[ "$(gaffer_day_count)" = "0" ] && ok "stale-day record resets count to 0" || fail "stale day should reset to 0 (got $(gaffer_day_count))"
gaffer_day_cap_ok && ok "cap OK again after rollover" || fail "cap should be OK after rollover"

echo "== guard disabled =="
export MAX_TICKS_PER_DAY=0
printf '%s 999\n' "$(date +%Y-%m-%d)" > "$DAILY_COUNTER_FILE"
gaffer_day_cap_ok && ok "MAX_TICKS_PER_DAY=0 disables the guard" || fail "cap of 0 should be unlimited"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
