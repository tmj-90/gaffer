#!/usr/bin/env bash
# =====================================================================
# ONE AGENT REVIEW PER DELIVERED COMMIT: A RESUBMITTED COMMIT (REVIEW_MODE=agent).
# ---------------------------------------------------------------------
# Split off review-once-per-head.test.sh (1-4) and review-once-per-head-races.test.sh
# (5, 5b, 6) when the one file outgrew the 600 s per-test cap on a slow macOS runner. Same
# world (lib/review-once-world.sh): real dispatch, real tick.sh, the real
# bin/tester-run.mjs and a stub agent whose own invocation log is what is counted:
#   7. a rework that resubmits the commit the reviewer asked changes on is not reviewed
#      again and not stranded: with the approve gate earned (AFK) the runner sends it back
#      to rework on the recorded verdict; supervised, a note on the ticket says it waits
#      for a person
# Run: bash runner/test/review-once-per-head-resubmit.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
for f in packages/dispatch/dist/cli/index.js packages/memory/dist/bin/memory.js packages/crew/dist/cli/index.js; do
  [ -f "$ROOT/$f" ] || { echo "SKIP: $f not built (run pnpm -r build)"; exit 0; }
done
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

# shellcheck source=lib/review-once-world.sh
. "$HERE/lib/review-once-world.sh"

echo "== 7. a rework that resubmits the same commit after CHANGES is not reviewed again, nor stranded =="
echo CHANGES > "$CTL/review-verdict"
# 7a. AFK: the approve gate is earned (the env floor), so a CHANGES verdict reworks.
# The stub's first delivery commits; with $CTL/no-commit every rework after it commits nothing.
export DISPATCH_ALLOW_AGENT_APPROVE=1
: > "$CTL/no-commit"
A="$(new_ticket "Changes then the same commit (AFK)" "v stays 1")"
daemon_pass
HA="$(branch_head "$A")"
[ -n "$HA" ] && [ "$(count review "$HA")" = 1 ] && ok "7a: #$A delivered, tested and reviewed once (CHANGES) at ${HA:0:12}" \
  || fail "7a: setup: #$A head ${HA:-none}, $(count review "$HA") reviews, status $(st "$A")"
grep -q "AFK: #$A → CHANGES; re-queued to ready" "$GAFFER_DATA/factory.log" && ok "7a: the CHANGES verdict sent #$A to rework" || fail "7a: no AFK rework line for #$A"
grep -q "^deliver $HA\$" "$CALLS" && ok "7a: the head is the first delivery's commit (${HA:0:12}); the rework added none" || fail "7a: ${HA:0:12} is not the first delivery's commit"
grep -q "^deliver-nocommit $HA\$" "$CALLS" && ok "7a: the rework ran and committed nothing" || fail "7a: no no-commit rework recorded: $(tail -4 "$CALLS" | tr '\n' '|')"
[ "$(count review "$HA")" = 1 ] && ok "7a: the same commit is not reviewed a second time" || fail "7a: ${HA:0:12} reviewed $(count review "$HA") times"
grep -q "AFK: #$A came back into review on ${HA:0:12} with no new commit after the reviewer's CHANGES" "$GAFFER_DATA/factory.log" \
  && ok "7a: the runner sent it back to rework on the recorded verdict" || fail "7a: no re-queue on the recorded verdict: $(grep "#$A" "$GAFFER_DATA/factory.log" | tail -3 | tr '\n' '|')"
case "$(st "$A")" in in_review) fail "7a: #$A sits in_review with nobody told" ;; *) ok "7a: #$A is not left in review ($(st "$A"))" ;; esac
# A rework that keeps resubmitting the same commit is parked by the retry cap (dispatch's
# reject cap, 3 by default), still with that one review.
daemon_pass
case "$(st "$A")" in blocked|refining) ok "7a: the retry cap parked #$A ($(st "$A")) after the same commit came back again" ;; *) fail "7a: #$A is $(st "$A") after another resubmit of the same commit" ;; esac
[ "$(count review "$HA")" = 1 ] && ok "7a: still one review of ${HA:0:12}" || fail "7a: ${HA:0:12} reviewed $(count review "$HA") times"
unset DISPATCH_ALLOW_AGENT_APPROVE
rm -f "$CTL/no-commit"
wg ticket cancel "$A" >/dev/null 2>&1 || wg wont-do "$A" --reason done >/dev/null 2>&1 || true
# 7b. Supervised: the CHANGES verdict is advisory; a person sends it back; the rework
# resubmits the same commit; a note says the commit waits for a person.
: > "$CTL/no-commit"
B="$(new_ticket "Changes then the same commit (supervised)" "v stays 1")"
daemon_pass
HB="$(branch_head "$B")"
[ -n "$HB" ] && [ "$(count review "$HB")" = 1 ] && [ "$(st "$B")" = in_review ] && ok "7b: #$B reviewed once (advisory CHANGES), in review for a person" \
  || fail "7b: setup: #$B head ${HB:-none}, $(count review "$HB") reviews, status $(st "$B")"
wg review reject "$B" --reason "do what the reviewer said" --to ready >/dev/null 2>&1
daemon_pass
daemon_pass
[ "$(branch_head "$B")" = "$HB" ] && [ "$(st "$B")" = in_review ] && ok "7b: the rework resubmitted the same commit; #$B in review" || fail "7b: head $(branch_head "$B") status $(st "$B")"
[ "$(count review "$HB")" = 1 ] && ok "7b: the same commit is not reviewed a second time" || fail "7b: ${HB:0:12} reviewed $(count review "$HB") times"
_NB="$(wg ticket show "$B" 2>/dev/null | grep -o "agent review: back in review on $HB" | wc -l | tr -d ' ')"
[ "$_NB" -ge 1 ] && ok "7b: the ticket says the commit waits for a person" || fail "7b: no back-in-review note on #$B"
wg ticket show "$B" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);const n=(v.evidence||[]).filter(e=>/^agent review: back in review on /.test(e.summary||"")).length;process.exit(n===1?0:1)})' \
  && ok "7b: said once over two passes" || fail "7b: the note was written more than once"
rm -f "$CTL/no-commit" "$CTL/review-verdict"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "review-once-per-head-resubmit: ALL $PASS checks passed"; exit 0; fi
echo "review-once-per-head-resubmit: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1
