#!/usr/bin/env bash
# =====================================================================
# A FEATURE SHIPS WHEN ALL ITS WORK HAS LANDED, PR MODE (external review 17, finding 3).
# A feature epic of two tickets (both carrying `Feature-Id: <id>`), one repository with a
# bare upstream and a recorded PR per ticket, the real Dispatch and Memory CLIs and
# databases, and a local stand-in for `gh` that merges a PR the way the provider does.
#   P1  ticket 1 lands THROUGH ITS PR via `gaffer merge` (bin/merge-ticket.mjs, PR mode):
#       the PR merged upstream, the ticket is done, the digest is stamped, and the feature
#       stays building (ticket 2 has not landed). Before the fix it went to shipped here.
#   P2  ticket 2 lands through its PR via the merge lane (lib/land.sh, which runs the
#       post-merge memory step through merge-ticket.mjs --apply-digest-only): every ticket
#       landed, the feature is shipped exactly once.
# Run: bash runner/test/feature-ship-pr-landing.test.sh   (bash 3.2 safe)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
DISPATCH_JS="$ROOT/packages/dispatch/dist/cli/index.js"
MEMORY_JS="$ROOT/packages/memory/dist/bin/memory.js"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
{ [ -f "$DISPATCH_JS" ] && [ -f "$MEMORY_JS" ]; } || { echo "SKIP: build the workspace first (no dispatch / memory CLI)"; exit 0; }
WORK="$(gaffer_test_tmpdir feature-ship-pr)" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
[ "${KEEP:-0}" = 1 ] || trap 'gaffer_test_rm_work "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/data"
printf '#!/bin/sh\nexit 1\n' > "$WORK/bin/claude"; chmod +x "$WORK/bin/claude"
# The provider stand-in: `pr merge <url>` (…/pull/<n>) moves the upstream main to the head
# of gaffer/t<n> (each ticket's branch is built on the one before, so it fast-forwards),
# logs the request, refuses a PR that already merged; --delete-branch drops the branches.
cat > "$WORK/bin/gh" <<'GH'
#!/bin/sh
set -eu
if [ "$1" = "--version" ]; then echo fixture-gh; exit 0; fi
[ "$1 ${2:-}" = "pr merge" ] || exit 4
n="${3##*/}"
echo "pr$n" >> "$MOCK_ROOT/requests"
if [ -f "$MOCK_ROOT/merged-$n" ]; then echo "Pull request $3 was already merged" >&2; exit 1; fi
remote="$MOCK_ROOT/repo.git"
git --git-dir="$remote" update-ref refs/heads/main "$(git --git-dir="$remote" rev-parse "refs/heads/gaffer/t$n")"
: > "$MOCK_ROOT/merged-$n"
case " $* " in
  *" --delete-branch "*)
    git --git-dir="$remote" update-ref -d "refs/heads/gaffer/t$n"
    git branch -q -D "gaffer/t$n" >/dev/null 2>&1 || true ;;
esac
GH
chmod +x "$WORK/bin/gh"
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN GAFFER_DIGEST_DISABLE GAFFER_PRINCIPAL_TOKEN
D="$WORK"
export HOME="$D" GAFFER_DATA="$D/data" DISPATCH_DB="$D/data/dispatch.sqlite" MEMORY_DB="$D/data/memory.sqlite" MOCK_ROOT="$D" \
  CLAUDE_BIN="$WORK/bin/claude" GAFFER_GH_BIN="$WORK/bin/gh" GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 \
  GAFFER_PR_LOCAL_FALLBACK=0 GAFFER_CREATE_PR=1 GAFFER_MEMORY_INDEX=0 GAFFER_CONFLICT_RESOLVER=0 GAFFER_DOD_SANDBOX=0 \
  DISPATCH_AUDIT_OFF=1 MEMORY_AUDIT_OFF=1 GAFFER_STRICT_REQUIRE=0 GAFFER_DOD_TYPECHECK=0 GAFFER_DOD_LINT=0
: > "$D/requests"

wgd() { node "$DISPATCH_JS" --db "$DISPATCH_DB" "$@"; }
lgd() { node "$MEMORY_JS" "$@"; }
jf() { node "$RUNNER_DIR/lib/json-tool.mjs" expr "$1"; }
status() { wgd ticket show "$1" | jf 'd.ticket.status'; }
feature_status() {
  node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const d = new DatabaseSync(process.argv[1], { readOnly: true });
    const r = d.prepare("SELECT status FROM feature WHERE id = ?").get(process.argv[2]);
    const n = d.prepare("SELECT COUNT(*) AS n FROM events WHERE lore_id = ? AND json_extract(payload, ?) = ?").get(process.argv[2], "$.to", "shipped").n;
    console.log((r ? r.status : "missing") + " " + n);' "$MEMORY_DB" "$1"
}

# The repository: main, then gaffer/t1 (ticket 1's change) and gaffer/t2 built on it.
git init -q -b main "$D/repo"
git -C "$D/repo" config user.email fixture@example.invalid; git -C "$D/repo" config user.name Fixture
mkdir -p "$D/repo/test"
printf 'base\n' > "$D/repo/version.txt"
printf 'import test from "node:test";\ntest("smoke", () => {});\n' > "$D/repo/test/smoke.test.mjs"
git -C "$D/repo" add -A; git -C "$D/repo" commit -qm baseline
git -C "$D/repo" switch -qc gaffer/t1
printf 'one\n' > "$D/repo/one.txt"; git -C "$D/repo" add one.txt; git -C "$D/repo" commit -qm "ticket 1"
H1="$(git -C "$D/repo" rev-parse HEAD)"
git -C "$D/repo" switch -qc gaffer/t2
printf 'two\n' > "$D/repo/two.txt"; git -C "$D/repo" add two.txt; git -C "$D/repo" commit -qm "ticket 2"
H2="$(git -C "$D/repo" rev-parse HEAD)"
git -C "$D/repo" switch -q main
git init -q --bare "$D/repo.git"
git -C "$D/repo" remote add origin "$D/repo.git"
git -C "$D/repo" push -q origin main gaffer/t1 gaffer/t2
git -C "$D/repo" fetch -q origin

wgd init >/dev/null
wgd repo add -n repo --path "$D/repo" --branch main --test "node --test test/smoke.test.mjs" >/dev/null
lgd digest set repo --source onboard --overview o --structure s --conventions c --stack k >/dev/null
FEAT="$(lgd feature add repo --name "Two part feature" --summary s --status building | sed -n 's/^memory: added feature \([^ ]*\) .*/\1/p')"
cat > "$D/plan.json" <<EOF
{ "epic": { "name": "Two part feature", "description": "auto-planned", "acceptance": false },
  "tickets": [
    { "title": "Part one", "description": "Part one.\n\nFeature-Id: $FEAT", "acceptanceCriteria": ["one.txt exists"], "repo": "repo", "access": "write", "policy_pack": "team_light", "risk_level": "low", "testable": false, "dependsOn": [] },
    { "title": "Part two", "description": "Part two.\n\nFeature-Id: $FEAT", "acceptanceCriteria": ["two.txt exists"], "repo": "repo", "access": "write", "policy_pack": "team_light", "risk_level": "low", "testable": false, "dependsOn": [] } ] }
EOF
wgd epic create "$D/plan.json" >/dev/null
AGENT="$(wgd agent register -n fixture --max-risk high | jf 'd.agent.id')"

deliver() {  # <n> <head>: deliver ticket n on gaffer/t<n> with its PR, approve the head
  local n="$1" head="$2" ac token
  wgd ticket ready "$n" >/dev/null
  ac="$(wgd ticket show "$n" | jf "d.acceptanceCriteria[0].id")"
  token="$(wgd claim-ticket "$n" --agent "$AGENT" --ttl 900 | jf 'd.claimToken')"
  wgd evidence "$n" --token "$token" --type test_output --summary "delivered" --ac "$ac" >/dev/null
  wgd ticket repo-delivery record "$n" repo --branch "gaffer/t$n" --commit "$head" --pr "https://github.com/example/repo/pull/$n" >/dev/null
  wgd submit "$n" --token "$token" --reason "ready" >/dev/null
  wgd delivery-artifact "$n" --branch "gaffer/t$n" --diff "the change" --pr "https://github.com/example/repo/pull/$n" --as system >/dev/null
  wgd ticket ci-result "$n" --commit "$head" --state pass --as system >/dev/null
  wgd review approve "$n" --reviewer fixture --commit "repo=$head" >/dev/null
}

echo "== P1: ticket 1 lands through its PR (gaffer merge); ticket 2 has not landed =="
deliver 1 "$H1"
[ "$(status 1)" = ready_for_merge ] && ok "setup: #1 approved (ready_for_merge)" || fail "setup: #1 is $(status 1)"
( cd "$D" && node "$RUNNER_DIR/bin/merge-ticket.mjs" --ticket 1 ) > "$D/mt.out" 2> "$D/mt.log"; rc=$?
[ "$rc" -eq 0 ] && [ "$(status 1)" = done ] && ok "P1: #1 merged and done (rc=0)" || fail "P1: rc=$rc status=$(status 1) $(cat "$D/mt.out") $(tail -4 "$D/mt.log" | tr '\n' '|')"
[ "$(jf 'd.via || ""' < "$D/mt.out")" = pr ] && grep -qx pr1 "$D/requests" && ok "P1: landed THROUGH the PR (via pr)" || fail "P1: via=$(jf 'd.via || ""' < "$D/mt.out") requests=$(tr '\n' ' ' < "$D/requests")"
grep -q "source: merge:#1" <<<"$(lgd digest repo 2>/dev/null)" && ok "P1: the per-ticket digest stamp still ran (source merge:#1)" || fail "P1: digest not stamped: $(lgd digest repo 2>/dev/null | grep -i source)"
FS="$(feature_status "$FEAT")"
[ "$FS" = "building 0" ] && ok "P1: the feature stays building (ticket 2 has not landed)" || fail "P1: feature is '$FS' after the first PR landing (want 'building 0')"

echo "== P2: ticket 2 lands through its PR (the merge lane, lib/land.sh) =="
deliver 2 "$H2"
( cd "$D" || exit 2
  log() { printf '%s\n' "$*" >> "$D/lane.log"; }
  wg() { node "$DISPATCH_JS" --db "$DISPATCH_DB" "$@"; }
  jget() { node "$RUNNER_DIR/lib/json-tool.mjs" expr "$1"; }
  gaffer_refresh_cards() { :; }
  _gaffer_flag_on() { case "${1:-}" in 1|true|yes|on) return 0 ;; *) return 1 ;; esac; }
  export RUNNER_DIR
  # shellcheck source=../lib/automerge.sh
  source "$RUNNER_DIR/lib/automerge.sh"
  # shellcheck source=../lib/land.sh
  source "$RUNNER_DIR/lib/land.sh"
  gaffer_land_delivery 2 "$D/repo" gaffer/t2 main "$(wg ticket show 2)" MERGE ) > /dev/null 2>&1; rc=$?
[ "$rc" -eq 0 ] && [ "$(status 2)" = done ] && grep -qx pr2 "$D/requests" && ok "P2: #2 landed through its PR by the lane and is done" || fail "P2: rc=$rc status=$(status 2) requests=$(tr '\n' ' ' < "$D/requests") $(tail -5 "$D/lane.log" 2>/dev/null | tr '\n' '|')"
grep -q "#2 digest/feature applied post-merge" "$D/lane.log" && ok "P2: the lane ran the post-merge memory step" || fail "P2: no post-merge memory step: $(tail -3 "$D/lane.log" | tr '\n' '|')"
FS="$(feature_status "$FEAT")"
[ "$FS" = "shipped 1" ] && ok "P2: every ticket landed: the feature is shipped exactly once" || fail "P2: feature is '$FS' (want 'shipped 1'); $(tail -5 "$GAFFER_DATA/merge-digest.log" 2>/dev/null | tr '\n' '|')"

echo
echo "feature-ship-pr-landing: $PASS passed, ${#FAILURES[@]} failed"
if [ "${#FAILURES[@]}" -gt 0 ]; then
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
exit 0
