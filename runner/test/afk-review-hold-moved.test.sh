#!/usr/bin/env bash
# =====================================================================
# AFK REVIEW, the pinned landing (the last case of afk-review-hold.test.sh; the same world,
# lib/afk-review-world.sh: real dispatch + tick.sh, a stub claude switched per case):
#   F. a delivery the agent reviewer approved while the merge gate was HELD
#      (ready_for_merge) is pinned to the reviewed commit; once its branch moves (an
#      unreviewed late commit) the merge lane HOLDS it (moved since the review approved
#      it): nothing lands and the ticket stays ready_for_merge.
# Run: bash runner/test/afk-review-hold-moved.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
AFK_NAME=afk-review-hold-moved
# shellcheck source=lib/afk-review-world.sh
source "$HERE/lib/afk-review-world.sh"

echo "== F. approved with the merge gate HELD, then the branch moves → the merge lane HOLDS it =="
echo deliver > "$MODE_FILE"
N2="$(wg ticket create -t "Pin probe" -d "deliver, approve, then move" 2>/dev/null | jget 'd.ticket.number')"
wg ac add "$N2" -t "helper added" >/dev/null 2>&1
wg ticket repo-access set "$N2" repo --access write --relation confirmed >/dev/null 2>&1
wg ticket ready "$N2" >/dev/null 2>&1
OUTF0="$(run_tick)"
[ "$(st "$N2")" = "in_review" ] && ok "F: #$N2 delivered → in_review" || fail "F: setup delivery: $OUTF0 status=$(st "$N2")"
echo approve > "$MODE_FILE"; rm -f "$GAFFER_DATA/.reviewed-tickets"
OUTF1="$(REVIEW_MODE=agent DISPATCH_ALLOW_AGENT_APPROVE=1 GAFFER_STRICT_REQUIRE=0 run_tick)"
[ "$(st "$N2")" = "ready_for_merge" ] && ok "F: #$N2 approved, merge gate held → ready_for_merge" || fail "F: #$N2 is '$(st "$N2")' ($OUTF1)"
RBR2="$(git -C "$R" branch --list "gaffer/ticket-$N2-*" | tr -d ' *' | head -1)"
REV2="$(git -C "$R" rev-parse "refs/heads/$RBR2")"
DEC="$(node "$RUNNER_DIR/lib/tester-binding.mjs" landing --db "$DISPATCH_DB" --ticket "$N2" --repo "$R" --branch "$RBR2")"
[ "$(printf '%s' "$DEC" | jget 'd.ok && d.reviewed === d.pin ? d.pin : ""')" = "$REV2" ] \
  && ok "F: the landing decision is pinned to the reviewed commit" || fail "F: decision before the move: $DEC"
WTX="$WORK/wt-move"; git -C "$R" worktree add -q "$WTX" "$RBR2" >/dev/null 2>&1
( cd "$WTX" && echo unreviewed > late.txt && git -c user.email=x@x -c user.name=x add late.txt && git -c user.email=x@x -c user.name=x commit -qm "unreviewed late commit" )
git -C "$R" worktree remove --force "$WTX" >/dev/null 2>&1
MAINF="$(git -C "$R" rev-parse main)"
OUTF2="$(REVIEW_MODE=human DISPATCH_ALLOW_AGENT_APPROVE=1 AUTO_MERGE=1 MERGE_ON_AGENT_REVIEW=1 GAFFER_STRICT_REQUIRE=0 run_tick)"
grep -q "MERGE: #$N2 HELD — $RBR2 moved since the review approved it" "$GAFFER_DATA/factory.log" \
  && ok "F: the merge lane HELD #$N2 (moved-since-review)" || fail "F: no moved-since-review hold: $(grep "#$N2" "$GAFFER_DATA/factory.log" | tail -3 | tr '\n' '|')"
[ "$(git -C "$R" rev-parse main)" = "$MAINF" ] && [ "$(st "$N2")" = "ready_for_merge" ] \
  && ok "F: nothing landed; #$N2 still ready_for_merge" || fail "F: main moved or #$N2 is '$(st "$N2")'"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
