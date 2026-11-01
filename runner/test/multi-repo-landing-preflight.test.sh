#!/usr/bin/env bash
# =====================================================================
# MULTI-REPO LANDING PREFLIGHT (exploratory finding cli-runner/F-01, F-11).
# ---------------------------------------------------------------------
# A ticket with write access to two repos is approved with both heads pinned. Then the
# SECONDARY repo's delivery branch moves (a commit nobody reviewed). That fault is
# knowable before anything merges, so every landing path must refuse the WHOLE ticket
# up front: exit 4 / non-zero, nothing merged in EITHER repo, the ticket still
# ready_for_merge, and the refusal names the repo and the exact recovery command. Before
# the fix the primary repo landed first and the ticket was left partly merged.
#   1. bin/merge-ticket.mjs (the dashboard's Merge now, `gaffer merge`)
#   2. lib/land.sh gaffer_land_delivery (the merge lane / AFK review pass)
#   3. the named recovery (reopen-for-review, approve the new heads) lands both repos.
# A secondary repo with NO approved commit is refused the same way (nothing lands).
#
# Requires the dispatch CLI built + git. SKIPs (exit 0) otherwise. bash 3.2 compatible.
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CLI_JS="$ROOT/packages/dispatch/dist/cli/index.js"

command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git  >/dev/null 2>&1 || { echo "SKIP: git required";  exit 0; }
[ -f "$CLI_JS" ] || { echo "SKIP: dispatch CLI not built ($CLI_JS) — run pnpm -C packages/dispatch build"; exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(gaffer_test_tmpdir multi-repo-preflight)" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
DB="$WORK/dispatch.sqlite"
export GAFFER_DATA="$WORK"

wg()   { node "$CLI_JS" --db "$DB" "$@"; }
jget() { node "$RUNNER_DIR/lib/json-tool.mjs" expr "$1"; }
status_of() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status' 2>/dev/null || echo ''; }

make_repo() {
  git init -q -b main "$1"
  git -C "$1" config user.email gaffer@test
  git -C "$1" config user.name gaffer-test
  mkdir -p "$1/src"
  printf 'export const base = 0;\n' > "$1/src/mod.ts"
  git -C "$1" add -A
  git -C "$1" commit -qm "init"
}
REPO_A="$WORK/repoA"; REPO_B="$WORK/repoB"
make_repo "$REPO_A"; make_repo "$REPO_B"

wg init >/dev/null 2>&1
wg repo add -n repoA --path "$REPO_A" --branch main --test "true" >/dev/null 2>&1
wg repo add -n repoB --path "$REPO_B" --branch main --test "true" >/dev/null 2>&1
AGENT="$(wg agent register -n gaffer-factory --max-risk high 2>/dev/null | jget 'd.agent.id')"

# commit_on <repo> <branch> <text>: one commit on <branch> (created from main when new),
# leaving main checked out and the tree clean.
commit_on() {
  if git -C "$1" rev-parse --verify --quiet "refs/heads/$2" >/dev/null; then
    git -C "$1" checkout -q "$2"
  else
    git -C "$1" checkout -q -b "$2" main
  fi
  printf '// %s\n' "$3" >> "$1/src/mod.ts"
  git -C "$1" add -A
  git -C "$1" commit -qm "$3"
  git -C "$1" checkout -q main
}

# deliver_ticket <title> → ticket number, in_review, a commit on gaffer/t<N> in both repos.
deliver_ticket() {
  local n ac tok br
  n="$(wg ticket create -t "$1" --description "two write repos" --policy team_light --risk low 2>/dev/null | jget 'd.ticket.number')"
  ac="$(wg ac add "$n" -t "both repos updated" 2>/dev/null | jget 'd.ac_id')"
  wg ticket repo-access set "$n" repoA --access write --relation confirmed >/dev/null 2>&1
  wg ticket repo-access set "$n" repoB --access write --relation confirmed >/dev/null 2>&1
  wg ticket ready "$n" >/dev/null 2>&1
  tok="$(wg claim-ticket "$n" --agent "$AGENT" --ttl 900 2>/dev/null | jget 'd.claimToken')"
  br="gaffer/t$n"
  commit_on "$REPO_A" "$br" "repoA change for $n"
  commit_on "$REPO_B" "$br" "repoB change for $n"
  wg evidence "$n" --token "$tok" --type test_output --summary "stub done for $n" --ac "$ac" >/dev/null 2>&1
  wg ticket repo-delivery record "$n" repoA --branch "$br" >/dev/null 2>&1
  wg ticket repo-delivery record "$n" repoB --branch "$br" >/dev/null 2>&1
  wg submit "$n" --token "$tok" --reason "both repos delivered" >/dev/null 2>&1
  printf '%s' "$n"
}
approve_heads() {  # $1 ticket
  # shellcheck disable=SC2046
  wg review approve "$1" --reviewer human1 $(wg ticket diff "$1" --heads 2>/dev/null | sed 's/^/--commit /') >/dev/null 2>&1
}

MT() {  # $1 ticket → stdout JSON; stderr to merge.log
  env DISPATCH_DB="$DB" GAFFER_DATA="$WORK" CLAUDE_BIN=/bin/false node "$RUNNER_DIR/bin/merge-ticket.mjs" --ticket "$1" 2>>"$WORK/merge.log"
}
LANE() {  # $1 ticket $2 log → rc of gaffer_land_delivery
  (
    _LANE_LOG="$2"
    log() { printf '%s\n' "$*" >> "$_LANE_LOG"; }
    gaffer_refresh_cards() { :; }
    _gaffer_flag_on() { case "${1:-}" in 1|true|yes|on) return 0 ;; *) return 1 ;; esac; }
    export DISPATCH_DB="$DB" GAFFER_DIGEST_DISABLE=1 RUNNER_DIR
    # shellcheck source=../lib/automerge.sh
    source "$RUNNER_DIR/lib/automerge.sh"
    # shellcheck source=../lib/land.sh
    source "$RUNNER_DIR/lib/land.sh"
    gaffer_land_delivery "$1" "$REPO_A" "gaffer/t$1" main "$(wg ticket show "$1" 2>/dev/null)" MERGE
  )
}

echo "== 1. merge-ticket: the SECONDARY repo moved since review → nothing lands, exit 4 =="
N="$(deliver_ticket "spans two repos")"
approve_heads "$N"
[ "$(status_of "$N")" = "ready_for_merge" ] && ok "#$N approved with both heads pinned" || fail "#$N not approved: $(status_of "$N")"
A_MAIN="$(git -C "$REPO_A" rev-parse main)"; B_MAIN="$(git -C "$REPO_B" rev-parse main)"
commit_on "$REPO_B" "gaffer/t$N" "late unreviewed change"
OUT="$(MT "$N")"; RC=$?
[ "$RC" -eq 4 ] && ok "merge-ticket exits 4" || fail "merge-ticket rc=$RC out=$OUT"
[ "$(printf '%s' "$OUT" | jget 'd.phase')" != "partially_merged" ] && ok "it is not reported partially_merged" || fail "partially_merged: $OUT"
[ "$(git -C "$REPO_A" rev-parse main)" = "$A_MAIN" ] && ok "repoA's main is untouched (the primary did NOT land first)" || fail "repoA landed although repoB moved"
[ "$(git -C "$REPO_B" rev-parse main)" = "$B_MAIN" ] && ok "repoB's main is untouched" || fail "repoB main moved"
[ "$(status_of "$N")" = "ready_for_merge" ] && ok "the ticket stays ready_for_merge" || fail "status: $(status_of "$N")"
[ "$(wg ticket landing "$N" 2>/dev/null | jget 'd.landed')" = "0" ] && ok "no landing is recorded" || fail "a landing was recorded: $(wg ticket landing "$N")"
ERR="$(printf '%s' "$OUT" | jget 'd.error || ""')"
case "$ERR" in *repoB*"moved since the review approved it"*) ok "the refusal names repoB and why" ;; *) fail "refusal does not name repoB: $ERR" ;; esac
case "$ERR" in *"gaffer wg ticket reopen-for-review $N "*"--reason"*"--resolution"*"gaffer approve $N"*) ok "the refusal names the exact recovery commands (F-11)" ;; *) fail "no recovery command in: $ERR" ;; esac

echo "== 2. merge lane (lib/land.sh): a second ticket, repoB moved → held before anything merges =="
NL="$(deliver_ticket "lane spanning ticket")"
approve_heads "$NL"
A_MAIN="$(git -C "$REPO_A" rev-parse main)"
commit_on "$REPO_B" "gaffer/t$NL" "late unreviewed change"
: > "$WORK/lane1.log"
LANE "$NL" "$WORK/lane1.log"; LRC=$?
[ "$LRC" -ne 0 ] && [ "$(status_of "$NL")" = "ready_for_merge" ] && ok "gaffer_land_delivery refuses (rc=$LRC), ticket stays ready_for_merge" || fail "lane landed: $(tr '\n' '|' < "$WORK/lane1.log")"
[ "$(git -C "$REPO_A" rev-parse main)" = "$A_MAIN" ] && ok "the lane did not land repoA either" || fail "the lane landed repoA first: $(tr '\n' '|' < "$WORK/lane1.log")"
grep -q "PARTLY MERGED" "$WORK/lane1.log" && fail "the lane reported PARTLY MERGED" || ok "no PARTLY MERGED in the lane log"
grep -q "repoB.*moved since the review approved it.*reopen-for-review $NL" "$WORK/lane1.log" \
  && ok "the lane log names repoB and the recovery command" || fail "lane log: $(tr '\n' '|' < "$WORK/lane1.log")"

echo "== 3. the named recovery: reopen for review, approve the new heads → both land =="
REC="$(printf '%s' "$ERR" | sed -n "s/.*\(gaffer wg ticket reopen-for-review $N [^;]*\); then.*/\1/p")"
[ -n "$REC" ] && ok "recovery command extracted: $REC" || fail "could not extract the recovery command from: $ERR"
# Run it as written, with `gaffer wg` → the CLI (the reason/resolution are quoted in the message).
eval "set -- ${REC#gaffer wg }"
wg "$@" >/dev/null 2>&1; RRC=$?
[ "$RRC" -eq 0 ] && [ "$(status_of "$N")" = "in_review" ] && ok "the recovery command moved #$N back to in_review" || fail "recovery rc=$RRC status=$(status_of "$N")"
[ "$(wg ticket landing "$N" 2>/dev/null | jget '(d.repos||[]).length')" = "0" ] && ok "the old pins no longer count" || fail "old pins still shown"
approve_heads "$N"
OUT3="$(MT "$N")"; RC3=$?
[ "$RC3" -eq 0 ] && [ "$(status_of "$N")" = "done" ] && ok "after re-review both repos land and the ticket is done" || fail "re-merge rc=$RC3 out=$OUT3"

echo "== 4. a secondary repo with NO approved commit → nothing lands =="
N2="$(deliver_ticket "second spanning ticket")"
approve_heads "$N2"
# Simulate an approval that did not cover repoB (made before every write repo had to be
# pinned): drop repoB's review pin row.
node -e '
  const D = require(process.argv[1]); const db = new D(process.argv[2]);
  const t = db.prepare("SELECT id FROM tickets WHERE number = ?").get(Number(process.argv[3]));
  const r = db.prepare("SELECT id FROM repositories WHERE name = ?").get("repoB");
  db.prepare("DELETE FROM evidence WHERE ticket_id = ? AND repo_id = ? AND uri LIKE ?").run(t.id, r.id, "gaffer-reviewed-commit:%");
' "$ROOT/packages/dispatch/node_modules/better-sqlite3" "$DB" "$N2"
A2_MAIN="$(git -C "$REPO_A" rev-parse main)"
OUT4="$(MT "$N2")"; RC4=$?
[ "$RC4" -eq 4 ] && ok "merge-ticket exits 4 for an unpinned secondary repo" || fail "unpinned rc=$RC4 out=$OUT4"
[ "$(git -C "$REPO_A" rev-parse main)" = "$A2_MAIN" ] && ok "repoA did not land" || fail "repoA landed although repoB has no approved commit"
case "$(printf '%s' "$OUT4" | jget 'd.error || ""')" in *repoB*) ok "the refusal names repoB" ;; *) fail "unpinned refusal: $OUT4" ;; esac

echo
echo "multi-repo-landing-preflight: $PASS passed, ${#FAILURES[@]} failed"
[ "${#FAILURES[@]}" -eq 0 ]
