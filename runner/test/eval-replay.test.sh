#!/usr/bin/env bash
# =====================================================================
# GOLDEN GATE FIXTURES — runner/eval/replay.sh replays recorded deliveries through
# the REAL gate pipeline (hygiene · minimalism · DoD · acceptance checks) and
# compares every verdict to the fixture's expectation.
#   1  the committed fixture set passes (rc 0, results.json ok, ≥ 10 fixtures);
#   2  results.json carries per-fixture expected/actual/gate rows (the CI artifact);
#   3  EXPECTATION DRIFT is caught: a fixture whose expected outcome is edited to
#      the wrong value fails the run (rc 1) and is named with the diff;
#   4  a GATE REGRESSION is caught: with the hygiene forbidden-path list emptied
#      (the gate no longer sees node_modules), the leak fixture flips to `submit`
#      and the run fails — the harness pins the gates, not just the file format;
#   5  --only limits the run to one fixture; an unknown name is a harness error (2);
#   6  a fixture whose patch does not apply is reported as a replay error, not a verdict.
# Run: bash runner/test/eval-replay.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
REPLAY="$RUNNER_DIR/eval/replay.sh"
for b in node git perl python3; do command -v "$b" >/dev/null 2>&1 || { echo "SKIP: $b not available"; exit 0; }; done

P=0; F=0
ok(){ P=$((P + 1)); printf '  ok   %s\n' "$1"; }
no(){ F=$((F + 1)); printf '  FAIL %s\n' "$1"; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/eval-replay-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
jq_(){ node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=eval("r."+process.argv[2]);process.stdout.write(v===undefined?"":typeof v==="string"?v:JSON.stringify(v))' "$1" "$2"; }

echo "== 1/2: the committed fixtures pass and results.json is written =="
out="$(bash "$REPLAY" --out "$WORK/run1" 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "replay exits 0 on the committed fixtures" || no "replay rc=$rc: $out"
R="$WORK/run1/results.json"
[ -f "$R" ] && ok "results.json written" || no "results.json missing"
[ "$(jq_ "$R" ok)" = "true" ] && ok "results.ok is true" || no "results.ok: $(jq_ "$R" ok)"
n="$(jq_ "$R" fixtures)"; [ "${n:-0}" -ge 10 ] && ok "$n fixtures replayed" || no "expected ≥ 10 fixtures, got $n"
[ "$(jq_ "$R" "results.find(f=>f.name==='clean-feature').actual.outcome")" = "submit" ] && ok "clean-feature → submit" || no "clean-feature outcome wrong"
[ "$(jq_ "$R" "results.find(f=>f.name==='breaks-tests').actual.dod_failed[0]")" = "tests" ] && ok "breaks-tests names the failing gate (tests)" || no "breaks-tests dod_failed wrong"
[ "$(jq_ "$R" "results.find(f=>f.name==='leaks-node-modules').actual.hygiene")" = "violation" ] && ok "leaks-node-modules → hygiene violation" || no "leak not caught"
rows="$(jq_ "$R" "results.find(f=>f.name==='clean-feature').gate_rows.length")"; [ "${rows:-0}" -ge 3 ] && ok "gate rows recorded per fixture ($rows for clean-feature)" || no "gate rows missing"
grep -q 'ac check-result ac-1 --ticket 1 --exit 1' "$WORK/run1/ac-check-fails/wg-calls.log" 2>/dev/null \
  && ok "the failing acceptance check was recorded through the wg check-result path" || no "wg check-result record missing"
printf '%s\n' "$out" | grep -q "PASS: $n/$n fixtures" && ok "human summary line printed" || no "summary line missing: $(printf '%s\n' "$out" | tail -1)"

echo "== 3: expectation drift is caught =="
cp -R "$RUNNER_DIR/eval/fixtures" "$WORK/fx-drift"
node -e '
  const fs=require("fs"), p=process.argv[1]; const j=JSON.parse(fs.readFileSync(p,"utf8"));
  j.expected.outcome="submit"; j.expected.dod="PASS"; fs.writeFileSync(p, JSON.stringify(j,null,2));
' "$WORK/fx-drift/breaks-tests/fixture.json"
out="$(bash "$REPLAY" --fixtures "$WORK/fx-drift" --out "$WORK/run-drift" 2>&1)"; rc=$?
[ "$rc" = 1 ] && ok "edited expectation → rc 1" || no "expected rc 1, got $rc"
printf '%s\n' "$out" | grep -q 'FAIL breaks-tests' && ok "the drifted fixture is named" || no "drifted fixture not named: $out"
printf '%s\n' "$out" | grep -q 'outcome: expected "submit", got "rework:definition-of-done"' && ok "the mismatch names expected vs actual" || no "mismatch detail missing"
[ "$(jq_ "$WORK/run-drift/results.json" mismatched)" = "1" ] && ok "results.json counts one mismatch" || no "mismatched count wrong"

echo "== 4: a gate regression is caught =="
# Simulate hygiene losing its node_modules rule: the leak fixture would now submit.
out="$(HYGIENE_FORBIDDEN_PATHS='.crew-never-matches-anything' bash "$REPLAY" --only leaks-node-modules --out "$WORK/run-regress" 2>&1)"; rc=$?
[ "$rc" = 1 ] && ok "weakened hygiene gate → rc 1" || no "expected rc 1 with a weakened gate, got $rc: $out"
printf '%s\n' "$out" | grep -q 'hygiene: expected "violation", got "ok"' && ok "the regression is reported as a hygiene verdict flip" || no "regression detail missing: $out"

echo "== 5: --only and harness errors =="
out="$(bash "$REPLAY" --only clean-feature --out "$WORK/run-only" 2>&1)"; rc=$?
[ "$rc" = 0 ] && [ "$(jq_ "$WORK/run-only/results.json" fixtures)" = "1" ] && ok "--only runs exactly one fixture" || no "--only wrong (rc=$rc)"
bash "$REPLAY" --only does-not-exist --out "$WORK/run-none" >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && ok "unknown --only name is a harness error (2)" || no "expected rc 2, got $rc"
bash "$REPLAY" --fixtures "$WORK/nope" >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && ok "missing fixtures dir is a harness error (2)" || no "expected rc 2, got $rc"

echo "== 6: a broken patch is a replay error, not a verdict =="
cp -R "$RUNNER_DIR/eval/fixtures" "$WORK/fx-broken"
printf 'diff --git a/nope.js b/nope.js\n--- a/nope.js\n+++ b/nope.js\n@@ -1 +1 @@\n-x\n+y\n' > "$WORK/fx-broken/clean-feature/delivery.patch"
out="$(bash "$REPLAY" --fixtures "$WORK/fx-broken" --only clean-feature --out "$WORK/run-broken" 2>&1)"; rc=$?
[ "$rc" = 1 ] && ok "unapplicable patch fails the run" || no "expected rc 1, got $rc"
printf '%s\n' "$out" | grep -q 'delivery patch does not apply' && ok "the error names the patch" || no "patch error not named: $out"

echo; echo "passed $P, failed $F"
[ "$F" -eq 0 ]
