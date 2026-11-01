#!/usr/bin/env bash
# =====================================================================
# A greenfield repo has no remote: with PR mode on, the person is asked once.
# ---------------------------------------------------------------------
# The bootstrap creates its repo locally (git init, no remote). With PR mode on
# (GAFFER_CREATE_PR=1) every delivery into it then skipped its pull request, and with
# GAFFER_REQUIRE_CI=1 the strict CI gate (no PR, so no checks) sent each one back to
# rework, one paid attempt per ticket, until someone noticed and added a remote by hand.
# Where the repo lives is the person's decision, so the bootstrap now files it as one:
# a human_required decision, filed when the repo is registered, holding the epic's
# tickets for that repo (the ones the inherit step just linked) until it is answered.
# Real dispatch DB, real `wg epic create`, real bootstrap onboard + inherit planner.
#   1. PR mode off → no decision (local merges are the plan)
#   2. PR mode on, no remote → one human_required decision, blocking every linked
#      dependent, with the git commands to add a remote
#   3. GAFFER_REQUIRE_CI on → the question says the CI gate would send each back
#   4. filed once: a second call reuses the open decision
#   5. a repo that already has a GitHub remote → no decision
#   6. answering it releases the hold
#   7. WIRING: tick.sh asks right after the inherit step on a successful onboard
# Run: bash runner/test/greenfield-remote-decision.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CLI_JS="$ROOT/packages/dispatch/dist/cli/index.js"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
# shellcheck source=lib/skip.sh
. "$HERE/lib/skip.sh"

command -v node    >/dev/null 2>&1 || gaffer_skip "node required"
command -v git     >/dev/null 2>&1 || gaffer_skip "git required"
command -v python3 >/dev/null 2>&1 || gaffer_skip "python3 required"
[ -f "$CLI_JS" ] || gaffer_skip "dispatch CLI not built ($CLI_JS)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/gf-remote.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
export GAFFER_DATA="$WORK" DISPATCH_DB="$WORK/dispatch.sqlite"
export GAFFER_BOOTSTRAP_ROOT="$WORK/git" GAFFER_INHERIT_DRY_RUN=1
unset GAFFER_CREATE_PR GAFFER_REQUIRE_CI GAFFER_PR_REMOTE

LOGF="$WORK/log.txt"; : > "$LOGF"
log() { printf '%s\n' "$*" >> "$LOGF"; }
gaffer_timeout() { shift; "$@"; }
fg() { :; }   # the crew Factory Map onboard is not under test
wg() { node "$CLI_JS" --db "$DISPATCH_DB" "$@"; }
jget() { node "$RUNNER_DIR/lib/json-tool.mjs" expr "$1"; }
# shellcheck source=../lib/greenfield.sh
source "$RUNNER_DIR/lib/greenfield.sh"
# shellcheck source=../lib/pr-create.sh
source "$RUNNER_DIR/lib/pr-create.sh"

decisions_titled() {  # $1 = title substring → count of pending decisions
  python3 - "$DISPATCH_DB" "$1" <<'PY'
import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
print(c.execute("SELECT count(*) FROM decisions WHERE title LIKE ? AND status IN ('requested','human_required')",('%'+sys.argv[2]+'%',)).fetchone()[0])
PY
}
blocked_by_remote() {  # $1 = ticket number → 1 when an open remote decision blocks it
  python3 - "$DISPATCH_DB" "$1" <<'PY'
import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
n=c.execute("""SELECT count(*) FROM ticket_decisions td JOIN tickets t ON t.id=td.ticket_id
  JOIN decisions d ON d.id=td.decision_id WHERE t.number=? AND td.relation='blocks'
  AND d.title LIKE 'Add a remote%' AND d.status IN ('requested','human_required')""",(int(sys.argv[2]),)).fetchone()[0]
print(1 if n else 0)
PY
}
question_of() {
  python3 - "$DISPATCH_DB" <<'PY'
import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
r=c.execute("SELECT question, severity FROM decisions WHERE title LIKE 'Add a remote%' ORDER BY created_at DESC LIMIT 1").fetchone()
print((r[1]+"|"+r[0]) if r else "")
PY
}

# A clean factory: a planned greenfield epic, its bootstrap scaffolded and registered.
new_world() {  # $1 = app slug → BOOT, DEP1, DEP2, DIR (bootstrap onboarded, siblings inherited)
  rm -f "$DISPATCH_DB"; wg init >/dev/null 2>&1
  local slug="$1"
  cat > "$WORK/plan.json" <<JSON
{"epic":{"name":"$slug epic"},"tickets":[
 {"title":"Bootstrap $slug","description":"scaffold","acceptanceCriteria":["repo exists"],"bootstrap":true,"repo":"$slug","dependsOn":[]},
 {"title":"Core","description":"core","acceptanceCriteria":["works"],"repo":"$slug","dependsOn":[0]},
 {"title":"Docs","description":"docs","acceptanceCriteria":["documented"],"repo":"$slug","dependsOn":[1]}]}
JSON
  local nums; nums="$(wg epic create "$WORK/plan.json" 2>/dev/null | jget '(d.ticket_numbers||[]).join(" ")')"
  # shellcheck disable=SC2086
  set -- $nums
  BOOT="$1"; DEP1="$2"; DEP2="$3"
  DIR="$(gaffer_bootstrap_repo_dir "$slug")"
  gaffer_bootstrap_init "$DIR" "$slug" "an app" >/dev/null 2>&1
  printf '{"name":"%s","scripts":{"test":"node -e 0"}}\n' "$slug" > "$DIR/package.json"
  git -C "$DIR" add -A >/dev/null 2>&1
  git -C "$DIR" -c user.email=t@t -c user.name=t commit -qm scaffold >/dev/null 2>&1
  gaffer_bootstrap_onboard "$BOOT" "$slug" "$DIR" "" "" main >/dev/null 2>&1
  wg repo link "$BOOT" "$slug" --as system >/dev/null 2>&1   # as tick.sh does before inheriting
  gaffer_inherit_repo "$BOOT" >/dev/null 2>&1
}

echo "== 1: PR mode off → no decision =="
new_world app-one
[ -n "${GAFFER_INHERIT_LINKED:-}" ] && ok "inherit linked the dependents (#${GAFFER_INHERIT_LINKED// /, #})" || fail "inherit linked nothing (log: $(tail -3 "$LOGF" | tr '\n' ' '))"
GAFFER_CREATE_PR=0 gaffer_bootstrap_remote_decision "$BOOT" app-one "$DIR"
[ "$(decisions_titled 'Add a remote')" = "0" ] && ok "no decision with PR mode off" || fail "a decision was filed with PR mode off"

echo "== 2: PR mode on, no remote → one decision holding the dependents =="
GAFFER_CREATE_PR=1 gaffer_bootstrap_remote_decision "$BOOT" app-one "$DIR"
[ "$(decisions_titled 'Add a remote for the new repo app-one')" = "1" ] && ok "one decision filed for app-one" || fail "decisions filed: $(decisions_titled 'Add a remote')"
Q="$(question_of)"
case "$Q" in human_required\|*) ok "severity human_required (a person answers it)" ;; *) fail "severity/question: '$Q'" ;; esac
case "$Q" in *"git -C $DIR remote add origin"*"push -u origin main"*) ok "the question carries the commands to add the remote" ;; *) fail "question lacks the remote commands: $Q" ;; esac
[ "$(blocked_by_remote "$DEP1")" = "1" ] && [ "$(blocked_by_remote "$DEP2")" = "1" ] \
  && ok "both dependents (#$DEP1, #$DEP2) are held by it" || fail "dependents not held: #$DEP1=$(blocked_by_remote "$DEP1") #$DEP2=$(blocked_by_remote "$DEP2")"
[ "$(blocked_by_remote "$BOOT")" = "0" ] && ok "the bootstrap itself is not held (it is already in review)" || fail "the bootstrap was held"
case "$Q" in *GAFFER_REQUIRE_CI\ on,*) fail "CI sentence present with CI off" ;; *) ok "no CI sentence while GAFFER_REQUIRE_CI is off" ;; esac

echo "== 4: filed once =="
GAFFER_CREATE_PR=1 gaffer_bootstrap_remote_decision "$BOOT" app-one "$DIR"
[ "$(decisions_titled 'Add a remote for the new repo app-one')" = "1" ] && ok "a second call reuses the open decision" || fail "duplicated: $(decisions_titled 'Add a remote for the new repo app-one')"

echo "== 6: answering it releases the hold =="
DID="$(python3 - "$DISPATCH_DB" <<'PY'
import sqlite3,sys
print(sqlite3.connect(sys.argv[1]).execute("SELECT id FROM decisions WHERE title LIKE 'Add a remote%'").fetchone()[0])
PY
)"
wg decisions resolve "$DID" --answer "added origin" >/dev/null 2>&1
[ "$(blocked_by_remote "$DEP1")" = "0" ] && ok "answered → #$DEP1 is no longer held" || fail "still held after the answer"

echo "== 3: GAFFER_REQUIRE_CI on → the question names the CI gate =="
new_world app-two
GAFFER_CREATE_PR=1 GAFFER_REQUIRE_CI=1 gaffer_bootstrap_remote_decision "$BOOT" app-two "$DIR"
case "$(question_of)" in *"With GAFFER_REQUIRE_CI on, the CI gate would also send each delivery back to rework."*) ok "the CI consequence is spelled out" ;; *) fail "CI sentence missing: $(question_of)" ;; esac

echo "== 5: a repo with a GitHub remote → no decision =="
new_world app-three
git -C "$DIR" remote add origin "https://github.com/example/app-three.git"
GAFFER_CREATE_PR=1 gaffer_bootstrap_remote_decision "$BOOT" app-three "$DIR"
[ "$(decisions_titled 'app-three')" = "0" ] && ok "no decision when the remote exists" || fail "filed despite a remote"

echo "== 7: WIRING — tick.sh asks right after the inherit step =="
TICK="$RUNNER_DIR/tick.sh"
INH="$(grep -n 'gaffer_inherit_repo "\$NUM" || true' "$TICK" | head -1 | cut -d: -f1)"
ASK="$(grep -n 'gaffer_bootstrap_remote_decision "\$NUM" "\$B_NAME" "\$B_DIR"' "$TICK" | head -1 | cut -d: -f1)"
[ -n "$INH" ] && [ -n "$ASK" ] && [ "$ASK" -gt "$INH" ] && [ "$((ASK - INH))" -le 4 ] \
  && ok "the bootstrap onboard path files it right after linking the dependents" || fail "wiring: inherit line $INH, ask line $ASK"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "greenfield-remote-decision: ALL $PASS checks passed"; exit 0; fi
echo "greenfield-remote-decision: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1
