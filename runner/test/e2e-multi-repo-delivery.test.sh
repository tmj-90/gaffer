#!/usr/bin/env bash
# =====================================================================
# E2E — MULTI-REPO DELIVERY: one ticket, write access to TWO repos.
# ---------------------------------------------------------------------
# A ticket that spans two repositories must deliver a change into BOTH, gate BOTH,
# and record a delivery branch for EACH — while remaining ONE claim and ONE submission
# for the whole ticket (not one-per-repo). That contract is implemented across tick.sh's
# per-write-repo worktree loop + per-repo DoD gate + the dispatch multi-repo delivery
# model, but nothing pins the WHOLE-TICKET multi-repo outcome end to end. This drives it
# against a REAL dispatch DB + TWO real on-disk git repos + the REAL DoD gate, with a
# STUB agent (a real commit in each worktree; no model, no spend).
#
# Asserts:
#   • the ticket carries WRITE access to both repos and reaches ready under ONE claim;
#   • the stub delivers a REAL, distinct committed diff in BOTH repos' worktrees
#     (two delivery branches, one per repo);
#   • the REAL DoD gate (lib/dod.sh) runs per-repo and PASSES for BOTH repos in a single
#     gate pass (the exact multi-row shape tick.sh feeds it);
#   • TWO per-repo deliveries are recorded in dispatch (ticket_repo_delivery has a row
#     with a branch for EACH repo);
#   • ONE submission completes the ticket: it holds exactly ONE claim across the whole
#     multi-repo delivery, and a single `wg submit` moves it claimed → in_review with the
#     claim completed (zero active claims) — not a submit-per-repo.
#
# Requires the dispatch CLI built + git. SKIPs (exit 0) otherwise.
# Run: bash test/e2e-multi-repo-delivery.test.sh    (also green under /bin/bash 3.2)
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

WORK="$(mktemp -d "${TMPDIR:-/tmp}/e2e-multirepo.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
DB="$WORK/dispatch.sqlite"
export GAFFER_DATA="$WORK"

gaffer_timeout() { shift; "$@"; return $?; }
export HYGIENE_FORBIDDEN_PATHS="node_modules .crew/ *.events.jsonl"
# shellcheck source=../lib/dod.sh
source "$RUNNER_DIR/lib/dod.sh"
# shellcheck source=../lib/hygiene.sh
source "$RUNNER_DIR/lib/hygiene.sh"

wg()   { node "$CLI_JS" --db "$DB" "$@"; }
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }
status_of() { wg ticket show "$1" 2>/dev/null | jget "d['ticket']['status']" 2>/dev/null || echo ''; }
active_claims() {
  python3 - "$DB" "$1" <<'PY'
import sqlite3,sys
db,num=sys.argv[1],int(sys.argv[2]); c=sqlite3.connect(db)
print(c.execute("SELECT count(*) FROM ticket_claims tc JOIN tickets t ON t.id=tc.ticket_id "
                "WHERE t.number=? AND tc.status='active'",(num,)).fetchone()[0])
PY
}
claims_total() {
  python3 - "$DB" "$1" <<'PY'
import sqlite3,sys
db,num=sys.argv[1],int(sys.argv[2]); c=sqlite3.connect(db)
print(c.execute("SELECT count(*) FROM ticket_claims tc JOIN tickets t ON t.id=tc.ticket_id "
                "WHERE t.number=?",(num,)).fetchone()[0])
PY
}
delivery_records() {  # per-repo delivery rows (one per repo) carrying a branch for the ticket
  python3 - "$DB" "$1" <<'PY'
import sqlite3,sys
db,num=sys.argv[1],int(sys.argv[2]); c=sqlite3.connect(db)
# One row per (ticket, repo); count the DISTINCT repos with a recorded delivery branch —
# proving the multi-repo ticket recorded a delivery for EACH repo, not that the branch
# strings differ (both repos legitimately use the same gaffer/t<N> branch name).
print(c.execute("SELECT count(DISTINCT trd.repo_id) FROM ticket_repo_delivery trd "
                "JOIN tickets t ON t.id=trd.ticket_id "
                "WHERE t.number=? AND trd.branch_name IS NOT NULL AND trd.branch_name<>''",(num,)).fetchone()[0])
PY
}

# ── Two real on-disk git repos, each main + a passing test command ────────────
make_repo() {  # $1 dir
  git init -q -b main "$1"
  git -C "$1" config user.email gaffer@test
  git -C "$1" config user.name gaffer-test
  mkdir -p "$1/src"
  printf 'export const base = 0;\n' > "$1/src/mod.ts"
  git -C "$1" add -A
  git -C "$1" commit -qm "init"
}
REPO_A="$WORK/repoA"; REPO_B="$WORK/repoB"
make_repo "$REPO_A"
make_repo "$REPO_B"

# ── STUB agent: a real committed change in whatever worktree it is cd'd into ────
STUB="$WORK/stub-claude.sh"
cat > "$STUB" <<'STUBSH'
#!/usr/bin/env bash
set -uo pipefail
# env contract: WT, TICKET, AC_ID, CLI_JS, DB, GAFFER_CLAIM_TOKEN, MARK
printf '// %s change for %s\n' "$MARK" "$TICKET" >> "$WT/src/mod.ts"
git -C "$WT" add -A
git -C "$WT" commit -qm "stub: $MARK deliver $TICKET"
node "$CLI_JS" --db "$DB" evidence "$TICKET" --token "$GAFFER_CLAIM_TOKEN" \
  --type test_output --summary "stub: $MARK done for $TICKET" --ac "$AC_ID" >/dev/null 2>&1
printf '{"type":"result","subtype":"success","is_error":false,"result":"delivered %s in %s"}\n' "$TICKET" "$MARK"
STUBSH
chmod +x "$STUB"

echo "== SETUP: one ticket with WRITE access to TWO repos, one claim =="
wg init >/dev/null 2>&1
wg repo add -n repoA --path "$REPO_A" --branch main --test "true" >/dev/null 2>&1
wg repo add -n repoB --path "$REPO_B" --branch main --test "true" >/dev/null 2>&1
NUM="$(wg ticket create -t "spans two repos" --description "one ticket, two write repos" --policy team_light --risk low 2>/dev/null | jget "d['ticket']['number']")"
ACID="$(wg ac add "$NUM" -t "both repos updated" 2>/dev/null | jget "d['ac_id']")"
wg ticket repo-access set "$NUM" repoA --access write --relation confirmed >/dev/null 2>&1
wg ticket repo-access set "$NUM" repoB --access write --relation confirmed >/dev/null 2>&1
WRITE_REPOS="$(wg ticket show "$NUM" 2>/dev/null | jget "len([r for r in d.get('repositories',[]) if r.get('access')=='write'])" 2>/dev/null || echo 0)"
[ "$WRITE_REPOS" = "2" ] && ok "ticket #$NUM has WRITE access to both repos" || fail "expected 2 write repos, got $WRITE_REPOS"
wg ticket ready "$NUM" >/dev/null 2>&1
[ "$(status_of "$NUM")" = "ready" ] && ok "#$NUM is ready (multi-repo ready gate satisfied)" || fail "#$NUM not ready (got '$(status_of "$NUM")')"
AGENT="$(wg agent register -n gaffer-factory --max-risk high 2>/dev/null | jget "d['agent']['id']")"
TOKEN="$(wg claim-ticket "$NUM" --agent "$AGENT" --ttl 900 2>/dev/null | jget "d['claimToken']")"
{ [ -n "$TOKEN" ] && [ "$(active_claims "$NUM")" = "1" ]; } \
  && ok "the runner holds ONE claim for the whole multi-repo ticket" \
  || fail "expected exactly one active claim (got $(active_claims "$NUM"))"

echo "== DELIVER: the stub commits a REAL change in EACH repo's worktree =="
BRANCH="gaffer/t$NUM"
WT_A="$WORK/wt-A-$NUM"; WT_B="$WORK/wt-B-$NUM"
git -C "$REPO_A" worktree add -q -b "$BRANCH" "$WT_A" main
git -C "$REPO_B" worktree add -q -b "$BRANCH" "$WT_B" main
( export WT="$WT_A" TICKET="$NUM" AC_ID="$ACID" CLI_JS DB GAFFER_CLAIM_TOKEN="$TOKEN" MARK="repoA"; "$STUB" -p "x" >/dev/null 2>&1 )
( export WT="$WT_B" TICKET="$NUM" AC_ID="$ACID" CLI_JS DB GAFFER_CLAIM_TOKEN="$TOKEN" MARK="repoB"; "$STUB" -p "x" >/dev/null 2>&1 )
DA="$(git -C "$WT_A" diff --numstat main...HEAD | wc -l | tr -d ' ')"
DB_LINES="$(git -C "$WT_B" diff --numstat main...HEAD | wc -l | tr -d ' ')"
{ [ "$DA" -ge 1 ] && [ "$DB_LINES" -ge 1 ]; } \
  && ok "TWO worktrees each carry a real committed diff vs main (delivered to both repos)" \
  || fail "expected a diff in both worktrees (A=$DA B=$DB_LINES)"

echo "== GATES: the REAL DoD gate runs per-repo and PASSES for BOTH =="
DOD="$WORK/dod.results"
# The exact multi-row shape tick.sh feeds the gate: one TAB row per write repo.
printf 'repoA\t%s\t1\t0\t0\ttrue\t-\t-\nrepoB\t%s\t1\t0\t0\ttrue\t-\t-\n' "$WT_A" "$WT_B" \
  | gaffer_run_dod_gates "$DOD"; DRC=$?
{ [ "$DRC" -eq 0 ] && grep -q 'GATE	tests	repoA	PASS' "$DOD" && grep -q 'GATE	tests	repoB	PASS' "$DOD"; } \
  && ok "DoD gate PASSED for BOTH repos in one pass (repoA + repoB tests gate)" \
  || fail "DoD gate did not pass for both (rc=$DRC): $(cat "$DOD" 2>/dev/null | tr '\n' '|')"

echo "== RECORD: a per-repo delivery is recorded for EACH repo =="
wg ticket repo-delivery record "$NUM" repoA --branch "$BRANCH" >/dev/null 2>&1
wg ticket repo-delivery record "$NUM" repoB --branch "$BRANCH" >/dev/null 2>&1
[ "$(delivery_records "$NUM")" = "2" ] \
  && ok "TWO per-repo deliveries recorded in dispatch (a delivery branch for each repo)" \
  || fail "expected 2 recorded per-repo deliveries, got $(delivery_records "$NUM")"

echo "== SUBMIT: ONE submission completes the whole-ticket claim → in_review =="
wg submit "$NUM" --token "$TOKEN" --reason "both repos delivered + gated" >/dev/null 2>&1
[ "$(status_of "$NUM")" = "in_review" ] \
  && ok "a SINGLE submit moved #$NUM claimed → in_review (not a submit-per-repo)" \
  || fail "#$NUM not in_review after submit (got '$(status_of "$NUM")')"
[ "$(claims_total "$NUM")" = "1" ] \
  && ok "exactly ONE claim existed for the whole multi-repo delivery (not one-per-repo)" \
  || fail "expected 1 total claim on the ticket, got $(claims_total "$NUM")"
[ "$(active_claims "$NUM")" = "0" ] \
  && ok "the single submission completed the claim (zero active claims)" \
  || fail "claim not completed after submit (active=$(active_claims "$NUM"))"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "e2e-multi-repo-delivery: ALL $PASS checks passed"
  exit 0
fi
echo "e2e-multi-repo-delivery: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
