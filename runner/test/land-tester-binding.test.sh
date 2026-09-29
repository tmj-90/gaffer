#!/usr/bin/env bash
# =====================================================================
# ACCEPTANCE GATE — the landing refuses code the tester did not run.
# _gaffer_land_tester_binding (lib/land.sh) reads the latest tester PASS evidence's
# tested_commit from the ticket JSON and compares it with the branch head:
#   1. no PASS binding recorded (a human verdict, an older ticket) → land (rc 0)
#   2. head == tested commit → land (rc 0); a short/abbreviated sha also matches
#   3. head moved past the tested commit → HELD (rc 1), _TB_* name both commits
#   4. WIRING: gaffer_land_delivery calls it first and returns 4 on a mismatch
# Run: bash runner/test/land-tester-binding.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/land-binding.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
jget() { node "$RUNNER_DIR/lib/json-tool.mjs" expr "$1"; }
log() { :; }
# Extract the REAL helper from land.sh (same idiom as bootstrap-park-visible.test.sh).
awk '$0 ~ /^_gaffer_land_tester_binding\(\) \{/ {p=1} p {print} p && /^\}/ {exit}' "$RUNNER_DIR/lib/land.sh" > "$WORK/fn.sh"
grep -q '^_gaffer_land_tester_binding() {' "$WORK/fn.sh" || { echo "FAIL: could not extract _gaffer_land_tester_binding"; exit 1; }
# shellcheck disable=SC1090
source "$WORK/fn.sh"

R="$WORK/repo"; git init -q -b main "$R"; git -C "$R" -c user.email=t@t -c user.name=t commit -q --allow-empty -m base
git -C "$R" checkout -q -b gaffer/ticket-9-x; git -C "$R" -c user.email=t@t -c user.name=t commit -q --allow-empty -m deliver
TESTED="$(git -C "$R" rev-parse gaffer/ticket-9-x)"
show_with() { printf '{"ticket":{"number":9},"evidence":[{"evidence_type":"test_output","created_at":"2026-01-01T00:00:00Z","payload_json":"{\\"verdict\\":\\"fail\\",\\"tested_commit\\":\\"deadbeefdeadbeef\\"}"},{"evidence_type":"test_output","created_at":"2026-01-02T00:00:00Z","payload_json":"{\\"verdict\\":\\"pass\\"%s}"}]}' "$1"; }

echo "== 1: no binding recorded → land =="
_gaffer_land_tester_binding 9 "$R" gaffer/ticket-9-x "$(show_with '')" && ok "PASS without tested_commit → rc 0" || fail "unbound PASS held"
_gaffer_land_tester_binding 9 "$R" gaffer/ticket-9-x '{"ticket":{"number":9},"evidence":[]}' && ok "no evidence at all → rc 0" || fail "no-evidence held"
_gaffer_land_tester_binding 9 "$R" gaffer/ticket-9-x '' && ok "empty show JSON → rc 0" || fail "empty show held"

echo "== 2: head is the tested commit → land =="
_gaffer_land_tester_binding 9 "$R" gaffer/ticket-9-x "$(show_with ",\\\"tested_commit\\\":\\\"$TESTED\\\"")" && ok "full sha matches → rc 0" || fail "matching sha held"
_gaffer_land_tester_binding 9 "$R" gaffer/ticket-9-x "$(show_with ",\\\"tested_commit\\\":\\\"${TESTED:0:12}\\\"")" && ok "abbreviated sha matches → rc 0" || fail "abbreviated sha held"
[ "$_TB_TESTED" = "${TESTED:0:12}" ] && ok "_TB_TESTED read from the LATEST pass evidence (not the earlier fail)" || fail "_TB_TESTED=$_TB_TESTED"

echo "== 3: the branch moved after the PASS → held =="
git -C "$R" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "sneaked in after the tester"
if _gaffer_land_tester_binding 9 "$R" gaffer/ticket-9-x "$(show_with ",\\\"tested_commit\\\":\\\"$TESTED\\\"")"; then fail "moved branch landed"; else ok "moved branch → rc 1 (held)"; fi
[ "$_TB_TESTED" = "$TESTED" ] && [ "$_TB_HEAD" = "$(git -C "$R" rev-parse gaffer/ticket-9-x)" ] && ok "_TB_TESTED / _TB_HEAD name both commits for the log line" || fail "_TB vars wrong"

echo "== 4: WIRING =="
L="$RUNNER_DIR/lib/land.sh"
B="$(grep -n '_gaffer_land_tester_binding "\$RNUM" "\$RREPO" "\$RBRANCH" "\$RSHOW"' "$L" | head -1 | cut -d: -f1)"
M="$(grep -n 'merge-base "\$RBRANCH" "\$RDEFAULT"' "$L" | head -1 | cut -d: -f1)"
[ -n "$B" ] && [ -n "$M" ] && [ "$B" -lt "$M" ] && ok "gaffer_land_delivery checks the binding BEFORE any merge work" || fail "binding check not before the merge ($B vs $M)"
grep -q 'moved since the tester.s PASS' "$L" && grep -A1 'moved since the tester' "$L" | grep -q 'return 4' && ok "a mismatch logs the two commits and returns 4 (held for a human)" || fail "mismatch does not hold with rc 4"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "land-tester-binding: ALL $PASS checks passed"; exit 0; fi
echo "land-tester-binding: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1
