#!/usr/bin/env bash
# =====================================================================
# MERGE LANE — a ticket that reaches ready_for_merge by any route lands autonomously.
# ---------------------------------------------------------------------
# The agent review pass merged only what IT approved. A ticket a HUMAN approved (the
# dashboard, `wg review approve`) or the independent TESTER passed reached
# ready_for_merge and then waited for the dashboard's Merge button — in autonomous mode
# too. A live run stalled that way with nine dependents starving behind a human-approved
# bootstrap. lib/merge-lane.sh runs at the start of every tick and lands every
# ready_for_merge ticket the merge policy permits, through the SAME gaffer_land_delivery
# the review pass uses. Proven against the REAL dispatch + tick.sh with a stub agent:
#   A  autonomous (merge env floor on): human-approved ticket → merged into main, done,
#      branch deleted, and its DEPENDENT is delivered in the SAME tick;
#   B  supervised (merge floor off, no policy): held for a human, logged ONCE per run,
#      the second tick stays silent (skip file), loop.sh resets the skip file;
#   C  GAFFER_MERGE_LANE=0 disables the lane (nothing merged, nothing logged);
#   D  wiring: tick.sh sources lib/land.sh + lib/merge-lane.sh and runs the lane before
#      the candidate scan; review.sh lands through the shared function;
#   (E-G, a merge conflict and its resolver, the second conflict, AUTO_MERGE alone on a
#   human approval: merge-lane-conflict.test.sh, on its own copy of the same world)
# Run: bash runner/test/merge-lane.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
# shellcheck source=lib/merge-lane-world.sh
source "$HERE/lib/merge-lane-world.sh"

echo "== A. autonomous: a HUMAN-approved ticket lands at the start of the next tick; its dependent delivers in the same tick =="
A="$(new_ticket "Landed helper" "deliver a helper")"; wg ticket ready "$A" >/dev/null 2>&1
DEP="$(new_ticket "Dependent helper" "deliver a helper after #$A")"; wg ticket dep add "$DEP" "$A" >/dev/null 2>&1; wg ticket ready "$DEP" >/dev/null 2>&1
AUTO_MERGE=0 run_tick >/dev/null
[ "$(st "$A")" = "in_review" ] && ok "A: #$A delivered → in_review" || fail "A: status=$(st "$A")"
AUTO_MERGE=0 run_tick >/dev/null
[ "$(st "$DEP")" = "ready" ] && ok "A: dependent #$DEP is NOT deliverable while #$A is unmerged (the edge is real)" || fail "A: dependent status=$(st "$DEP") before the merge — the dependency edge did not hold"
BA="$(branch_of "$A")"; [ -n "$BA" ] && ok "A: delivery branch recorded ($BA)" || fail "A: no branch_name recorded"
wg review approve "$A" $(approve_heads "$A") --reviewer human1 >/dev/null 2>&1
[ "$(st "$A")" = "ready_for_merge" ] && ok "A: human approve → ready_for_merge (nobody has merged yet)" || fail "A: after approve status=$(st "$A")"
MAIN0="$(git -C "$R" rev-parse main)"
OUT="$(GAFFER_MODE=autonomous AUTO_MERGE=1 DISPATCH_ALLOW_AGENT_APPROVE=1 MERGE_ON_AGENT_REVIEW=1 run_tick)"
[ "$(st "$A")" = "done" ] && ok "A: merge lane landed #$A → done" || fail "A: after tick status=$(st "$A") ($OUT)"
_MLOG="$(git -C "$R" log --oneline main)"   # string match, not `| grep -q`: under pipefail grep's early exit can SIGPIPE git (seen on macOS CI)
if [ "$(git -C "$R" rev-parse main)" != "$MAIN0" ] && [[ "$_MLOG" == *"helper$A"* ]]; then ok "A: main now carries the helper commit"; else fail "A: main did not gain the helper commit (main $(git -C "$R" rev-parse --short main) vs before $(printf '%s' "$MAIN0" | cut -c1-7); log: $(git -C "$R" log --oneline -3 main | tr '\n' '|'); stub commits: $(grep -l . "$CALLS"/*/kind 2>/dev/null | xargs -I{} cat {} 2>/dev/null | tr '\n' ','))"; fi
git -C "$R" rev-parse --verify -q "refs/heads/$BA" >/dev/null 2>&1 && fail "A: merged branch $BA still exists" || ok "A: merged branch deleted"
grep -q "MERGE: #$A ready_for_merge + merge gate earned → landing $BA → main" "$LOGF" && ok "A: lane logged the landing" || fail "A: no landing log line"
grep -q "MERGE: #$A merged ($BA → main, via local) and marked done" "$LOGF" && ok "A: shared landing logged under the MERGE prefix" || fail "A: no MERGE-prefixed merged line: $(grep "#$A" "$LOGF" | tail -3 | tr '\n' '|' | cut -c1-300)"
# autonomous turns auto-push on; the fixture repo has no origin. That is "nothing to push",
# never a rejected push (seen live: every merge of a greenfield run logged a failed push).
grep -q "MERGE: main merged locally — no origin remote, nothing to push" "$LOGF" && ok "A: no-origin repo logs 'nothing to push' (not a failed push)" || fail "A: no-origin push line missing or wrong: $(grep -i 'push' "$LOGF" | tail -2 | tr '\n' '|' | cut -c1-300)"
[ "$(st "$DEP")" = "in_review" ] && ok "A: dependent #$DEP was unblocked AND delivered in the SAME tick (lane runs before the scan)" || fail "A: dependent status=$(st "$DEP") — expected in_review"
grep -q '^TICK_RESULT=worked$' <<<"$OUT" && ok "A: the tick still reports its delivery (lane never exits the tick)" || fail "A: tick result $OUT"
# PROVENANCE TRAILERS (lib/provenance-trailers.mjs): the merge commit names the ticket,
# the approving actor and the gate verdicts — read from the DB, no model name.
_AMSG="$(git -C "$R" log -1 --format=%B main)"
[[ "$_AMSG" == *"Gaffer-Ticket: #$A"* ]] && ok "A: the merge commit carries Gaffer-Ticket: #$A" || fail "A: no ticket trailer: $(printf '%s' "$_AMSG" | tr '\n' '|')"
[[ "$_AMSG" == *"Gaffer-Reviewed-By: human:human1"* ]] && ok "A: …and the approving human (Gaffer-Reviewed-By: human:human1)" || fail "A: reviewer trailer: $(printf '%s' "$_AMSG" | tr '\n' '|')"
# (the stub records no AC evidence, so the honest count is 0 of 1)
[[ "$_AMSG" == *"Gaffer-Gates: DoD PASS (tests pass, typecheck skip, lint pass, integrity pass); AC 0/1 satisfied"* ]] && ok "A: …and the gate verdicts (DoD per gate, the AC count)" || fail "A: gates trailer: $(printf '%s' "$_AMSG" | tr '\n' '|')"
_ATR="$(git -C "$R" log -1 --format='%(trailers:key=Gaffer-Ticket,valueonly)' main | tr -d '[:space:]')"
[ "$_ATR" = "#$A" ] && ok "A: git reads them as trailers (%(trailers))" || fail "A: git trailer parse gave '$_ATR'"
[ "$(git -C "$R" rev-list --parents -n 1 main | wc -w | tr -d ' ')" = 3 ] && ok "A: a real merge commit carries them (--no-ff)" || fail "A: main HEAD is not a merge commit"

echo "== B. supervised: the merge gate holds; logged once per run; loop.sh resets the skip file =="
B="$(new_ticket "Held helper" "deliver a helper")"; wg ticket ready "$B" >/dev/null 2>&1
AUTO_MERGE=0 run_tick >/dev/null; wg review approve "$B" $(approve_heads "$B") --reviewer human1 >/dev/null 2>&1
[ "$(st "$B")" = "ready_for_merge" ] && ok "B: #$B human-approved → ready_for_merge" || fail "B: status=$(st "$B")"
AUTO_MERGE=0 GAFFER_MODE=supervised run_tick >/dev/null
[ "$(st "$B")" = "ready_for_merge" ] && ok "B: supervised → NOT merged (held for a human)" || fail "B: status=$(st "$B")"
N1="$(grep -c "MERGE: #$B approved but auto-merge NOT permitted by policy" "$LOGF")"
[ "$N1" = "1" ] && ok "B: the hold is logged once" || fail "B: hold logged $N1 times"
AUTO_MERGE=0 GAFFER_MODE=supervised run_tick >/dev/null
N2="$(grep -c "MERGE: #$B approved but auto-merge NOT permitted by policy" "$LOGF")"
[ "$N2" = "1" ] && ok "B: a second tick in the same run stays silent (skip file)" || fail "B: hold logged $N2 times after the second tick"
grep -qx "$B" "$GAFFER_DATA/.merge-held-tickets" && ok "B: #$B recorded in .merge-held-tickets" || fail "B: skip file lacks #$B"
grep -qF '${GAFFER_RUN_STATE_DIR:-$GAFFER_DATA}/.merge-held-tickets' "$RUNNER_DIR/lib/merge-lane.sh" && grep -q 'gaffer_run_state_begin loop' "$RUNNER_DIR/loop.sh" && grep -q 'gaffer_run_state_begin poll' "$RUNNER_DIR/bin/poll-once.sh" \
  && ok "B: .merge-held-tickets lives in the run's own fresh state dir" || fail "B: the merge-held list is not per run"
# The hold lasts for the RUN (like .reviewed-tickets): the next run (a fresh run-state
# dir, empty) re-asks the policy, and with the merge floor on the held ticket lands.
rm -f "$GAFFER_DATA/.merge-held-tickets"
GAFFER_PROVENANCE_TRAILERS=0 GAFFER_MODE=autonomous AUTO_MERGE=1 DISPATCH_ALLOW_AGENT_APPROVE=1 MERGE_ON_AGENT_REVIEW=1 run_tick >/dev/null
[ "$(st "$B")" = "done" ] && ok "B: next run with the merge floor on → the held ticket lands" || fail "B: status=$(st "$B") after floor on"
_BMSG="$(git -C "$R" log -1 --format=%B main)"
[[ "$_BMSG" != *"Gaffer-"* ]] && ok "B: GAFFER_PROVENANCE_TRAILERS=0 → no trailers on the landing" || fail "B: trailers written with the switch off: $(printf '%s' "$_BMSG" | tr '\n' '|')"

echo "== C. GAFFER_MERGE_LANE=0 disables the lane =="
C="$(new_ticket "Lane-off helper" "deliver a helper")"; wg ticket ready "$C" >/dev/null 2>&1
AUTO_MERGE=0 run_tick >/dev/null; wg review approve "$C" $(approve_heads "$C") --reviewer human1 >/dev/null 2>&1
GAFFER_MERGE_LANE=0 GAFFER_MODE=autonomous AUTO_MERGE=1 DISPATCH_ALLOW_AGENT_APPROVE=1 MERGE_ON_AGENT_REVIEW=1 run_tick >/dev/null
[ "$(st "$C")" = "ready_for_merge" ] && ok "C: lane off → #$C stays ready_for_merge" || fail "C: status=$(st "$C")"
grep -q "MERGE: #$C" "$LOGF" && fail "C: lane logged with the switch off" || ok "C: lane silent with the switch off"

echo "== D. wiring =="
grep -q 'source "$HERE/lib/land.sh"' "$RUNNER_DIR/tick.sh" && grep -q 'source "$HERE/lib/merge-lane.sh"' "$RUNNER_DIR/tick.sh" && ok "D: tick.sh sources lib/land.sh + lib/merge-lane.sh" || fail "D: tick.sh does not source the lane libs"
grep -q 'gaffer_land_delivery "$RNUM" "$RREPO" "$RBRANCH" "$RDEFAULT" "$RSHOW" AFK' "$RUNNER_DIR/lib/review.sh" && ok "D: the review pass lands through the shared gaffer_land_delivery" || fail "D: review.sh does not use gaffer_land_delivery"
_lane_line="$(grep -n '_gaffer_merge_lane$' "$RUNNER_DIR/tick.sh" | head -1 | cut -d: -f1)"; _scan_line="$(grep -n 'ready-candidate scan\|How many tickets are claimable' "$RUNNER_DIR/tick.sh" | head -1 | cut -d: -f1)"
[ -n "$_lane_line" ] && [ -n "$_scan_line" ] && [ "$_lane_line" -lt "$_scan_line" ] && ok "D: the lane runs before the candidate scan (line $_lane_line < $_scan_line)" || fail "D: lane not before the scan ($_lane_line vs $_scan_line)"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "merge-lane: PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
