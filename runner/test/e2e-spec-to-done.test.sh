#!/usr/bin/env bash
# =====================================================================
# E2E SPEC → COVERAGE — spec-driven traceability through to delivery.
# ---------------------------------------------------------------------
# ONE deterministic, hermetic run that drives a FROZEN SPEC through the real
# dispatch state machine and the Phase-3 coverage read model, with a STUB agent
# (no tokens spent), a temp dispatch DB, and a temp on-disk git repo. It proves
# the traceability loop composes: a clause that gets a SATISFIED acceptance
# criterion shows GREEN; a clause whose delivery is REJECTED stays OPEN; a clause
# with NO covering ticket surfaces in the GAP report.
#
# Flow (each step a REAL dispatch CLI verb or a REAL runner gate function):
#   spec create (3 clauses) → freeze → tickets whose ACs carry clause provenance
#   → deliver ONE ticket (stub agent, real worktree+commit, token-scoped evidence)
#   → its AC satisfied → clause GREEN. A second ticket's delivery is REJECTED at
#   review → its clause stays OPEN. A third clause has no ticket → GAP.
#
# It asserts, via `spec coverage <id>`:
#   • the satisfied clause is covered + satisfied (GREEN) and carries a BOUNCE count
#     (the rework trail joins to the clause via its AC's ticket);
#   • the rejected clause is covered but NOT satisfied (OPEN);
#   • NEGATIVE CONTROL: the clause with no covering ticket is an ORPHAN in the gap
#     report and is NOT counted covered.
#
# Requires the dispatch CLI to be built + git + python3. SKIPs (exit 0) otherwise.
# Run: bash test/e2e-spec-to-done.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CLI_JS="$ROOT/packages/dispatch/dist/cli/index.js"

command -v node    >/dev/null 2>&1 || { echo "SKIP: node required";    exit 0; }
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required"; exit 0; }
command -v git     >/dev/null 2>&1 || { echo "SKIP: git required";     exit 0; }
[ -f "$CLI_JS" ] || { echo "SKIP: dispatch CLI not built ($CLI_JS) — run pnpm -C packages/dispatch build"; exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/e2e-spec-to-done.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
DB="$WORK/dispatch.sqlite"
REPO="$WORK/repo"
export GAFFER_DATA="$WORK"

wg()   { node "$CLI_JS" --db "$DB" "$@"; }
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }
status_of()    { wg ticket show "$1" 2>/dev/null | jget "d['ticket']['status']" 2>/dev/null || echo ''; }
ac_status_of() { wg ticket show "$1" 2>/dev/null | jget "d['acceptanceCriteria'][0]['status']" 2>/dev/null || echo ''; }
ac_id_of()     { wg ticket show "$1" 2>/dev/null | jget "d['acceptanceCriteria'][0]['id']" 2>/dev/null || echo ''; }

# Read a single clause's coverage field from `spec coverage <id>` JSON. The output
# shape is { clauses:[{clause_id, covered, satisfied, orphan, bounce_count, ...}],
# rollup:{...} }. `clause_field <specId> <clauseId> <field>` prints that field.
clause_field() {
  wg spec coverage "$1" 2>/dev/null | python3 -c "
import sys,json
sid,cid,field=sys.argv[1],sys.argv[2],sys.argv[3]
d=json.load(sys.stdin)
c=next((x for x in d['clauses'] if x['clause_id']==cid),None)
print('' if c is None else c[field])
" "$1" "$2" "$3"
}
rollup_field() {
  wg spec coverage "$1" 2>/dev/null | jget "d['rollup']['$2']"
}
orphan_has() {
  wg spec coverage "$1" 2>/dev/null | python3 -c "
import sys,json
print('yes' if sys.argv[1] in json.load(sys.stdin)['rollup']['orphans'] else 'no')
" "$2"
}

# ── A real on-disk git repo, main branch + a passing test command ────────────
git init -q -b main "$REPO"
git -C "$REPO" config user.email gaffer@test
git -C "$REPO" config user.name gaffer-test
mkdir -p "$REPO/src"
printf 'export const x = 1;\n' > "$REPO/src/x.ts"
git -C "$REPO" add -A
git -C "$REPO" commit -qm "init"

# ── The STUB agent (no tokens spent): commits a trivial change + records AC evidence ─
STUB="$WORK/stub-claude.sh"
cat > "$STUB" <<'STUBSH'
#!/usr/bin/env bash
set -uo pipefail
# env contract: WT, TICKET, AC_ID, CLI_JS, DB, GAFFER_CLAIM_TOKEN
printf '// delivered by stub agent for %s\n' "$TICKET" >> "$WT/src/x.ts"
git -C "$WT" add -A
git -C "$WT" commit -qm "stub: deliver $TICKET"
node "$CLI_JS" --db "$DB" evidence "$TICKET" --token "$GAFFER_CLAIM_TOKEN" \
  --type test_output --summary "stub agent: tests pass for $TICKET" --ac "$AC_ID" >/dev/null 2>&1
printf '{"type":"result","subtype":"success","is_error":false,"result":"delivered %s"}\n' "$TICKET"
STUBSH
chmod +x "$STUB"

wg init >/dev/null 2>&1
wg repo add -n demo --path "$REPO" --branch main --test "true" >/dev/null 2>&1

echo "== SPEC: author + freeze a spec with three clauses =="
SPEC_DOC="$WORK/spec.json"
cat > "$SPEC_DOC" <<'JSON'
{
  "title": "Checkout redesign",
  "brief": "Rework the checkout flow",
  "clauses": [
    { "clause_id": "R-green", "kind": "requirement", "text": "User can pay with a saved card" },
    { "clause_id": "R-open",  "kind": "requirement", "text": "Refunds are processed within 24h" },
    { "clause_id": "N-gap",   "kind": "non-goal",    "text": "No crypto payments" }
  ]
}
JSON
SPEC_ID="$(wg spec create "$SPEC_DOC" 2>/dev/null | jget "d['spec']['id']")"
[ -n "$SPEC_ID" ] && ok "created draft spec ($SPEC_ID)" || { fail "spec create failed"; }
FROZEN="$(wg spec freeze "$SPEC_ID" 2>/dev/null | jget "d['spec']['status']")"
[ "$FROZEN" = "frozen" ] && ok "spec frozen (immutable snapshot)" || fail "spec did not freeze (got '$FROZEN')"

echo "== BASELINE: before any ticket, every clause is an orphan (gap report) =="
[ "$(rollup_field "$SPEC_ID" total)" = "3" ] && ok "coverage sees all 3 clauses" || fail "expected total=3"
[ "$(rollup_field "$SPEC_ID" covered)" = "0" ] && ok "0 clauses covered at baseline" || fail "expected covered=0 at baseline"
[ "$(orphan_has "$SPEC_ID" R-green)" = "yes" ] && ok "R-green starts in the gap report" || fail "R-green not orphan at baseline"

echo "== TICKETS: create two tickets whose ACs carry clause provenance =="
# T1 → R-green (will be delivered GREEN). T2 → R-open (delivery rejected → OPEN).
NUM1="$(wg ticket create -t "Saved-card payment" --description "pay with a saved card" --policy team_light --risk low 2>/dev/null | jget "d['ticket']['number']")"
wg ac add "$NUM1" -t "pays with saved card" --clause R-green >/dev/null 2>&1
wg ticket repo-access set "$NUM1" demo --access write --relation confirmed >/dev/null 2>&1
NUM2="$(wg ticket create -t "Refund worker" --description "process refunds" --policy team_light --risk low 2>/dev/null | jget "d['ticket']['number']")"
wg ac add "$NUM2" -t "refund within 24h" --clause R-open >/dev/null 2>&1
wg ticket repo-access set "$NUM2" demo --access write --relation confirmed >/dev/null 2>&1
[ -n "$NUM1" ] && [ -n "$NUM2" ] && ok "created #$NUM1 (→R-green) and #$NUM2 (→R-open)" || fail "ticket/AC setup failed"

echo "== both clauses are now COVERED but not yet satisfied (OPEN) =="
[ "$(clause_field "$SPEC_ID" R-green covered)" = "True" ] && ok "R-green is covered once its AC exists" || fail "R-green not covered after AC add"
[ "$(clause_field "$SPEC_ID" R-green satisfied)" = "False" ] && ok "R-green still OPEN before delivery" || fail "R-green wrongly satisfied before delivery"
[ "$(orphan_has "$SPEC_ID" R-green)" = "no" ] && ok "R-green left the gap report once covered" || fail "R-green still orphan after AC add"

echo "== DELIVER #$NUM1: the RUNNER claims; the STUB agent satisfies R-green's AC =="
AGENT="$(wg agent register -n gaffer-factory --max-risk high 2>/dev/null | jget "d['agent']['id']")"
wg ticket ready "$NUM1" >/dev/null 2>&1
[ "$(status_of "$NUM1")" = "ready" ] && ok "#$NUM1 reached ready" || fail "#$NUM1 not ready (got '$(status_of "$NUM1")')"
TOK1="$(wg claim-ticket "$NUM1" --agent "$AGENT" --ttl 900 2>/dev/null | jget "d['claimToken']")"
AC1="$(ac_id_of "$NUM1")"
BR1="gaffer/t$NUM1"; WT1="$WORK/wt-$NUM1"
git -C "$REPO" worktree add -q -b "$BR1" "$WT1" main
( export WT="$WT1" TICKET="$NUM1" AC_ID="$AC1" CLI_JS DB GAFFER_CLAIM_TOKEN="$TOK1"
  "$STUB" -p "deliver #$NUM1" >/dev/null 2>&1 )
[ "$(ac_status_of "$NUM1")" = "satisfied" ] && ok "#$NUM1's AC satisfied by token-scoped evidence" || fail "#$NUM1 AC not satisfied (got '$(ac_status_of "$NUM1")')"

echo "== COVERAGE: R-green now shows GREEN (covered + satisfied) =="
[ "$(clause_field "$SPEC_ID" R-green satisfied)" = "True" ] && ok "R-green is GREEN (satisfied)" || fail "R-green not satisfied after delivery"

echo "== REJECT #$NUM2: its delivery is refused → R-open stays OPEN =="
# Claim then RELEASE the delivery to the visible blocked column (rework exhausted):
# the AC is never satisfied, so the clause it covers must remain OPEN.
wg ticket ready "$NUM2" >/dev/null 2>&1
TOK2="$(wg claim-ticket "$NUM2" --agent "$AGENT" --ttl 900 2>/dev/null | jget "d['claimToken']")"
wg runner-release "$NUM2" --to blocked --token "$TOK2" --reason "rejected in review" --reason-code rework_exhausted --attempt 3 --max 3 >/dev/null 2>&1
[ "$(status_of "$NUM2")" = "blocked" ] && ok "#$NUM2 parked to blocked (rejected delivery)" || fail "#$NUM2 not blocked (got '$(status_of "$NUM2")')"
[ "$(clause_field "$SPEC_ID" R-open covered)" = "True" ] && ok "R-open remains covered" || fail "R-open lost coverage"
[ "$(clause_field "$SPEC_ID" R-open satisfied)" = "False" ] && ok "R-open stays OPEN after the rejected delivery" || fail "R-open wrongly satisfied"

echo "== BOUNCE: a rework attempt on #$NUM1's ticket joins to R-green as a bounce =="
# Record one rework attempt against #$NUM1's ticket, then assert the coverage read
# model joins it to R-green via the AC's ticket ("requirement bounced N×").
python3 - "$DB" "$NUM1" <<'PY'
import sqlite3,sys,uuid
db,num=sys.argv[1],int(sys.argv[2]); c=sqlite3.connect(db)
tid=c.execute("SELECT id FROM tickets WHERE number=?",(num,)).fetchone()[0]
c.execute("INSERT INTO rework_attempts (id,ticket_id,attempt,max_attempts,gate,distilled_failure,ac_id,created_at)"
          " VALUES (?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
          (str(uuid.uuid4()),tid,1,3,'tests','assert failed',None))
c.commit()
PY
[ "$(clause_field "$SPEC_ID" R-green bounce_count)" = "1" ] && ok "R-green bounce_count = 1 (rework trail joined via the AC's ticket)" || fail "R-green bounce_count wrong (got '$(clause_field "$SPEC_ID" R-green bounce_count)')"

echo "== NEGATIVE CONTROL: N-gap has no ticket → orphan in the gap report =="
[ "$(clause_field "$SPEC_ID" N-gap orphan)" = "True" ] && ok "N-gap is an orphan (no covering AC)" || fail "N-gap not orphan"
[ "$(clause_field "$SPEC_ID" N-gap covered)" = "False" ] && ok "N-gap is not counted covered" || fail "N-gap wrongly counted covered"
[ "$(orphan_has "$SPEC_ID" N-gap)" = "yes" ] && ok "N-gap surfaces in the rollup gap report" || fail "N-gap missing from the gap report"

echo "== ROLLUP: 3 clauses, 2 covered, 1 satisfied, 1 gap =="
[ "$(rollup_field "$SPEC_ID" covered)" = "2" ] && ok "rollup covered = 2" || fail "rollup covered wrong (got '$(rollup_field "$SPEC_ID" covered)')"
[ "$(rollup_field "$SPEC_ID" satisfied)" = "1" ] && ok "rollup satisfied = 1" || fail "rollup satisfied wrong (got '$(rollup_field "$SPEC_ID" satisfied)')"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "e2e-spec-to-done: ALL $PASS checks passed"
  exit 0
fi
echo "e2e-spec-to-done: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
