#!/usr/bin/env bash
# =====================================================================
# Per-UTC-day USD cap validation (Part B — lib/budget.sh).
# ---------------------------------------------------------------------
# Proves, with a REAL temp usage ledger, that the configurable per-day
# USD ceiling halts a tick/loop when the UTC-day spend is at/over it:
#   1. gaffer_day_usd_spent sums only TODAY's (UTC) records, counting
#      measured total_cost_usd AND killed/timeout estimated_cost_usd,
#      and ignoring a prior-day record.
#   2. GAFFER_DAILY_BUDGET_USD unset/0 → the gate is always OK (OFF) —
#      backward-compat, matching the MAX_TICKS_PER_DAY=0 case.
#   3. Boundary: cap 1.00; spent 0.99 → OK (proceed); 1.00 → NOT OK
#      (halt); 1.01 → NOT OK.
#   4. New-day rollover: a prior-day record over the cap → today OK.
#   5. A garbage / awk-metacharacter cap value coerces to 0 (OFF),
#      never executes.
#   6. Wiring: loop.sh, lib/daemon.sh and tick.sh all consult the gate
#      and halt cleanly (break / idle / no_work exit 0).
# Needs node + awk. Run: bash test/day-usd-cap.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v awk  >/dev/null 2>&1 || { echo "SKIP: awk required";  exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/day-usd-cap.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
LEDGER="$WORK/usage-ledger.jsonl"
export GAFFER_USAGE_LEDGER="$LEDGER"
export GAFFER_ESTIMATE_LIB="$RUNNER_DIR/lib/estimate.mjs"

# shellcheck source=../lib/budget.sh
source "$RUNNER_DIR/lib/budget.sh"

TODAY="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "== 1: gaffer_day_usd_spent sums TODAY's measured + estimated, ignores prior day =="
{
  # Measured 0.40 + killed ESTIMATE 0.20 today = 0.60. A prior-day (2000) measured
  # $99 row and an honest today "unknown" row both contribute 0 to the window.
  printf '{"ts":"%s","kind":"delivery","measured":true,"total_cost_usd":0.40}\n' "$TODAY"
  printf '{"ts":"%s","kind":"delivery","measured":false,"estimated":true,"estimated_cost_usd":0.20,"estimate_basis":"flat-floor","total_cost_usd":"unknown"}\n' "$TODAY"
  printf '{"ts":"%s","kind":"delivery","measured":false,"total_cost_usd":"unknown"}\n' "$TODAY"
  printf '{"ts":"2000-01-01T00:00:00Z","kind":"delivery","measured":true,"total_cost_usd":99}\n'
} > "$LEDGER"
SPENT="$(gaffer_day_usd_spent)"
awk "BEGIN{exit !((${SPENT:-0}+0) > 0.5999 && (${SPENT:-0}+0) < 0.6001)}" \
  && ok "today's spend = measured 0.40 + estimated 0.20 = 0.60 (prior-day + unknown ignored)" \
  || fail "day spend should be 0.60 (got '$SPENT')"

echo "== 2: cap unset / 0 → gate always OK (OFF, backward-compat) =="
unset GAFFER_DAILY_BUDGET_USD
gaffer_day_usd_cap_ok && ok "unset cap → OK (OFF)" || fail "unset cap should be OFF"
export GAFFER_DAILY_BUDGET_USD=0
gaffer_day_usd_cap_ok && ok "cap 0 → OK (OFF)" || fail "cap 0 should be OFF"
export GAFFER_DAILY_BUDGET_USD=""
gaffer_day_usd_cap_ok && ok "empty cap → OK (OFF)" || fail "empty cap should be OFF"

echo "== 3: boundary — just-under vs just-over (cap 1.00, today spend 0.60) =="
export GAFFER_DAILY_BUDGET_USD=1.00
gaffer_day_usd_cap_ok && ok "spent 0.60 < cap 1.00 → OK (tick proceeds)" || fail "0.60 under 1.00 should be OK"
# Push today's spend to exactly the cap (add estimated 0.40 → 1.00).
printf '{"ts":"%s","kind":"delivery","measured":false,"estimated":true,"estimated_cost_usd":0.40,"estimate_basis":"flat-floor","total_cost_usd":"unknown"}\n' "$TODAY" >> "$LEDGER"
SPENT="$(gaffer_day_usd_spent)"
awk "BEGIN{exit !((${SPENT:-0}+0) > 0.9999 && (${SPENT:-0}+0) < 1.0001)}" \
  && ok "spend now exactly at the cap (1.00)" || fail "spend should be 1.00 (got '$SPENT')"
if gaffer_day_usd_cap_ok; then fail "spent == cap should NOT be OK (halt)"; else ok "spent 1.00 == cap 1.00 → NOT OK (halt, mirrors MAX_TICKS at-cap)"; fi
# Just-over: add another 0.01.
printf '{"ts":"%s","kind":"delivery","measured":true,"total_cost_usd":0.01}\n' "$TODAY" >> "$LEDGER"
if gaffer_day_usd_cap_ok; then fail "spent 1.01 over cap should NOT be OK"; else ok "spent 1.01 > cap 1.00 → NOT OK (halt)"; fi

echo "== 4: new-day rollover — a prior-day record over the cap → today OK again =="
printf '{"ts":"2000-01-01T00:00:00Z","kind":"delivery","measured":true,"total_cost_usd":500}\n' > "$LEDGER"
SPENT="$(gaffer_day_usd_spent)"
awk "BEGIN{exit !((${SPENT:-1}+0) == 0)}" && ok "prior-day spend does not count today (window = 0)" || fail "prior-day should be 0 today (got '$SPENT')"
gaffer_day_usd_cap_ok && ok "cap OK again after the day rolled over" || fail "cap should be OK after rollover"

echo "== 5: a garbage / awk-metacharacter cap coerces to 0 (OFF), never executes =="
rm -f "$WORK/pwned"
export GAFFER_DAILY_BUDGET_USD='1}; system("touch '"$WORK"'/pwned"); {print 0'
gaffer_day_usd_cap_ok && ok "garbage cap → OFF (treated as inert data)" || fail "garbage cap should read as OFF"
[ ! -f "$WORK/pwned" ] || fail "SECURITY: the awk-metacharacter cap value was EXECUTED"
[ ! -f "$WORK/pwned" ] && ok "the injected system() never ran (value passed via -v, not the program body)"

echo "== 6: loop.sh / daemon.sh / tick.sh wire the gate and halt cleanly =="
grep -q 'gaffer_day_usd_cap_ok' "$RUNNER_DIR/loop.sh" \
  && grep -q 'per-day USD cap' "$RUNNER_DIR/loop.sh" \
  && ok "loop.sh consults gaffer_day_usd_cap_ok and breaks with a logged reason" \
  || fail "loop.sh should consult the day-USD gate"
grep -q 'gaffer_day_usd_cap_ok' "$RUNNER_DIR/lib/daemon.sh" \
  && ok "daemon.sh idles until the next day on the USD cap" \
  || fail "daemon.sh should consult the day-USD gate"
# tick.sh: the defense-in-depth gate must exit 0 with no_work BEFORE any paid call.
awk '/gaffer_day_usd_cap_ok/{f=1} f&&/result no_work; exit 0/{print "hit"; exit}' "$RUNNER_DIR/tick.sh" | grep -q hit \
  && ok "tick.sh gate exits 0 with no_work before starting paid work" \
  || fail "tick.sh should gate on gaffer_day_usd_cap_ok → result no_work; exit 0"
grep -q 'DRY_RUN' <(awk '/Part B \(defense-in-depth\)/,/^fi$/' "$RUNNER_DIR/tick.sh") \
  && ok "tick.sh gate is skipped under DRY_RUN (never blocks a non-spending tick)" \
  || fail "tick.sh gate should be DRY_RUN-guarded"
# B28(d): the parallel worker pool ignored the USD cap entirely (only the tick-count
# cap was checked), so at GAFFER_CONCURRENCY>1 GAFFER_DAILY_BUDGET_USD did nothing.
grep -q 'gaffer_day_usd_cap_ok' "$RUNNER_DIR/worker.sh" \
  && grep -q 'per-day USD cap' "$RUNNER_DIR/worker.sh" \
  && ok "worker.sh (GAFFER_CONCURRENCY>1) consults the day-USD gate and stops with a logged reason" \
  || fail "worker.sh should consult gaffer_day_usd_cap_ok"
# B28(c): the dashboard's Poll button (bin/poll-once.sh) is gated too.
grep -q 'gaffer_day_usd_cap_ok' "$RUNNER_DIR/bin/poll-once.sh" \
  && ok "bin/poll-once.sh (dashboard Poll) consults the day-USD gate" \
  || fail "poll-once.sh should consult gaffer_day_usd_cap_ok"
# B28(d): the cap is exposed in the dashboard Settings allow-list.
grep -q '"GAFFER_DAILY_BUDGET_USD"' "$RUNNER_DIR/../packages/dispatch/src/api/settings.ts" \
  && ok "GAFFER_DAILY_BUDGET_USD is a dashboard Setting (SETTING_DEFS)" \
  || fail "GAFFER_DAILY_BUDGET_USD should be in SETTING_DEFS"

echo "== fail closed: a configured cap with an UNMEASURABLE spend halts (was: read as \$0) =="
export GAFFER_DAILY_BUDGET_USD=1.00
# The reader needs node; with no node on PATH the spend is unknowable (the strict reader
# no longer depends on estimate.mjs — a corrupt ledger is its own failure mode, below).
# A PATH with awk but NO node, in a SUBSHELL with the command hash cleared: a temporary
# `PATH=… func` assignment plus bash's hashed-command table behaved differently on macOS
# bash 3.2 (the hashed awk/node survived the PATH change), which made this check
# non-deterministic across CI runners. The subshell + `hash -r` is unambiguous.
NONODE="$WORK/bin-nonode"; mkdir -p "$NONODE"; ln -sf "$(command -v awk)" "$NONODE/awk"
_probe_spent="$( PATH="$NONODE"; hash -r; gaffer_day_usd_spent )"
[ "$_probe_spent" = "unknown" ] && ok "no node on PATH ⇒ spend reads 'unknown', not 0" || fail "missing node should yield 'unknown' (got '$_probe_spent')"
if ( PATH="$NONODE"; hash -r; gaffer_day_usd_cap_ok 2>/dev/null ); then fail "cap set + unknown spend should HALT (fail closed)"; else ok "cap set + unknown spend ⇒ NOT OK (halt, fail closed)"; fi
if ( PATH=/nonexistent; hash -r; gaffer_day_usd_cap_ok 2>/dev/null ); then fail "cap set + no awk should HALT (fail closed)"; else ok "cap set + no awk to compare ⇒ NOT OK (halt, fail closed)"; fi
unset GAFFER_DAILY_BUDGET_USD
( PATH="$NONODE"; hash -r; gaffer_day_usd_cap_ok 2>/dev/null ) && ok "no cap + unknown spend ⇒ OK (the guard is OFF, nothing to enforce)" || fail "unknown spend must not block when no cap is set"
export GAFFER_DAILY_BUDGET_USD=1.00
_ledger_save="$GAFFER_USAGE_LEDGER"; export GAFFER_USAGE_LEDGER="$WORK/never-written.jsonl"
[ "$(gaffer_day_usd_spent)" = "0" ] && ok "NO ledger yet ⇒ 0 (a fresh factory is never blocked)" || fail "missing ledger should read 0 (got '$(gaffer_day_usd_spent)')"
gaffer_day_usd_cap_ok && ok "cap set + no ledger ⇒ OK" || fail "no ledger must not halt"
export GAFFER_USAGE_LEDGER="$_ledger_save"; unset GAFFER_DAILY_BUDGET_USD

echo "== fail closed: a MALFORMED ledger is an unknown spend (was: corrupt lines skipped ⇒ \$0) =="
export GAFFER_DAILY_BUDGET_USD=1.00
BAD="$WORK/bad-ledger.jsonl"
printf '{"ts":"%s","kind":"delivery","total_cost_usd":100}\nthis is not json\n' "$TODAY" > "$BAD"
[ "$(GAFFER_USAGE_LEDGER="$BAD" gaffer_day_usd_spent)" = "unknown" ] && ok "a non-JSON line ⇒ 'unknown' (never a partial sum)" || fail "malformed ledger should read unknown (got '$(GAFFER_USAGE_LEDGER="$BAD" gaffer_day_usd_spent)')"
if GAFFER_USAGE_LEDGER="$BAD" gaffer_day_usd_cap_ok 2>/dev/null; then fail "malformed ledger + cap should HALT"; else ok "malformed ledger + cap ⇒ NOT OK (halt)"; fi
printf '[1,2,3]\n' > "$BAD"
[ "$(GAFFER_USAGE_LEDGER="$BAD" gaffer_day_usd_spent)" = "unknown" ] && ok "a non-object record ⇒ 'unknown'" || fail "non-object record should read unknown"

echo "== fail closed: an EXISTING but UNREADABLE ledger is an unknown spend (was: read error swallowed ⇒ \$0) =="
UNR="$WORK/unreadable-ledger.jsonl"
printf '{"ts":"%s","kind":"delivery","total_cost_usd":100}\n' "$TODAY" > "$UNR"
chmod 000 "$UNR"
if [ "$(id -u)" != "0" ]; then
  [ "$(GAFFER_USAGE_LEDGER="$UNR" gaffer_day_usd_spent)" = "unknown" ] && ok "mode-000 ledger ⇒ 'unknown'" || fail "unreadable ledger should read unknown (got '$(GAFFER_USAGE_LEDGER="$UNR" gaffer_day_usd_spent)')"
  if GAFFER_USAGE_LEDGER="$UNR" gaffer_day_usd_cap_ok 2>/dev/null; then fail "unreadable ledger + cap should HALT"; else ok "unreadable ledger + cap ⇒ NOT OK (halt)"; fi
elif command -v setpriv >/dev/null 2>&1; then
  # root reads anything: probe as an unprivileged uid (the reviewer's harness did the same).
  chmod 711 "$WORK"
  _probe="$(setpriv --reuid=65534 --regid=65534 --clear-groups env GAFFER_USAGE_LEDGER="$UNR" GAFFER_DAILY_BUDGET_USD=1.00 DAILY_COUNTER_FILE="$WORK/.dc" \
    bash -c 'source "'"$RUNNER_DIR"'/lib/budget.sh"; s="$(gaffer_day_usd_spent)"; if gaffer_day_usd_cap_ok 2>/dev/null; then d=ALLOW; else d=HALT; fi; printf "%s %s" "$s" "$d"' 2>/dev/null)"
  [ "$_probe" = "unknown HALT" ] && ok "unprivileged reader: mode-000 ledger ⇒ 'unknown' ⇒ HALT" || fail "unprivileged probe should be 'unknown HALT' (got '$_probe')"
else
  ok "SKIP unreadable-ledger probe (running as root without setpriv)"
fi
chmod 644 "$UNR" 2>/dev/null || true
unset GAFFER_DAILY_BUDGET_USD

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
