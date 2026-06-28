#!/usr/bin/env bash
# =====================================================================
# A-1 — gaffer_with_lock + day-cap concurrency safety (factory.config.sh,
# lib/budget.sh).
# ---------------------------------------------------------------------
# Parallel ticket execution (GAFFER_CONCURRENCY>1) runs N worker.sh
# processes that share mutable state. The day-cap counter is a
# read-modify-write — the denial-of-wallet ledger — and MUST NOT lose or
# double-count a tick under concurrency. gaffer_bump_day_count wraps the
# RMW in gaffer_with_lock; this proves the lock actually serialises:
#
#   AC1  gaffer_with_lock runs its command and relays the exit status.
#   AC2  a contended critical section is mutually exclusive (no overlap).
#   AC3  N parallel gaffer_bump_day_count calls → final count == N
#        (no lost updates), using the REAL budget.sh under the REAL lock.
#   AC4  a stale mkdir-lock (killed holder) is reaped, not a permanent wedge.
#
# Portable (macOS has no flock): the test exercises whichever primitive
# gaffer_with_lock selects (flock on Linux/CI, atomic mkdir on macOS).
# Zero deps beyond bash + coreutils. Run: bash test/parallel-lock.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/parallel-lock.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
export GAFFER_DATA="$WORK"

# Source the lock shim from factory.config.sh WITHOUT running the whole config
# (it has side effects). We extract just the two functions we need by sourcing the
# file in a guarded subshell would be heavy; instead source the file — it is
# idempotent config + function defs and tolerates a bare environment. Set the DB
# vars it likes so nothing complains.
export DISPATCH_DB="$WORK/d.sqlite" MEMORY_DB="$WORK/m.sqlite"
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1

echo "== AC1: gaffer_with_lock relays exit status =="
gaffer_with_lock "$WORK/.t.lock" true  && ok "lock around 'true' returns 0"  || fail "expected 0 from 'true'"
gaffer_with_lock "$WORK/.t.lock" false && fail "expected non-zero from 'false'" || ok "lock around 'false' returns non-zero"
out="$(gaffer_with_lock "$WORK/.t.lock" echo hello)"
[ "$out" = "hello" ] && ok "command stdout passes through the lock" || fail "stdout not relayed (got '$out')"

echo "== AC2: the critical section is mutually exclusive =="
# Two concurrent holders each append enter/exit markers; under a correct lock the
# markers never interleave (every 'enter' is immediately followed by its 'exit').
MARK="$WORK/marks"; : > "$MARK"
crit() { echo "enter-$1" >> "$MARK"; sleep 0.2; echo "exit-$1" >> "$MARK"; }
gaffer_with_lock "$WORK/.mx.lock" crit A &
gaffer_with_lock "$WORK/.mx.lock" crit B &
wait
# Collapse to the sequence of A/B transitions; a non-interleaved log is
# enter-X exit-X enter-Y exit-Y (each enter paired with its own exit next).
# Read line-pairs without mapfile (bash 3.2 on macOS has none).
bad=0; prev=""; expect="enter"; entered=""
while IFS= read -r ln; do
  tag="${ln%-*}"; who="${ln#*-}"
  if [ "$expect" = "enter" ]; then
    [ "$tag" = "enter" ] || { bad=1; break; }
    entered="$who"; expect="exit"
  else
    { [ "$tag" = "exit" ] && [ "$who" = "$entered" ]; } || { bad=1; break; }
    expect="enter"
  fi
done < "$MARK"
[ "$bad" = "0" ] && ok "no interleaving — sections ran one-at-a-time" || { fail "critical sections interleaved"; sed 's/^/    /' "$MARK"; }

echo "== AC3: N parallel day-count bumps lose nothing (final == N) =="
export DAILY_COUNTER_FILE="$WORK/.daily-ticks"; rm -f "$DAILY_COUNTER_FILE"
export MAX_TICKS_PER_DAY=0   # disable the cap; we only care about the counter
N=12
for _ in $(seq "$N"); do gaffer_bump_day_count & done
wait
got="$(gaffer_day_count)"
[ "$got" = "$N" ] && ok "$N concurrent bumps → count $got (no lost updates)" || fail "expected $N, got $got (LOST a count — lock failed)"

echo "== AC4: a stale mkdir-lock is reaped (no permanent wedge) =="
# Only meaningful on the mkdir fallback (macOS). On flock systems skip — flock
# auto-releases on holder death so there is no stale-dir to reap.
if command -v flock >/dev/null 2>&1; then
  ok "flock present — stale-dir reaping N/A (flock self-releases on death)"
else
  STALE="$WORK/.stale.lock.d"
  mkdir -p "$STALE"
  # Backdate its mtime well past GAFFER_LOCK_STALE so it's considered abandoned.
  if touch -t "$(date -v-1H +%Y%m%d%H%M 2>/dev/null || date -d '-1 hour' +%Y%m%d%H%M)" "$STALE" 2>/dev/null; then
    export GAFFER_LOCK_STALE=5 GAFFER_LOCK_TIMEOUT=10
    if gaffer_with_lock "$WORK/.stale.lock" true; then
      ok "stale lock reaped — acquisition succeeded despite a leftover lock dir"
    else
      fail "stale lock NOT reaped — gaffer_with_lock wedged on a dead holder"
    fi
  else
    ok "could not backdate mtime on this platform — skipping stale-reap probe"
  fi
fi

echo "== AC5: a LIVE holder past GAFFER_LOCK_STALE is NOT reaped (mutual exclusion) =="
# FIX-3 regression: staleness was judged purely by the lock dir's mtime (set once,
# never refreshed), so a holder that ran longer than GAFFER_LOCK_STALE was wrongly
# reaped by a waiter → two holders in the section at once. With PID-liveness
# reaping, a live holder is never reaped however long it holds. Only meaningful on
# the mkdir fallback (flock self-releases on death, no mtime reaping at all).
if command -v flock >/dev/null 2>&1; then
  ok "flock present — live-holder reaping N/A (flock has no mtime-stale path)"
else
  export GAFFER_LOCK_STALE=1 GAFFER_LOCK_TIMEOUT=10
  LIVELOCK="$WORK/.live.lock"
  LIVEMARK="$WORK/live-marks"; : > "$LIVEMARK"
  # Holder A holds the section for 3s — WELL past GAFFER_LOCK_STALE=1.
  hold_long() { echo "enter-A" >> "$LIVEMARK"; sleep 3; echo "exit-A" >> "$LIVEMARK"; }
  gaffer_with_lock "$LIVELOCK" hold_long &
  hpid=$!
  sleep 0.5   # let A acquire and write its pid
  # Waiter B tries to enter while A still holds AND the lock is already older than
  # GAFFER_LOCK_STALE. A correct lock makes B WAIT for A; a broken (mtime-only) lock
  # reaps A's dir and lets B in concurrently.
  enter_b() { echo "enter-B" >> "$LIVEMARK"; echo "exit-B" >> "$LIVEMARK"; }
  gaffer_with_lock "$LIVELOCK" enter_b &
  wait
  # A correct, non-interleaved log is: enter-A exit-A enter-B exit-B (B strictly
  # after A). If A was reaped mid-section, B's enter appears BEFORE A's exit.
  first_three="$(head -3 "$LIVEMARK" | tr '\n' ',')"
  if [ "$first_three" = "enter-A,exit-A,enter-B," ]; then
    ok "live holder past STALE was not reaped — B waited for A (no overlap)"
  else
    fail "live holder reaped mid-section — got order: $first_three"; sed 's/^/    /' "$LIVEMARK"
  fi
fi

echo "== AC6: an ABANDONED lock (dead holder PID) IS still reaped =="
# The liveness check must not WEDGE on a lock whose recorded PID is dead. A lock
# dir carrying a never-running PID with a fresh mtime must still be acquirable
# (dead PID → fall through to acquire), proving we didn't trade one wedge for
# another.
if command -v flock >/dev/null 2>&1; then
  ok "flock present — dead-holder reaping N/A (flock self-releases)"
else
  export GAFFER_LOCK_STALE=120 GAFFER_LOCK_TIMEOUT=10
  DEAD="$WORK/.dead.lock.d"
  mkdir -p "$DEAD"
  # A PID that is certainly not running. 2^31-ish is never a live pid here.
  deadpid=2147480000
  while kill -0 "$deadpid" 2>/dev/null; do deadpid=$((deadpid - 1)); done
  echo "$deadpid" > "$DEAD/pid"
  # mtime is FRESH (just created), so only the dead-PID path can reap it.
  if gaffer_with_lock "$WORK/.dead.lock" true; then
    ok "abandoned lock with a dead holder PID was reaped despite a fresh mtime"
  else
    fail "dead-holder lock NOT reaped — liveness check wedged on a dead PID"
  fi
fi

echo "== AC7: a lock-wrapped call inside a parent while-read loop is fd-isolated =="
# Regression: the flock path used to open the lock descriptor in the PARENT shell, which
# collided with the tick's process-substitution candidate loops and silently dropped
# iterations (passed on macOS's fd-free mkdir path, failed on the Linux flock path).
# Drive that exact shape — every iteration must run.
n7=0
while IFS= read -r line7; do
  gaffer_with_lock "$(mktemp -u "${TMPDIR:-/tmp}/lk.XXXX")" echo "$line7" >/dev/null 2>&1
  n7=$((n7 + 1))
done < <(printf 'a\nb\nc\nd\ne\n')
[ "$n7" = 5 ] && ok "all 5 parent read-loop iterations ran (lock fd did not corrupt the loop)" \
  || fail "parent while-read loop corrupted by the lock descriptor (ran $n7 of 5)"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"; exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
