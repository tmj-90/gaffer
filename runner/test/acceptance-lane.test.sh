#!/usr/bin/env bash
# =====================================================================
# ACCEPTANCE GATE — the runner half. Dispatch routes an epic's acceptance ticket to
# in_testing whatever GAFFER_TESTING says; the runner must then TEST it even with the
# lane off (or the build strands as "not accepted" with nothing said), must give the
# delivery agent the acceptance prompt block, and status/loop must count an
# unaccepted build as human attention (covered in status.test.sh / loop-end-ping).
#   1. lane OFF + an acceptance ticket in_testing → the tester runs on it
#   2. lane OFF + only ordinary tickets in_testing → nothing runs (unchanged)
#   3. lane ON → runs as before
#   4. json-tool: status-count / loop-count acceptance_unaccepted read stats.acceptance
#   5. WIRING: tick.sh reads ticket.acceptance and prepends the acceptance block
# Run: bash runner/test/acceptance-lane.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/acceptance-lane.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT

# A fake RUNNER_DIR whose bin/tester-run.mjs records the ticket it was asked to test
# and answers with a verdict envelope; lib/ links to the real libs.
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
log() { printf '%s\n' "$*" >> "$LOGF"; }
result() { :; }
gaffer_auto_decision() { echo deny; }
jget() { node "$RUNNER_DIR/lib/json-tool.mjs" expr "$1"; }
gaffer_json() { node "$RUNNER_DIR/lib/json-tool.mjs" "$@"; }
_gaffer_locked() { shift; "$@"; }
_gaffer_append_line() { echo "$2" >> "$1"; }
# Stub wg: `ticket list -s in_testing` answers from $LIST; `ticket show N` answers in_testing.
LIST="$WORK/list.json"
wg() {
  case "$*" in
    "ticket list -s in_testing") cat "$LIST" ;;
    "ticket show "*) printf '{"ticket":{"number":%s,"status":"ready_for_merge"}}' "$3" ;;
    *) echo '{}' ;;
  esac
}
# shellcheck source=../lib/tester.sh
source "$RUNNER_DIR/lib/tester.sh"
# _gaffer_tester_pass ends with `result tested; exit 0` — run it in a subshell.
run_lane() { ( RUNNER_DIR="$FAKE" _gaffer_tester_pass ); }

echo "== 1: lane OFF + an ACCEPTANCE ticket in_testing → tested =="
printf '[{"number":9,"status":"in_testing","acceptance":1},{"number":4,"status":"in_testing","acceptance":0}]' > "$LIST"
: > "$TESTED"; : > "$LOGF"
GAFFER_TESTING=0 run_lane
grep -qx 9 "$TESTED" && ok "acceptance #9 was handed to the tester with the lane off" || fail "acceptance ticket not tested (tested: $(tr '\n' ' ' < "$TESTED"))"
grep -qx 4 "$TESTED" && fail "the ordinary in_testing #4 was tested with the lane off" || ok "the ordinary in_testing #4 was left alone"
grep -q 'ACCEPTANCE #9 (lane off — acceptance is a gate, not an option)' "$LOGF" && ok "log says why the lane ran" || fail "log line missing: $(cat "$LOGF")"

echo "== 2: lane OFF + only ordinary tickets → nothing runs =="
printf '[{"number":4,"status":"in_testing","acceptance":0}]' > "$LIST"
: > "$TESTED"; : > "$LOGF"
GAFFER_TESTING=0 run_lane
[ ! -s "$TESTED" ] && ok "nothing tested (unchanged behaviour)" || fail "tester ran with the lane off on an ordinary ticket"

echo "== 3: lane ON → runs as before =="
printf '[{"number":4,"status":"in_testing","acceptance":0}]' > "$LIST"
: > "$TESTED"; : > "$LOGF"
GAFFER_TESTING=1 run_lane
grep -qx 4 "$TESTED" && ok "lane on: #4 tested" || fail "lane on: #4 not tested"
grep -q 'in_testing #4 (lane on)' "$LOGF" && ok "lane-on log line unchanged" || fail "lane-on log line changed"

echo "== 4: json-tool reads stats.acceptance.unaccepted =="
J='{"ticketsByStatus":{"in_review":0},"acceptance":{"unaccepted":2,"testing":1,"accepted":3,"failed":0,"epics":[]}}'
[ "$(printf '%s' "$J" | node "$RUNNER_DIR/lib/json-tool.mjs" status-count acceptance_unaccepted)" = "2" ] && ok "status-count acceptance_unaccepted = 2" || fail "status-count wrong"
[ "$(printf '%s' "$J" | node "$RUNNER_DIR/lib/json-tool.mjs" loop-count acceptance_unaccepted)" = "2" ] && ok "loop-count acceptance_unaccepted = 2" || fail "loop-count wrong"
[ "$(printf '{"ticketsByStatus":{}}' | node "$RUNNER_DIR/lib/json-tool.mjs" status-count acceptance_unaccepted)" = "0" ] && ok "absent summary → 0 (older dispatch)" || fail "absent summary not 0"

echo "== 5: WIRING — tick.sh reads ticket.acceptance and prepends the prompt block =="
grep -q "IS_ACCEPTANCE=\"\$(echo \"\$SHOW\" | jget '\[1, true\].includes(d.ticket.acceptance)" "$RUNNER_DIR/tick.sh" && ok "tick.sh derives IS_ACCEPTANCE from the ticket" || fail "IS_ACCEPTANCE not derived"
grep -q 'PRODUCT_CONTEXT_BLOCK="$(gaffer_acceptance_prompt_block)' "$RUNNER_DIR/tick.sh" && ok "the acceptance block is prepended to the product-context slot" || fail "acceptance block not wired"
# shellcheck source=../lib/acceptance.sh
source "$RUNNER_DIR/lib/acceptance.sh"
B="$(gaffer_acceptance_prompt_block)"
case "$B" in *"ACCEPTANCE TICKET"*"Never weaken"*"INDEPENDENT tester"*) ok "block: acceptance suite, never weaken a test, the tester decides" ;; *) fail "block content wrong" ;; esac
grep -q 'lib/acceptance.sh' "$RUNNER_DIR/factory.config.sh" && ok "lib/acceptance.sh is sourced by factory.config.sh" || fail "lib not sourced"
grep -q 'tested commit' "$RUNNER_DIR/bin/tester-run.mjs" && ok "tester verdicts name the tested commit" || fail "tester-run.mjs lacks the tested-commit stamp"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "acceptance-lane: ALL $PASS checks passed"; exit 0; fi
echo "acceptance-lane: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1
