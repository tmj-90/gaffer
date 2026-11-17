#!/usr/bin/env bash
# =====================================================================
# WASTE CONTROLS, the fresh-branch override and the bootstrap rework (the second half of
# waste-controls.test.sh), through the REAL tick.sh with a stub agent (real dispatch, real
# git; lib/waste-controls-world.sh):
#   D. GAFFER_RETRY_FRESH_BRANCH=1 restores the clean-slate reset (opt-in) when a NEW
#      tick re-enters the ticket.
#   E. a bootstrap REWORK whose repo is already registered runs as a normal delivery on
#      the kept branch, with the review feedback (not a second blind scaffold pass).
#   F. GAFFER_RETRY_FRESH_BRANCH=1 does NOT reset IN-TICK rework: a gate failure re-runs
#      the agent in the same worktree on top of its own commits (the feedback is about
#      that diff), which is what docs/CONFIG.md now says.
# Run: bash runner/test/waste-controls-fresh-branch.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
WASTE_NAME=waste-controls-fresh-branch
# shellcheck source=lib/waste-controls-world.sh
source "$HERE/lib/waste-controls-world.sh"

echo "== D. GAFFER_RETRY_FRESH_BRANCH=1 restores the clean-slate reset =="
echo deliver > "$MODE"; echo changes > "$REVIEW"
E="$(new_ready "Fresh-branch helper" "deliver a helper")"
run_tick >/dev/null; review_tick >/dev/null
[ "$(st "$E")" = "ready" ] && ok "D: #$E re-queued after CHANGES" || fail "D: status=$(st "$E")"
echo approve > "$REVIEW"
GAFFER_RETRY_FRESH_BRANCH=1 run_tick >/dev/null
D3="$(last_delivery)"
[ -n "$D3" ] && [ "$(cat "$D3/commits-at-spawn")" = "0" ] && ok "D: with the override the retry spawned on a branch reset to base (0 prior commits)" || fail "D: override did not reset (commits-at-spawn=$(cat "$D3/commits-at-spawn" 2>/dev/null))"
retire "$E"   # clear the review lane before case E (no case below reviews it)

echo "== E. a bootstrap REWORK (repo already registered) runs as a normal delivery with feedback =="
# LIVE FINDING: after the scaffold was reviewed (CHANGES) the ticket still carried
# bootstrap=1, so the retry re-entered the create-a-repo path — whose prompt has no
# review-feedback block — and paid for a second blind scaffold pass. Once the repo is
# registered and linked, a bootstrap rework is a normal delivery on the kept branch.
echo deliver > "$MODE"; echo approve > "$REVIEW"
F="$(wg ticket create -t "Bootstrap the r repo" -d "scaffold the repo" --risk low --bootstrap 2>/dev/null | jget 'd.ticket.number')"
wg ac add "$F" -t "helper added" >/dev/null 2>&1
wg ticket repo-access set "$F" repo --access write --relation confirmed >/dev/null 2>&1
# Simulate the prior bootstrap pass: its scaffold commit already sits on the ticket branch.
ticket_slug() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' | tr -s '-' | sed -E 's/^-+//; s/-+$//' | cut -d- -f1-6 | cut -c1-50 | sed -E 's/-+$//'; }  # mirrors tick.sh gaffer_ticket_slug
BF="gaffer/ticket-$F-$(ticket_slug "Bootstrap the r repo")"
git -C "$R" branch "$BF" main >/dev/null 2>&1
git -C "$R" worktree add -q "$WORK/wt-f" "$BF" >/dev/null 2>&1
printf 'export const scaffold = 1;\n' > "$WORK/wt-f/src/scaffold.js"
git -C "$WORK/wt-f" -c user.email=t@t -c user.name=t add -A >/dev/null 2>&1
git -C "$WORK/wt-f" -c user.email=t@t -c user.name=t commit -qm "deliver #$F: scaffold" >/dev/null 2>&1
git -C "$R" worktree remove --force "$WORK/wt-f" >/dev/null 2>&1
wg ticket ready "$F" >/dev/null 2>&1
[ "$(wg ticket show "$F" | jget '[1, true].includes(d.ticket.bootstrap) ? 1 : 0')" = "1" ] && ok "E: #$F is a bootstrap ticket with a REGISTERED repo linked" || fail "E: fixture is not a bootstrap ticket"
run_tick >/dev/null
grep -q "BOOTSTRAP #$F: repo already registered at .* rework runs as a normal delivery" "$GAFFER_DATA/factory.log" && ok "E: runner routed the bootstrap rework to the normal delivery path" || fail "E: no routing log line"
grep -q "BOOTSTRAP #$F ('Bootstrap the r repo') → create new repo" "$GAFFER_DATA/factory.log" && fail "E: the create-a-repo path ran for a registered repo" || ok "E: the create-a-repo path did NOT run"
D4="$(last_delivery)"
[ -n "$D4" ] && [ "$(cat "$D4/commits-at-spawn")" -ge 1 ] && ok "E: the rework agent saw the prior scaffold commit at spawn (branch $BF kept)" || fail "E: rework did not keep the scaffold commit (commits-at-spawn=$(cat "$D4/commits-at-spawn" 2>/dev/null))"
[ "$(st "$F")" = "in_review" ] && ok "E: bootstrap rework re-delivered → in_review" || fail "E: status=$(st "$F")"

echo "== F. GAFFER_RETRY_FRESH_BRANCH=1 leaves IN-TICK rework on the agent's own commits =="
retire "$F"   # clear the review lane left by case E
echo fail-then-fix > "$MODE"; echo approve > "$REVIEW"
G="$(new_ready "In-tick rework helper" "deliver a helper")"
BEFORE_F="$(ls -1 "$CALLS" | wc -l | tr -d ' ')"
GAFFER_RETRY_FRESH_BRANCH=1 run_tick >/dev/null
SPAWNS=""; for d in "$CALLS"/*; do
  [ "$(basename "$d")" -gt "$BEFORE_F" ] 2>/dev/null || continue
  [ "$(cat "$d/kind" 2>/dev/null)" = delivery ] && SPAWNS+="$(cat "$d/commits-at-spawn") "
done
SPAWNS="${SPAWNS% }"
case "$SPAWNS" in
  "0 "[1-9]*) ok "F: attempt 1 spawned on base, the in-tick retry on its commits (commits-at-spawn: $SPAWNS)" ;;
  *) fail "F: expected an in-tick retry on the kept branch (commits-at-spawn per attempt: '${SPAWNS}')" ;;
esac
[ "$(st "$G")" = "in_review" ] && ok "F: the in-tick rework delivered → in_review" || fail "F: status=$(st "$G")"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
