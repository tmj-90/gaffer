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
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
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
WORK="$(mktemp -d "${TMPDIR:-/tmp}/parallel-stop.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
LP=""
cleanup() {
  [ -n "$LP" ] && kill -KILL -- "-$LP" 2>/dev/null
  workers | while read -r p; do kill -KILL "$p" 2>/dev/null; done
  [ "${KEEP:-0}" = 1 ] || gaffer_test_rm_work "$WORK"
}
trap cleanup EXIT

# THIS pool's worker processes: the exact `bash <runner>/worker.sh` command line
# (fields, not a substring, so the awk never matches its own argv) AND the loop's
# process group. The group is what scopes it: the CI harness runs other tests that
# start their own loop.sh / worker.sh from the same runner dir in parallel, and
# matching the command line alone counted (and the cleanup KILLed) their workers too.
# Counts the workers' own $(...) subshells as well, which is fine: the assertion is
# that none are left.
workers() {
  [ -n "$LP" ] || return 0
  ps -axo pid=,pgid=,command= 2>/dev/null \
    | awk -v w="$RUNNER_DIR/worker.sh" -v g="$LP" '$2 == g && $3 == "bash" && $4 == w {print $1}'
}
ticks_in() { [ -f "$1/factory.log" ] || { echo 0; return; }; wc -l < "$1/factory.log" | tr -d ' '; }

# The loop starts the way a terminal starts it: in its own process group with SIGINT at
# its default. A background job of this non-interactive script starts with SIGINT
# ignored, and a signal ignored on entry cannot be trapped (POSIX; bash 3.2 on macOS
# enforces it), so without the reset P1 tested a launch no user ever makes.
# LP is the pid the launcher records just before it execs loop.sh, which is also the
# pool's process group id (setpgrp): every signal and the workers() scope use it, and
# it does not depend on how the shell forks the `( ... ) &` around the launcher.
start_pool() {  # <case> → sets LP (the loop pid == its own process group id), D
  D="$WORK/$1"; mkdir -p "$D/data"
  ( export GAFFER_DATA="$D/data"; cd "$RUNNER_DIR" && source ./factory.config.sh >/dev/null 2>&1 && wg init >/dev/null 2>&1 )
  ( cd "$RUNNER_DIR" && GAFFER_DATA="$D/data" DRY_RUN=1 GAFFER_CONCURRENCY=2 EMPTY_POLL_LIMIT=100000 MAX_TICKS=100000 \
      TICK_SLEEP=1 GAFFER_MAINTENANCE=0 GAFFER_REAP_GRACE=2 \
      exec perl -e '$SIG{INT} = "DEFAULT"; setpgrp(0, 0);
        open(my $f, ">", shift) or die "pid file: $!"; print $f "$$\n"; close $f;
        exec @ARGV' "$D/loop.pid" bash ./loop.sh > "$D/loop.out" 2>&1 ) &
  LP=""
  local _
  # Bounded waits sized for a loaded CI runner (macOS shards start a pool slowly): the
  # stop assertions below are what the test is about, not how fast the pool comes up.
  for _ in $(seq 1 300); do [ -s "$D/loop.pid" ] && { LP="$(cat "$D/loop.pid")"; break; }; sleep 0.1; done
  [ -n "$LP" ] || return 1
  for _ in $(seq 1 300); do [ "$(workers | wc -l | tr -d ' ')" -ge 2 ] && [ "$(ticks_in "$D/data")" -ge 2 ] && return 0; sleep 0.2; done
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
# On a failure, show what survived: each process with its parent, group, state and
# command line, plus the loop's and every worker's log tail. A platform-only failure
# (macOS bash 3.2) is then diagnosable from the CI log alone.
dump_survivors() {  # <case-label>
  echo "  -- $1 survivors in the pool's process group $LP (pid ppid pgid stat etime command) --"
  ps -axo pid=,ppid=,pgid=,stat=,etime=,command= 2>/dev/null \
    | awk -v g="$LP" '$3 == g && (($6 ~ /(^|\/)bash$/ && $7 ~ /(worker|tick|loop)\.sh$/) || ($6 ~ /(^|\/)perl$/ && index($0, "alarm")))' \
    | sed 's/^/     /'
  echo "  -- loop.out (tail) --"; tail -n 15 "$D/loop.out" 2>/dev/null | sed 's/^/     /'
  local f; for f in "$D/data/.workers"/*; do [ -f "$f" ] || continue
    echo "  -- $(basename "$f") --"; tail -n 5 "$f" 2>/dev/null | sed 's/^/     /'; done
}
assert_stopped() {  # <case-label> <secs>
  if gone_within "$2"; then ok "$1: loop and both workers exited within $2s"; else fail "$1: still running after $2s (loop alive=$(kill -0 "$LP" 2>/dev/null && echo yes || echo no), workers=$(workers | wc -l | tr -d ' '))"; dump_survivors "$1"; fi
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
