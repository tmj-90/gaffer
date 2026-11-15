#!/usr/bin/env bash
# =====================================================================
# A PAUSE DISPATCH REFUSES IS NOT A PAUSE (audit finding 4).
# ---------------------------------------------------------------------
# On a turn, timeout or budget cap the tick called `wg ticket pause` once; when it
# failed it logged a warning and still reported `paused`, kept the worktree flag (so the
# crash trap skipped the claim release), and the ticket sat `claimed` with no Continue
# until its lease lapsed and it was delivered again from attempt 1.
#
#   P1  gaffer_pause_delivery retries a failing pause (three tries) and succeeds when a
#       later try does
#   P2  a pause that fails every time returns 1 with the CLI's error, after 3 tries
#   P3  a pause whose command failed but whose ticket reads `paused` counts as paused
#   P4  the cap path parks a refused pause to blocked (pause_failed, branch kept) and
#       reports error, never `paused`, with the real release (stubbed `wg`)
#   P5  the cap path in tick-launch.sh no longer claims a pause it did not record
#   P6  a pause that hangs until the tick is killed (the outer tick bound): the crash trap
#       parks the ticket to blocked (pause_failed), never back to ready, and keeps the
#       branch; the replay manifest is not finished as paused
#
# Run: bash test/pause-failed.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/pause-failed.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT

# A stub `wg`: `ticket pause` fails until the call number in $PAUSE_OK_AT (0 = never);
# `ticket show` prints $SHOW_STATUS; `runner-release` records its argv. Every call is
# logged to $WORK/calls.
stub_env() {
  # shellcheck source=../lib/tick-gates.sh
  source "$RUNNER_DIR/lib/tick-gates.sh"
  NUM=7; CLAIM_TOKEN=tok; DRY_RUN=0
  log() { printf '%s\n' "$*" >> "$WORK/log"; }
  jget() { node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const d=JSON.parse(s);process.stdout.write(String(eval(process.argv[1])??""))}catch{}})' "$1"; }
  sleep() { :; }
  wg() {
    printf '%s\n' "$*" >> "$WORK/calls"
    case "$1 $2" in
      "ticket pause")
        local n; n=$(( $(grep -c '^ticket pause' "$WORK/calls") ))
        if [ "${PAUSE_OK_AT:-0}" != 0 ] && [ "$n" -ge "$PAUSE_OK_AT" ]; then return 0; fi
        echo "SQLITE_BUSY: database is locked" >&2; return 1 ;;
      "ticket show") printf '{"ticket":{"status":"%s"}}' "${SHOW_STATUS:-claimed}" ;;
      runner-release*) return 0 ;;
    esac
    return 0
  }
}
reset() { : > "$WORK/calls"; : > "$WORK/log"; }

echo "== P1: a transient failure is retried =="
reset
( stub_env; PAUSE_OK_AT=2 gaffer_pause_delivery --reason cap_hit --branch b ) ; rc=$?
[ "$rc" = 0 ] && [ "$(grep -c '^ticket pause' "$WORK/calls")" = 2 ] \
  && ok "P1 the second try pauses (rc 0, 2 pause calls)" || fail "P1 rc=$rc calls=$(cat "$WORK/calls")"
grep -q -- '--reason cap_hit --branch b' "$WORK/calls" && ok "P1 the pause arguments are passed as given" || fail "P1 args lost: $(cat "$WORK/calls")"

echo "== P2: a pause that never takes =="
reset
OUT="$( stub_env; gaffer_pause_delivery --reason cap_hit; echo "rc=$? err=$_GAFFER_PAUSE_ERR" )"
case "$OUT" in *"rc=1 err="*SQLITE_BUSY*) ok "P2 rc 1 with the CLI's error" ;; *) fail "P2 got: $OUT" ;; esac
[ "$(grep -c '^ticket pause' "$WORK/calls")" = 3 ] && ok "P2 three tries" || fail "P2 tries: $(grep -c '^ticket pause' "$WORK/calls")"

echo "== P3: the command failed but the ticket is paused =="
reset
( stub_env; SHOW_STATUS=paused gaffer_pause_delivery --reason cap_hit ) ; rc=$?
[ "$rc" = 0 ] && ok "P3 a ticket that reads paused counts as paused" || fail "P3 rc=$rc"

echo "== P4: the cap path parks a refused pause and reports error =="
# The else branch of the cap path, run as tick-launch.sh runs it (copied out of the
# file between its markers, so this test follows the code): stubs for the worktree
# teardown, the skip list and `result`.
BLOCK="$(awk '/if (gaffer_pause_delivery|wg ticket pause "\$NUM") --reason "\$_PAUSE_REASON"/{f=1} f{print} f&&/^    fi$/{exit}' "$RUNNER_DIR/lib/tick-launch.sh")"
[ -n "$BLOCK" ] && ok "P4 found the cap path's pause block in tick-launch.sh" || fail "P4 pause block not found"
reset
OUT="$( stub_env
  _PAUSE_REASON=cap_hit WORK_BRANCH=gaffer/ticket-7-x PRIMARY_REPO=/x _WT_JSON='[]' REPO_PATH=/x
  _DELIV_ATTEMPT=2 _MAX_DELIVERY_ATTEMPTS=3 _CAP_TURNS=40 _CAP_SPEND=1.2
  gaffer_cleanup_worktrees() { echo "cleanup:${1:-keep-branch} keep=${GAFFER_KEEP_DELIVERY_BRANCH:-0}" >> "$WORK/log"; }
  gaffer_skip_ticket() { echo "skip:$1" >> "$WORK/log"; }
  gaffer_tick_branch_ledger() { echo "ledger:$1" >> "$WORK/log"; }
  gaffer_manifest_finish() { :; }
  result() { echo "RESULT=$1"; }
  eval "$BLOCK"
  echo "RESULT=paused"
)"
case "$OUT" in RESULT=error*) ok "P4 a refused pause reports error, not paused" ;; *) fail "P4 result: $OUT" ;; esac
grep -q '^runner-release 7 --to blocked .*--reason-code pause_failed' "$WORK/calls" \
  && ok "P4 the claim is released to blocked with reason pause_failed" || fail "P4 no blocked release: $(cat "$WORK/calls")"
grep -q 'branch gaffer/ticket-7-x preserved' "$WORK/calls" && ok "P4 the release reason says the branch is kept" || fail "P4 reason: $(grep runner-release "$WORK/calls")"
grep -q '^cleanup:keep-branch keep=1' "$WORK/log" && ok "P4 the worktree is removed, the branch kept" || fail "P4 teardown: $(cat "$WORK/log")"
grep -q '^skip:7' "$WORK/log" && ok "P4 the ticket is skipped for the rest of the run" || fail "P4 not skipped"
grep -q '^ledger:preserved' "$WORK/log" && ok "P4 the park marks the branch preserved (branch ledger)" || fail "P4 no preserved ledger row"

echo "== P5: no pause claimed without a recorded pause =="
grep -q 'could not pause #$NUM via dispatch; worktree is still kept alive' "$RUNNER_DIR/lib/tick-launch.sh" \
  && fail "P5 the old warn-and-carry-on path is still there" || ok "P5 the warn-and-report-paused path is gone"

echo "== P6: a hung pause ended by a kill parks the ticket, branch kept =="
# The cap path from the lines that prepare the pause (kept branch, pause in flight)
# through its end; a file without them runs the pause block alone.
BLOCK6="$(awk '/# A kill while the pause is being recorded/{f=1} f{print} f&&/^    fi$/{exit}' "$RUNNER_DIR/lib/tick-launch.sh")"
[ -n "$BLOCK6" ] || BLOCK6="$BLOCK"
reset
( stub_env
  # shellcheck source=../lib/tick-recovery.sh
  source "$RUNNER_DIR/lib/tick-recovery.sh"
  # shellcheck disable=SC2034  # read by the extracted cap path and the crash trap
  _PAUSE_REASON=cap_hit WORK_BRANCH=gaffer/ticket-7-x PRIMARY_REPO=/x _WT_JSON='[]' REPO_PATH=/x
  _DELIV_ATTEMPT=1 _MAX_DELIVERY_ATTEMPTS=3 _CAP_TURNS=40 _CAP_SPEND=1.2 rc=0
  export GAFFER_DATA="$WORK/p6data"; mkdir -p "$GAFFER_DATA"
  # shellcheck disable=SC2034  # read by the extracted cap path and the crash trap
  WT_ROWS="r1"$'\t'"repo"$'\t'"/x"$'\t'"main"$'\t'"/x-wt" SKIP_FILE="$WORK/skip"
  GAFFER_KEEP_DELIVERY_BRANCH=0
  gaffer_cleanup_worktrees() { echo "cleanup:${1:-keep-branch} keep=${GAFFER_KEEP_DELIVERY_BRANCH:-0}" >> "$WORK/log"; }
  gaffer_skip_ticket() { echo "skip:$1" >> "$WORK/log"; }
  gaffer_tick_branch_ledger() { echo "ledger:$1" >> "$WORK/log"; }
  gaffer_manifest_finish() { echo "manifest:$1" >> "$WORK/log"; }
  gaffer_manifest_close() { echo "manifest-close:$1" >> "$WORK/log"; }
  gaffer_reap_orphan_agent() { :; }
  result() { echo "RESULT=$1" >> "$WORK/log"; }
  # The pause CLI "hangs" until the outer bound kills the tick: the stub signals this
  # shell, whose traps run as tick.sh's do.
  # $BASHPID is bash 4+; macOS /bin/bash is 3.2. `exec sh` replaces the command
  # substitution's subshell, so its $PPID is this shell: the pid BASHPID would give.
  TICK_PID="${BASHPID:-$(exec sh -c 'echo $PPID')}"
  wg() {
    printf '%s\n' "$*" >> "$WORK/calls"
    case "$1 $2" in
      "ticket pause") kill -TERM "$TICK_PID"; return 1 ;;
      "ticket show") printf '{"ticket":{"status":"claimed"}}' ;;
    esac
    return 0
  }
  trap '_GAFFER_EXIT_CAUSE=signal; exit 143' TERM
  trap 'gaffer_crash_cleanup' EXIT
  eval "$BLOCK6"
  echo "RESULT=paused" >> "$WORK/log"
) >"$WORK/p6.out" 2>&1
grep -q '^runner-release 7 --to blocked .*--reason-code pause_failed' "$WORK/calls" \
  && ok "P6 the crash trap parks the ticket to blocked (pause_failed)" || fail "P6 release: $(grep runner-release "$WORK/calls" | tr '\n' ' ') $(tail -5 "$WORK/p6.out" | tr '\n' ' ')"
grep -q '^runner-release 7 --to ready' "$WORK/calls" && fail "P6 the ticket was handed back to ready (redelivered past the cap)" \
  || ok "P6 the ticket is not handed back to ready"
grep -q '^cleanup:keep-branch keep=1' "$WORK/log" && ! grep -q '^cleanup:drop-branch' "$WORK/log" \
  && ok "P6 the worktree is removed and the branch (with the WIP checkpoint) kept" || fail "P6 teardown: $(grep cleanup "$WORK/log" | tr '\n' ' ')"
grep -q '^RESULT=paused' "$WORK/log" && fail "P6 reported paused" || ok "P6 nothing reports paused"
grep -q '^manifest:paused' "$WORK/log" && fail "P6 the replay manifest says paused although the pause never landed" \
  || ok "P6 the replay manifest is not finished as paused"
# (The manifest line sits outside the extracted block: it must follow the pause call.)
_mline="$(grep -n 'gaffer_manifest_finish "paused:' "$RUNNER_DIR/lib/tick-launch.sh" | head -1 | cut -d: -f1)"
_pline="$(grep -n 'if gaffer_pause_delivery --reason' "$RUNNER_DIR/lib/tick-launch.sh" | head -1 | cut -d: -f1)"
[ -n "$_mline" ] && [ -n "$_pline" ] && [ "$_mline" -gt "$_pline" ] \
  && ok "P6 the manifest is finished as paused only after the pause call succeeded" \
  || fail "P6 the manifest is finished as paused before the pause is attempted (line ${_mline:-?} vs ${_pline:-?})"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
