#!/usr/bin/env bash
# =====================================================================
# CONFLICT RESOLUTION — a re-approval that did not happen is NOT a success.
# ---------------------------------------------------------------------
# On a landing conflict, lib/land.sh hands the ticket to the resolver (bin/merge-ticket.mjs),
# which merges the default branch INTO the delivery branch and reopens the ticket for
# re-review. When that reopen failed (a locked DB, an unbuilt CLI) the helper still exited
# 0 as conflict_resolved_pending_reapproval, land.sh logged "reopened for re-review" and
# returned success — and the NEXT landing (now a clean merge) shipped the resolver's
# unreviewed merge commit. Proves, with real git, the real land.sh + automerge.sh and the
# real merge-ticket.mjs (a fake resolver, a dispatch CLI stub that always fails):
#   A. neither of two landings returns success (0 / 5) and the default branch never moves;
#      the branch is back at its pre-resolution head, the resolution kept on a side ref;
#   B. land.sh itself fails closed on a pending_reapproval phase whose reapproval.ok is
#      not true (an older helper), instead of trusting the phase name.
# Run: bash runner/test/land-conflict-reapproval.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
node -e 'require("node:sqlite")' 2>/dev/null || { echo "SKIP: node:sqlite unavailable"; exit 0; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/land-reapproval.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT

R="$WORK/repo"; g() { git -C "$R" -c user.email=t@t -c user.name=t "$@"; }
git init -q -b main "$R"; echo base > "$R/f"; g add -A; g commit -qm base
g checkout -qb gaffer/ticket-7-x; printf 'base\nbranch\n' > "$R/f"; g commit -qam branch
g checkout -q main; printf 'base\nmain\n' > "$R/f"; g commit -qam main
PRE="$(g rev-parse gaffer/ticket-7-x)"; MAIN0="$(g rev-parse main)"
DB="$WORK/db.sqlite"
node --no-warnings -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);d.exec(process.argv[2]);d.close()' "$DB" "CREATE TABLE tickets (id TEXT PRIMARY KEY, number INTEGER UNIQUE, title TEXT, status TEXT, branch_name TEXT, pr_url TEXT, acceptance INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE evidence (id TEXT PRIMARY KEY, ticket_id TEXT, evidence_type TEXT, summary TEXT, payload_json TEXT, created_at TEXT);
 CREATE TABLE repositories (id TEXT PRIMARY KEY, name TEXT UNIQUE, local_path TEXT, default_branch TEXT, stack TEXT);
 CREATE TABLE ticket_repos (ticket_id TEXT, repo_id TEXT, role TEXT, branch_name TEXT, access TEXT, pr_url TEXT);
 INSERT INTO tickets VALUES ('t7',7,'x','ready_for_merge','gaffer/ticket-7-x',NULL,0);
 INSERT INTO repositories VALUES ('r1','demo','$R','main','');
 INSERT INTO ticket_repos VALUES ('t7','r1','primary','gaffer/ticket-7-x','write',NULL);"
# The fake resolver really resolves (merges main in, keeping the branch side).
FAKE="$WORK/fake-claude.sh"
printf '#!/usr/bin/env bash\ngit -c user.email=r@r -c user.name=r merge -q -X ours --no-edit main >/dev/null 2>&1\nprintf "%%s\\n" "{\\"result\\":\\"resolved\\"}"\n' > "$FAKE"; chmod +x "$FAKE"
echo 'process.stderr.write("database is locked\n");process.exit(1)' > "$WORK/failwg.js"

LOGF="$WORK/log"; CALLS="$WORK/calls"
log() { printf '%s\n' "$*" >> "$LOGF"; }
wg() { printf 'wg %s\n' "$*" >> "$CALLS"; }
jget() { node "$RUNNER_DIR/lib/json-tool.mjs" expr "$1"; }
gaffer_refresh_cards() { :; }
_gaffer_flag_on() { case "${1:-}" in 1|true|yes|on) return 0 ;; *) return 1 ;; esac; }
_gaffer_locked() { shift; "$@"; }
_gaffer_append_line() { printf '%s\n' "$2" >> "$1"; }
export GAFFER_DATA="$WORK/data" DISPATCH_DB="$DB" RUNNER_DIR GAFFER_DIGEST_DISABLE=1 CLAUDE_BIN="$FAKE" \
       DISPATCH_CLI="$WORK/failwg.js" GAFFER_STRICT_REQUIRE=0 STRICT_MODE=0 SANDBOX_PROVIDER=none \
       MEMORY_DB="$WORK/mem.sqlite" GAFFER_REAPPROVAL_BACKOFF_MS=1
mkdir -p "$GAFFER_DATA"
# shellcheck source=../lib/automerge.sh
source "$RUNNER_DIR/lib/automerge.sh"
# shellcheck source=../lib/land.sh
source "$RUNNER_DIR/lib/land.sh"

echo "== A. the reopen fails: nothing lands, on this landing or the next =="
gaffer_land_delivery 7 "$R" gaffer/ticket-7-x main '{"ticket":{"number":7}}' MERGE; rc1=$?
case "$rc1" in 0|5) fail "A: landing 1 returned success (rc=$rc1)" ;; *) ok "A: landing 1 is held (rc=$rc1)" ;; esac
grep -q "reopened for re-review" "$LOGF" && fail "A: the log claims the ticket was reopened" || ok "A: the log does not claim a reopen"
[ "$(g rev-parse main)" = "$MAIN0" ] && ok "A: main untouched after landing 1" || fail "A: main moved: $(g log --oneline -1 main)"
[ "$(g rev-parse gaffer/ticket-7-x)" = "$PRE" ] && ok "A: the branch is back at its pre-resolution head" || fail "A: branch carries the unreviewed resolution: $(g log --oneline -1 gaffer/ticket-7-x)"
g merge-base --is-ancestor main refs/gaffer/conflict-resolved/7 2>/dev/null && ok "A: the resolution is kept on refs/gaffer/conflict-resolved/7" || fail "A: no side ref with the resolution"
gaffer_land_delivery 7 "$R" gaffer/ticket-7-x main '{"ticket":{"number":7}}' MERGE; rc2=$?
case "$rc2" in 0|5) fail "A: landing 2 returned success (rc=$rc2)" ;; *) ok "A: landing 2 is held too (rc=$rc2)" ;; esac
[ "$(g rev-parse main)" = "$MAIN0" ] && ok "A: main untouched after landing 2" || fail "A: the unreviewed resolution landed: $(g log --oneline -1 main)"
grep -q "mark-merged" "$CALLS" 2>/dev/null && fail "A: mark-merged was called" || ok "A: the ticket was never marked merged"

echo "== B. land.sh does not trust the phase name alone (an older helper) =="
FAKEBIN="$WORK/fakebin"; mkdir -p "$FAKEBIN"; REAL_NODE="$(command -v node)"
cat > "$FAKEBIN/node" <<STUB
#!/usr/bin/env bash
case "\$*" in
  *merge-ticket.mjs*) printf '%s\n' '{"phase":"conflict_resolved_pending_reapproval","ticket":7,"reapproval":{"ok":false}}'; exit 0 ;;
esac
exec "$REAL_NODE" "\$@"
STUB
chmod +x "$FAKEBIN/node"
: > "$GAFFER_DATA/.merge-conflict-resolved"; : > "$LOGF"
PATH="$FAKEBIN:$PATH" _gaffer_land_conflict_resolve 7 "$R" gaffer/ticket-7-x main MERGE; rc3=$?
[ "$rc3" -ne 0 ] && grep -q "NOT reopened for re-review — HELD" "$LOGF" \
  && ok "B: pending phase + reapproval.ok=false → held (rc=$rc3)" || fail "B: rc=$rc3 log: $(tr '\n' '|' < "$LOGF")"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "land-conflict-reapproval: PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
