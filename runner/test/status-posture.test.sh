#!/usr/bin/env bash
# =====================================================================
# `gaffer status`: the posture it runs with, and no factory where there is none.
# ---------------------------------------------------------------------
#   1  an unknown GAFFER_MODE (yolo, autonomus) warns ONCE on stderr, naming the valid
#      modes and the supervised fallback (it used to fall back in silence);
#   2  status shows the effective posture: mode (and the fallback), review mode,
#      auto-merge, the dollar caps, the ticks cap, whether the OS sandbox is required;
#   3  on an uninitialised GAFFER_DATA (real doctors): exit 1, "no factory here" + the
#      `runner/gaffer setup` hint on stderr, no raw JSON, and NO file created (the
#      doctors used to create dispatch.sqlite + memory.sqlite and exit 0).
# Run: bash runner/test/status-posture.test.sh   (bash 3.2 safe)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
has()  { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/status-posture.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
export GAFFER_DATA="$WORK/data"; mkdir -p "$GAFFER_DATA"
unset GAFFER_MODE REVIEW_MODE AUTO_MERGE GAFFER_DAILY_BUDGET_USD GAFFER_BUDGET_USD GAFFER_STRICT_REQUIRE STRICT_MODE \
  DISPATCH_ALLOW_AGENT_APPROVE MERGE_ON_AGENT_REVIEW MEMORY_AUTO_APPROVE GAFFER_AUTO_PUSH _GAFFER_MODE_WARNED _GAFFER_OPERATOR_ENV \
  GAFFER_ALLOW_UNCAPPED   # run.sh opts the suite out of the cap; this test shows the cap line
printf '#!/usr/bin/env bash\necho Healthy.\n' > "$WORK/doc.sh"; chmod +x "$WORK/doc.sh"
printf '#!/usr/bin/env bash\necho "{}"\n' > "$WORK/json.sh"; chmod +x "$WORK/json.sh"
st() {  # st [VAR=value…] — gaffer status with stubbed sources; stdout → OUT, stderr → ERR
  env "$@" WG_DOCTOR_CMD="$WORK/doc.sh" FG_DOCTOR_CMD="$WORK/doc.sh" LG_DOCTOR_CMD="$WORK/doc.sh" STATS_CMD="$WORK/json.sh" \
    REPOS_CMD="$WORK/json.sh" HUMAN_QUEUE_CMD="$WORK/json.sh" GAFFER_LOG="$WORK/factory.log" \
    DASHBOARD_PROBE_URL="http://127.0.0.1:9/healthz" bash "$RUNNER_DIR/gaffer" status >"$WORK/out" 2>"$WORK/err"
  RC=$?; OUT="$(cat "$WORK/out")"; ERR="$(cat "$WORK/err")"
}
count() { printf '%s\n' "$1" | grep -c "$2"; }

echo "== 1: an unknown GAFFER_MODE warns, once =="
st GAFFER_MODE=yolo
has "$ERR" "GAFFER_MODE='yolo' is not a mode (supervised, graduated, lite, autonomous, strict) — using supervised" \
  && ok "the warning names the value, the valid modes and the fallback" || fail "no/incorrect warning: $ERR"
[ "$(count "$ERR" "is not a mode")" = 1 ] && ok "warned once (gaffer + status.sh both source the config)" || fail "warned $(count "$ERR" "is not a mode") times"
st GAFFER_MODE=supervised
has "$ERR" "is not a mode" && fail "a valid mode warned: $ERR" || ok "a valid mode does not warn"

echo "== 2: the posture block =="
st GAFFER_MODE=autonomus
has "$OUT" "mode:        supervised  (GAFFER_MODE='autonomus' is not a mode" && ok "posture shows the effective mode and the fallback" || fail "mode line: $(printf '%s' "$OUT" | grep 'mode:')"
has "$OUT" "review:      human" && has "$OUT" "auto-merge:  off" && ok "supervised: human review, auto-merge off" || fail "review/auto-merge: $OUT"
has "$OUT" "day cap:     none — a live run refuses to start" && ok "no dollar cap is said plainly" || fail "cap line: $(printf '%s' "$OUT" | grep 'cap:')"
has "$OUT" "sandbox:     not required" && ok "sandbox not required (supervised)" || fail "sandbox line: $(printf '%s' "$OUT" | grep 'sandbox:')"
st GAFFER_MODE=autonomous GAFFER_DAILY_BUDGET_USD=5 GAFFER_BUDGET_USD=40
has "$OUT" "mode:        autonomous" && has "$OUT" "review:      agent" && has "$OUT" "auto-merge:  on" \
  && ok "autonomous: agent review, auto-merge on" || fail "autonomous posture: $OUT"
has "$OUT" 'day cap:     $5 a day (GAFFER_DAILY_BUDGET_USD) · lifetime $40 (GAFFER_BUDGET_USD)' && ok "both caps shown" || fail "caps: $(printf '%s' "$OUT" | grep 'cap:')"
has "$OUT" "sandbox:     required (GAFFER_STRICT_REQUIRE=1" && ok "autonomy makes the sandbox required, and status says so" || fail "sandbox: $(printf '%s' "$OUT" | grep 'sandbox:')"

echo "== 3: an uninitialised GAFFER_DATA =="
EMPTY="$WORK/fresh"; mkdir -p "$EMPTY"
RC=0; OUT="$(env GAFFER_DATA="$EMPTY" bash "$RUNNER_DIR/gaffer" status 2>"$WORK/err")" || RC=$?; ERR="$(cat "$WORK/err")"
[ "$RC" -ne 0 ] && ok "exit $RC" || fail "exit 0 on a factory that does not exist"
has "$ERR" "no factory here" && has "$ERR" "runner/gaffer setup" && ok "says there is no factory and to run setup (stderr)" || fail "message: out=$OUT err=$ERR"
has "$OUT$ERR" "CONFIG_NOT_FOUND" && fail "raw JSON shown" || ok "no raw JSON"
has "$OUT$ERR" "MISMATCH" && fail "the db MISMATCH warning still shows" || ok "no MISMATCH warning"
[ -z "$(ls -A "$EMPTY")" ] && ok "nothing was created in it" || fail "files created: $(ls -A "$EMPTY" | tr '\n' ' ')"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "status-posture: ALL $PASS checks passed"; exit 0; fi
echo "status-posture: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
