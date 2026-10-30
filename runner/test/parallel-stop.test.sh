#!/usr/bin/env bash
# =====================================================================
# PARALLEL STOP — a GAFFER_CONCURRENCY>1 worker pool can be stopped.
# ---------------------------------------------------------------------
# Background workers start with SIGINT ignored and used to have no TERM handling:
# Ctrl-C reaped the in-flight ticks while every worker went straight on to the next
# one, and a TERM (or SIGKILL) to loop.sh orphaned the pool, which kept claiming until
# MAX_TICKS. Real loop.sh / worker.sh / tick.sh, DRY_RUN, two workers, an empty queue:
#   P1. Ctrl-C (INT to the loop's process group) → loop + workers gone, ticks stop
#   P2. TERM to the loop pid only               → loop + workers gone, ticks stop
#   P3. KILL to the loop pid (no trap can run)  → workers notice the loop is gone
# Run: bash runner/test/parallel-stop.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v perl >/dev/null 2>&1 || { echo "SKIP: perl required (timeout primitive)"; exit 0; }
[ -f "$ROOT/packages/dispatch/dist/cli/index.js" ] || { echo "SKIP: dispatch not built (run pnpm -r build)"; exit 0; }

PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/parallel-stop.XXXXXX")"; WORK="$(cd "$WORK" && pwd -P)"
LP=""
cleanup() {
  [ -n "$LP" ] && kill -KILL -- "-$LP" 2>/dev/null
  workers | while read -r p; do kill -KILL "$p" 2>/dev/null; done
  [ "${KEEP:-0}" = 1 ] || rm -rf "$WORK"
}
trap cleanup EXIT

# Worker processes: the exact `bash <runner>/worker.sh` command line (fields, not a
# substring — the awk below would otherwise match its own argv). Counts the workers'
# own $(...) subshells too, which is fine: the assertion is that none are left.
workers() { ps -axo pid=,command= 2>/dev/null | awk -v w="$RUNNER_DIR/worker.sh" '$2 == "bash" && $3 == w {print $1}'; }
ticks_in() { [ -f "$1/factory.log" ] || { echo 0; return; }; wc -l < "$1/factory.log" | tr -d ' '; }

start_pool() {  # <case> → sets LP (the loop pid == its own process group id), D
  D="$WORK/$1"; mkdir -p "$D/data"
  ( export GAFFER_DATA="$D/data"; cd "$RUNNER_DIR" && source ./factory.config.sh >/dev/null 2>&1 && wg init >/dev/null 2>&1 )
  ( cd "$RUNNER_DIR" && GAFFER_DATA="$D/data" DRY_RUN=1 GAFFER_CONCURRENCY=2 EMPTY_POLL_LIMIT=100000 MAX_TICKS=100000 \
      TICK_SLEEP=1 GAFFER_MAINTENANCE=0 GAFFER_REAP_GRACE=2 \
      exec perl -e 'setpgrp(0, 0); exec @ARGV' bash ./loop.sh > "$D/loop.out" 2>&1 ) &
  LP=$!
  local _
  for _ in $(seq 1 100); do [ "$(workers | wc -l | tr -d ' ')" -ge 2 ] && [ "$(ticks_in "$D/data")" -ge 2 ] && return 0; sleep 0.2; done
  return 1
}
gone_within() {  # <secs> → 0 once the loop and every worker have exited
  local _
  for _ in $(seq 1 $(( $1 * 5 ))); do
    if ! kill -0 "$LP" 2>/dev/null && [ -z "$(workers)" ]; then return 0; fi
    sleep 0.2
  done
  return 1
}
assert_stopped() {  # <case-label> <secs>
  if gone_within "$2"; then ok "$1: loop and both workers exited within $2s"; else fail "$1: still running after $2s (loop alive=$(kill -0 "$LP" 2>/dev/null && echo yes || echo no), workers=$(workers | wc -l | tr -d ' '))"; fi
  local n1 n2; n1="$(ticks_in "$D/data")"; sleep 3; n2="$(ticks_in "$D/data")"
  [ "$n1" = "$n2" ] && ok "$1: no new ticks after the stop ($n1 log lines, unchanged for 3s)" || fail "$1: ticks kept coming ($n1 → $n2 log lines in 3s)"
  workers | while read -r p; do kill -KILL "$p" 2>/dev/null; done
  LP=""
}

echo "== P1. Ctrl-C (INT to the process group) stops the pool =="
start_pool int && ok "P1: pool running (2 workers ticking)" || fail "P1: the pool never started"
kill -INT -- "-$LP" 2>/dev/null
assert_stopped P1 15

echo "== P2. TERM to the loop pid stops the pool =="
start_pool term && ok "P2: pool running" || fail "P2: the pool never started"
kill -TERM "$LP" 2>/dev/null
assert_stopped P2 15
grep -q "stop signal — stopping the worker pool" "$WORK/term/loop.out" && ok "P2: loop.sh logged the pool stop" || fail "P2: no pool-stop line in loop.out"

echo "== P3. SIGKILL to the loop pid: the workers notice it is gone =="
start_pool kill && ok "P3: pool running" || fail "P3: the pool never started"
{ kill -KILL "$LP"; wait "$LP"; } 2>/dev/null
assert_stopped P3 20

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
