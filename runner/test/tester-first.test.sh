#!/usr/bin/env bash
# =====================================================================
# TESTER FIRST — the runner half. With the tester lane on for a ticket (dispatch decides:
# an epic's acceptance ticket, or a testable one whose lane is on), the independent tester
# tests a delivery BEFORE a person reviews it. The runner sends it there:
#   1. gaffer_tester_route <n>: `wg ticket tester-route <n> --as system`, logged, fail-soft
#   2. the tester pass sweeps (`--all`) under REVIEW_MODE=human, never under agent|both
#      (the agent review pass routes after its verdict instead)
#   3. the lane setting: unset/auto tests every in_testing ticket (dispatch only routes
#      where the lane applies), explicit off only an acceptance ticket
#   4. WIRING: the delivery tick routes after its gates and CI (REVIEW_MODE=human), the
#      agent review pass routes a ticket it left in review, and the CLI verb is denied to
#      agents by the safety hook (safety-hook.test.mjs)
#   5. a tester FAIL's observation is the next attempt's review feedback (json-tool
#      review-feedback reads the in_testing -> refining reason)
# Run: bash runner/test/tester-first.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tester-first.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT

FAKE="$WORK/runner"; mkdir -p "$FAKE/bin" "$FAKE/lib"
ln -s "$RUNNER_DIR/lib/json-tool.mjs" "$FAKE/lib/json-tool.mjs"
TESTED="$WORK/tested.log"; : > "$TESTED"
cat > "$FAKE/bin/tester-run.mjs" <<JS
import { appendFileSync } from "node:fs";
const i = process.argv.indexOf("--ticket");
appendFileSync("$TESTED", process.argv[i + 1] + "\n");
process.stdout.write(JSON.stringify({ phase: "verdict", verdict: "pass", ticket: Number(process.argv[i + 1]) }));
JS
GAFFER_DATA="$WORK/data"; mkdir -p "$GAFFER_DATA"; DISPATCH_DB="$WORK/wg.sqlite"; MEMORY_DB="$WORK/lg.sqlite"
LOGF="$WORK/log"; : > "$LOGF"
CALLS="$WORK/wg-calls"; : > "$CALLS"
log() { printf '%s\n' "$*" >> "$LOGF"; }
result() { :; }
gaffer_auto_decision() { echo deny; }
jget() { node "$RUNNER_DIR/lib/json-tool.mjs" expr "$1"; }
gaffer_json() { node "$RUNNER_DIR/lib/json-tool.mjs" "$@"; }
_gaffer_locked() { shift; "$@"; }
_gaffer_append_line() { echo "$2" >> "$1"; }
LIST="$WORK/list.json"; printf '[]' > "$LIST"
ROUTE_RC=0
wg() {
  printf '%s\n' "$*" >> "$CALLS"
  case "$*" in
    "ticket list -s in_testing") cat "$LIST" ;;
    "ticket tester-route --all --as system")
      printf '{"ok":true,"routed":1,"routes":[{"number":12,"routed":true},{"number":13,"routed":false,"why":"x"}]}' ;;
    "ticket tester-route "*) [ "$ROUTE_RC" = 0 ] || return "$ROUTE_RC"
      printf '{"ok":true,"routed":1,"routes":[{"number":%s,"routed":true}]}' "$3" ;;
    "ticket show "*) printf '{"ticket":{"number":%s,"status":"in_review"}}' "$3" ;;
    *) echo '{}' ;;
  esac
}
# shellcheck source=../lib/tester.sh
source "$RUNNER_DIR/lib/tester.sh"
run_lane() { ( RUNNER_DIR="$FAKE" _gaffer_tester_pass ); }

echo "== 1: gaffer_tester_route =="
: > "$CALLS"; : > "$LOGF"
gaffer_tester_route 7
grep -qx 'ticket tester-route 7 --as system' "$CALLS" && ok "asks dispatch to route #7 as the runner (system)" || fail "route call: $(cat "$CALLS")"
grep -q 'sent #7 to the independent tester before review' "$LOGF" && ok "logs the route" || fail "route log: $(cat "$LOGF")"
: > "$LOGF"; ROUTE_RC=3
gaffer_tester_route 8; rc=$?
ROUTE_RC=0
[ "$rc" = 0 ] && ok "fail-soft: a refused route returns 0" || fail "route rc=$rc"
grep -q 'could not send #8' "$LOGF" && ok "a refused route is logged" || fail "refusal log: $(cat "$LOGF")"
: > "$CALLS"
DRY_RUN=1 gaffer_tester_route 9
[ ! -s "$CALLS" ] && ok "DRY_RUN routes nothing" || fail "DRY_RUN called wg: $(cat "$CALLS")"

echo "== 2: the sweep runs under REVIEW_MODE=human only =="
: > "$CALLS"; : > "$LOGF"
REVIEW_MODE=human GAFFER_TESTING="" run_lane
grep -qx 'ticket tester-route --all --as system' "$CALLS" && ok "human review: the tester pass sweeps in_review tickets to the tester" || fail "no sweep: $(cat "$CALLS")"
grep -q 'sent #12 to the independent tester' "$LOGF" && ok "the sweep logs only the routed ones" || fail "sweep log: $(cat "$LOGF")"
grep -q '#13' "$LOGF" && fail "an unrouted ticket was logged as sent" || ok "an unrouted ticket is not logged as sent"
: > "$CALLS"
REVIEW_MODE=agent run_lane
grep -q 'tester-route' "$CALLS" && fail "agent review mode swept (the agent review routes after its verdict)" || ok "agent review mode: no sweep"
: > "$CALLS"
REVIEW_MODE=both run_lane
grep -q 'tester-route' "$CALLS" && fail "both mode swept" || ok "both mode: no sweep"

echo "== 3: the lane setting =="
printf '[{"number":4,"status":"in_testing","acceptance":0}]' > "$LIST"
: > "$TESTED"; : > "$LOGF"
( unset GAFFER_TESTING; RUNNER_DIR="$FAKE" REVIEW_MODE=agent _gaffer_tester_pass )
grep -qx 4 "$TESTED" && ok "auto (unset): an in_testing ticket is tested" || fail "auto: #4 not tested"
grep -q 'in_testing #4 (lane auto: a test command is registered)' "$LOGF" && ok "auto log line" || fail "auto log: $(cat "$LOGF")"
# lane-hook R4: an acceptance ticket under auto is tested whatever its repos have, so the
# log must not say a test command is registered.
printf '[{"number":5,"status":"in_testing","acceptance":1}]' > "$LIST"
: > "$TESTED"; : > "$LOGF"
( unset GAFFER_TESTING; RUNNER_DIR="$FAKE" REVIEW_MODE=agent _gaffer_tester_pass )
grep -qx 5 "$TESTED" && ok "auto: an acceptance ticket is tested" || fail "auto: acceptance #5 not tested"
grep -q 'ACCEPTANCE #5 (lane auto: acceptance is a gate' "$LOGF" && ok "auto acceptance log line names the gate" || fail "auto acceptance log: $(cat "$LOGF")"
grep -q '#5 (lane auto: a test command is registered)' "$LOGF" && fail "auto acceptance log claims a test command" || ok "auto acceptance log does not claim a test command"
printf '[{"number":4,"status":"in_testing","acceptance":0}]' > "$LIST"
: > "$TESTED"
GAFFER_TESTING=auto REVIEW_MODE=agent run_lane
grep -qx 4 "$TESTED" && ok "auto (explicit word): tested" || fail "GAFFER_TESTING=auto: #4 not tested"
: > "$TESTED"
GAFFER_TESTING=0 REVIEW_MODE=agent run_lane
[ ! -s "$TESTED" ] && ok "explicit off: an ordinary ticket is left alone" || fail "explicit off tested #4"
: > "$TESTED"
GAFFER_TESTING=No REVIEW_MODE=agent run_lane
[ ! -s "$TESTED" ] && ok "explicit off (any other word): left alone" || fail "GAFFER_TESTING=No tested #4"

echo "== 4: WIRING =="
_T="$(awk '/TESTER FIRST \(lib\/tester.sh\): the gates passed/{f=1} f&&/gaffer_tester_route "\$NUM"/{print "found"; exit}' "$RUNNER_DIR/tick.sh")"
[ "$_T" = found ] && ok "tick.sh routes the delivery to the tester after its gates (REVIEW_MODE=human)" || fail "tick.sh does not route after delivery"
_ci="$(grep -n 'H3: ci-gate.sh not loaded' "$RUNNER_DIR/tick.sh" | head -1 | cut -d: -f1)"
_rt="$(grep -n 'gaffer_tester_route "\$NUM"' "$RUNNER_DIR/tick.sh" | head -1 | cut -d: -f1)"
[ -n "$_ci" ] && [ -n "$_rt" ] && [ "$_rt" -gt "$_ci" ] && ok "the route comes after the CI gate (a red CI rejects from review first)" || fail "route line $_rt vs CI gate $_ci"
grep -q 'gaffer_tester_route "\$RNUM"' "$RUNNER_DIR/lib/review.sh" && ok "the agent review pass routes a ticket it left in review" || fail "review.sh does not route"
_H="$(awk '/_review_hold_ticket\(\) \{/{f=1} f&&/gaffer_tester_route "\$RNUM"/{print "found"; exit} f&&/^      \}/{exit}' "$RUNNER_DIR/lib/review.sh")"
[ "$_H" = found ] && ok "a ticket the reviewer agent cannot review is routed to the tester (no sweep under agent|both)" || fail "_review_hold_ticket does not route"
grep -q '"tester-route",' "$RUNNER_DIR/lib/hook/control-plane.mjs" && ok "tester-route is a control-plane verb in the safety hook" || fail "hook verb missing"

echo "== 5: a tester FAIL is the next attempt's review feedback =="
SHOW='{"events":[{"event_type":"ticket.transitioned","payload_json":"{\"from\":\"in_review\",\"to\":\"in_testing\",\"reason\":\"tester_before_review\"}"},{"event_type":"ticket.transitioned","payload_json":"{\"from\":\"in_testing\",\"to\":\"refining\",\"reason\":\"tester_failed:GET /todos returns 500 on an empty list [tested commit 1111111111aa of gaffer/ticket-3-x]\"}"}]}'
RF="$(printf '%s' "$SHOW" | node "$RUNNER_DIR/lib/json-tool.mjs" review-feedback)"
[ "$RF" = "  - tester_failed:GET /todos returns 500 on an empty list [tested commit 1111111111aa of gaffer/ticket-3-x]" ] \
  && ok "review-feedback carries the tester's observation (the route into testing is not feedback)" || fail "review-feedback: '$RF'"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "tester-first: ALL $PASS checks passed"; exit 0; fi
echo "tester-first: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1
