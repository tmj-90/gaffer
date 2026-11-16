#!/usr/bin/env bash
# =====================================================================
# LOCK TAKEOVER RACES (audit finding 3): a dead holder's mkdir lock is taken over by
# exactly one contender, and a live holder that has not written its pid yet is never
# robbed.
# ---------------------------------------------------------------------
# The review claim (lib/review.sh) and the DoD rerun lock (lib/dod.sh) took over a dead
# holder's lock with a bare `rm -rf` then `mkdir`: two lanes that both read the dead pid
# both removed and both took it (the auditor's stress loop: both lanes held the review
# claim in 137 of 300 rounds), and a claim whose pid was not written yet read as dead.
# Both now reap through config/10-locks.sh _gaffer_lock_reap, as gaffer_with_lock does.
#
#   R1  review claim, a dead-pid claim, two contenders at once, 200 rounds: at most one
#       claimant every round (and the claim is taken)
#   R2  review claim with no pid yet (a lane between its mkdir and its pid write): not
#       taken; a pid-less claim older than GAFFER_LOCK_STALE is
#   R3  review claim held by a live lane: rc 1 with its pid
#   D1  DoD rerun lock, a dead-pid lock, three reruns at once, 10 rounds: the reruns never
#       overlap
#   D2  DoD rerun lock with no pid yet: left alone (the rerun gives up in time, rc 75)
#   K1  the take itself is atomic where mkdir(1) is not (a racy stand-in for uutils mkdir)
#   K2  every lock directory in runner/ is taken through that one take
#   P1  no bare `rm -rf` takeover of a lock is left in runner/ (lib and bin shell)
#
# Run: bash test/lock-takeover-race.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
export RUNNER_DIR

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/lock-takeover.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT

dead_pid() { bash -c 'echo $$'; }

# One contender: its own process (its own $$), the real lock helpers and review.sh,
# waiting on a barrier file so both start together.
cat > "$WORK/claim.sh" <<'EOF'
#!/usr/bin/env bash
# shellcheck source=/dev/null
source "$RUNNER_DIR/config/10-locks.sh"; unset _GAFFER_CONFIG_PART
# shellcheck source=/dev/null
source "$RUNNER_DIR/lib/review.sh"
while [ ! -e "$2" ]; do :; done
_gaffer_review_claim "$1" >/dev/null; rc=$?
[ "$rc" = 0 ] && echo "won $$" >> "$3"
echo "tried $$" >> "$3"
# A winner holds the claim (stays alive) until both contenders have tried, so the
# loser always meets a claim whose holder is running, as in a live pool.
if [ "$rc" = 0 ]; then
  n=0; while [ "$(grep -c tried "$3")" -lt 2 ] && [ "$n" -lt 500 ]; do sleep 0.01; n=$((n + 1)); done
fi
exit 0
EOF
chmod +x "$WORK/claim.sh"

echo "== R1: two contenders, a dead lane's review claim, 200 rounds =="
both=0; none=0
for i in $(seq 1 200); do
  C="$WORK/r1/claim-$i"; mkdir -p "$C"; dead_pid > "$C/pid"
  B="$WORK/r1/go-$i"; O="$WORK/r1/out-$i"; : > "$O"
  "$WORK/claim.sh" "$C" "$B" "$O" & a=$!
  "$WORK/claim.sh" "$C" "$B" "$O" & b=$!
  touch "$B"; wait "$a" "$b"
  n="$(grep -c won "$O")"
  [ "$n" -gt 1 ] && both=$((both + 1))
  [ "$n" -eq 0 ] && none=$((none + 1))
done
[ "$both" -eq 0 ] && ok "R1 at most one claimant in every one of 200 rounds" \
  || fail "R1 both lanes took the review claim in $both of 200 rounds"
[ "$none" -eq 0 ] && ok "R1 the dead lane's claim was taken over in every round" \
  || fail "R1 nobody took the dead lane's claim in $none of 200 rounds"

echo "== R2: a claim with no pid yet is not taken; an old pid-less one is =="
(
  source "$RUNNER_DIR/config/10-locks.sh"; unset _GAFFER_CONFIG_PART
  source "$RUNNER_DIR/lib/review.sh"
  C="$WORK/r2/claim"; mkdir -p "$C"
  _GAFFER_REVIEW_CLAIM_TRIES=3 _gaffer_review_claim "$C" >/dev/null; rc=$?
  [ "$rc" = 2 ] && [ -d "$C" ] && [ ! -e "$C/pid" ] && echo FRESH_KEPT
  touch -d '-10 minutes' "$C" 2>/dev/null || touch -t "$(date -d '-10 minutes' +%Y%m%d%H%M 2>/dev/null || date -v-10M +%Y%m%d%H%M)" "$C"
  GAFFER_LOCK_STALE=120 _gaffer_review_claim "$C" >/dev/null; rc=$?
  [ "$rc" = 0 ] && [ "$(cat "$C/pid")" = "$$" ] && echo OLD_TAKEN
) > "$WORK/r2.out" 2>&1
grep -q FRESH_KEPT "$WORK/r2.out" && ok "R2 a fresh claim with no pid (a live lane mid-take) is left alone" \
  || fail "R2 a fresh pid-less claim was taken from a live lane: $(cat "$WORK/r2.out")"
grep -q OLD_TAKEN "$WORK/r2.out" && ok "R2 a pid-less claim older than GAFFER_LOCK_STALE is reaped and taken" \
  || fail "R2 an abandoned pid-less claim was never reaped: $(cat "$WORK/r2.out")"

echo "== R3: a live lane's claim is reported, not taken =="
sleep 30 & LIVE=$!
(
  source "$RUNNER_DIR/config/10-locks.sh"; unset _GAFFER_CONFIG_PART
  source "$RUNNER_DIR/lib/review.sh"
  C="$WORK/r3/claim"; mkdir -p "$C"; echo "$LIVE" > "$C/pid"
  out="$(_gaffer_review_claim "$C")"; rc=$?
  [ "$rc" = 1 ] && [ "$out" = "$LIVE" ] && [ "$(cat "$C/pid")" = "$LIVE" ] && echo LIVE_KEPT
) > "$WORK/r3.out" 2>&1
kill "$LIVE" 2>/dev/null; wait "$LIVE" 2>/dev/null
grep -q LIVE_KEPT "$WORK/r3.out" && ok "R3 a live lane's claim: rc 1, its pid, untouched" \
  || fail "R3 live claim mishandled: $(cat "$WORK/r3.out")"

echo "== D1: three DoD reruns at once against a dead holder's lock, 10 rounds =="
cat > "$WORK/rerun.sh" <<'EOF'
#!/usr/bin/env bash
gaffer_timeout() { shift; "$@"; }
# shellcheck source=/dev/null
source "$RUNNER_DIR/config/10-locks.sh"; unset _GAFFER_CONFIG_PART
# shellcheck source=/dev/null
source "$RUNNER_DIR/lib/dod.sh"
while [ ! -e "$2" ]; do :; done
GAFFER_DOD_RERUN_WAIT=0 GAFFER_DOD_TIMEOUT=20 gaffer_dod_rerun_serial "$1" "$1/out.$$" "$3" >/dev/null 2>&1
EOF
chmod +x "$WORK/rerun.sh"
overlap=0; skipped=0
for i in $(seq 1 10); do
  export GAFFER_DATA="$WORK/d1/data-$i"; mkdir -p "$GAFFER_DATA/.dod-serial/rerun.lock"
  dead_pid > "$GAFFER_DATA/.dod-serial/rerun.lock/pid"
  WT="$WORK/d1/wt-$i"; mkdir -p "$WT"; B="$WORK/d1/go-$i"; L="$WORK/d1/log-$i"; : > "$L"
  CMD="mkdir '$WT/inside' 2>/dev/null || echo OVERLAP >> '$L'; echo ran >> '$L'; sleep 0.1; rmdir '$WT/inside' 2>/dev/null; true"
  "$WORK/rerun.sh" "$WT" "$B" "$CMD" & a=$!
  "$WORK/rerun.sh" "$WT" "$B" "$CMD" & b=$!
  "$WORK/rerun.sh" "$WT" "$B" "$CMD" & c=$!
  touch "$B"; wait "$a" "$b" "$c"
  grep -q OVERLAP "$L" && overlap=$((overlap + 1))
  [ "$(grep -c ran "$L")" = 3 ] || skipped=$((skipped + 1))
done
unset GAFFER_DATA
[ "$overlap" -eq 0 ] && ok "D1 the three reruns never ran two at once (10 rounds)" \
  || fail "D1 two reruns held the serial lock at once in $overlap of 10 rounds"
[ "$skipped" -eq 0 ] && ok "D1 all three reruns ran, one after another, every round" \
  || fail "D1 a rerun did not run in $skipped of 10 rounds"

echo "== D2: a rerun lock with no pid yet is left alone =="
(
  gaffer_timeout() { shift; "$@"; }
  source "$RUNNER_DIR/config/10-locks.sh"; unset _GAFFER_CONFIG_PART
  source "$RUNNER_DIR/lib/dod.sh"
  export GAFFER_DATA="$WORK/d2/data"; mkdir -p "$GAFFER_DATA/.dod-serial/rerun.lock"
  WT="$WORK/d2/wt"; mkdir -p "$WT"
  GAFFER_DOD_RERUN_WAIT=0 GAFFER_DOD_TIMEOUT=2 gaffer_dod_rerun_serial "$WT" "$WT/out" "echo ran > '$WT/ran'" >/dev/null 2>&1; rc=$?
  [ "$rc" = 75 ] && [ ! -e "$WT/ran" ] && [ -d "$GAFFER_DATA/.dod-serial/rerun.lock" ] && echo NOPID_KEPT
) > "$WORK/d2.out" 2>&1
grep -q NOPID_KEPT "$WORK/d2.out" && ok "D2 a fresh pid-less rerun lock is not taken (rc 75, nothing ran)" \
  || fail "D2 a fresh pid-less rerun lock was taken: $(cat "$WORK/d2.out")"

echo "== K1: the take is atomic even where mkdir(1) is not =="
# uutils coreutils' mkdir (the default on Ubuntu 25.10 and later) checks "exists?" and
# then creates, and exits 0 when the directory appeared in between: two racers both
# "create" a lock. This stand-in does the same with the window held open, first on PATH
# for the contenders. Four start together on a path that does not exist.
REAL_MKDIR="$(command -v mkdir)"
mkdir -p "$WORK/racybin" "$WORK/k1"
{
  printf '%s\n' '#!/bin/sh'
  printf 'REAL=%s\n' "$REAL_MKDIR"
  printf '%s\n' 'case "$1" in -*) exec "$REAL" "$@" ;; esac' \
    '[ "$#" = 1 ] || exec "$REAL" "$@"' \
    '[ -e "$1" ] && exit 1' \
    'sleep 0.05' \
    '"$REAL" "$1" 2>/dev/null || { [ -d "$1" ] && exit 0; exit 1; }' \
    'exit 0'
} > "$WORK/racybin/mkdir"
chmod +x "$WORK/racybin/mkdir"
{
  printf '%s\n' '#!/usr/bin/env bash' \
    '# $1 = mode (take|bare), $2 = lock dir, $3 = barrier, $4 = out' \
    'source "$RUNNER_DIR/config/10-locks.sh"; unset _GAFFER_CONFIG_PART' \
    'while [ ! -e "$3" ]; do :; done' \
    'if [ "$1" = take ]; then _gaffer_lock_take_dir "$2"; else mkdir "$2" 2>/dev/null; fi' \
    '[ "$?" = 0 ] && echo "won $$" >> "$4"' \
    'exit 0'
} > "$WORK/take.sh"
chmod +x "$WORK/take.sh"
k1_rounds() {  # <mode> <rounds>: prints "<rounds with more than one winner> <rounds with none>"
  local mode="$1" rounds="$2" many=0 zero=0 i j n L B O
  for i in $(seq 1 "$rounds"); do
    mkdir -p "$WORK/k1/$mode-$i"
    L="$WORK/k1/$mode-$i/lock"; B="$WORK/k1/$mode-go-$i"; O="$WORK/k1/$mode-out-$i"; : > "$O"
    for j in 1 2 3 4; do PATH="$WORK/racybin:$PATH" "$WORK/take.sh" "$mode" "$L" "$B" "$O" & done
    touch "$B"; wait
    n="$(grep -c won "$O")"
    [ "$n" -gt 1 ] && many=$((many + 1))
    [ "$n" -eq 0 ] && zero=$((zero + 1))
  done
  echo "$many $zero"
}
read -r K_MANY K_ZERO <<<"$(k1_rounds bare 10)"
[ "$K_MANY" -gt 0 ] && ok "K1 the stand-in is racy: a bare mkdir had more than one winner in $K_MANY of 10 rounds" \
  || fail "K1 the racy mkdir stand-in never let two in (the check below would prove nothing)"
read -r K_MANY K_ZERO <<<"$(k1_rounds take 30)"
[ "$K_MANY" -eq 0 ] && ok "K1 _gaffer_lock_take_dir: one taker at most in every one of 30 rounds" \
  || fail "K1 two takers held one lock in $K_MANY of 30 rounds"
[ "$K_ZERO" -eq 0 ] && ok "K1 ...and the lock was taken every round" || fail "K1 nobody took a free lock in $K_ZERO of 30 rounds"
[ "$(cat "$WORK/k1/take-1/lock/pid" 2>/dev/null)" = "$(sed -n 's/^won //p' "$WORK/k1/take-out-1")" ] \
  && ok "K1 the pid file names the one winner" || fail "K1 the pid file does not name the winner"

echo "== K2: every lock in runner/ takes its directory through the atomic take =="
# A lock acquired with a bare mkdir in a loop or a condition is the bug above.
HITS="$(grep -nE '(while|until|if)[[:space:]]+!?[[:space:]]*mkdir[[:space:]]+"\$' "$RUNNER_DIR"/lib/*.sh "$RUNNER_DIR"/*.sh "$RUNNER_DIR"/config/*.sh "$RUNNER_DIR"/bin/*.sh 2>/dev/null || true)"
[ -z "$HITS" ] && ok "K2 no lock is taken with a bare mkdir" || fail "K2 a lock is still taken with a bare mkdir: $HITS"
K2_MISSING=""
for f in config/10-locks.sh lib/review.sh lib/dod.sh lib/run-state.sh; do
  grep -q '_gaffer_lock_take_dir "\$' "$RUNNER_DIR/$f" || K2_MISSING="$K2_MISSING $f"
done
[ -z "$K2_MISSING" ] && ok "K2 the lock files all call _gaffer_lock_take_dir" || fail "K2 no _gaffer_lock_take_dir call in:$K2_MISSING"
N_DEF="$(cat "$RUNNER_DIR/config/10-locks.sh" "$RUNNER_DIR/lib/review.sh" "$RUNNER_DIR/lib/dod.sh" "$RUNNER_DIR/lib/run-state.sh" | grep -c 'set -o noclobber; printf')"
[ "$N_DEF" = 4 ] && ok "K2 the take is the same exclusive pid-file create in each of its four definitions" \
  || fail "K2 expected four identical definitions of the take, found $N_DEF"

echo "== P1: no bare rm -rf takeover of a mkdir lock left in runner/ =="
# A takeover is an rm of a lock/claim dir followed by a retry of its mkdir; the guarded
# helper is the only place allowed to remove another holder's lock.
HITS="$(grep -nE 'rm -rf "\$(lock|_lock|_RCLAIM|lockdir)"' "$RUNNER_DIR"/lib/*.sh "$RUNNER_DIR"/*.sh "$RUNNER_DIR"/config/*.sh 2>/dev/null \
  | grep -vE '_gaffer_lock_reap|release|rmdir "\$lockdir" 2>/dev/null \|\| rm -rf "\$lockdir"|= "\$\$" \] && rm -rf|^[^:]*:[0-9]+:[[:space:]]*#' \
  | grep -vE 'dod\.sh:[0-9]+:  rm -rf "\$lock" 2>/dev/null$|review\.sh:[0-9]+:.*rm -rf "\$_RCLAIM"; _RCLAIMED=0')"
[ -z "$HITS" ] && ok "P1 only owner releases remain (no takeover by bare rm -rf)" \
  || fail "P1 a bare rm -rf lock takeover remains: $HITS"
grep -q 'rm -rf "\$1"' "$RUNNER_DIR/lib/run-state.sh" \
  && fail "P1 run-state.sh still falls back to a bare removal without the guarded reap" \
  || ok "P1 run-state.sh's poll lock never takes over without the guarded reap"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
