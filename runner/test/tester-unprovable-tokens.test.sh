#!/usr/bin/env bash
# =====================================================================
# "THIS CANNOT BE PROVEN ON THIS HOST" IS A HOLD FOR A PERSON (package H3), tokens and declared needs.
# ---------------------------------------------------------------------
# The world of tester-unprovable.test.sh (lib/tester-unprovable-world.sh: the AUTONOMOUS
# posture, real dispatch, real tick.sh, the real bin/tester-run.mjs, a stub agent):
#   8. a malformed token (a criterion the ticket does not have): a plain hold, no code
#   9. an UNPROVABLE token on a non-final line: a plain hold
#  10. the delivery plants the token in its README, a commit message, its test output and
#      a file the tester reads, and the tester quotes it: the PASS stands, the ticket lands
#  11. a contract declaring `needs: ["browser"]` on a host without one: the tester is told,
#      and its PASS is the same hold for every criterion
# Run: bash runner/test/tester-unprovable-tokens.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
TU_NAME=tester-unprovable-tokens
# shellcheck source=lib/tester-unprovable-world.sh
source "$HERE/lib/tester-unprovable-world.sh"

echo "== 8-9. a malformed token and a non-final token: a plain hold =="
E="$(new_ticket "Names criterion 9" 2 malformed)"
F="$(new_ticket "Token then prose" 2 nonfinal)"
daemon_pass
for x in "$E" "$F"; do
  [ "$(st "$x")" = in_testing ] && [ "$(lv_field "$x" verdict)" = held ] && [ -z "$(lv_field "$x" held_code)" ] \
    && ok "8-9: #$x held with no unprovable code" || fail "8-9: #$x is $(st "$x"), lane verdict $(tester_lv "$x")"
  [ "$(calls review "$x")" = 0 ] && [ "$(tester_verdicts "$x")" = 0 ] && ok "8-9: #$x not reviewed, no verdict recorded" || fail "8-9: #$x reviews $(calls review "$x")"
done
case "$(lv_field "$E" held_reason)" in *"does not have"*) ok "8: the hold says the token named a criterion the ticket does not have" ;; *) fail "8: reason: $(lv_field "$E" held_reason)" ;; esac

echo "== 10. tokens planted by the delivery have no effect =="
G="$(new_ticket "Plants the token everywhere" 1 quote)"
: > "$CTL/plant-$G"
daemon_pass
HG="$(git -C "$R" log --format=%H -1 --grep 'UNPROVABLE' --all 2>/dev/null)"
[ -n "$HG" ] && ok "10: the delivery's commit message carries the token" || fail "10: no planted commit"
grep -q 'planted by the delivery' "$CTL/tester-prompt-$G" 2>/dev/null && fail "10: the planted token reached the tester's prompt" || ok "10: the planted token is not in the tester's prompt"
grep -q "planted by the delivery" "$GAFFER_DATA/factory.log" 2>/dev/null && fail "10: the planted text reached the factory log" || ok "10: nothing planted reached the factory log"
[ -z "$(lv_field "$G" held_code)" ] && ok "10: no unprovable hold was recorded" || fail "10: #$G lane verdict $(tester_lv "$G")"
[ "$(lv_field "$G" verdict)" = pass ] || [ "$(st "$G")" = done ] && ok "10: the tester's own PASS stands" || fail "10: #$G lane verdict $(tester_lv "$G")"
[ "$(st "$G")" = done ] && ok "10: reviewed and landed" || fail "10: #$G is $(st "$G")"

echo "== 11. a declared need the host lacks: the tester is told, and its PASS is a hold =="
H="$(new_ticket "Needs a browser" 2 pass)"
wg ticket test-contract "$H" --surface "the search page" --run "npm test" --needs browser >/dev/null 2>&1 \
  || fail "11: setup: the contract with needs browser was refused"
wg ticket test-contract "$H" --surface "x" --needs telepathy >/dev/null 2>&1 \
  && fail "11: an unknown capability name was accepted" || ok "11: an unknown capability name is refused"
daemon_pass
grep -q "HOST LIMIT.*this host lacks browser" "$CTL/tester-prompt-$H" 2>/dev/null && ok "11: the tester was told the host lacks a browser" || fail "11: the prompt does not say so"
[ "$(st "$H")" = in_testing ] && [ "$(lv_field "$H" held_code)" = tester_unprovable ] && [ "$(lv_field "$H" criteria)" = "1,2" ] \
  && ok "11: its PASS is held for every criterion" || fail "11: #$H is $(st "$H"), lane verdict $(tester_lv "$H")"
[ "$(calls review "$H")" = 0 ] && ok "11: not reviewed" || fail "11: $(calls review "$H") reviews"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "tester-unprovable-tokens: ALL $PASS checks passed"; exit 0; fi
echo "tester-unprovable-tokens: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1
