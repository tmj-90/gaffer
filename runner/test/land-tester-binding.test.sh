#!/usr/bin/env bash
# =====================================================================
# ACCEPTANCE GATE — ONE landing decision (lib/tester-binding.mjs), applied by BOTH
# landing implementations: lib/land.sh (merge lane / AFK review) and
# bin/merge-ticket.mjs (dashboard Merge button, `gaffer merge`).
#   A. the decision table, from the dispatch DB (never agent-shaped JSON), fail closed
#   B. the SAME moved candidate is refused by BOTH paths (nothing merged)
#   C. both paths land a bound, unmoved candidate — and merge the PINNED commit
#   D. an acceptance ticket with no bound PASS is refused by both paths
# Real git repos, a reduced SQLite dispatch fixture, real land.sh + automerge.sh, real
# merge-ticket.mjs. Run: bash runner/test/land-tester-binding.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
node -e 'require("node:sqlite")' 2>/dev/null || { echo "SKIP: node:sqlite unavailable"; exit 0; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/land-binding.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
HELPER="$RUNNER_DIR/lib/tester-binding.mjs"
g() { git -C "$R" -c user.email=t@t -c user.name=t "$@"; }

# ── fixture: repo with a delivery branch; a reduced dispatch DB ─────────────────
R="$WORK/repo"; git init -q -b main "$R"; g commit -q --allow-empty -m base
g checkout -q -b gaffer/ticket-9-x; echo v1 > "$R/f"; g add -A; g commit -q -m deliver
TESTED="$(g rev-parse gaffer/ticket-9-x)"; g checkout -q main
DB="$WORK/dispatch.sqlite"
sql() { node --no-warnings -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);d.exec(process.argv[2]);d.close()' "$DB" "$1" || { echo "FIXTURE ERROR: $1" >&2; exit 1; }; }
sql "CREATE TABLE tickets (id TEXT PRIMARY KEY, number INTEGER UNIQUE, title TEXT, status TEXT, branch_name TEXT, pr_url TEXT, acceptance INTEGER NOT NULL DEFAULT 0);
     CREATE TABLE evidence (id TEXT PRIMARY KEY, ticket_id TEXT, evidence_type TEXT, summary TEXT, payload_json TEXT, created_at TEXT);
     CREATE TABLE repositories (id TEXT PRIMARY KEY, name TEXT UNIQUE, local_path TEXT, default_branch TEXT, stack TEXT);
     CREATE TABLE ticket_repos (ticket_id TEXT, repo_id TEXT, role TEXT, branch_name TEXT, access TEXT, pr_url TEXT);
     INSERT INTO tickets VALUES ('t9', 9, 'x', 'ready_for_merge', 'gaffer/ticket-9-x', NULL, 0);
     INSERT INTO repositories VALUES ('r1', 'repo', '$R', 'main', '');
     INSERT INTO ticket_repos VALUES ('t9', 'r1', 'primary', 'gaffer/ticket-9-x', 'write', NULL);"
set_pass() {  # $1 = payload json ('' = no evidence)
  sql "DELETE FROM evidence;"
  # Named columns: the Node merge path's mark-merged migrates this fixture (adds columns).
  [ -n "$1" ] && sql "INSERT INTO evidence (id, ticket_id, evidence_type, summary, payload_json, created_at) VALUES ('e1', 't9', 'test_output', 'pass', '$1', '2026-09-29T00:00:00Z');"
  return 0
}
decide() { node --no-warnings "$HELPER" landing --db "$DB" --ticket 9 --repo "$R" --branch gaffer/ticket-9-x; }
kind() { printf '%s' "$1" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).kind)}catch{console.log("?")}})'; }

echo "== A: the decision table =="
set_pass ''; out="$(decide)"; rc=$?
[ "$rc" -eq 0 ] && [ "$(kind "$out")" = "no-tester" ] && ok "ordinary ticket, no tester PASS → land (no-tester)" || fail "no-tester: rc=$rc $out"
sql "UPDATE tickets SET acceptance = 1"; out="$(decide)"; rc=$?
[ "$rc" -eq 4 ] && [ "$(kind "$out")" = "unverified" ] && ok "ACCEPTANCE ticket, no tester PASS → hold (unverified)" || fail "acceptance no pass: rc=$rc $out"
set_pass '{"verdict":"pass","provenance":"agent"}'; out="$(decide)"; rc=$?
[ "$rc" -eq 4 ] && [ "$(kind "$out")" = "unverified" ] && ok "ACCEPTANCE ticket, agent PASS with no commit → hold (unverified)" || fail "acceptance legacy: rc=$rc $out"
set_pass '{"verdict":"pass","provenance":"human"}'; out="$(decide)"; rc=$?
[ "$rc" -eq 0 ] && [ "$(kind "$out")" = "waived" ] && ok "ACCEPTANCE ticket, HUMAN PASS → land as a waiver" || fail "waiver: rc=$rc $out"
sql "UPDATE tickets SET acceptance = 0"
set_pass '{"verdict":"pass","provenance":"agent"}'; out="$(decide)"; rc=$?
[ "$rc" -eq 0 ] && [ "$(kind "$out")" = "legacy-unbound" ] && ok "ordinary ticket, pre-binding agent PASS → land (legacy, logged)" || fail "legacy: rc=$rc $out"
set_pass "{\"verdict\":\"pass\",\"provenance\":\"agent\",\"tested_commit\":\"$TESTED\"}"; out="$(decide)"; rc=$?
[ "$rc" -eq 0 ] && [ "$(kind "$out")" = "bound" ] && [[ "$out" == *"\"pin\":\"$TESTED\""* ]] && ok "bound PASS, head == tested → land, pinned to the tested commit" || fail "bound: rc=$rc $out"
out="$(node "$HELPER" landing --db "$WORK/nope.sqlite" --ticket 9 --repo "$R" --branch gaffer/ticket-9-x)"; rc=$?
[ "$rc" -eq 4 ] && [ "$(kind "$out")" = "unreadable" ] && ok "missing dispatch DB → hold (fail closed)" || fail "missing db: rc=$rc $out"
out="$(node "$HELPER" landing --db "$DB" --ticket 77 --repo "$R" --branch gaffer/ticket-9-x)"; rc=$?
[ "$rc" -eq 4 ] && ok "unknown ticket → hold" || fail "unknown ticket: rc=$rc $out"
out="$(node "$HELPER" landing --db "$DB" --ticket 9 --repo "$R" --branch no/such-branch)"; rc=$?
[ "$rc" -eq 4 ] && [ "$(kind "$out")" = "no-head" ] && ok "unresolvable branch head → hold" || fail "no head: rc=$rc $out"

# ── the Bash path: real land.sh + automerge.sh, stubbed tick globals ─────────────
LOGF="$WORK/log"; CALLS="$WORK/calls"
log() { printf '%s\n' "$*" >> "$LOGF"; }
wg() { printf 'wg %s\n' "$*" >> "$CALLS"; }
jget() { node "$RUNNER_DIR/lib/json-tool.mjs" expr "$1"; }
gaffer_refresh_cards() { :; }
_gaffer_flag_on() { case "${1:-}" in 1|true|yes|on) return 0 ;; *) return 1 ;; esac; }
export GAFFER_DATA="$WORK/data" DISPATCH_DB="$DB" RUNNER_DIR GAFFER_DIGEST_DISABLE=1; mkdir -p "$GAFFER_DATA"
# shellcheck source=../lib/automerge.sh
source "$RUNNER_DIR/lib/automerge.sh"
# shellcheck source=../lib/land.sh
source "$RUNNER_DIR/lib/land.sh"
bash_land() { : > "$LOGF"; : > "$CALLS"; gaffer_land_delivery 9 "$R" gaffer/ticket-9-x main '{"ticket":{"number":9}}' MERGE; }
node_land() { DISPATCH_DB="$DB" GAFFER_DATA="$WORK/data" GAFFER_DIGEST_DISABLE=1 node "$RUNNER_DIR/bin/merge-ticket.mjs" --ticket 9 2>"$WORK/node.err"; }

echo "== B: the SAME moved candidate is refused by BOTH landing paths =="
set_pass "{\"verdict\":\"pass\",\"provenance\":\"agent\",\"tested_commit\":\"$TESTED\"}"
g checkout -q gaffer/ticket-9-x; echo sneaked >> "$R/f"; g commit -q -am "after the tester"; MOVED="$(g rev-parse HEAD)"; g checkout -q main
MAIN0="$(g rev-parse main)"
bash_land; rc=$?
[ "$rc" -eq 4 ] && ok "Bash path: moved candidate → rc 4 (held)" || fail "Bash path landed a moved candidate (rc=$rc)"
grep -q "moved since the tester's PASS (tested ${TESTED:0:12}, head is now ${MOVED:0:12})" "$LOGF" && ok "Bash path log names both commits" || fail "Bash log: $(cat "$LOGF")"
[ "$(g rev-parse main)" = "$MAIN0" ] && ! grep -q mark-merged "$CALLS" && ok "Bash path: main untouched, not marked merged" || fail "Bash path changed main or marked merged"
out="$(node_land)"; rc=$?
[ "$rc" -eq 4 ] && [[ "$out" == *"landing check moved"* ]] && ok "Node path (merge-ticket.mjs): the SAME moved candidate → exit 4 (held)" || fail "Node path did not refuse the moved candidate (rc=$rc out=$out)"
[ "$(g rev-parse main)" = "$MAIN0" ] && ok "Node path: main untouched" || fail "Node path merged a moved candidate"

echo "== C: both paths land a bound, unmoved candidate — the PINNED commit =="
set_pass "{\"verdict\":\"pass\",\"provenance\":\"agent\",\"tested_commit\":\"$MOVED\"}"
bash_land; rc=$?
[ "$rc" -eq 0 ] && g merge-base --is-ancestor "$MOVED" main && ok "Bash path lands the tested commit" || fail "Bash path did not land (rc=$rc; $(tail -2 "$LOGF" | tr '\n' ' '))"
# reset main and try the Node path on a fresh delivery
g reset -q --hard "$MAIN0"; g branch -f gaffer/ticket-9-x "$MOVED" 2>/dev/null || g branch gaffer/ticket-9-x "$MOVED"
out="$(node_land)"; rc=$?
[ "$rc" -eq 0 ] && g merge-base --is-ancestor "$MOVED" main && ok "Node path lands the tested commit" || fail "Node path did not land (rc=$rc out=$out err=$(tail -3 "$WORK/node.err" | tr '\n' ' '))"
# the pinned merge itself refuses a branch that moves between check and merge (rc 6)
g reset -q --hard "$MAIN0"; g branch -f gaffer/ticket-9-x "$MOVED" 2>/dev/null || g branch gaffer/ticket-9-x "$MOVED"
gaffer_auto_merge "$R" gaffer/ticket-9-x main "$TESTED"; rc=$?
[ "$rc" -eq 6 ] && [ "$(g rev-parse main)" = "$MAIN0" ] && ok "gaffer_auto_merge with a stale pin refuses (rc 6), nothing merged" || fail "stale pin merged (rc=$rc)"

echo "== D: an ACCEPTANCE ticket with no bound PASS is refused by BOTH paths =="
g reset -q --hard "$MAIN0"; g branch -f gaffer/ticket-9-x "$MOVED" 2>/dev/null || g branch gaffer/ticket-9-x "$MOVED"
sql "UPDATE tickets SET acceptance = 1"; set_pass '{"verdict":"pass","provenance":"agent"}'
[ "$(kind "$(decide)")" = "unverified" ] && [ "$(node --no-warnings -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);console.log(d.prepare("SELECT COUNT(*) n FROM evidence").get().n)' "$DB")" = "1" ] \
  && ok "fixture: exactly one unbound agent PASS on record (the case really is 'bound PASS missing')" || fail "fixture evidence not as intended"
bash_land; rc=$?
[ "$rc" -eq 4 ] && grep -q 'landing check: unverified' "$LOGF" && ok "Bash path: unbound acceptance PASS → held" || fail "Bash path landed an unbound acceptance (rc=$rc)"
out="$(node_land)"; rc=$?
[ "$rc" -eq 4 ] && [[ "$out" == *"unverified"* ]] && ok "Node path: unbound acceptance PASS → held" || fail "Node path landed an unbound acceptance (rc=$rc out=$out)"
[ "$(g rev-parse main)" = "$MAIN0" ] && ok "main untouched by either" || fail "main moved"

echo "== E: PR mode passes the pinned commit to gh as --match-head-commit (both paths) =="
GH="$WORK/gh"; GHLOG="$WORK/gh.log"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "%s"\nexit 0\n' "$GHLOG" > "$GH"; chmod +x "$GH"
: > "$GHLOG"
GAFFER_GH_BIN="$GH" gaffer_pr_merge "$R" https://github.com/o/r/pull/9 main "$TESTED" >/dev/null 2>&1
grep -q -- "--match-head-commit $TESTED" "$GHLOG" && ok "Bash gaffer_pr_merge: gh pr merge … --match-head-commit <pin>" || fail "Bash PR merge argv: $(cat "$GHLOG")"
# (argv order matters: with -e, argv[1] is the first extra arg, and merge-ticket.mjs runs
# main() when argv[1] is its own path — so the pin goes first.)
ARGV="$(node --no-warnings -e 'import(process.argv[2]).then(m=>console.log(JSON.stringify(m.buildPrMergeArgv({prUrl:"u",method:"merge",matchHeadCommit:process.argv[1]}))))' "$TESTED" "$RUNNER_DIR/bin/merge-ticket.mjs")"
[[ "$ARGV" == *"\"--match-head-commit\",\"$TESTED\""* ]] && ok "Node buildPrMergeArgv: --match-head-commit <pin>" || fail "Node PR argv: $ARGV"
grep -q 'matchHeadCommit: pin' "$RUNNER_DIR/bin/merge-ticket.mjs" && ok "merge-ticket.mjs passes the decision's pin to the PR merge" || fail "PR merge not pinned in merge-ticket.mjs"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "land-tester-binding: ALL $PASS checks passed"; exit 0; fi
echo "land-tester-binding: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1
