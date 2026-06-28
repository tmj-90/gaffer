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

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"; exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
