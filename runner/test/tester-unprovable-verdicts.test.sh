#!/usr/bin/env bash
# =====================================================================
# "THIS CANNOT BE PROVEN ON THIS HOST" IS A HOLD FOR A PERSON (package H3), which verdict wins.
# ---------------------------------------------------------------------
# The world of tester-unprovable.test.sh (lib/tester-unprovable-world.sh: the AUTONOMOUS
# posture, real dispatch, real tick.sh, the real bin/tester-run.mjs, a stub agent):
#   5. a tester that names every criterion: held, nothing reviewed, nothing lands
#   6. UNPROVABLE with a failing clean replay of its kept tests: FAIL (rework), not held
#   7. a FAIL whose prose mentions UNPROVABLE: FAIL wins
# Run: bash runner/test/tester-unprovable-verdicts.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
TU_NAME=tester-unprovable-verdicts
# shellcheck source=lib/tester-unprovable-world.sh
source "$HERE/lib/tester-unprovable-world.sh"

echo "== 5. a tester that names every criterion: held, nothing reviewed, nothing lands =="
B="$(new_ticket "Everything needs a browser" 2 all)"
daemon_pass
[ "$(st "$B")" = in_testing ] && [ "$(lv_field "$B" held_code)" = tester_unprovable ] && [ "$(lv_field "$B" criteria)" = "1,2" ] \
  && ok "5: held for criteria 1,2" || fail "5: #$B is $(st "$B"), lane verdict $(tester_lv "$B")"
[ "$(calls review "$B")" = 0 ] && [ "$(merged_on_main "$B")" = 0 ] && ok "5: nothing reviewed, nothing landed" || fail "5: reviews $(calls review "$B"), merged $(merged_on_main "$B")"

echo "== 6. UNPROVABLE with a failing clean replay: FAIL wins =="
C="$(new_ticket "Its kept test fails" 2 failtest)"
daemon_pass 3
_cv="$(lv_field "$C" verdict)"; _cc="$(lv_field "$C" held_code)"
[ "$_cv" = fail ] && [ -z "$_cc" ] && ok "6: the outcome is a FAIL, not a hold" || fail "6: tester lane verdict on #$C: $(tester_lv "$C")"
[ "$(calls deliver "$C")" -ge 2 ] && ok "6: sent to rework (delivered again)" || fail "6: #$C was not reworked ($(calls deliver "$C") deliveries, $(st "$C"))"
[ "$(calls review "$C")" = 0 ] && ok "6: no review paid" || fail "6: $(calls review "$C") reviews"
wg ticket cancel "$C" >/dev/null 2>&1 || wg wont-do "$C" --reason done >/dev/null 2>&1 || true

echo "== 7. a FAIL whose prose mentions UNPROVABLE: FAIL wins =="
D="$(new_ticket "A failing criterion" 2 failprose)"
daemon_pass 3
[ "$(lv_field "$D" verdict)" = fail ] && [ -z "$(lv_field "$D" held_code)" ] && ok "7: recorded as FAIL" || fail "7: lane verdict on #$D: $(tester_lv "$D")"
[ "$(calls deliver "$D")" -ge 2 ] && ok "7: sent to rework (delivered again)" || fail "7: #$D was not reworked ($(calls deliver "$D") deliveries)"
wg ticket cancel "$D" >/dev/null 2>&1 || wg wont-do "$D" --reason done >/dev/null 2>&1 || true

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "tester-unprovable-verdicts: ALL $PASS checks passed"; exit 0; fi
echo "tester-unprovable-verdicts: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1
