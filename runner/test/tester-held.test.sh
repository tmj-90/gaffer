#!/usr/bin/env bash
# =====================================================================
# TESTER HOLDS — lib/tester.sh's record of a ticket the independent tester could
# not decide (bin/tester-run.mjs phase "held", exit 2).
#   1. the log names the tester-run's OWN reason (implementation change, failed
#      clean replay, no token), never one fixed "no verdict token" line
#   2. the reason is attached to the ticket as a `tester held: <reason>`
#      manual_note, so the board says why the ticket sits in in_testing
#   3. the hold survives loop.sh's per-run reset of .tested-tickets: the next run
#      does NOT re-spawn the (paid) tester for the same stay in_testing
#   4. once the ticket leaves in_testing and comes back (a new transition into
#      in_testing), it is tested again
#   5. a held ticket does not block the next in_testing ticket in the same pass
#   6. a recorded verdict never writes a hold
# No model: bin/tester-run.mjs is a stub that answers with a canned envelope.
# Run: bash runner/test/tester-held.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tester-held.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT

# A fake RUNNER_DIR whose bin/tester-run.mjs logs the ticket it was asked to test
# and answers with the envelope in $WORK/reply-<n>.json (exit code in rc-<n>).
FAKE="$WORK/runner"; mkdir -p "$FAKE/bin" "$FAKE/lib"
ln -s "$RUNNER_DIR/lib/json-tool.mjs" "$FAKE/lib/json-tool.mjs"
SPAWNS="$WORK/spawns.log"; : > "$SPAWNS"
cat > "$FAKE/bin/tester-run.mjs" <<JS
import { appendFileSync, copyFileSync, existsSync, readFileSync } from "node:fs";
const n = process.argv[process.argv.indexOf("--ticket") + 1];
appendFileSync("$SPAWNS", n + "\n");
// The raw claude envelope, as the real tester-run hands it to the runner.
if (process.env.GAFFER_TESTER_ENVELOPE_OUT && existsSync("$WORK/envelope-" + n + ".json"))
  copyFileSync("$WORK/envelope-" + n + ".json", process.env.GAFFER_TESTER_ENVELOPE_OUT);
process.stdout.write(readFileSync("$WORK/reply-" + n + ".json", "utf8"));
process.exit(Number(readFileSync("$WORK/rc-" + n, "utf8")));
JS
GAFFER_DATA="$WORK/data"; mkdir -p "$GAFFER_DATA"; DISPATCH_DB="$WORK/wg.sqlite"; MEMORY_DB="$WORK/lg.sqlite"
LOGF="$WORK/log"; : > "$LOGF"
EVID="$WORK/evidence"; : > "$EVID"
log() { printf '%s\n' "$*" >> "$LOGF"; }
result() { :; }
gaffer_auto_decision() { echo deny; }
jget() { node "$RUNNER_DIR/lib/json-tool.mjs" expr "$1"; }
gaffer_json() { node "$RUNNER_DIR/lib/json-tool.mjs" "$@"; }
_gaffer_locked() { shift; "$@"; }
_gaffer_append_line() { echo "$2" >> "$1"; }
# Stub wg: the in_testing list from $LIST; `ticket show N` carries a transition into
# in_testing at the time in $WORK/entered-<n>; attach-evidence is recorded.
LIST="$WORK/list.json"
wg() {
  case "$1 $2" in
    "ticket list") cat "$LIST" ;;
    "ticket show")
      printf '{"ticket":{"number":%s,"status":"in_testing"},"events":[{"event_type":"ticket.transitioned","created_at":"2026-01-01T00:00:00.000Z","payload_json":"{\\"from\\":\\"ready\\",\\"to\\":\\"in_progress\\"}"},{"event_type":"ticket.transitioned","created_at":"%s","payload_json":"{\\"from\\":\\"in_review\\",\\"to\\":\\"in_testing\\"}"}]}' \
        "$3" "$(cat "$WORK/entered-$3" 2>/dev/null)" ;;
    "attach-evidence "*) printf '%s|%s|%s\n' "$2" "$4" "$6" >> "$EVID" ;;
    *) echo '{}' ;;
  esac
}
# shellcheck source=../lib/tester.sh
source "$RUNNER_DIR/lib/tester.sh"
# The real usage-window pause helpers (lib/usage-pause.sh), as factory.config.sh sources them.
# shellcheck source=../lib/usage-pause.sh
source "$RUNNER_DIR/lib/usage-pause.sh"
run_lane() { ( RUNNER_DIR="$FAKE" GAFFER_TESTING=1 _gaffer_tester_pass ); }
new_run() { rm -f "$GAFFER_DATA/.tested-tickets"; }   # what loop.sh does at every run start
held() { # <n> <reason>
  printf '{"phase":"held","ticket":%s,"reason":"%s","testsBranch":"gaffer-tests/ticket-%s"}' "$1" "$2" "$1" > "$WORK/reply-$1.json"
  echo 2 > "$WORK/rc-$1"
}
spawns_of() { grep -cx "$1" "$SPAWNS"; }

echo "== 1+2: the log and the ticket carry the tester-run's own reason =="
printf '[{"number":3,"status":"in_testing"}]' > "$LIST"
echo "2026-02-01T10:00:00.000Z" > "$WORK/entered-3"
held 3 "tester modified implementation files: src/a.js"
run_lane
grep -q 'TESTER: #3 HELD in_testing — tester modified implementation files: src/a.js' "$LOGF" \
  && ok "log names the implementation-change reason" || fail "log line wrong: $(grep 'TESTER: #3' "$LOGF")"
grep -q 'no verdict token' "$LOGF" && fail "an implementation-change hold was logged as 'no verdict token'" \
  || ok "no misleading 'no verdict token' text for an implementation-change hold"
grep -q '^3|manual_note|tester held: tester modified implementation files: src/a.js — held in_testing for a human; its tests are kept on gaffer-tests/ticket-3' "$EVID" \
  && ok "a 'tester held: <reason>' manual_note is attached to #3" || fail "held evidence missing/wrong: $(cat "$EVID")"
grep -qx $'3\t2026-02-01T10:00:00.000Z' "$GAFFER_DATA/.tester-held" \
  && ok "the hold is remembered for this stay in_testing" || fail "hold marker missing: $(cat "$GAFFER_DATA/.tester-held" 2>/dev/null)"

echo "== 3: the next run does not re-spawn the tester for the same stay =="
new_run; : > "$EVID"
run_lane
[ "$(spawns_of 3)" = 1 ] && ok "#3 not re-tested after the per-run skip file was cleared (1 spawn total)" \
  || fail "#3 was re-spawned on the next run ($(spawns_of 3) spawns)"
grep -q 'TESTER: #3 is still HELD in_testing for a human' "$LOGF" && ok "log says it is still held" || fail "no still-held log line"
[ ! -s "$EVID" ] && ok "no duplicate held note on the skipped run" || fail "a duplicate note was attached: $(cat "$EVID")"

echo "== 4: leaving in_testing and coming back is a new stay → tested again =="
new_run
echo "2026-02-03T09:00:00.000Z" > "$WORK/entered-3"
held 3 "clean replay failed: npm test exited 1 on a clean checkout of abc"
run_lane
[ "$(spawns_of 3)" = 2 ] && ok "#3 re-tested after re-entering in_testing" || fail "#3 not re-tested after re-entry ($(spawns_of 3) spawns)"
grep -q 'TESTER: #3 HELD in_testing — clean replay failed: npm test exited 1' "$LOGF" \
  && ok "log names the replay-failure reason" || fail "replay reason not logged"
grep -q '^3|manual_note|tester held: clean replay failed: npm test exited 1' "$EVID" \
  && ok "the replay-failure reason is attached" || fail "replay evidence missing: $(cat "$EVID")"

echo "== 5: a held ticket does not block the next in_testing ticket =="
new_run
printf '[{"number":3,"status":"in_testing"},{"number":5,"status":"in_testing"}]' > "$LIST"
echo "2026-02-04T09:00:00.000Z" > "$WORK/entered-5"
held 5 "the tester produced no verdict token"
run_lane
[ "$(spawns_of 3)" = 2 ] && [ "$(spawns_of 5)" = 1 ] && ok "held #3 skipped, #5 tested in the same pass" \
  || fail "spawns: #3=$(spawns_of 3) #5=$(spawns_of 5)"
grep -q 'TESTER: #5 HELD in_testing — the tester produced no verdict token' "$LOGF" && ok "no-token hold logged as such" || fail "no-token reason not logged"

echo "== 6: holds for tickets that left in_testing are forgotten; a verdict writes none =="
new_run
printf '[{"number":5,"status":"in_testing"},{"number":6,"status":"in_testing"}]' > "$LIST"
echo "2026-02-04T10:00:00.000Z" > "$WORK/entered-6"
printf '{"phase":"verdict","verdict":"pass","ticket":6}' > "$WORK/reply-6.json"; echo 0 > "$WORK/rc-6"
run_lane
! grep -q '^3	' "$GAFFER_DATA/.tester-held" && ok "#3's hold pruned once it left in_testing" || fail "stale hold kept: $(cat "$GAFFER_DATA/.tester-held")"
grep -q '^5	' "$GAFFER_DATA/.tester-held" && ok "#5's live hold kept" || fail "#5's hold was dropped"
[ "$(spawns_of 6)" = 1 ] && ! grep -q '^6	' "$GAFFER_DATA/.tester-held" && ok "#6 verdict recorded, no hold written" \
  || fail "#6: spawns=$(spawns_of 6) held=$(cat "$GAFFER_DATA/.tester-held")"
# A FAILED in_testing listing must not forget the holds (that would re-spend on them).
wg_real="$(declare -f wg)"
wg() { [ "$1 $2" = "ticket list" ] && return 1; echo '{}'; }
run_lane
grep -q '^5	' "$GAFFER_DATA/.tester-held" && ok "a failed listing keeps the holds" || fail "a failed listing pruned the holds"
eval "$wg_real"

echo "== 7: a tester REFUSED by the usage window is not held for a human; the factory pauses =="
new_run; : > "$EVID"
printf '[{"number":8,"status":"in_testing"}]' > "$LIST"
echo "2026-02-05T09:00:00.000Z" > "$WORK/entered-8"
printf '{"phase":"usage_limited","ticket":8,"kind":"usage_limit","reason":"You hit your 5-hour limit"}' > "$WORK/reply-8.json"; echo 3 > "$WORK/rc-8"
printf '%s\n' '{"type":"result","subtype":"success","is_error":true,"num_turns":1,"result":"You'"'"'ve hit your 5-hour limit · resets 11:58pm (UTC) · progress saved","total_cost_usd":0}' > "$WORK/envelope-8.json"
RESULTS="$WORK/results"; : > "$RESULTS"
result() { echo "$1" >> "$RESULTS"; }
run_lane
[ "$(spawns_of 8)" = 1 ] && ok "#8 was tested once" || fail "#8 spawns: $(spawns_of 8)"
grep -q '^8	' "$GAFFER_DATA/.tester-held" 2>/dev/null && fail "#8 was remembered as HELD for a human (it would never be re-tested)" \
  || ok "#8 is not remembered as held"
grep -q '^8|manual_note|tester held' "$EVID" && fail "a 'tester held' note was attached to #8: $(cat "$EVID")" \
  || ok "no 'tester held' note on #8"
[ -s "$GAFFER_DATA/usage-pause.json" ] && grep -q '"lane":"tester"' "$GAFFER_DATA/usage-pause.json" && grep -q '"ticket":8' "$GAFFER_DATA/usage-pause.json" \
  && ok "the pause was recorded (lane tester, ticket 8)" || fail "pause file: $(cat "$GAFFER_DATA/usage-pause.json" 2>/dev/null)"
grep -q 'TESTER: #8 refused by the usage window' "$LOGF" && ok "the log names the usage-window refusal" || fail "no usage-window log line: $(grep 'TESTER: #8' "$LOGF")"
grep -qx usage_paused "$RESULTS" && ok "the tick reports usage_paused" || fail "tick results: $(tr '\n' ' ' < "$RESULTS")"
[ ! -e "$GAFFER_DATA/.usage-tester-8.json" ] && ok "the envelope copy was removed" || fail "the envelope copy was left behind"
new_run; rm -f "$GAFFER_DATA/usage-pause.json"
printf '{"phase":"verdict","verdict":"pass","ticket":8}' > "$WORK/reply-8.json"; echo 0 > "$WORK/rc-8"; rm -f "$WORK/envelope-8.json"
run_lane
[ "$(spawns_of 8)" = 2 ] && ok "#8 is tested again on the next run (after the window reset)" || fail "#8 not re-tested ($(spawns_of 8) spawns)"
echo "== 7b: the same words in the agent's own reply (success envelope) are still a hold =="
new_run; : > "$EVID"
printf '[{"number":9,"status":"in_testing"}]' > "$LIST"
echo "2026-02-05T10:00:00.000Z" > "$WORK/entered-9"
held 9 "the tester produced no verdict token"
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"num_turns":4,"result":"You'"'"'ve hit your 5-hour limit · resets 11:58pm (UTC)","total_cost_usd":0.01}' > "$WORK/envelope-9.json"
run_lane
grep -q '^9	' "$GAFFER_DATA/.tester-held" && ok "#9 held as before" || fail "#9 not held"
[ ! -e "$GAFFER_DATA/usage-pause.json" ] && ok "no pause from an agent's own reply" || fail "an agent's reply wrote a pause: $(cat "$GAFFER_DATA/usage-pause.json")"
result() { :; }

echo "== entered-status-at reads the LATEST transition into the status =="
J='{"events":[{"event_type":"ticket.transitioned","created_at":"2026-01-02T00:00:00.000Z","payload_json":"{\"to\":\"in_testing\"}"},{"event_type":"ticket.transitioned","created_at":"2026-01-05T00:00:00.000Z","payload_json":"{\"to\":\"in_testing\"}"},{"event_type":"ticket.transitioned","created_at":"2026-01-09T00:00:00.000Z","payload_json":"{\"to\":\"refining\"}"}]}'
[ "$(printf '%s' "$J" | node "$RUNNER_DIR/lib/json-tool.mjs" entered-status-at in_testing)" = "2026-01-05T00:00:00.000Z" ] \
  && ok "latest in_testing entry picked" || fail "entered-status-at wrong"
[ -z "$(printf 'not json' | node "$RUNNER_DIR/lib/json-tool.mjs" entered-status-at in_testing)" ] && ok "unparseable → empty" || fail "unparseable not empty"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "tester-held: ALL $PASS checks passed"; exit 0; fi
echo "tester-held: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1
