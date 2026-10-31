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
#     claim completed (zero active claims) — not a submit-per-repo;
#   • (external review #2/#3) the approval names BOTH repos' head commits (a stale or
#     commit-less approval is refused), and the ticket is done only when BOTH default
#     branches carry their change — a partial landing is held, and a retry lands the
#     remaining repo without re-merging the landed one (dashboard Merge path, then the
#     merge lane's lib/land.sh path for a second ticket).
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
jget() { node "$RUNNER_DIR/lib/json-tool.mjs" expr "$1"; }
status_of() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status' 2>/dev/null || echo ''; }
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
NUM="$(wg ticket create -t "spans two repos" --description "one ticket, two write repos" --policy team_light --risk low 2>/dev/null | jget 'd.ticket.number')"
ACID="$(wg ac add "$NUM" -t "both repos updated" 2>/dev/null | jget 'd.ac_id')"
wg ticket repo-access set "$NUM" repoA --access write --relation confirmed >/dev/null 2>&1
wg ticket repo-access set "$NUM" repoB --access write --relation confirmed >/dev/null 2>&1
WRITE_REPOS="$(wg ticket show "$NUM" 2>/dev/null | jget '(d.repositories || []).filter((r) => r.access === "write").length' 2>/dev/null || echo 0)"
[ "$WRITE_REPOS" = "2" ] && ok "ticket #$NUM has WRITE access to both repos" || fail "expected 2 write repos, got $WRITE_REPOS"
wg ticket ready "$NUM" >/dev/null 2>&1
[ "$(status_of "$NUM")" = "ready" ] && ok "#$NUM is ready (multi-repo ready gate satisfied)" || fail "#$NUM not ready (got '$(status_of "$NUM")')"
AGENT="$(wg agent register -n gaffer-factory --max-risk high 2>/dev/null | jget 'd.agent.id')"
TOKEN="$(wg claim-ticket "$NUM" --agent "$AGENT" --ttl 900 2>/dev/null | jget 'd.claimToken')"
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

# ── External review #2 + #3: approve what was shown, land EVERY repo ──────────
# The steelman: one extension through approval exposes a ticket marked done after ONE
# repo's merge. The landing path here is bin/merge-ticket.mjs (the dashboard's Merge,
# `gaffer merge`), then lib/land.sh (the merge lane / AFK review pass) for a second ticket.
echo "== APPROVE: the approval names the head commit of BOTH repos =="
HEADS="$(wg ticket diff "$NUM" --heads 2>/dev/null)"
[ "$(printf '%s\n' "$HEADS" | grep -c '=')" = "2" ] \
  && ok "ticket diff reports one head per write repo" || fail "expected two heads, got: $HEADS"
OLD_A="$(git -C "$REPO_A" rev-parse "$BRANCH")"
# A commit lands on repoA's branch AFTER the heads were read: the approval is refused.
( cd "$WT_A" && printf '// late\n' >> src/mod.ts && git add -A && git commit -qm "late, unreviewed" )
STALE_ERR="$(wg review approve "$NUM" --reviewer human1 --commit "repoA=$OLD_A" --commit "repoB=$(git -C "$REPO_B" rev-parse "$BRANCH")" 2>&1 >/dev/null)"
case "$STALE_ERR" in *stale_revision*) ok "an approval of a commit the branch moved past is refused (stale_revision)" ;; *) fail "stale approval not refused: $STALE_ERR" ;; esac
[ "$(status_of "$NUM")" = "in_review" ] && ok "the refused approval approved nothing (still in_review)" || fail "status after stale approve: $(status_of "$NUM")"
NOCOMMIT_ERR="$(wg review approve "$NUM" --reviewer human1 2>&1 >/dev/null)"
case "$NOCOMMIT_ERR" in *revision_required*) ok "an approval that names no commit is refused (revision_required)" ;; *) fail "commit-less approval not refused: $NOCOMMIT_ERR" ;; esac
HA="$(git -C "$REPO_A" rev-parse "$BRANCH")"; HB="$(git -C "$REPO_B" rev-parse "$BRANCH")"
wg review approve "$NUM" --reviewer human1 --commit "repoA=$HA" --commit "repoB=$HB" >/dev/null 2>&1
[ "$(status_of "$NUM")" = "ready_for_merge" ] && ok "approving the current heads of both repos → ready_for_merge" || fail "approve failed (status $(status_of "$NUM"))"
PINS="$(wg ticket landing "$NUM" 2>/dev/null | jget '(d.repos||[]).length')"
[ "$PINS" = "2" ] && ok "the approval pinned BOTH repos' commits" || fail "expected 2 approved revisions, got $PINS"

echo "== LAND (dashboard Merge path): repoB's checkout is dirty → PARTLY MERGED, held =="
git -C "$REPO_A" worktree remove --force "$WT_A" >/dev/null 2>&1; git -C "$REPO_B" worktree remove --force "$WT_B" >/dev/null 2>&1
printf 'operator edit\n' >> "$REPO_B/src/mod.ts"   # an uncommitted edit in repoB's live checkout
MT() { env DISPATCH_DB="$DB" GAFFER_DATA="$WORK" CLAUDE_BIN=/bin/false node "$RUNNER_DIR/bin/merge-ticket.mjs" --ticket "$NUM" 2>>"$WORK/merge.log"; }
OUT1="$(MT)"; RC1=$?
[ "$RC1" -eq 4 ] && [ "$(printf '%s' "$OUT1" | jget 'd.phase')" = "partially_merged" ] \
  && ok "the merge lands repoA, refuses repoB, and reports partially_merged (exit 4)" || fail "first merge: rc=$RC1 out=$OUT1"
git -C "$REPO_A" merge-base --is-ancestor "$HA" main && ok "repoA's main carries its approved change" || fail "repoA main lacks $HA"
git -C "$REPO_B" merge-base --is-ancestor "$HB" main && fail "repoB landed despite the dirty checkout" || ok "repoB's main does not have it yet"
[ "$(status_of "$NUM")" = "ready_for_merge" ] && ok "a partial landing is NOT done: the ticket stays ready_for_merge" || fail "ticket after partial landing: $(status_of "$NUM")"
QLABEL="$(wg human-queue --json 2>/dev/null | N="$NUM" jget '((d.items||[]).find(i => i.ticket && String(i.ticket.number) === process.env.N) || {}).label || ""')"
[ "$QLABEL" = "Partly merged" ] && ok "the human queue shows the ticket as 'Partly merged'" || fail "human queue label: '$QLABEL'"
LABEL="$(wg ticket landing "$NUM" 2>/dev/null | jget 'd.partial ? "partial" : "not-partial"')"
[ "$LABEL" = "partial" ] && ok "the landing status reads partial (repoA landed, repoB pending)" || fail "landing status: $LABEL"
MM_ERR="$(wg ticket mark-merged "$NUM" --as system 2>&1 >/dev/null)"
case "$MM_ERR" in *partial_landing*) ok "mark-merged is refused while repoB has not landed" ;; *) fail "mark-merged was not refused: $MM_ERR" ;; esac
A_MERGES="$(git -C "$REPO_A" rev-list --merges --count main)"

echo "== RETRY: the operator cleans repoB; a second run lands ONLY repoB =="
git -C "$REPO_B" checkout -q -- src/mod.ts
OUT2="$(MT)"; RC2=$?
[ "$RC2" -eq 0 ] && [ "$(printf '%s' "$OUT2" | jget 'd.phase')" = "merged" ] && ok "the retry merges and reports merged" || fail "retry: rc=$RC2 out=$OUT2"
git -C "$REPO_B" merge-base --is-ancestor "$HB" main && ok "repoB's main now carries its approved change" || fail "repoB main lacks $HB"
git -C "$REPO_A" merge-base --is-ancestor "$HA" main && ok "repoA's main still carries its change" || fail "repoA main lost $HA"
[ "$(git -C "$REPO_A" rev-list --merges --count main)" = "$A_MERGES" ] && ok "repoA was NOT merged a second time" || fail "repoA re-merged on the retry"
[ "$(status_of "$NUM")" = "done" ] && ok "with BOTH repos landed the ticket is done" || fail "ticket after full landing: $(status_of "$NUM")"
grep -q "MERGE GATE PASS .* in repoB passes the gates" "$WORK/merge.log" \
  && ok "repoB's landing went through the merge gate on its current main (dashboard path)" \
  || fail "no merge-gate pass for repoB in merge.log: $(tr '\n' '|' < "$WORK/merge.log" | cut -c1-400)"

echo "== LAND (merge lane path, lib/land.sh): a second two-repo ticket lands in both repos =="
N2="$(wg ticket create -t "second spanning ticket" --description "lane path" --policy team_light --risk low 2>/dev/null | jget 'd.ticket.number')"
AC2="$(wg ac add "$N2" -t "both" 2>/dev/null | jget 'd.ac_id')"
wg ticket repo-access set "$N2" repoA --access write --relation confirmed >/dev/null 2>&1
wg ticket repo-access set "$N2" repoB --access write --relation confirmed >/dev/null 2>&1
wg ticket ready "$N2" >/dev/null 2>&1
TOK2="$(wg claim-ticket "$N2" --agent "$AGENT" --ttl 900 2>/dev/null | jget 'd.claimToken')"
BR2="gaffer/t$N2"
git -C "$REPO_A" worktree add -q -b "$BR2" "$WORK/wt2A" main; git -C "$REPO_B" worktree add -q -b "$BR2" "$WORK/wt2B" main
( export WT="$WORK/wt2A" TICKET="$N2" AC_ID="$AC2" CLI_JS DB GAFFER_CLAIM_TOKEN="$TOK2" MARK="laneA"; "$STUB" -p x >/dev/null 2>&1 )
( export WT="$WORK/wt2B" TICKET="$N2" AC_ID="$AC2" CLI_JS DB GAFFER_CLAIM_TOKEN="$TOK2" MARK="laneB"; "$STUB" -p x >/dev/null 2>&1 )
git -C "$REPO_A" worktree remove --force "$WORK/wt2A" >/dev/null 2>&1; git -C "$REPO_B" worktree remove --force "$WORK/wt2B" >/dev/null 2>&1
wg ticket repo-delivery record "$N2" repoA --branch "$BR2" >/dev/null 2>&1
wg ticket repo-delivery record "$N2" repoB --branch "$BR2" >/dev/null 2>&1
wg submit "$N2" --token "$TOK2" --reason "both" >/dev/null 2>&1
H2A="$(git -C "$REPO_A" rev-parse "$BR2")"; H2B="$(git -C "$REPO_B" rev-parse "$BR2")"
# shellcheck disable=SC2046
wg review approve "$N2" --reviewer human1 $(wg ticket diff "$N2" --heads 2>/dev/null | sed 's/^/--commit /') >/dev/null 2>&1
LANE_LOG="$WORK/lane.log"
(
  log() { printf '%s\n' "$*" >> "$LANE_LOG"; }
  gaffer_refresh_cards() { :; }
  _gaffer_flag_on() { case "${1:-}" in 1|true|yes|on) return 0 ;; *) return 1 ;; esac; }
  export DISPATCH_DB="$DB" GAFFER_DIGEST_DISABLE=1 RUNNER_DIR
  # shellcheck source=../lib/automerge.sh
  source "$RUNNER_DIR/lib/automerge.sh"
  # shellcheck source=../lib/land.sh
  source "$RUNNER_DIR/lib/land.sh"
  gaffer_land_delivery "$N2" "$REPO_A" "$BR2" main "$(wg ticket show "$N2" 2>/dev/null)" MERGE
) ; LRC=$?
[ "$LRC" -eq 0 ] && ok "gaffer_land_delivery returned 0 (landed)" || fail "lane landing rc=$LRC: $(tr '\n' '|' < "$LANE_LOG")"
git -C "$REPO_A" merge-base --is-ancestor "$H2A" main && git -C "$REPO_B" merge-base --is-ancestor "$H2B" main \
  && ok "the merge lane landed the change on BOTH repos' default branches" || fail "lane landing missed a repo: $(tr '\n' '|' < "$LANE_LOG")"
[ "$(status_of "$N2")" = "done" ] && ok "the lane marked the two-repo ticket done only after both landed" || fail "lane ticket status: $(status_of "$N2")"
[ "$(grep -c "MERGE GATE PASS" "$LANE_LOG")" = "2" ] \
  && ok "the lane gated EACH repo's merge on its current main (two merge-gate passes)" \
  || fail "expected two merge-gate passes in the lane log: $(tr '\n' '|' < "$LANE_LOG")"

echo "== MERGE GATE on a SECONDARY repo (lane path): repoB's combination is red → held =="
# Each side passes alone; the combination fails repoB's gate: the branch adds combo-a, and
# after the approval main gains combo-b. repoA (primary) lands and is recorded; repoB's
# main is untouched and the ticket is held for a human (blocked, merge_gate_red).
N3="$(wg ticket create -t "third spanning ticket" --description "secondary gate red" --policy team_light --risk low 2>/dev/null | jget 'd.ticket.number')"
AC3="$(wg ac add "$N3" -t "both" 2>/dev/null | jget 'd.ac_id')"
wg ticket repo-access set "$N3" repoA --access write --relation confirmed >/dev/null 2>&1
wg ticket repo-access set "$N3" repoB --access write --relation confirmed >/dev/null 2>&1
wg ticket ready "$N3" >/dev/null 2>&1
TOK3="$(wg claim-ticket "$N3" --agent "$AGENT" --ttl 900 2>/dev/null | jget 'd.claimToken')"
BR3="gaffer/t$N3"
git -C "$REPO_A" worktree add -q -b "$BR3" "$WORK/wt3A" main; git -C "$REPO_B" worktree add -q -b "$BR3" "$WORK/wt3B" main
( export WT="$WORK/wt3A" TICKET="$N3" AC_ID="$AC3" CLI_JS DB GAFFER_CLAIM_TOKEN="$TOK3" MARK="gateA"; "$STUB" -p x >/dev/null 2>&1 )
( export WT="$WORK/wt3B" TICKET="$N3" AC_ID="$AC3" CLI_JS DB GAFFER_CLAIM_TOKEN="$TOK3" MARK="gateB"; "$STUB" -p x >/dev/null 2>&1 )
( cd "$WORK/wt3B" && : > combo-a && git add combo-a && git commit -qm "branch side of the combination" )
git -C "$REPO_A" worktree remove --force "$WORK/wt3A" >/dev/null 2>&1; git -C "$REPO_B" worktree remove --force "$WORK/wt3B" >/dev/null 2>&1
wg ticket repo-delivery record "$N3" repoA --branch "$BR3" >/dev/null 2>&1
wg ticket repo-delivery record "$N3" repoB --branch "$BR3" >/dev/null 2>&1
wg submit "$N3" --token "$TOK3" --reason "both" >/dev/null 2>&1
H3A="$(git -C "$REPO_A" rev-parse "$BR3")"; H3B="$(git -C "$REPO_B" rev-parse "$BR3")"
# shellcheck disable=SC2046
wg review approve "$N3" --reviewer human1 $(wg ticket diff "$N3" --heads 2>/dev/null | sed 's/^/--commit /') >/dev/null 2>&1
[ "$(status_of "$N3")" = "ready_for_merge" ] && ok "#$N3 approved in both repos" || fail "#$N3 approve failed (status $(status_of "$N3"))"
( cd "$REPO_B" && : > combo-b && git add combo-b && git commit -qm "main side of the combination" )
wg repo set-commands repoB --test "test ! -f combo-a -o ! -f combo-b" >/dev/null 2>&1
B_MAIN="$(git -C "$REPO_B" rev-parse main)"
LANE3_LOG="$WORK/lane3.log"
(
  log() { printf '%s\n' "$*" >> "$LANE3_LOG"; }
  gaffer_refresh_cards() { :; }
  _gaffer_flag_on() { case "${1:-}" in 1|true|yes|on) return 0 ;; *) return 1 ;; esac; }
  export DISPATCH_DB="$DB" GAFFER_DIGEST_DISABLE=1 RUNNER_DIR
  # shellcheck source=../lib/automerge.sh
  source "$RUNNER_DIR/lib/automerge.sh"
  # shellcheck source=../lib/land.sh
  source "$RUNNER_DIR/lib/land.sh"
  gaffer_land_delivery "$N3" "$REPO_A" "$BR3" main "$(wg ticket show "$N3" 2>/dev/null)" MERGE
) ; L3RC=$?
[ "$L3RC" -eq 4 ] && ok "the lane HELD the ticket (rc 4): repoB's merge gate is red" || fail "lane rc=$L3RC: $(tr '\n' '|' < "$LANE3_LOG")"
git -C "$REPO_A" merge-base --is-ancestor "$H3A" main && ok "the primary repo (repoA) landed first" || fail "repoA main lacks $H3A"
[ "$(git -C "$REPO_B" rev-parse main)" = "$B_MAIN" ] && ! git -C "$REPO_B" merge-base --is-ancestor "$H3B" main \
  && ok "repoB's main is untouched by the red combination" || fail "repoB main moved: $(git -C "$REPO_B" log --oneline -3 main | tr '\n' '|')"
[ "$(status_of "$N3")" = "blocked" ] && ok "the ticket is held for a human (blocked), never done" || fail "#$N3 status: $(status_of "$N3")"
[ "$(wg ticket landing "$N3" 2>/dev/null | jget 'd.partial ? "partial" : "not-partial"')" = "partial" ] \
  && ok "the landing status records repoA landed, repoB pending" || fail "landing status for #$N3: $(wg ticket landing "$N3" 2>/dev/null)"
SHOW3="$(wg ticket show "$N3" 2>/dev/null)"
case "$SHOW3" in *merge_gate_red*) ok "the hold names merge_gate_red" ;; *) fail "no merge_gate_red on #$N3" ;; esac
MM3_ERR="$(wg ticket mark-merged "$N3" --as system 2>&1 >/dev/null)"
[ "$(status_of "$N3")" != "done" ] && ok "mark-merged cannot finish a ticket whose secondary repo never landed" || fail "mark-merged finished #$N3: $MM3_ERR"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "e2e-multi-repo-delivery: ALL $PASS checks passed"
  exit 0
fi
echo "e2e-multi-repo-delivery: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
