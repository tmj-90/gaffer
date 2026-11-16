#!/usr/bin/env bash
# =====================================================================
# AUTONOMY STEP-DOWN on the LIVE path (backlog 58): when the evidence turns bad for a
# repo x risk x gate that worked automatically, autonomy is taken back, and the runner
# honours it wherever it asks dispatch whether automation applies.
# ---------------------------------------------------------------------
# Proven against the REAL dispatch + tick.sh (the merge lane) with a stub agent, in the
# graduated posture (no env floor, `auto` policy rows for low risk only):
#   A  before: an agent-approved low-risk ticket lands automatically through the merge lane;
#   B  a person links a regression of it: dispatch records the step-down (approve and merge
#      at low, merge cascades upward), `wg ticket auto-decision` answers deny with the hold;
#   C  after: an agent-approved ticket already waiting at ready_for_merge is HELD by the lane
#      (nothing lands, main unchanged); a new agent approve is refused; a person's approval
#      waits for a person's Merge (AUTO_MERGE off);
#   D  a person lifts it (`wg autonomy lift --override --reason`): the next agent-approved
#      ticket lands again;
#   E  the in-flight race: a step-down recorded while the merge lane's landing of an
#      agent-approved ticket waits in the merge gate stops that landing at landing-begin
#      (main unchanged, the ticket stays ready_for_merge, the log says why).
# Run it both ways: served (default) and GAFFER_WG_SERVE=0.
# Run: bash runner/test/autonomy-step-down.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
export MERGE_LANE_NAME=autonomy-step-down
# shellcheck source=lib/merge-lane-world.sh
source "$HERE/lib/merge-lane-world.sh"
export GAFFER_DIGEST_DISABLE=1 GAFFER_MEMORY_INDEX=0 GAFFER_CONFLICT_RESOLVER=0 GAFFER_DOD_SANDBOX=0 \
  AUTO_MERGE=0 MERGE_ON_AGENT_REVIEW=0 DISPATCH_ALLOW_AGENT_APPROVE=0
CORE_JS="$ROOT/packages/dispatch/dist/core.js"

# The graduated grant: `auto` rows for low risk at both gates (what a person enables on
# Settings > Autonomy; the REST surface is the only writer, so this calls the same service).
# SEALED AUTONOMY: opened with the factory key (as the REST server does), so the rows are
# signed with the key every runner CLI call verifies them under.
DISPATCH_DB="$DISPATCH_DB" node --input-type=module -e "
  import { Dispatch } from '$CORE_JS';
  import { hostGateKeyring } from '$ROOT/packages/dispatch/dist/events/gateSeal.js';
  const wg = Dispatch.open(process.env.DISPATCH_DB, undefined, undefined, { gateKeyring: hostGateKeyring(process.env.DISPATCH_DB) });
  const repo = wg.repos.findByName('repo');
  for (const gate of ['approve', 'merge']) {
    wg.setAutonomyPolicy({ repoId: repo.id, riskLevel: 'low', gate, mode: 'auto', confirm: true }, { type: 'human', id: 'op' });
  }
  wg.db.close();
" || { echo "FAIL: could not enable the low-risk policies"; exit 1; }

# The runner's reviewer principal: a registered agent, distinct from the delivering one.
REV="$(wg agent register -n reviewer-1 --max-risk high 2>/dev/null | jget 'd.agent.id')"
decide() { wg ticket auto-decision "$1" --gate "$2" 2>/dev/null | jget 'd.decision || ""'; }
# shellcheck disable=SC2046,SC2069  # approve_heads prints flag words; keep stderr only
agent_approve() { wg review approve "$1" $(approve_heads "$1") --as agent --reviewer "$REV" 2>&1 >/dev/null; }
deliver() { local n; n="$(new_ticket "$1" "deliver a helper")"; wg ticket ready "$n" >/dev/null 2>&1; run_tick >/dev/null; printf '%s' "$n"; }

echo "== A. before: an agent-approved low-risk ticket lands automatically =="
T1="$(deliver "Auto helper one")"
[ "$(st "$T1")" = in_review ] && ok "A: #$T1 delivered → in_review" || fail "A: #$T1 status=$(st "$T1")"
[ "$(decide "$T1" approve)" = allow ] && ok "A: the approve gate allows (the low/approve row)" || fail "A: approve decision=$(decide "$T1" approve)"
out="$(agent_approve "$T1")"
[ "$(st "$T1")" = ready_for_merge ] && ok "A: the reviewer agent's approval is accepted → ready_for_merge" || fail "A: agent approve refused: $out"
MAIN0="$(git -C "$R" rev-parse main)"
run_tick >/dev/null
[ "$(st "$T1")" = "done" ] && ok "A: the merge lane landed #$T1 → done" || fail "A: #$T1 status=$(st "$T1")"
[ "$(git -C "$R" rev-parse main)" != "$MAIN0" ] && ok "A: main advanced" || fail "A: main did not move"
grep -q "MERGE: #$T1 ready_for_merge + merge gate earned" "$LOGF" && ok "A: logged as an earned merge gate" || fail "A: no earned-gate line"

# A second agent-approved ticket, waiting at ready_for_merge when the step-down lands.
T4="$(deliver "Auto helper waiting")"
out="$(agent_approve "$T4")"
[ "$(st "$T4")" = ready_for_merge ] && ok "A: #$T4 agent-approved and waiting at ready_for_merge" || fail "A: #$T4 not approved: $out"

echo "== B. a person links a regression of the automatic change: autonomy steps down =="
D2="$(new_ticket "Export crashes" "the helper broke export")"
RES="$(wg ticket regression-of "$D2" --of "$T1" 2>&1)"
STEPPED="$(printf '%s' "$RES" | jget '(d.stepped_down || []).map(r => r.riskLevel + "/" + r.gate + "/" + r.trigger).join(" ")' 2>/dev/null)"
[ "$STEPPED" = "low/approve/regression low/merge/regression medium/merge/cascade high/merge/cascade critical/merge/cascade" ] \
  && ok "B: stepped down low approve + merge, merge cascades to every higher risk" || fail "B: stepped_down='$STEPPED' ($RES)"
[ "$(decide "$T4" merge)" = deny ] && ok "B: auto-decision --gate merge now answers deny" || fail "B: merge decision=$(decide "$T4" merge)"
HELD="$(wg ticket auto-decision "$T4" --gate merge 2>/dev/null | jget '(d.held && d.held.kind) || ""')"
[ "$HELD" = stepped_down ] && ok "B: …and names the hold (stepped_down)" || fail "B: held='$HELD'"
LADDER="$(wg autonomy ladder --repo repo --json 2>/dev/null | jget 'd.repos[0].rows[0].gates.merge.step_down.trigger || ""')"
[ "$LADDER" = regression ] && ok "B: the ladder shows the step-down and its trigger" || fail "B: ladder trigger='$LADDER'"
POLICY="$(wg autonomy policies --mode auto 2>/dev/null | jget 'd.count')"
[ "$POLICY" = 2 ] && ok "B: the policy rows are suspended, not deleted ($POLICY auto rows)" || fail "B: auto rows=$POLICY"

echo "== C. after: the lane holds for a person; a new agent approve is refused =="
MAIN1="$(git -C "$R" rev-parse main)"
run_tick >/dev/null
[ "$(st "$T4")" = ready_for_merge ] && ok "C: #$T4 (agent-approved before) is NOT landed" || fail "C: #$T4 status=$(st "$T4")"
grep -q "MERGE: #$T4 approved but auto-merge NOT permitted by policy (merge gate held)" "$LOGF" && ok "C: the lane logs the hold" || fail "C: no hold line for #$T4"
T3="$(new_ticket "Auto helper three" "deliver a helper")"; wg ticket ready "$T3" >/dev/null 2>&1; run_tick >/dev/null
[ "$(st "$T3")" = in_review ] && ok "C: #$T3 delivered → in_review" || fail "C: #$T3 status=$(st "$T3")"
out="$(agent_approve "$T3")"
[ "$(st "$T3")" = in_review ] && [[ "$out" == *"stepped down"* ]] && ok "C: the agent's approve is refused (stepped down)" || fail "C: agent approve: status=$(st "$T3") out=$out"
# shellcheck disable=SC2046  # approve_heads prints flag words
wg review approve "$T3" $(approve_heads "$T3") --reviewer human1 >/dev/null 2>&1
[ "$(st "$T3")" = ready_for_merge ] && ok "C: a person still approves #$T3" || fail "C: person approve: $(st "$T3")"
rm -f "$GAFFER_DATA/.merge-held-tickets"
run_tick >/dev/null
[ "$(st "$T3")" = ready_for_merge ] && [ "$(st "$T4")" = ready_for_merge ] && ok "C: nothing lands automatically (AUTO_MERGE off: a person merges)" || fail "C: T3=$(st "$T3") T4=$(st "$T4")"
[ "$(git -C "$R" rev-parse main)" = "$MAIN1" ] && ok "C: main unchanged after the step-down" || fail "C: main moved"

echo "== D. a person lifts it: automation returns =="
LIFT="$(wg autonomy lift repo --risk low --gate merge --override --reason "the regression was in a dependency" 2>&1)"
[ "$(printf '%s' "$LIFT" | jget 'd.how || ""' 2>/dev/null)" = override ] && ok "D: the merge step-down is lifted (override, a reason)" || fail "D: lift merge: $LIFT"
wg autonomy lift repo --risk low --gate approve --override --reason "the regression was in a dependency" >/dev/null 2>&1 \
  && ok "D: the approve step-down is lifted" || fail "D: lift approve failed"
[ "$(decide "$T4" merge)" = allow ] && ok "D: auto-decision --gate merge allows again" || fail "D: merge decision=$(decide "$T4" merge)"
rm -f "$GAFFER_DATA/.merge-held-tickets"
run_tick >/dev/null
[ "$(st "$T4")" = "done" ] && ok "D: the lane lands #$T4 once the step-down is lifted" || fail "D: #$T4 status=$(st "$T4")"

echo "== E. the in-flight race: a step-down during the merge gate stops the landing =="
T5="$(deliver "Auto helper race")"
out="$(agent_approve "$T5")"
[ "$(st "$T5")" = ready_for_merge ] && ok "E: #$T5 agent-approved → ready_for_merge" || fail "E: #$T5 not approved: $out"
# The merge gate runs the repo's test command on the merged result: hold it on a barrier.
cat > "$WORK/gate.cjs" <<GATE
const fs = require("node:fs");
fs.writeFileSync("$WORK/inside", "1");
const until = Date.now() + 120000;
const t = setInterval(() => { if (fs.existsSync("$WORK/release") || Date.now() > until) clearInterval(t); }, 100);
GATE
wg repo set-commands repo --test "node $WORK/gate.cjs" >/dev/null 2>&1
MAIN2="$(git -C "$R" rev-parse main)"
rm -f "$GAFFER_DATA/.merge-held-tickets"
( run_tick > "$WORK/race.out" ) & TICK_PID=$!
i=0; while [ ! -e "$WORK/inside" ] && [ "$i" -lt 600 ]; do sleep 0.2; i=$((i + 1)); done
if [ -e "$WORK/inside" ]; then
  ok "E: the lane decided to land #$T5 and is inside its merge gate"
  D6="$(new_ticket "Export crashes again" "the helper broke export again")"
  RES="$(wg ticket regression-of "$D6" --of "$T4" 2>&1)"
  [ "$(printf '%s' "$RES" | jget '(d.stepped_down || []).length' 2>/dev/null)" -gt 0 ] 2>/dev/null \
    && ok "E: a regression of #$T4 (landed automatically) steps merge down meanwhile" || fail "E: no step-down: $RES"
  touch "$WORK/release"; wait "$TICK_PID"
  [ "$(git -C "$R" rev-parse main)" = "$MAIN2" ] && ok "E: main did not move" || fail "E: main advanced after the step-down"
  [ "$(st "$T5")" = ready_for_merge ] && ok "E: #$T5 stays ready_for_merge for a person" || fail "E: #$T5 status=$(st "$T5")"
  grep -q "MERGE: #$T5 not landed: .*stepped down" "$LOGF" && ok "E: the log says why (not landed: stepped down)" || fail "E: no 'not landed' line: $(grep "#$T5" "$LOGF" | tail -3 | tr '\n' '|' | cut -c1-400)"
else
  fail "E: the landing never reached the merge gate: $(grep "#$T5" "$LOGF" | tail -3 | tr '\n' '|' | cut -c1-400)"
  touch "$WORK/release"; wait "$TICK_PID" 2>/dev/null
fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "autonomy-step-down: PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
