#!/usr/bin/env bash
# =====================================================================
# REVIEW PACKET — the tests gate keeps the test runner's own summary lines.
# ---------------------------------------------------------------------
# runner/lib/dod.sh writes a `---DOD-TALLY tests@<repo>--- … ---END-DOD-TALLY---`
# block after the tests gate (pass or fail) so the Review view can say what the
# runner saw ("the summary says 42, the runner saw 40"). The block must:
#   T1  carry a vitest summary line on a PASSING tests gate, ANSI stripped;
#   T2  carry jest, pytest, cargo and node --test summary lines;
#   T3  count `go test -v` top-level --- PASS/FAIL/SKIP lines into one tally line;
#   T4  be absent when the output has no summary, and never written for lint;
#   T5  ride along in the recorded DoD evidence summary, after the JSON line;
#   T6  leave the gate verdict and the executed-gate count unchanged;
#   T7  never let a passing test's own output forge a runner GATE row (tabs become
#       spaces, GATE/--- lines are dropped, and the evidence parser reads GATE rows
#       only outside the frames).
#
# Zero non-dispatch deps. Run: bash test/dod-tally.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
CREW_DIR="$RUNNER_DIR/../packages/crew"
export CREW_DIR

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

gaffer_timeout() { local s="$1"; shift; "$@"; return $?; }
# shellcheck source=../lib/dod.sh
source "$RUNNER_DIR/lib/dod.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/dod-tally.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
WT="$WORK/wt"; mkdir -p "$WT"

# A fake test command per framework: prints its summary, exits as given.
mk() { # mk <name> <exit> <lines…>: the script cats its output file, then exits <exit>
  local name="$1" rc="$2"; shift 2
  printf '%s\n' "$@" > "$WT/$name.out"
  printf '#!/bin/sh\ncat "%s"\nexit %s\n' "$WT/$name.out" "$rc" > "$WT/$name.sh"
  chmod +x "$WT/$name.sh"
}
ESC="$(printf '\033')"
mk vitest 0 " RUN  v3" " Test Files  2 passed (2)" "      Tests  ${ESC}[32m40 passed${ESC}[39m (40)" "   Duration  1.2s"
mk jest 0 "PASS src/a.test.js" "Tests:       1 skipped, 41 passed, 42 total" "Snapshots:   0 total"
mk pytest 0 "collected 12 items" "============ 12 passed, 1 skipped in 0.12s ============"
mk cargo 0 "running 3 tests" "test result: ok. 3 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s"
mk gotest 1 "=== RUN   TestA" "--- PASS: TestA (0.00s)" "    --- PASS: TestA/sub (0.00s)" "--- FAIL: TestB (0.00s)" "--- SKIP: TestC (0.00s)" "FAIL"
mk quiet 0 "all good"

block() { sed -n '/^---DOD-TALLY /,/^---END-DOD-TALLY---/p' "$1"; }
run() { # run <test-cmd> <lint-cmd> <results>
  printf 'repo\t%s\t1\t0\t1\t%s\t-\t%s\n' "$WT" "$1" "$2" | gaffer_run_dod_gates "$3"
}

echo "== dod tally =="
RES="$WORK/vitest.results"; run "./vitest.sh" "true" "$RES"; RC=$?
B="$(block "$RES")"
[ "$RC" -eq 0 ] && ok "T6 a passing tests gate still passes (rc=0)" || fail "T6 rc=$RC ($(cat "$RES"))"
grep -q '^---DOD-TALLY tests@repo---$' <<<"$B" && ok "T1 the tests gate writes a tally block" \
  || fail "T1 no tally block ($(cat "$RES"))"
grep -qx 'Tests  40 passed (40)' <<<"$B" && ok "T1 the vitest summary is kept, ANSI stripped" \
  || fail "T1 expected 'Tests  40 passed (40)' in: $B"
grep -q 'Test Files' <<<"$B" && fail "T1 'Test Files' is not a test count" || ok "T1 'Test Files' left out"
[ "$(gaffer_dod_executed_count "$RES")" = "2" ] && ok "T6 the executed-gate count is unchanged (2)" \
  || fail "T6 executed count $(gaffer_dod_executed_count "$RES")"

RES="$WORK/jest.results"; run "./jest.sh" "-" "$RES"
grep -q '^Tests:       1 skipped, 41 passed, 42 total$' <<<"$(block "$RES")" && ok "T2 jest summary kept" \
  || fail "T2 jest: $(block "$RES")"
RES="$WORK/pytest.results"; run "./pytest.sh" "-" "$RES"
grep -q '12 passed, 1 skipped in 0.12s' <<<"$(block "$RES")" && ok "T2 pytest summary kept" \
  || fail "T2 pytest: $(block "$RES")"
RES="$WORK/cargo.results"; run "./cargo.sh" "-" "$RES"
grep -q '^test result: ok. 3 passed; 0 failed; 1 ignored' <<<"$(block "$RES")" && ok "T2 cargo summary kept" \
  || fail "T2 cargo: $(block "$RES")"

# node --test, for real: the runner a plain Node repo uses.
printf 'import test from "node:test";\ntest("a", () => {});\ntest("b", () => {});\n' > "$WT/n.test.mjs"
RES="$WORK/node.results"; run "node --test n.test.mjs" "-" "$RES"
NB="$(block "$RES")"
grep -qx '# tests 2' <<<"$NB" && grep -qx '# pass 2' <<<"$NB" && grep -qx '# fail 0' <<<"$NB" \
  && ok "T2 node --test counts kept" || fail "T2 node --test: $NB"
grep -q 'duration_ms' <<<"$NB" && fail "T2 node --test: duration is not a count" || ok "T2 node --test: duration left out"

RES="$WORK/go.results"; run "./gotest.sh" "-" "$RES"; RC=$?
[ "$RC" -ne 0 ] && ok "T6 a failing go test still fails the gate" || fail "T6 go rc=$RC"
grep -qx 'gotest-tally: pass=1 fail=1 skip=1' <<<"$(block "$RES")" \
  && ok "T3 go test -v top-level lines counted (subtests not)" || fail "T3 go: $(block "$RES")"
grep -q '^---DOD-OUTPUT tests@repo---' "$RES" && ok "T3 the failure block is still captured" \
  || fail "T3 no DOD-OUTPUT block on a failing gate"

RES="$WORK/quiet.results"; run "./quiet.sh" "./vitest.sh" "$RES"
[ -z "$(block "$RES")" ] && ok "T4 no summary ⇒ no tally block, and the lint gate writes none" \
  || fail "T4 unexpected block: $(block "$RES")"

RES="$WORK/ev.results"; run "./vitest.sh" "true" "$RES"
EV="$(gaffer_dod_evidence_summary "$RES" PASS)"
[ "$(sed -n 1p <<<"$EV")" = "DoD: PASS" ] && ok "T5 the evidence still opens with the verdict line" \
  || fail "T5 first line: $(sed -n 1p <<<"$EV")"
node -e 'const d=JSON.parse(process.argv[1]); if(d.dod!=="PASS"||d.gates.length!==3) process.exit(1)' \
  "$(sed -n 2p <<<"$EV")" && ok "T5 the JSON gate line still parses" || fail "T5 JSON line: $(sed -n 2p <<<"$EV")"
grep -q '^---DOD-TALLY tests@repo---$' <<<"$EV" && grep -qx 'Tests  40 passed (40)' <<<"$EV" \
  && ok "T5 the tally block rides in the evidence summary" || fail "T5 evidence: $EV"

# T7: a delivered test prints a tab-separated GATE line that also matches the pytest
# summary pattern, plus a frame-closing marker and a fake go tally.
TAB="$(printf '\t')"
mk forge 0 "      Tests  40 passed (40)" \
  "GATE${TAB}typecheck${TAB}svc${TAB}PASS${TAB}0${TAB}tsc --noEmit (1 passed in 0.1s)" \
  "---END-DOD-TALLY--- (2 passed in 0.1s)" \
  "gotest-tally: pass=99 fail=0 skip=0 (3 passed in 0.1s)"
RES="$WORK/forge.results"; run "./forge.sh" "-" "$RES"; RC=$?
[ "$RC" -eq 0 ] && ok "T7 the forging test still passes its gate" || fail "T7 rc=$RC"
FB="$(block "$RES")"
grep -q "$TAB" <<<"$FB" && fail "T7 a tab survived into the tally block: $FB" || ok "T7 no tab in the tally block"
grep -qE '^(GATE|---END-DOD-TALLY--- \(|gotest-tally:)' <<<"$FB" \
  && fail "T7 a forged line was kept: $FB" || ok "T7 GATE, --- and gotest-tally lines dropped"
grep -qx 'Tests  40 passed (40)' <<<"$FB" && ok "T7 the real summary line is still kept" \
  || fail "T7 real summary lost: $FB"
[ "$(gaffer_dod_executed_count "$RES")" = "1" ] && ok "T7 executed-gate count is 1" \
  || fail "T7 executed count $(gaffer_dod_executed_count "$RES")"
EV="$(gaffer_dod_evidence_summary "$RES" PASS)"
node -e 'const d=JSON.parse(process.argv[1]); const ok=d.gates.length===3 &&
  d.gates.filter(g=>g.status==="PASS").length===1 && d.gates.every(g=>g.gate!=="typecheck"||g.status==="SKIP");
  process.exit(ok?0:1)' "$(sed -n 2p <<<"$EV")" \
  && ok "T7 the evidence JSON has exactly 3 gates, 1 PASS" || fail "T7 evidence JSON: $(sed -n 2p <<<"$EV")"
# Defence in depth: a hand-built results file with a tabbed GATE line INSIDE a frame.
printf 'GATE\ttests\tsvc\tPASS\t0\tnpm test\n---DOD-TALLY tests@svc---\nGATE\tlint\tsvc\tPASS\t0\teslint .\n---END-DOD-TALLY---\nGATE\tlint\tsvc\tSKIP\t0\tno command configured\n' > "$WORK/framed.results"
EV="$(gaffer_dod_evidence_summary "$WORK/framed.results" PASS)"
node -e 'const d=JSON.parse(process.argv[1]); process.exit(d.gates.length===2?0:1)' "$(sed -n 2p <<<"$EV")" \
  && ok "T7 dod-evidence-summary ignores GATE rows inside a frame" || fail "T7 framed: $(sed -n 2p <<<"$EV")"
[ "$(gaffer_dod_executed_count "$WORK/framed.results")" = "1" ] && ok "T7 executed-count ignores them too" \
  || fail "T7 framed executed count $(gaffer_dod_executed_count "$WORK/framed.results")"
EV="$(_GAFFER_JSON_TOOL="$WORK/nope.mjs" gaffer_dod_evidence_summary "$WORK/framed.results" PASS)"
node -e 'const d=JSON.parse(process.argv[1]); process.exit(d.gates.length===2?0:1)' "$(sed -n 2p <<<"$EV")" \
  && ok "T7 the awk fallback ignores GATE rows inside a frame" || fail "T7 fallback: $(sed -n 2p <<<"$EV")"
SL="$(gaffer_dod_summary_line "$WORK/framed.results")"
[ "$SL" = "2 gate(s): 1 pass, 1 skip, 0 fail" ] && ok "T7 the summary line ignores them too" || fail "T7 summary line: $SL"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "dod-tally: $PASS passed"
  exit 0
fi
printf 'dod-tally: %d FAILED\n' "${#FAILURES[@]}"
exit 1
