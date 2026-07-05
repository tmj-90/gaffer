#!/usr/bin/env bash
# =====================================================================
# E2E — BOOTSTRAP ("create-a-repo") ticket driven all the way to `done`.
# ---------------------------------------------------------------------
# A `--bootstrap` ticket has NO repo to branch — it CREATES one, then delivers into it
# like any other ticket and lands on the default branch. That whole arc (git-init +
# baseline scaffold → register the repo → branch OFF the baseline → deliver → submit →
# approve → merge → done) is implemented by lib/greenfield.sh + the tick.sh bootstrap
# block, but greenfield.test.sh only pins the helpers in isolation + greps tick.sh for
# the wiring. This drives the REAL greenfield functions + REAL dispatch DB + REAL git,
# composing the bootstrap into the ordinary claim-gated delivery lane through to `done`,
# with a STUB scaffold agent (a real commit; no model, no spend).
#
# The bootstrap CREATES its repo via the real greenfield helpers, registers it, then
# delivers into it through the ordinary claim-gated lane. (Dispatch's ready gate still
# needs a linked repo — REPO_REQUIRED — so the create+register happens before ready;
# the create-a-repo work is the real bootstrap helpers, not a hand-registered fixture.)
# Asserts:
#   • the ticket is flagged bootstrap (create-a-repo);
#   • gaffer_bootstrap_init git-inits the new repo with a README BASELINE on `main`
#     (HEAD born, tree == README.md) — the base a delivery can branch off + diff against;
#   • gaffer_bootstrap_onboard REGISTERS the new repo in dispatch (the link target);
#   • the scaffold is delivered ON A BRANCH (gaffer/ticket-N-<slug>) forked OFF the
#     baseline — never branchless onto main (the reviewer-refused shape) — with the branch
#     recorded as the delivery branch;
#   • the ordinary lane finishes it: submit → approve → REAL auto-merge onto main →
#     mark-merged → `done`, with the scaffold actually on the default branch.
#
# Requires the dispatch CLI built + git. SKIPs (exit 0) otherwise.
# Run: bash test/e2e-bootstrap-to-done.test.sh    (also green under /bin/bash 3.2)
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

WORK="$(mktemp -d "${TMPDIR:-/tmp}/e2e-bootstrap.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
DB="$WORK/dispatch.sqlite"
export GAFFER_DATA="$WORK"
export GAFFER_BOOTSTRAP_ROOT="$WORK/git"   # sandbox the created repo well away from $HOME

# lib/greenfield.sh uses `log` (onboard error path) + the `wg` wrapper; provide both.
log() { :; }
# shellcheck source=../lib/greenfield.sh
source "$RUNNER_DIR/lib/greenfield.sh"
# shellcheck source=../lib/automerge.sh
source "$RUNNER_DIR/lib/automerge.sh"

wg()   { node "$CLI_JS" --db "$DB" "$@"; }
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }
status_of() { wg ticket show "$1" 2>/dev/null | jget "d['ticket']['status']" 2>/dev/null || echo ''; }
repo_registered() {  # count of registered repositories with the given name
  python3 - "$DB" "$1" <<'PY'
import sqlite3,sys
db,name=sys.argv[1],sys.argv[2]; c=sqlite3.connect(db)
print(c.execute("SELECT count(*) FROM repositories WHERE name=?",(name,)).fetchone()[0])
PY
}

echo "== SETUP: create the --bootstrap ticket (no repo exists yet) =="
wg init >/dev/null 2>&1
NUM="$(wg ticket create -t "Gym Tracker" --description "bootstrap a brand-new gym tracker repo" --policy team_light --risk low --bootstrap 2>/dev/null | jget "d['ticket']['number']")"
ACID="$(wg ac add "$NUM" -t "the new repo is scaffolded" 2>/dev/null | jget "d['ac_id']")"
IS_BOOT="$(wg ticket show "$NUM" 2>/dev/null | jget "1 if d['ticket'].get('bootstrap') else 0" 2>/dev/null || echo 0)"
[ "$IS_BOOT" = "1" ] && ok "#$NUM is flagged bootstrap (create-a-repo)" || fail "#$NUM not flagged bootstrap"

echo "== CREATE: the bootstrap helpers derive the name/dir + git-init a README BASELINE =="
RSHOW="$(wg ticket show "$NUM" 2>/dev/null)"
NAME="$(gaffer_bootstrap_repo_name "$RSHOW")"
[ "$NAME" = "gym-tracker" ] && ok "gaffer_bootstrap_repo_name derived the slug '$NAME'" || fail "repo name slug wrong (got '$NAME')"
DIR="$(gaffer_bootstrap_repo_dir "$NAME")"
[ "$DIR" = "$WORK/git/$NAME" ] && ok "gaffer_bootstrap_repo_dir = \$GAFFER_BOOTSTRAP_ROOT/<name>" || fail "repo dir wrong (got '$DIR')"
gaffer_bootstrap_target_ok "$DIR" >/dev/null 2>&1 && ok "target dir is usable (missing → will create)" || fail "target dir wrongly refused"
gaffer_bootstrap_init "$DIR" "$NAME" "Track your gym sessions" >/dev/null 2>&1 \
  && [ -d "$DIR/.git" ] && ok "gaffer_bootstrap_init created the git repo at $DIR" || fail "init did not create the repo"
[ "$(git -C "$DIR" symbolic-ref --short HEAD 2>/dev/null)" = "main" ] && ok "default branch is 'main'" || fail "default branch is not main"
BASELINE="$(git -C "$DIR" rev-parse --verify -q HEAD 2>/dev/null || echo '')"
{ [ -n "$BASELINE" ] && [ "$(git -C "$DIR" ls-tree -r --name-only HEAD 2>/dev/null)" = "README.md" ]; } \
  && ok "a README-only BASELINE commit is born on main (a base to branch off + diff)" \
  || fail "init did not seed a README-only baseline"

echo "== REGISTER: onboard the freshly-created repo into dispatch + link the ticket =="
gaffer_bootstrap_onboard "$NUM" "$NAME" "$DIR" "" >/dev/null 2>&1; ORC=$?
[ "$ORC" -eq 0 ] && ok "gaffer_bootstrap_onboard registered the new repo (rc0)" || fail "onboard failed (rc=$ORC)"
[ "$(repo_registered "$NAME")" = "1" ] && ok "the new repo '$NAME' is registered in dispatch (link target exists)" || fail "'$NAME' not registered in dispatch"
# The bootstrap ticket delivers into its own new repo → link it write.
wg ticket repo-access set "$NUM" "$NAME" --access write --relation confirmed >/dev/null 2>&1
WRITE_OK="$(wg ticket show "$NUM" 2>/dev/null | jget "any(r.get('name')=='$NAME' and r.get('access')=='write' for r in d.get('repositories',[]))" 2>/dev/null || echo False)"
[ "$WRITE_OK" = "True" ] && ok "linked the bootstrap ticket to its new repo with write access" || fail "ticket not linked write to '$NAME'"

echo "== READY+CLAIM: the bootstrap ticket now enters the ordinary claim-gated lane =="
wg ticket ready "$NUM" >/dev/null 2>&1
[ "$(status_of "$NUM")" = "ready" ] \
  && ok "the bootstrap ticket reached ready once its new repo was linked" \
  || fail "#$NUM not ready (got '$(status_of "$NUM")')"
AGENT="$(wg agent register -n gaffer-factory --max-risk high 2>/dev/null | jget "d['agent']['id']")"
TOKEN="$(wg claim-ticket "$NUM" --agent "$AGENT" --ttl 900 2>/dev/null | jget "d['claimToken']")"
{ [ -n "$TOKEN" ] && [ "$(status_of "$NUM")" = "claimed" ]; } \
  && ok "the runner claimed the bootstrap ticket (token held for the delivery)" \
  || fail "bootstrap ticket not claimed (status=$(status_of "$NUM"))"

echo "== DELIVER: scaffold ON A BRANCH forked OFF the baseline (never branchless on main) =="
SLUG="$NAME"
B_WORK_BRANCH="gaffer/ticket-$NUM-$SLUG"
# Branch off the baseline (exactly what tick.sh does: checkout -B <branch> off main).
git -C "$DIR" checkout -q -B "$B_WORK_BRANCH" main
# The stub scaffold agent: a real committed scaffold file + token-scoped AC evidence.
mkdir -p "$DIR/src"
printf 'export function track() { return true; }\n' > "$DIR/src/index.ts"
git -C "$DIR" add -A
git -C "$DIR" -c user.email=stub@test -c user.name=stub commit -qm "scaffold: gym tracker skeleton" >/dev/null 2>&1
wg evidence "$NUM" --token "$TOKEN" --type test_output --summary "scaffold in place" --ac "$ACID" >/dev/null 2>&1
git -C "$DIR" checkout -q main
# The delivery branch forked OFF the baseline and carries a real diff vs it.
[ "$(git -C "$DIR" merge-base "$B_WORK_BRANCH" main)" = "$BASELINE" ] \
  && ok "the delivery branch $B_WORK_BRANCH forked off the README baseline" \
  || fail "delivery branch is not forked off the baseline"
[ "$(git -C "$DIR" diff --numstat main..."$B_WORK_BRANCH" | wc -l | tr -d ' ')" -ge 1 ] \
  && ok "the scaffold is a real committed diff on the branch (branch-delivery, not branchless)" \
  || fail "no diff on the delivery branch"
# Record the delivery branch as branch_name (the reviewer/done-gate resolve THIS branch).
wg delivery-artifact "$NUM" --branch "$B_WORK_BRANCH" --as system >/dev/null 2>&1
wg ticket repo-delivery record "$NUM" "$NAME" --branch "$B_WORK_BRANCH" >/dev/null 2>&1
ok "recorded branch_name = $B_WORK_BRANCH (delivered via the ordinary review lane)"

echo "== FINISH: submit → approve → auto-merge → mark-merged → DONE =="
wg submit "$NUM" --token "$TOKEN" --reason "bootstrapped new repo + scaffold delivered" >/dev/null 2>&1
[ "$(status_of "$NUM")" = "in_review" ] && ok "submit moved the bootstrap ticket claimed → in_review" || fail "#$NUM not in_review after submit (got '$(status_of "$NUM")')"
wg review approve "$NUM" --reviewer human1 >/dev/null 2>&1
[ "$(status_of "$NUM")" = "ready_for_merge" ] && ok "approve → ready_for_merge (done-gate satisfied by the real branch diff)" || fail "#$NUM not ready_for_merge after approve (got '$(status_of "$NUM")')"
gaffer_auto_merge "$DIR" "$B_WORK_BRANCH" main; MRC=$?
[ "$MRC" -eq 0 ] && ok "gaffer_auto_merge landed the scaffold on main (rc0)" || fail "auto-merge rc=$MRC"
git -C "$DIR" show "main:src/index.ts" 2>/dev/null | grep -q 'function track' \
  && ok "the scaffold is now on the default branch (main)" \
  || fail "scaffold did not land on main"
wg ticket mark-merged "$NUM" --as system >/dev/null 2>&1
[ "$(status_of "$NUM")" = "done" ] \
  && ok "wg ticket mark-merged → the bootstrap ticket is DONE (repo created, scaffolded, shipped)" \
  || fail "#$NUM not done after mark-merged (got '$(status_of "$NUM")')"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "e2e-bootstrap-to-done: ALL $PASS checks passed"
  exit 0
fi
echo "e2e-bootstrap-to-done: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
