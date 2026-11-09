#!/usr/bin/env bash
# =====================================================================
# TESTER FIRST — the runner half. With the tester lane on for a ticket (dispatch decides:
# an epic's acceptance ticket, or a testable one whose lane is on), the independent tester
# tests a delivery BEFORE a person reviews it. The runner sends it there:
#   1. gaffer_tester_route <n>: `wg ticket tester-route <n> --as system`, logged, fail-soft
#   2. the tester pass sweeps (`--all`) in every review mode (tester first everywhere:
#      the reviewer agent of agent|both reviews only after the tester had its say)
#   3. the lane setting: unset/auto tests every in_testing ticket (dispatch only routes
#      where the lane applies), explicit off only an acceptance ticket
#   4. WIRING: the delivery tick routes after its gates and CI in every review mode, the
#      agent review pick asks gaffer_tester_gate before it spends a reviewer call, and the
#      CLI verb is denied to agents by the safety hook (safety-hook.test.mjs)
#   6. gaffer_tester_gate: the route's code decides whether the reviewer agent may run
#      (not_gated / covered), the ticket went to the tester (routed), or it waits (anything
#      else, a refused call, a dispatch with no code: fail closed)
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
      if [ -n "${ROUTE_CODE:-}" ]; then
        printf '{"ok":true,"routed":0,"routes":[{"number":%s,"routed":%s,"code":"%s","why":"%s"}]}' "$3" "$([ "$ROUTE_CODE" = routed ] && echo true || echo false)" "$ROUTE_CODE" "${ROUTE_WHY:-}"
      else
        printf '{"ok":true,"routed":1,"routes":[{"number":%s,"routed":true}]}' "$3"
      fi ;;
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

echo "== 2: the sweep runs in every review mode =="
: > "$CALLS"; : > "$LOGF"
REVIEW_MODE=human GAFFER_TESTING="" run_lane
grep -qx 'ticket tester-route --all --as system' "$CALLS" && ok "human review: the tester pass sweeps in_review tickets to the tester" || fail "no sweep: $(cat "$CALLS")"
grep -q 'sent #12 to the independent tester' "$LOGF" && ok "the sweep logs only the routed ones" || fail "sweep log: $(cat "$LOGF")"
grep -q '#13' "$LOGF" && fail "an unrouted ticket was logged as sent" || ok "an unrouted ticket is not logged as sent"
: > "$CALLS"
REVIEW_MODE=agent run_lane
grep -qx 'ticket tester-route --all --as system' "$CALLS" && ok "agent review mode: the tester pass sweeps too (tester first)" || fail "agent mode did not sweep: $(cat "$CALLS")"
: > "$CALLS"
REVIEW_MODE=both run_lane
grep -qx 'ticket tester-route --all --as system' "$CALLS" && ok "both mode: the tester pass sweeps too" || fail "both mode did not sweep: $(cat "$CALLS")"

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
_T="$(awk '/TESTER FIRST \(lib\/tester.sh\), in every review mode: the gates passed/{f=1} f&&/gaffer_tester_route "\$NUM"/{print "found"; exit}' "$RUNNER_DIR/lib/tick-close.sh")"
[ "$_T" = found ] && ok "tick.sh routes the delivery to the tester after its gates" || fail "tick.sh does not route after delivery"
grep -q 'REVIEW_MODE:-human}" = "human" ] && declare -F gaffer_tester_route' "$RUNNER_DIR/lib/tick-close.sh" \
  && fail "the delivery route is still limited to REVIEW_MODE=human" || ok "the delivery route runs in every review mode (tester first before the reviewer agent too)"
_ci="$(grep -n 'H3: ci-gate.sh not loaded' "$RUNNER_DIR/lib/tick-close.sh" | head -1 | cut -d: -f1)"
_rt="$(grep -n 'gaffer_tester_route "\$NUM"' "$RUNNER_DIR/lib/tick-close.sh" | head -1 | cut -d: -f1)"
[ -n "$_ci" ] && [ -n "$_rt" ] && [ "$_rt" -gt "$_ci" ] && ok "the route comes after the CI gate (a red CI rejects from review first)" || fail "route line $_rt vs CI gate $_ci"
grep -q 'gate="$(gaffer_tester_gate "$n")"' "$RUNNER_DIR/lib/review.sh" && ok "the agent review pick asks the tester gate before it spends a reviewer call" || fail "review.sh does not ask gaffer_tester_gate"
_H="$(awk '/_review_hold_ticket\(\) \{/{f=1} f&&/gaffer_tester_route "\$RNUM"/{print "found"; exit} f&&/^      \}/{exit}' "$RUNNER_DIR/lib/review.sh")"
[ "$_H" = found ] && ok "a ticket the reviewer agent cannot review is routed to the tester" || fail "_review_hold_ticket does not route"
grep -q '"tester-route",' "$RUNNER_DIR/lib/hook/control-plane.mjs" && ok "tester-route is a control-plane verb in the safety hook" || fail "hook verb missing"

echo "== 5: a tester FAIL is the next attempt's review feedback =="
SHOW='{"events":[{"event_type":"ticket.transitioned","payload_json":"{\"from\":\"in_review\",\"to\":\"in_testing\",\"reason\":\"tester_before_review\"}"},{"event_type":"ticket.transitioned","payload_json":"{\"from\":\"in_testing\",\"to\":\"refining\",\"reason\":\"tester_failed:GET /todos returns 500 on an empty list [tested commit 1111111111aa of gaffer/ticket-3-x]\"}"}]}'
RF="$(printf '%s' "$SHOW" | node "$RUNNER_DIR/lib/json-tool.mjs" review-feedback)"
[ "$RF" = "  - tester_failed:GET /todos returns 500 on an empty list [tested commit 1111111111aa of gaffer/ticket-3-x]" ] \
  && ok "review-feedback carries the tester's observation (the route into testing is not feedback)" || fail "review-feedback: '$RF'"

echo "== 6: gaffer_tester_gate =="
gate() { ROUTE_CODE="$1" ROUTE_WHY="${2:-}" gaffer_tester_gate 21; }
: > "$LOGF"
[ "$(gate not_gated)" = review ] && ok "not_gated: the reviewer agent may review" || fail "not_gated -> $(gate not_gated)"
[ "$(gate covered)" = review ] && ok "covered (a PASS on the head): the reviewer agent may review" || fail "covered -> $(gate covered)"
[ "$(gate routed)" = routed ] && ok "routed: the reviewer waits for the tester" || fail "routed -> $(gate routed)"
grep -q 'sent #21 to the independent tester before review' "$LOGF" && ok "routed is logged" || fail "routed log: $(cat "$LOGF")"
[ "$(gate not_in_review)" = gone ] && ok "not_in_review: gone" || fail "not_in_review -> $(gate not_in_review)"
case "$(gate ci_pending "CI has not passed on abc yet")" in "wait:CI has not passed on abc yet [ci_pending]") ok "ci_pending: wait, with dispatch's reason" ;; *) fail "ci_pending -> $(gate ci_pending x)" ;; esac
case "$(gate "" "")" in wait:*) ok "a route with no code: wait (fail closed)" ;; *) fail "no code -> $(gate "" "")" ;; esac
ROUTE_RC=3; case "$(gaffer_tester_gate 21)" in wait:*) ok "a refused route call: wait (fail closed)" ;; *) fail "refused -> $(gaffer_tester_gate 21)" ;; esac; ROUTE_RC=0
[ "$(DRY_RUN=1 gaffer_tester_gate 21)" = review ] && ok "DRY_RUN: no route, the preview goes on" || fail "DRY_RUN gate"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "tester-first: ALL $PASS checks passed"; exit 0; fi
echo "tester-first: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1
