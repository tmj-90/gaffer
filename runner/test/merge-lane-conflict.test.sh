#!/usr/bin/env bash
# =====================================================================
# MERGE LANE, conflicts and the AUTO_MERGE path (the second half of merge-lane.test.sh).
# ---------------------------------------------------------------------
# The same world (lib/merge-lane-world.sh: real dispatch + tick.sh, a stub agent):
#   E  a merge CONFLICT spawns the conflict resolver (bin/merge-ticket.mjs) once: the
#      branch gets the resolution, the ticket returns to in_review, main is untouched,
#      the spend is ledgered; re-approval lands it with both sides intact;
#   F  a second conflict after a resolver pass is held for a human; the knob turns the
#      resolver off;
#   G  AUTO_MERGE alone lands a HUMAN approval (the Settings promise); an AGENT approval
#      under AUTO_MERGE alone is held (its gate also needs MERGE_ON_AGENT_REVIEW).
# (A-D, the lane itself, its supervised hold, its switch and its wiring: merge-lane.test.sh)
# Run: bash runner/test/merge-lane-conflict.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
MERGE_LANE_NAME=merge-lane-conflict
# shellcheck source=lib/merge-lane-world.sh
source "$HERE/lib/merge-lane-world.sh"

resolver_turns() { grep -l "resolve a merge conflict on the delivery branch" "$CALLS"/*/prompt 2>/dev/null | xargs -r grep -l "(ticket #$1)" 2>/dev/null | wc -l | tr -d ' '; }
echo "== E. autonomous: a CONFLICT spawns the resolver once, the ticket returns to review, and lands after re-approval =="
E="$(new_ticket "Conflicting helper" "deliver a helper that will conflict")"; wg ticket ready "$E" >/dev/null 2>&1
AUTO_MERGE=0 run_tick >/dev/null
[ "$(st "$E")" = "in_review" ] && ok "E: #$E delivered → in_review" || fail "E: status=$(st "$E")"
BE="$(branch_of "$E")"
# A sibling lands on main touching the SAME line region (append to src/a.js) → conflict.
( cd "$R" && printf 'export function mainSide() { return 3; }\n' >> src/a.js && git -c user.email=t@t -c user.name=t commit -qam "feat: mainSide" )
wg review approve "$E" $(approve_heads "$E") --reviewer human1 >/dev/null 2>&1
[ "$(st "$E")" = "ready_for_merge" ] && ok "E: human approve → ready_for_merge" || fail "E: after approve status=$(st "$E")"
MAIN_E="$(git -C "$R" rev-parse main)"
GAFFER_MODE=autonomous AUTO_MERGE=1 DISPATCH_ALLOW_AGENT_APPROVE=1 MERGE_ON_AGENT_REVIEW=1 GAFFER_MERGE_TIMEOUT_MS=60000 run_tick >/dev/null
grep -q "MERGE: #$E conflict — spawning the conflict resolver" "$LOGF" && ok "E: the lane spawned the resolver on the conflict" || fail "E: no resolver spawn logged: $(grep "#$E" "$LOGF" | tail -3 | tr '\n' '|' | cut -c1-400)"
[ "$(st "$E")" = "in_review" ] && ok "E: resolved ticket reopened for RE-REVIEW (in_review), not landed" || fail "E: status=$(st "$E") after the resolver"
[ "$(git -C "$R" rev-parse main)" = "$MAIN_E" ] && ok "E: main untouched by the resolver (proposed on the branch only)" || fail "E: main moved during resolution"
[ "$(git -C "$R" rev-list --merges --count "main..$BE")" -ge 1 ] && ok "E: the branch carries the resolver's merge commit" || fail "E: no merge commit on $BE"
grep -qx "$E" "$GAFFER_DATA/.merge-conflict-resolved" && ok "E: #$E recorded in .merge-conflict-resolved (one resolver pass per ticket)" || fail "E: marker file lacks #$E"
[ "$(resolver_turns "$E")" = "1" ] && ok "E: exactly one resolver turn spawned for #$E" || fail "E: resolver turns for #$E = $(resolver_turns "$E")"
grep -q '"kind":"merge-resolver"' "$GAFFER_DATA/usage-ledger.jsonl" 2>/dev/null && ok "E: the resolver's spend is ledgered as kind=merge-resolver" || fail "E: no merge-resolver ledger row"
# Re-approval of the resolved diff → the lane lands it cleanly on the next tick OF THE
# SAME RUN: a resolved conflict must not sit in the run's held file (it did, live: the
# re-approved ticket waited at ready_for_merge until the next run).
grep -qx "$E" "$GAFFER_DATA/.merge-held-tickets" 2>/dev/null && fail "E: a resolved conflict was added to .merge-held-tickets (would not land this run)" || ok "E: resolved ticket is NOT held for the run"
wg review approve "$E" $(approve_heads "$E") --reviewer human1 >/dev/null 2>&1
GAFFER_MODE=autonomous AUTO_MERGE=1 DISPATCH_ALLOW_AGENT_APPROVE=1 MERGE_ON_AGENT_REVIEW=1 run_tick >/dev/null
[ "$(st "$E")" = "done" ] && ok "E: re-approved resolved branch lands → done" || fail "E: status=$(st "$E") after re-approval"
_ME="$(git -C "$R" show main:src/a.js)"; [[ "$_ME" == *"helper$E"* ]] && [[ "$_ME" == *"mainSide"* ]] && ok "E: main carries BOTH sides after the landing" || fail "E: main lost a side: $(printf '%s' "$_ME" | tr '\n' '|')"

echo "== F. a SECOND conflict for a ticket that already had its resolver pass is held for a human; GAFFER_CONFLICT_RESOLVER=0 never spawns =="
F="$(new_ticket "Twice-conflicting helper" "deliver a helper")"; wg ticket ready "$F" >/dev/null 2>&1
AUTO_MERGE=0 run_tick >/dev/null; BF="$(branch_of "$F")"
( cd "$R" && printf 'export function mainSide2() { return 4; }\n' >> src/a.js && git -c user.email=t@t -c user.name=t commit -qam "feat: mainSide2" )
wg review approve "$F" $(approve_heads "$F") --reviewer human1 >/dev/null 2>&1
echo "$F" >> "$GAFFER_DATA/.merge-conflict-resolved"   # pretend a resolver pass already happened
rm -f "$GAFFER_DATA/.merge-held-tickets"
GAFFER_MODE=autonomous AUTO_MERGE=1 DISPATCH_ALLOW_AGENT_APPROVE=1 MERGE_ON_AGENT_REVIEW=1 run_tick >/dev/null
[ "$(st "$F")" = "ready_for_merge" ] && ok "F: second conflict → held at ready_for_merge for a human" || fail "F: status=$(st "$F")"
grep -q "MERGE: #$F conflicted AGAIN after a resolver pass" "$LOGF" && ok "F: the hold says why (no second resolver)" || fail "F: no 'conflicted AGAIN' line"
grep -q "MERGE: #$F approved but merge hit a CONFLICT — left on $BF for a human" "$LOGF" && ok "F: the classic conflict hold line is still logged" || fail "F: no conflict hold line"
[ "$(resolver_turns "$F")" = "0" ] && ok "F: no resolver turn for #$F" || fail "F: resolver turns for #$F = $(resolver_turns "$F")"
G="$(new_ticket "Lane-off conflicting helper" "deliver a helper")"; wg ticket ready "$G" >/dev/null 2>&1
AUTO_MERGE=0 run_tick >/dev/null
( cd "$R" && printf 'export function mainSide3() { return 5; }\n' >> src/a.js && git -c user.email=t@t -c user.name=t commit -qam "feat: mainSide3" )
wg review approve "$G" $(approve_heads "$G") --reviewer human1 >/dev/null 2>&1; rm -f "$GAFFER_DATA/.merge-held-tickets"
GAFFER_CONFLICT_RESOLVER=0 GAFFER_MODE=autonomous AUTO_MERGE=1 DISPATCH_ALLOW_AGENT_APPROVE=1 MERGE_ON_AGENT_REVIEW=1 run_tick >/dev/null
[ "$(st "$G")" = "ready_for_merge" ] && grep -q "MERGE: #$G conflict — the resolver lane is off" "$LOGF" && ok "F: GAFFER_CONFLICT_RESOLVER=0 → held, resolver never spawned" || fail "F: lane-off status=$(st "$G")"
[ "$(resolver_turns "$G")" = "0" ] && ok "F: lane off spawned no resolver for #$G" || fail "F: resolver turns for #$G = $(resolver_turns "$G")"

echo "== G. AUTO_MERGE alone ('Auto-merge on approval') lands a HUMAN approval; an AGENT approval still needs the merge gate =="
# The Settings switch promised "safe-merge into the default branch on approval" but the
# lane only asked the AGENT ship floor (AUTO_MERGE AND MERGE_ON_AGENT_REVIEW), so a human
# `gaffer approve` under AUTO_MERGE=1 alone was logged "NOT permitted by policy" and sat.
H="$(new_ticket "Human-approved helper" "deliver a helper")"; wg ticket ready "$H" >/dev/null 2>&1
AUTO_MERGE=0 run_tick >/dev/null; BH="$(branch_of "$H")"
wg review approve "$H" $(approve_heads "$H") --reviewer human1 >/dev/null 2>&1
[ "$(st "$H")" = "ready_for_merge" ] && ok "G: #$H human-approved → ready_for_merge" || fail "G: status=$(st "$H")"
rm -f "$GAFFER_DATA/.merge-held-tickets"
GAFFER_MODE=supervised REVIEW_MODE=human AUTO_MERGE=1 MERGE_ON_AGENT_REVIEW=0 DISPATCH_ALLOW_AGENT_APPROVE=0 GAFFER_STRICT_REQUIRE=0 run_tick >/dev/null
[ "$(st "$H")" = "done" ] && ok "G: AUTO_MERGE=1 (MERGE_ON_AGENT_REVIEW=0) → the human-approved ticket LANDS → done" || fail "G: status=$(st "$H") — $(grep "#$H" "$LOGF" | tail -2 | tr '\n' '|' | cut -c1-300)"
grep -q "MERGE: #$H ready_for_merge + human-approved + AUTO_MERGE on → landing $BH → main" "$LOGF" && ok "G: the lane says why it landed (human-approved + AUTO_MERGE on)" || fail "G: no human-approved landing line"
[[ "$(git -C "$R" log --oneline main)" == *"helper$H"* ]] && ok "G: main carries #$H's commit" || fail "G: main lacks helper$H"
# An AGENT approval under AUTO_MERGE=1 alone is NOT a human approval: the lane only widens
# the gate for an approver the event log records as human|admin (approval-actor below).
grep -qF 'human|admin) _dec=allow; _via="human-approved + AUTO_MERGE on"' "$RUNNER_DIR/lib/merge-lane.sh" \
  && ok "G: the lane widens the gate for human|admin approvers only (an agent approval still needs the merge gate)" \
  || fail "G: merge-lane.sh does not restrict the AUTO_MERGE path to human|admin approvers"
# approval-actor (lib/json-tool.mjs): the approver is read from the dispatch event log.
aa() { printf '%s' "$1" | node "$RUNNER_DIR/lib/json-tool.mjs" approval-actor; }
EVH='{"events":[{"event_type":"ticket.transitioned","actor_type":"agent","payload_json":"{\"to\":\"in_review\"}"},{"event_type":"ticket.transitioned","actor_type":"human","payload_json":"{\"to\":\"ready_for_merge\",\"reason\":\"review_approved\"}"}]}'
[ "$(aa "$EVH")" = "human" ] && ok "G: approval-actor → human for a human review_approved" || fail "G: approval-actor human → '$(aa "$EVH")'"
EVA='{"events":[{"event_type":"ticket.transitioned","actor_type":"agent","payload_json":"{\"to\":\"in_review\"}"},{"event_type":"ticket.transitioned","actor_type":"agent","payload_json":"{\"to\":\"ready_for_merge\",\"reason\":\"review_approved\"}"}]}'
[ "$(aa "$EVA")" = "agent" ] && ok "G: approval-actor → agent for an agent approval" || fail "G: approval-actor agent → '$(aa "$EVA")'"
EVS='{"events":[{"event_type":"ticket.transitioned","actor_type":"human","payload_json":"{\"to\":\"ready_for_merge\",\"reason\":\"review_approved\"}"},{"event_type":"ticket.transitioned","actor_type":"system","payload_json":"{\"to\":\"in_review\",\"reason\":\"reopen_for_review\"}"}]}'
[ -z "$(aa "$EVS")" ] && ok "G: approval-actor → '' once the ticket re-entered in_review (stale approval)" || fail "G: stale approval still read as '$(aa "$EVS")'"
[ -z "$(aa 'not json')" ] && ok "G: approval-actor → '' on junk (never grants)" || fail "G: junk → '$(aa 'not json')'"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "merge-lane-conflict: PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
