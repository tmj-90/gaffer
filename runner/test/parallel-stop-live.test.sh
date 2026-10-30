#!/usr/bin/env bash
# =====================================================================
# PARALLEL STOP (live) — stopping a pool mid-delivery releases the claim.
# ---------------------------------------------------------------------
# Stopping a GAFFER_CONCURRENCY>1 pool sends the in-flight tick several TERMs (the
# outer reaper on INT, the worker's TERM to the tick's group, the reaper again when
# the worker signals it). A crash trap that reset TERM to default was killed by the
# second one half-way through: the ticket stayed `claimed` until its TTL and the
# worktree plus mcp-runtime.<pid>.json (the claim token) were left behind. Real
# loop.sh / worker.sh / tick.sh, DRY_RUN=0, two workers, a stub agent that hangs:
#   L1. Ctrl-C (INT to the loop's process group) → the ticket is back to ready
#   L2. TERM to the loop pid only               → the ticket is back to ready
# (The DRY_RUN pool-stop cases: parallel-stop.test.sh.)
# Run: bash runner/test/parallel-stop-live.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
command -v perl >/dev/null 2>&1 || { echo "SKIP: perl required (timeout primitive)"; exit 0; }
for f in packages/dispatch/dist/cli/index.js packages/memory/dist/bin/memory.js packages/crew/dist/cli/index.js; do
  [ -f "$ROOT/$f" ] || { echo "SKIP: $f not built (run pnpm -r build)"; exit 0; }
done

STUB_TICK_NAME=parallel-stop-live
# shellcheck source=lib/stub-tick.sh
source "$HERE/lib/stub-tick.sh"
LP=""
cleanup() {
  [ -n "$LP" ] && kill -KILL -- "-$LP" 2>/dev/null
  pkill -KILL -f "$WORK" 2>/dev/null
  [ "${KEEP:-0}" = 1 ] || rm -rf "$WORK"
}
trap cleanup EXIT
echo hang > "$MODE"

start_pool() {  # <case> → sets LP (the loop pid == its own process group id)
  rm -rf "$CALLS"; mkdir -p "$CALLS"
  ( cd "$RUNNER_DIR" && GAFFER_CONCURRENCY=2 EMPTY_POLL_LIMIT=100000 MAX_TICKS=50 TICK_SLEEP=1 GAFFER_REAP_GRACE=30 \
      exec perl -e 'setpgrp(0, 0); exec @ARGV' bash ./loop.sh > "$WORK/loop-$1.out" 2>&1 ) &
  LP=$!
  wait_hanging
}
stopped_within() {  # <secs> → 0 once the loop has exited
  local _
  for _ in $(seq 1 $(( $1 * 5 ))); do kill -0 "$LP" 2>/dev/null || return 0; sleep 0.2; done
  return 1
}
assert_released() {  # <label> <ticket>
  stopped_within 45 && ok "$1: the loop exited" || fail "$1: the loop is still running after 45s"
  [ "$(st "$2")" = ready ] && ok "$1: #$2 is back to ready (claim released)" || fail "$1: #$2 is $(st "$2") after the stop"
  local n; n="$(grep -c "released claim on #$2 → ready" "$GAFFER_DATA/factory.log" 2>/dev/null)"
  [ "${n:-0}" -ge 1 ] && ok "$1: the crash trap logged the claim release" || fail "$1: no 'released claim on #$2' line in factory.log"
  local left; left="$(find "$GAFFER_DATA" -maxdepth 1 -name 'mcp-runtime.*.json' 2>/dev/null | wc -l | tr -d ' ')"
  [ "$left" = 0 ] && ok "$1: no mcp-runtime.<pid>.json (claim token) left behind" || fail "$1: $left mcp-runtime file(s) left in GAFFER_DATA"
  kill -KILL -- "-$LP" 2>/dev/null; pkill -KILL -f "$CALLS" 2>/dev/null; LP=""
  rm -f "$GAFFER_DATA/.failed-tickets"
}

echo "== L1. Ctrl-C (INT to the process group) mid-delivery releases the claim =="
L1="$(new_ready "Pool live int" "deliver a helper")"
start_pool int && [ "$(st "$L1")" = claimed ] && ok "L1: #$L1 claimed, agent running" || fail "L1: the delivery never started (status $(st "$L1"))"
kill -INT -- "-$LP" 2>/dev/null
assert_released L1 "$L1"
retire "$L1"

echo "== L2. TERM to the loop pid mid-delivery releases the claim =="
L2="$(new_ready "Pool live term" "deliver a helper")"
start_pool term && [ "$(st "$L2")" = claimed ] && ok "L2: #$L2 claimed, agent running" || fail "L2: the delivery never started (status $(st "$L2"))"
kill -TERM "$LP" 2>/dev/null
assert_released L2 "$L2"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
