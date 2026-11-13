#!/usr/bin/env bash
# =====================================================================
# ONE AGENT REVIEW PER DELIVERED COMMIT, AFTER THE TESTER (REVIEW_MODE=agent).
# ---------------------------------------------------------------------
# A live run (agent review, supervised, the tester lane on through a registered test
# command) paid for 22 agent reviews on 12 deliveries: each delivery was reviewed,
# then sent to the tester, then reviewed AGAIN on the next daemon pass, on the same
# commit (the tester changes no code; the "already reviewed" memory was a per-run
# skip file). One re-review raced a person's merge and was held as "reviewer
# modified the candidate". Pinned here, with real dispatch, real tick.sh, the real
# bin/tester-run.mjs and a stub agent whose own invocation log is what is counted:
#   1. a delivery goes to the tester BEFORE any reviewer runs; the tester's PASS
#      brings it back and the reviewer runs once, with the tester's PASS in its packet
#   2. a second daemon pass (a new run, an empty per-run skip file) does not review
#      the same head again
#   3. a rework (a new head) is tested and reviewed once more, exactly once
#   4. a tester FAIL sends the ticket to rework without a paid review
# The races (5, 5b, 6) are in review-once-per-head-races.test.sh and the resubmitted
# commit after CHANGES (7) in review-once-per-head-resubmit.test.sh; all three build the
# same world from lib/review-once-world.sh (one file outgrew the 600 s per-test cap).
# Run: bash runner/test/review-once-per-head.test.sh
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

echo "== 1-2. one delivery, two daemon passes =="
echo PASS > "$CTL/tester-verdict"
N="$(new_ticket "Once per head" "v stays 1")"
daemon_pass
H1="$(branch_head "$N")"
[ -n "$H1" ] && ok "setup: #$N delivered (head ${H1:0:12})" || fail "setup: #$N has no delivery head (status $(st "$N"))"
[ "$(count tester "$H1")" -ge 1 ] && ok "1: the tester ran on ${H1:0:12}" || fail "1: the tester never ran on the head: $(tr '\n' '|' < "$CALLS")"
_t="$(line_of tester "$H1")"; _r="$(line_of review "$H1")"
[ -n "$_t" ] && [ -n "$_r" ] && [ "$_t" -lt "$_r" ] \
  && ok "1: the tester ran before the reviewer" || fail "1: order tester=${_t:-never} review=${_r:-never}: $(tr '\n' '|' < "$CALLS")"
[ "$(count review "$H1")" = 1 ] && ok "1: exactly one review in the first pass" || fail "1: $(count review "$H1") reviews of ${H1:0:12} in pass 1"
P="$CTL/review-prompt-$H1"
if [ -f "$P" ] && grep -q "TESTER OUTCOME" "$P" && grep -q "PASS on this exact commit" "$P" && grep -q "stub-pass-marker" "$P"; then
  ok "1: the review packet carries the tester's PASS for this head"
else
  fail "1: the review packet lacks the tester's PASS: $(grep -o 'TESTER OUTCOME[^.]*' "$P" 2>/dev/null | head -2 | tr '\n' '|')"
fi
grep -q "tests_commit\|tests are kept on\|gaffer-tests/ticket-$N" "$P" 2>/dev/null \
  && ok "1: the packet names where the tester's tests are kept" || fail "1: the packet does not name the tester's tests"
[ "$(st "$N")" = in_review ] && ok "1: #$N waits in_review for a person (advisory)" || fail "1: #$N is $(st "$N")"
daemon_pass
[ "$(count review "$H1")" = 1 ] && ok "2: a second daemon pass does not review the same head again" \
  || fail "2: ${H1:0:12} was reviewed $(count review "$H1") times over two passes"
[ "$(count tester "$H1")" = 1 ] && ok "2: nor tests it again" || fail "2: ${H1:0:12} tested $(count tester "$H1") times"

echo "== 3. a rework (a new head) is tested and reviewed once more =="
wg review reject "$N" --reason "a person wants another line" --to ready >/dev/null 2>&1
daemon_pass
H2="$(branch_head "$N")"
[ -n "$H2" ] && [ "$H2" != "$H1" ] && ok "3: the rework is a new head (${H2:0:12})" || fail "3: no new head (H1=${H1:0:12} H2=${H2:0:12}, status $(st "$N"))"
daemon_pass
_t="$(line_of tester "$H2")"; _r="$(line_of review "$H2")"
[ -n "$_t" ] && [ -n "$_r" ] && [ "$_t" -lt "$_r" ] \
  && ok "3: the new head is tested, then reviewed" || fail "3: order tester=${_t:-never} review=${_r:-never}"
[ "$(count review "$H2")" = 1 ] && ok "3: exactly one review of the new head over two passes" || fail "3: ${H2:0:12} reviewed $(count review "$H2") times"
[ "$(count review "$H1")" = 1 ] && ok "3: the old head is not reviewed again" || fail "3: ${H1:0:12} reviewed $(count review "$H1") times"

echo "== 4. a tester FAIL gets no review =="
echo FAIL > "$CTL/tester-verdict"
M="$(new_ticket "Fails its test" "v stays 1")"
daemon_pass
HM="$(git -C "$R" for-each-ref --format='%(objectname)' "refs/heads/$(wg ticket show "$M" 2>/dev/null | jget 'd.ticket.branch_name || ""')" 2>/dev/null)"
[ "$(count tester "$HM")" -ge 1 ] && ok "4: the tester ran on #$M" || fail "4: the tester did not run on #$M: $(tr '\n' '|' < "$CALLS")"
case "$(st "$M")" in refining|ready) ok "4: the FAIL sent #$M to rework ($(st "$M"))" ;; *) fail "4: #$M is $(st "$M")" ;; esac
[ "$(count review "$HM")" = 0 ] && ok "4: no reviewer was paid for the failing head" || fail "4: ${HM:0:12} reviewed $(count review "$HM") times"
wg review reject "$M" --reason park --to cancelled >/dev/null 2>&1 || wg ticket cancel "$M" >/dev/null 2>&1 || true
echo PASS > "$CTL/tester-verdict"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "review-once-per-head: ALL $PASS checks passed"; exit 0; fi
echo "review-once-per-head: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1
