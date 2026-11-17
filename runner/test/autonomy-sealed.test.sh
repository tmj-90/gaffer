#!/usr/bin/env bash
# =====================================================================
# SEALED AUTONOMY on the LIVE path (S5 part B): a process that can write the sqlite file
# cannot grant itself automatic approval or merge. The rows that decide what may happen
# without a person count only with a seal under the factory key, and the runner honours
# that wherever it asks dispatch whether automation applies.
# ---------------------------------------------------------------------
# Proven against the REAL dispatch + tick.sh (the merge lane) with a stub agent, in the
# graduated posture (no env floor; signed `auto` rows for low risk at both gates):
#   A  a signed row: an agent-approved low-risk ticket lands automatically;
#   B  a FORGED row (direct SQL, medium risk): auto-decision denies, an agent's approve is
#      refused, the ticket waits for a person;
#   C  the signed low/merge row EDITED in place (direct SQL): an agent-approved ticket
#      waiting at ready_for_merge is HELD by the lane; put back exactly, it lands;
#   D  a low row's SEAL COPIED onto a forged high row: auto-decision denies at high;
#   E  a ticket's risk LOWERED by direct SQL (high to low): decided as the highest risk,
#      auto-decision names the hold (risk_unsigned), an agent's approve is refused;
#   F  a FORGED LIFT event after a step-down: autonomy stays stepped down.
# Run it both ways: served (default) and GAFFER_WG_SERVE=0.
# Run: bash runner/test/autonomy-sealed.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
export MERGE_LANE_NAME=autonomy-sealed
# shellcheck source=lib/merge-lane-world.sh
source "$HERE/lib/merge-lane-world.sh"
export GAFFER_DIGEST_DISABLE=1 GAFFER_MEMORY_INDEX=0 GAFFER_CONFLICT_RESOLVER=0 GAFFER_DOD_SANDBOX=0 \
  AUTO_MERGE=0 MERGE_ON_AGENT_REVIEW=0 DISPATCH_ALLOW_AGENT_APPROVE=0
DIST="$ROOT/packages/dispatch/dist"

# The graduated grant: signed `auto` rows for low risk at both gates, through the same
# service Settings uses, with the factory key (what the REST server holds).
DISPATCH_DB="$DISPATCH_DB" node --input-type=module -e "
  import { Dispatch } from '$DIST/core.js';
  import { hostGateKeyring } from '$DIST/events/gateSeal.js';
  const db = process.env.DISPATCH_DB;
  const wg = Dispatch.open(db, undefined, undefined, { gateKeyring: hostGateKeyring(db) });
  const repo = wg.repos.findByName('repo');
  for (const gate of ['approve', 'merge']) {
    wg.setAutonomyPolicy({ repoId: repo.id, riskLevel: 'low', gate, mode: 'auto', confirm: true }, { type: 'human', id: 'op' });
  }
  wg.db.close();
" || { echo "FAIL: could not enable the low-risk policies"; exit 1; }

# A writer of the sqlite file that holds no key (what an in-sandbox MCP server can do).
sql() { DISPATCH_DB="$DISPATCH_DB" SQL="$1" node --no-warnings --input-type=module -e "
  import { DatabaseSync } from 'node:sqlite';
  const db = new DatabaseSync(process.env.DISPATCH_DB);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(process.env.SQL);
  db.close();
"; }
REPO_ID="$(wg repo list 2>/dev/null | jget '(Array.isArray(d) ? d : (d.repositories || [])).find(r => r.name === "repo").id')"
[ -n "$REPO_ID" ] || { echo "FAIL: no repo id"; exit 1; }

REV="$(wg agent register -n reviewer-1 --max-risk high 2>/dev/null | jget 'd.agent.id')"
decide() { wg ticket auto-decision "$1" --gate "$2" 2>/dev/null | jget 'd.decision || ""'; }
held() { wg ticket auto-decision "$1" --gate "$2" 2>/dev/null | jget '(d.held && d.held.kind) || ""'; }
# shellcheck disable=SC2046,SC2069  # approve_heads prints flag words; keep stderr only
agent_approve() { wg review approve "$1" $(approve_heads "$1") --as agent --reviewer "$REV" 2>&1 >/dev/null; }
ticket_at() { # $1 title $2 risk: a ticket writing to the repo, not delivered
  local n; n="$(wg ticket create -t "$1" -d "x" --risk "$2" 2>/dev/null | jget 'd.ticket.number')"
  wg ticket repo-access set "$n" repo --access write --relation confirmed >/dev/null 2>&1; printf '%s' "$n"; }
deliver_at() { # $1 title $2 risk: delivered by the stub agent → in_review
  local n; n="$(wg ticket create -t "$1" -d "deliver a helper" --risk "$2" 2>/dev/null | jget 'd.ticket.number')"
  wg ac add "$n" -t "helper added" >/dev/null 2>&1
  wg ticket repo-access set "$n" repo --access write --relation confirmed >/dev/null 2>&1
  wg ticket ready "$n" >/dev/null 2>&1; run_tick >/dev/null; printf '%s' "$n"; }

echo "== A. a signed row: an agent-approved low-risk ticket lands automatically =="
T1="$(deliver_at "Sealed helper one" low)"
[ "$(st "$T1")" = in_review ] && ok "A: #$T1 delivered → in_review" || fail "A: #$T1 status=$(st "$T1")"
[ "$(decide "$T1" approve)" = allow ] && ok "A: the signed low/approve row allows" || fail "A: approve decision=$(decide "$T1" approve)"
out="$(agent_approve "$T1")"
[ "$(st "$T1")" = ready_for_merge ] && ok "A: the reviewer agent's approval is accepted" || fail "A: agent approve refused: $out"
MAIN0="$(git -C "$R" rev-parse main)"
run_tick >/dev/null
[ "$(st "$T1")" = "done" ] && ok "A: the merge lane landed #$T1 → done" || fail "A: #$T1 status=$(st "$T1")"
[ "$(git -C "$R" rev-parse main)" != "$MAIN0" ] && ok "A: main advanced" || fail "A: main did not move"

echo "== B. a forged row (direct SQL) grants nothing =="
sql "INSERT INTO autonomy_policy (id, repo_id, risk_level, gate, mode, enabled_by, enabled_at, created_at, updated_at)
     VALUES ('forged-a', '$REPO_ID', 'medium', 'approve', 'auto', 'op', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
            ('forged-m', '$REPO_ID', 'medium', 'merge', 'auto', 'op', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')" \
  || fail "B: could not write the forged rows"
T2="$(deliver_at "Forged helper" medium)"
[ "$(st "$T2")" = in_review ] && ok "B: #$T2 (medium) delivered → in_review" || fail "B: #$T2 status=$(st "$T2")"
[ "$(decide "$T2" approve)" = deny ] && [ "$(decide "$T2" merge)" = deny ] && ok "B: auto-decision denies both gates on the forged rows" || fail "B: approve=$(decide "$T2" approve) merge=$(decide "$T2" merge)"
out="$(agent_approve "$T2")"
[ "$(st "$T2")" = in_review ] && ok "B: an agent's approve is refused: #$T2 waits for a person" || fail "B: agent approve accepted: status=$(st "$T2") out=$out"
SIGNED="$(wg autonomy policies --mode auto 2>/dev/null | jget '(d.policies || []).filter(p => p.signed === false).length')"
[ "$SIGNED" = 2 ] && ok "B: the policy listing marks both forged rows as not signed" || fail "B: unsigned rows listed=$SIGNED"
DOCTOR="$(wg doctor 2>/dev/null)"
grep -q "2 automatic policy rows are not signed: they are off until you sign them" <<<"$DOCTOR" \
  && ok "B: doctor says the forged rows are off until a person signs them" || fail "B: doctor: $(wg doctor 2>/dev/null | grep -i autonomy | head -3 | tr '\n' '|')"

echo "== C. the signed low/merge row edited in place: the lane holds; put back, it lands =="
T3="$(deliver_at "Sealed helper waiting" low)"
out="$(agent_approve "$T3")"
[ "$(st "$T3")" = ready_for_merge ] && ok "C: #$T3 agent-approved → ready_for_merge" || fail "C: #$T3 not approved: $out"
sql "UPDATE autonomy_policy SET enabled_by = 'mallory' WHERE repo_id = '$REPO_ID' AND risk_level = 'low' AND gate = 'merge'"
[ "$(decide "$T3" merge)" = deny ] && ok "C: auto-decision --gate merge denies the edited row" || fail "C: merge decision=$(decide "$T3" merge)"
MAIN1="$(git -C "$R" rev-parse main)"
rm -f "$GAFFER_DATA/.merge-held-tickets"
run_tick >/dev/null
[ "$(st "$T3")" = ready_for_merge ] && ok "C: the lane holds #$T3 for a person" || fail "C: #$T3 status=$(st "$T3")"
[ "$(git -C "$R" rev-parse main)" = "$MAIN1" ] && ok "C: main unchanged" || fail "C: main moved on an edited row"
sql "UPDATE autonomy_policy SET enabled_by = 'op' WHERE repo_id = '$REPO_ID' AND risk_level = 'low' AND gate = 'merge'"
[ "$(decide "$T3" merge)" = allow ] && ok "C: put back exactly as signed, the row verifies again" || fail "C: merge decision=$(decide "$T3" merge)"
rm -f "$GAFFER_DATA/.merge-held-tickets"
run_tick >/dev/null
[ "$(st "$T3")" = "done" ] && ok "C: the lane lands #$T3 on the signed row" || fail "C: #$T3 status=$(st "$T3")"

echo "== D. a signed row's seal copied onto a forged row grants nothing =="
T4="$(ticket_at "High change" high)"
sql "INSERT INTO autonomy_policy (id, repo_id, risk_level, gate, mode, enabled_by, enabled_at, created_at, updated_at)
       SELECT 'copy-m', repo_id, 'high', gate, mode, enabled_by, enabled_at, created_at, updated_at FROM autonomy_policy
        WHERE repo_id = '$REPO_ID' AND risk_level = 'low' AND gate = 'merge';
     INSERT INTO row_seals (kind, row_id, event_id, facts_json, key_id, mac, created_at)
       SELECT kind, 'copy-m', event_id, facts_json, key_id, mac, created_at FROM row_seals
        WHERE kind = 'autonomy_policy' AND row_id = (SELECT id FROM autonomy_policy WHERE repo_id = '$REPO_ID' AND risk_level = 'low' AND gate = 'merge');"
[ "$(decide "$T4" merge)" = deny ] && ok "D: auto-decision denies the high ticket on the copied seal" || fail "D: merge decision=$(decide "$T4" merge)"

echo "== E. a ticket's risk lowered by direct SQL is decided as the highest =="
T5="$(deliver_at "Lowered helper" high)"
[ "$(st "$T5")" = in_review ] && ok "E: #$T5 (high) delivered → in_review" || fail "E: #$T5 status=$(st "$T5")"
sql "UPDATE tickets SET risk_level = 'low' WHERE number = $T5"
[ "$(decide "$T5" approve)" = deny ] && ok "E: auto-decision denies (the low rows do not reach it)" || fail "E: approve decision=$(decide "$T5" approve)"
[ "$(held "$T5" approve)" = risk_unsigned ] && ok "E: …and names the hold (risk_unsigned)" || fail "E: held='$(held "$T5" approve)'"
RISK="$(wg ticket auto-decision "$T5" --gate merge 2>/dev/null | jget 'd.risk_level + "/" + d.stored_risk_level')"
[ "$RISK" = "critical/low" ] && ok "E: decided at critical, not the stored low" || fail "E: risk=$RISK"
out="$(agent_approve "$T5")"
[ "$(st "$T5")" = in_review ] && ok "E: an agent's approve is refused: #$T5 waits for a person" || fail "E: agent approve accepted: status=$(st "$T5") out=$out"

echo "== F. a forged lift does not end a step-down =="
D6="$(ticket_at "Export crashes" low)"
RES="$(wg ticket regression-of "$D6" --of "$T1" 2>&1)"
[ "$(printf '%s' "$RES" | jget '(d.stepped_down || []).length' 2>/dev/null)" -gt 0 ] 2>/dev/null \
  && ok "F: a person links a regression of #$T1: low steps down" || fail "F: no step-down: $RES"
DISPATCH_DB="$DISPATCH_DB" node --input-type=module -e "
  import { Dispatch } from '$DIST/core.js';
  import { refusingGateKeyring } from '$DIST/events/gateSeal.js';
  import { writeEvent } from '$DIST/events/eventWriter.js';
  const wg = Dispatch.open(process.env.DISPATCH_DB, undefined, undefined, { gateKeyring: refusingGateKeyring('a database writer') });
  for (const gate of ['approve', 'merge']) {
    writeEvent(wg.db, { entity_type: 'repository', entity_id: '$REPO_ID', actor: { type: 'human', id: 'op' },
      event_type: 'autonomy.step_down_lifted', payload: { risk_level: 'low', gate, how: 'override', reason: 'forged' } });
  }
  wg.db.close();
" || fail "F: could not write the forged lifts"
T7="$(ticket_at "After the forged lift" low)"
[ "$(decide "$T7" merge)" = deny ] && [ "$(held "$T7" merge)" = stepped_down ] && ok "F: auto-decision still denies (stepped down)" || fail "F: merge decision=$(decide "$T7" merge) held=$(held "$T7" merge)"
LADDER="$(wg autonomy ladder --repo repo --json 2>/dev/null | jget 'd.repos[0].rows[0].gates.merge.step_down ? "in force" : "lifted"')"
[ "$LADDER" = "in force" ] && ok "F: the ladder shows the step-down still in force" || fail "F: ladder=$LADDER"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "autonomy-sealed: PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
