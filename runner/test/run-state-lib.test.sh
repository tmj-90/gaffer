#!/usr/bin/env bash
# =====================================================================
# lib/run-state.sh on its own: the per-run state dir, the sweep, the poll lock.
# ---------------------------------------------------------------------
# poll-overlap-run-state.test.sh drives the real Polls; this file pins the edges of
# the helpers themselves, fast and without a factory:
#   S1  begin / end with a GAFFER_DATA holding spaces: a fresh, empty, private dir
#       named <kind>-<pid>-<epoch>, exported; end removes it and never another run's.
#   S2  the sweep removes ONLY a directory named exactly <kind>-<pid>-<epoch> whose
#       pid is gone: a live pid's dir, a name of any other shape, a plain file and a
#       symlink are left alone (the root holds nothing else of ours, and a sweep that
#       guesses at names could delete what an operator put there).
#   S3  the poll lock: a fresh lock whose holder is alive makes a Poll wait, then
#       refuse, and is left alone; a dead holder's lock is taken over at once; a lock
#       with no pid is taken over after a few seconds; only the holder releases it.
#   S4  PID REUSE: a lock whose pid is alive but whose pid file is older than any Poll
#       can run (the outer tick bound + the reap grace + 60 s) belongs to a Poll that
#       is gone (its pid now names another process, as after a container restart): it
#       is taken over, not waited on and refused on every Poll for as long as that
#       unrelated process lives.
# Run: bash runner/test/run-state-lib.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
command -v perl >/dev/null 2>&1 || { echo "SKIP: perl required (to age a file)"; exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(gaffer_test_tmpdir run-state-lib)" || exit 70
trap 'kill ${LIVE:-} 2>/dev/null; gaffer_test_rm_work "$WORK"' EXIT
export GAFFER_DATA="$WORK/fac tory data"
mkdir -p "$GAFFER_DATA"
unset GAFFER_RUN_STATE_DIR GAFFER_POLL_WAIT_TIMEOUT
export GAFFER_TICK_OUTER_TIMEOUT=5 GAFFER_REAP_GRACE=1
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh"
ROOT="$GAFFER_DATA/run-state"
DEAD=999999; while kill -0 "$DEAD" 2>/dev/null; do DEAD=$((DEAD - 1)); done
sleep 300 & LIVE=$!
age() { perl -e 'my $t = time - $ARGV[0]; utime($t, $t, $ARGV[1]) or exit 1' "$1" "$2"; }

echo "== S1. begin / end (GAFFER_DATA with spaces) =="
( gaffer_run_state_begin poll || exit 9
  printf '%s\n' "$GAFFER_RUN_STATE_DIR" > "$WORK/s1.dir"
  env | grep -c '^GAFFER_RUN_STATE_DIR=' > "$WORK/s1.exported"
  ls -A "$GAFFER_RUN_STATE_DIR" > "$WORK/s1.ls"
  touch "$GAFFER_RUN_STATE_DIR/.failed-tickets"
  gaffer_run_state_end )
rc=$?
D1="$(cat "$WORK/s1.dir" 2>/dev/null)"
[ "$rc" = 0 ] && ok "S1: begin succeeded" || fail "S1: begin rc=$rc"
case "${D1##*/}" in poll-"$$"-[0-9]*) [ "${D1%/*}" = "$ROOT" ] && ok "S1: the dir is $ROOT/poll-<pid>-<epoch>" || fail "S1: dir '$D1'" ;; *) fail "S1: dir '$D1'" ;; esac
[ "$(cat "$WORK/s1.exported")" = 1 ] && ok "S1: GAFFER_RUN_STATE_DIR is exported" || fail "S1: not exported"
[ -e "$WORK/s1.ls" ] && [ ! -s "$WORK/s1.ls" ] && ok "S1: the dir starts empty" || fail "S1: dir held $(cat "$WORK/s1.ls" 2>/dev/null)"
[ ! -e "$D1" ] && ok "S1: end removed the run's dir (spaces in the path)" || fail "S1: '$D1' left"
mkdir -p "$ROOT/poll-$LIVE-1"
( GAFFER_RUN_STATE_DIR="$ROOT/poll-$LIVE-1"; gaffer_run_state_end )
[ -d "$ROOT/poll-$LIVE-1" ] && ok "S1: end never removes another run's dir" || fail "S1: end removed poll-$LIVE-1"

echo "== S2. the sweep removes only a dead run's <kind>-<pid>-<epoch> dir =="
mkdir -p "$ROOT/loop-$DEAD-17" "$ROOT/notes" "$ROOT/loop-$DEAD" "$ROOT/loop-$DEAD-1x" "$ROOT/loop-$DEAD-1-2" \
         "$ROOT/LOOP-$DEAD-1" "$ROOT/-$DEAD-1" "$WORK/elsewhere"
touch "$ROOT/notes/keep" "$WORK/elsewhere/keep"
printf 'x\n' > "$ROOT/poll-$DEAD-3"
ln -s "$WORK/elsewhere" "$ROOT/poll-$DEAD-4"
( gaffer_run_state_sweep )
[ ! -e "$ROOT/loop-$DEAD-17" ] && ok "S2: a dead run's dir is swept" || fail "S2: loop-$DEAD-17 kept"
[ -d "$ROOT/poll-$LIVE-1" ] && ok "S2: a live pid's dir is kept" || fail "S2: poll-$LIVE-1 swept"
for n in notes "loop-$DEAD" "loop-$DEAD-1x" "loop-$DEAD-1-2" "LOOP-$DEAD-1" "-$DEAD-1"; do
  [ -d "$ROOT/$n" ] && ok "S2: '$n' (not <kind>-<pid>-<epoch>) is kept" || fail "S2: '$n' was swept"
done
[ -f "$ROOT/poll-$DEAD-3" ] && ok "S2: a plain file is kept" || fail "S2: file poll-$DEAD-3 removed"
[ -L "$ROOT/poll-$DEAD-4" ] && [ -f "$WORK/elsewhere/keep" ] && ok "S2: a symlink (and what it points at) is kept" || fail "S2: symlink poll-$DEAD-4 removed"

echo "== S3. the poll lock =="
LOCK="$GAFFER_DATA/.poll.lock.d"
mkdir -p "$LOCK"; printf '%s\n' "$LIVE" > "$LOCK/pid"
out="$( GAFFER_POLL_WAIT_TIMEOUT=1 gaffer_poll_lock_acquire; echo "rc=$? holder=$_GAFFER_POLL_LOCK_HOLDER" )"
case "$out" in *"rc=1 holder=$LIVE"*) ok "S3: a live holder's fresh lock is waited on, then refused" ;; *) fail "S3: $(printf '%s' "$out" | tr '\n' '|')" ;; esac
[ "$(cat "$LOCK/pid" 2>/dev/null)" = "$LIVE" ] && ok "S3: the live holder's lock is left alone" || fail "S3: lock now '$(cat "$LOCK/pid" 2>/dev/null)'"
( _GAFFER_POLL_LOCK_HELD=1; gaffer_poll_lock_release )
[ "$(cat "$LOCK/pid" 2>/dev/null)" = "$LIVE" ] && ok "S3: only the holder releases the lock" || fail "S3: a non-holder released it"
printf '%s\n' "$DEAD" > "$LOCK/pid"
( GAFFER_POLL_WAIT_TIMEOUT=0 gaffer_poll_lock_acquire && [ "$(cat "$LOCK/pid")" = "$$" ] && gaffer_poll_lock_release && [ ! -e "$LOCK" ] )
[ "$?" = 0 ] && ok "S3: a dead holder's lock is taken over at once, and released" || fail "S3: dead holder's lock not taken over"
mkdir -p "$LOCK"
( GAFFER_POLL_WAIT_TIMEOUT=30 gaffer_poll_lock_acquire >/dev/null && [ "$(cat "$LOCK/pid")" = "$$" ] && gaffer_poll_lock_release )
[ "$?" = 0 ] && ok "S3: a lock with no pid is taken over after a few seconds" || fail "S3: a pid-less lock stuck"

echo "== S4. pid reuse: an aged lock whose pid now names another process =="
# The age reader itself, on this platform (GNU `stat -f` is filesystem status, not
# BSD's file stat: the old BSD-first form printed a filesystem report here).
touch "$WORK/aged"; age 600 "$WORK/aged"; _a="$(_gaffer_lock_age "$WORK/aged" 2>&1)"
case "$_a" in ''|*[!0-9]*) fail "S4: _gaffer_lock_age gave '$(printf '%s' "$_a" | head -1)'" ;;
  *) [ "$_a" -ge 595 ] && [ "$_a" -le 700 ] && ok "S4: _gaffer_lock_age reads a file's age ($_a s)" || fail "S4: _gaffer_lock_age gave $_a for a 600 s old file" ;; esac
mkdir -p "$LOCK"; printf '%s\n' "$LIVE" > "$LOCK/pid"; age 600 "$LOCK/pid"
out="$( GAFFER_POLL_WAIT_TIMEOUT=2 gaffer_poll_lock_acquire; echo "rc=$? pid=$(cat "$LOCK/pid" 2>/dev/null)" )"
case "$out" in *"rc=0 pid=$$"*) ok "S4: the aged lock is taken over (not waited on and refused)" ;; *) fail "S4: $(printf '%s' "$out" | tr '\n' '|')" ;; esac
case "$out" in *"older than any Poll runs"*) ok "S4: the takeover is said" ;; *) fail "S4: no takeover line: $(printf '%s' "$out" | tr '\n' '|')" ;; esac
rm -rf "$LOCK"
mkdir -p "$LOCK"; printf '%s\n' "$LIVE" > "$LOCK/pid"; age 30 "$LOCK/pid"
out="$( GAFFER_POLL_WAIT_TIMEOUT=1 gaffer_poll_lock_acquire; echo "rc=$?" )"
case "$out" in *"rc=1"*) ok "S4: a lock younger than that bound is still waited on and refused" ;; *) fail "S4: young lock: $(printf '%s' "$out" | tr '\n' '|')" ;; esac
( _GAFFER_POLL_LOCK_HELD=1; printf '%s\n' "$$" > "$LOCK/pid"; age 600 "$LOCK/pid"; gaffer_poll_lock_refresh
  _a="$(_gaffer_lock_age "$LOCK/pid")"; [ "${_a:-999}" -lt 60 ] )
[ "$?" = 0 ] && ok "S4: the holder refreshes its pid file before its tick (the bound counts from there)" || fail "S4: refresh did not touch the pid file"
rm -rf "$LOCK"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
