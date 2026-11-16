#!/usr/bin/env bash
# =====================================================================
# WASTE CONTROLS — a capped, timed-out or reworked delivery never starts from scratch.
# ---------------------------------------------------------------------
# Three loss paths a hard budget made expensive, driven through the REAL tick.sh with a
# stub agent (real dispatch, real git):
#   A. TURN CAP before the agent's first commit: the runner now commits a WIP checkpoint
#      of the uncommitted work and PAUSES in place (paused, reason cap_hit, worktree +
#      branch kept). Before: no commit → no pause → the attempt was burned and the retry
#      started over.
#   B. WALL-CLOCK TIMEOUT (rc 124) mid-delivery: pause-eligible like a cap (reason
#      `timeout`), work checkpointed. Before: a plain failure.
#   C. REWORK after review CHANGES: the next attempt re-enters on the EXISTING branch with
#      the previous commits kept (the agent sees them at spawn). Before: `worktree add -B`
#      reset the branch to base and the agent re-implemented everything.
#   (D-F, GAFFER_RETRY_FRESH_BRANCH and the bootstrap rework:
#   waste-controls-fresh-branch.test.sh, on its own copy of the same world)
# Run: bash runner/test/waste-controls.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
# shellcheck source=lib/waste-controls-world.sh
source "$HERE/lib/waste-controls-world.sh"

echo "== A. turn cap BEFORE the first commit → WIP checkpoint + pause (work kept) =="
echo edit-nocommit-cap > "$MODE"
A="$(new_ready "Cap before commit" "deliver a helper")"
OUTA="$(run_tick)"
grep -q '^TICK_RESULT=paused$' <<<"$OUTA" && ok "A: tick result paused" || fail "A: tick result $OUTA"
[ "$(st "$A")" = "paused" ] && ok "A: #$A is paused (not refining / failed)" || fail "A: #$A is '$(st "$A")'"
[ "$(pause_reason "$A")" = "cap_hit" ] && ok "A: pause reason cap_hit" || fail "A: pause reason '$(pause_reason "$A")'"
BA="$(branch_of "$A")"
[ -n "$BA" ] && [[ "$(git -C "$R" log --oneline "main..$BA")" == *"wip #$A: checkpoint at cap"* ]] && ok "A: a WIP checkpoint commit holds the uncommitted work on $BA" || fail "A: no WIP checkpoint on '$BA': $(git -C "$R" log --oneline "main..${BA:-main}" 2>/dev/null | tr '\n' '|')"
[[ "$(git -C "$R" show "$BA" --stat --format= 2>/dev/null)" == *"partial-helper$A"* ]] && ok "A: the checkpoint contains the agent's partial file" || fail "A: checkpoint lacks the partial file"
grep -q "CAP: #$A had uncommitted work at the cap — WIP checkpoint committed" "$GAFFER_DATA/factory.log" && ok "A: runner logged the checkpoint" || fail "A: no checkpoint log line"
WTA="$(wg ticket show "$A" | jget '(d.events||[]).filter(e => e.event_type === "ticket.paused").map(e => { try { return JSON.parse(e.payload_json).worktree_path } catch { return "" } }).pop() || ""')"
[ -n "$WTA" ] && [ -d "$WTA" ] && ok "A: paused worktree preserved at $(basename "$WTA")" || fail "A: paused worktree missing ('$WTA')"

echo "== B. wall-clock timeout mid-delivery → pause (reason timeout), work kept =="
echo edit-nocommit-hang > "$MODE"
B="$(new_ready "Timeout mid-delivery" "deliver a helper")"
OUTB="$(GAFFER_TICK_TIMEOUT=3 GAFFER_REAP_GRACE=1 run_tick)"
grep -q '^TICK_RESULT=paused$' <<<"$OUTB" && ok "B: tick result paused" || fail "B: tick result $OUTB"
[ "$(st "$B")" = "paused" ] && ok "B: #$B is paused" || fail "B: #$B is '$(st "$B")'"
[ "$(pause_reason "$B")" = "timeout" ] && ok "B: pause reason timeout" || fail "B: pause reason '$(pause_reason "$B")'"
BB="$(branch_of "$B")"
[ -n "$BB" ] && [[ "$(git -C "$R" log --oneline "main..$BB")" == *"wip #$B"* ]] && ok "B: WIP checkpoint on $BB after the kill" || fail "B: no checkpoint after timeout on '$BB'"

echo "== C. rework after review CHANGES re-enters on the existing branch (commits kept) =="
echo deliver > "$MODE"; echo changes > "$REVIEW"
C="$(new_ready "Reworked helper" "deliver a helper")"
run_tick >/dev/null; [ "$(st "$C")" = "in_review" ] && ok "C: #$C delivered → in_review" || fail "C: status=$(st "$C")"
BC="$(branch_of "$C")"; N1="$(git -C "$R" rev-list --count "main..$BC" 2>/dev/null)"
[ "${N1:-0}" -ge 1 ] && ok "C: first attempt left $N1 commit(s) on $BC" || fail "C: no commits after first attempt"
review_tick >/dev/null
[ "$(st "$C")" = "ready" ] && ok "C: reviewer CHANGES → re-queued (ready)" || fail "C: after review status=$(st "$C")"
echo approve > "$REVIEW"; echo deliver-with-test > "$MODE"
run_tick >/dev/null
D2="$(last_delivery)"
[ -n "$D2" ] && [ "$(cat "$D2/commits-at-spawn")" -ge 1 ] && ok "C: the rework agent saw $(cat "$D2/commits-at-spawn") prior commit(s) at spawn (branch kept, not reset)" || fail "C: rework spawned on a reset branch (commits-at-spawn=$(cat "$D2/commits-at-spawn" 2>/dev/null))"
grep -q "reused worktree for repo .* on EXISTING branch $BC .* prior commit(s) kept" "$GAFFER_DATA/factory.log" && ok "C: runner logged the branch reuse" || fail "C: no reuse log: $(grep -E 'worktree for repo' "$GAFFER_DATA/factory.log" | tail -2 | tr '\n' '|' | cut -c1-300)"
grep -q "previous attempt's commits are\|prior\nattempt's commits\|ALREADY on this branch" "$D2/prompt" && ok "C: rework prompt tells the agent the prior commits are on the branch" || fail "C: rework prompt lacks the kept-commits note"
[ "$(st "$C")" = "in_review" ] && ok "C: rework re-delivered → in_review" || fail "C: rework status=$(st "$C")"
# Clear the review lane before the next case (a tick reviews the OLDEST in_review ticket first).
review_tick >/dev/null
[ "$(st "$C")" = "ready_for_merge" ] && ok "C: rework approved → ready_for_merge" || fail "C: after approve status=$(st "$C")"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
