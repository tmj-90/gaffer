#!/usr/bin/env bash
# =====================================================================
# EVERY RECORDED PR LANDS UPSTREAM (external review #8, finding 3).
# ---------------------------------------------------------------------
# Two repositories, each delivery record carrying a PR. Gaffer used to ask the provider to
# merge only the primary's PR, merge the secondary into its LOCAL checkout and mark the
# ticket done while that repo's upstream main still had the original code. Now each repo
# with a recorded PR lands through that PR, on both landing paths:
#   merge  `gaffer merge` (bin/merge-ticket.mjs)
#   poll   the merge lane / AFK path (lib/land.sh gaffer_land_delivery)
# For each path: the provider rejects A → nothing lands, only A's PR was asked for, the
# ticket stays open; the provider rejects B → A may land, B's upstream main is unchanged
# and the ticket is NOT done; the provider accepts both → both upstreams moved, done.
# Ported from the reviewer's pull-requests/check.py: real git with two bare upstreams, the
# real Dispatch CLI and a local stand-in for gh. GAFFER_PR_LOCAL_FALLBACK=0 throughout.
# Run: bash test/secondary-pr-landing.test.sh   (bash 3.2 safe)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
DISPATCH_JS="$ROOT/packages/dispatch/dist/cli/index.js"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
[ -f "$DISPATCH_JS" ] || { echo "SKIP: build the workspace first (no $DISPATCH_JS)"; exit 0; }
WORK="$(gaffer_test_tmpdir secondary-pr-landing)" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
mkdir -p "$WORK/bin"
printf '#!/bin/sh\nexit 1\n' > "$WORK/bin/claude"; chmod +x "$WORK/bin/claude"
cat > "$WORK/bin/gh" <<'GH'
#!/bin/sh
set -eu
if [ "$1" = "--version" ]; then echo fixture-gh; exit 0; fi
[ "$1 $2" = "pr merge" ] || exit 4
case "$3" in */repoA/*) repo=repoA ;; */repoB/*) repo=repoB ;; *) exit 3 ;; esac
echo "$repo" >> "$MOCK_ROOT/requests"
if [ "$repo" = "$MOCK_BLOCKED" ]; then echo 'required check is red' >&2; exit 1; fi
remote="$MOCK_ROOT/$repo.git"
git --git-dir="$remote" update-ref refs/heads/main "$(git --git-dir="$remote" rev-parse refs/heads/gaffer/change)"
GH
chmod +x "$WORK/bin/gh"
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
export CLAUDE_BIN="$WORK/bin/claude" GAFFER_GH_BIN="$WORK/bin/gh" GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 \
  GAFFER_PR_LOCAL_FALLBACK=0 GAFFER_CREATE_PR=1 GAFFER_DIGEST_DISABLE=1 GAFFER_MEMORY_INDEX=0 \
  GAFFER_CONFLICT_RESOLVER=0 GAFFER_DOD_SANDBOX=0 DISPATCH_AUDIT_OFF=1 MEMORY_AUDIT_OFF=1

D=""
wgd() { node "$DISPATCH_JS" --db "$D/data/dispatch.sqlite" "$@"; }
jf() { node "$RUNNER_DIR/lib/json-tool.mjs" expr "$1"; }
upstream() { git --git-dir="$D/$1.git" show main:version.txt; }

world() {  # <case> <blocked repo or none>
  D="$WORK/$1"; mkdir -p "$D/data"
  export HOME="$D" GAFFER_DATA="$D/data" DISPATCH_DB="$D/data/dispatch.sqlite" MEMORY_DB="$D/data/memory.sqlite" \
    MOCK_ROOT="$D" MOCK_BLOCKED="$2"
  : > "$D/requests"
  wgd init >/dev/null
  local name
  for name in repoA repoB; do
    git init -q -b main "$D/$name"
    git -C "$D/$name" config user.email fixture@example.invalid; git -C "$D/$name" config user.name Fixture
    printf 'base\n' > "$D/$name/version.txt"; git -C "$D/$name" add version.txt; git -C "$D/$name" commit -qm baseline
    git -C "$D/$name" switch -qc gaffer/change
    printf '%s delivery\n' "$name" > "$D/$name/version.txt"; git -C "$D/$name" add version.txt; git -C "$D/$name" commit -qm deliver
    eval "HEAD_$name=\"\$(git -C \"\$D/\$name\" rev-parse HEAD)\""
    git -C "$D/$name" switch -q main
    git init -q --bare "$D/$name.git"
    git -C "$D/$name" remote add origin "$D/$name.git"
    git -C "$D/$name" push -q origin main gaffer/change
    wgd repo add -n "$name" --path "$D/$name" --branch main --test true >/dev/null
  done
  wgd ticket create -t "Update both repos" --policy team_light --description "One pull request per repository" --risk low >/dev/null
  local ac agent token
  ac="$(wgd ac add 1 -t "Update both versions" | jf 'd.ac_id')"
  for name in repoA repoB; do wgd ticket repo-access set 1 "$name" --access write --relation confirmed >/dev/null; done
  wgd ticket ready 1 >/dev/null
  agent="$(wgd agent register -n fixture --max-risk high | jf 'd.agent.id')"
  token="$(wgd claim-ticket 1 --agent "$agent" --ttl 900 | jf 'd.claimToken')"
  wgd evidence 1 --token "$token" --type test_output --summary "Both versions changed" --ac "$ac" >/dev/null
  wgd ticket repo-delivery record 1 repoA --branch gaffer/change --commit "$HEAD_repoA" --pr "https://github.com/example/repoA/pull/1" >/dev/null
  wgd ticket repo-delivery record 1 repoB --branch gaffer/change --commit "$HEAD_repoB" --pr "https://github.com/example/repoB/pull/1" >/dev/null
  wgd submit 1 --token "$token" --reason "Both deliveries ready" >/dev/null
  wgd delivery-artifact 1 --branch gaffer/change --diff "Two filed PRs" --pr "https://github.com/example/repoA/pull/1" --as system >/dev/null
  wgd review approve 1 --reviewer fixture --commit "repoA=$HEAD_repoA" --commit "repoB=$HEAD_repoB" >/dev/null
}
status() { wgd ticket show 1 | jf 'd.ticket.status'; }
calls() { tr '\n' ' ' < "$D/requests" | sed 's/ $//'; }

land_via() {  # <merge|poll> → rc
  if [ "$1" = merge ]; then
    ( cd "$D" && bash "$RUNNER_DIR/gaffer" merge 1 ) > "$D/land.log" 2>&1
  else
    ( cd "$D" || exit 2
      log() { printf '%s\n' "$*" >> "$D/land.log"; }
      wg() { node "$DISPATCH_JS" --db "$DISPATCH_DB" "$@"; }
      jget() { node "$RUNNER_DIR/lib/json-tool.mjs" expr "$1"; }
      gaffer_refresh_cards() { :; }
      _gaffer_flag_on() { case "${1:-}" in 1|true|yes|on) return 0 ;; *) return 1 ;; esac; }
      export RUNNER_DIR
      # shellcheck source=../lib/automerge.sh
      source "$RUNNER_DIR/lib/automerge.sh"
      # shellcheck source=../lib/land.sh
      source "$RUNNER_DIR/lib/land.sh"
      gaffer_land_delivery 1 "$D/repoA" gaffer/change main "$(wg ticket show 1)" MERGE ) > /dev/null 2>&1
  fi
}

for path in merge poll; do
  echo "== $path: the provider rejects A =="
  world "$path-rejectA" repoA
  land_via "$path"; rc=$?
  [ "$rc" -ne 0 ] && [ "$(status)" != done ] && ok "$path/A: held, not done (rc=$rc, $(status))" || fail "$path/A: rc=$rc status=$(status)"
  [ "$(calls)" = repoA ] && ok "$path/A: only A's PR was asked for" || fail "$path/A: provider calls: $(calls)"
  [ "$(upstream repoA)" = base ] && [ "$(upstream repoB)" = base ] && ok "$path/A: both upstreams unchanged" || fail "$path/A: an upstream moved"
  [ "$(git -C "$D/repoB" show main:version.txt)" = base ] && ok "$path/A: B's local main untouched too" || fail "$path/A: B merged locally"

  echo "== $path: the provider rejects B =="
  world "$path-rejectB" repoB
  land_via "$path"; rc=$?
  [ "$(calls)" = "repoA repoB" ] && ok "$path/B: B's PR was asked for too (not bypassed by a local merge)" || fail "$path/B: provider calls: $(calls)"
  [ "$(status)" != done ] && [ "$rc" -ne 0 ] && ok "$path/B: the ticket is NOT done (rc=$rc, $(status))" || fail "$path/B: done with B missing upstream (rc=$rc)"
  [ "$(upstream repoB)" = base ] && ok "$path/B: B's upstream main unchanged" || fail "$path/B: B's upstream moved"
  [ "$(git -C "$D/repoB" show main:version.txt)" = base ] && ok "$path/B: B was not merged into its local checkout" || fail "$path/B: B merged locally"
  [ "$(upstream repoA)" = "repoA delivery" ] && ok "$path/B: A landed upstream through its PR" || fail "$path/B: A did not land"
  [ "$(wgd ticket landing 1 | jf '(d.repos || []).filter(r => r.landed).map(r => r.repo).join(",")')" = repoA ] \
    && ok "$path/B: Dispatch records A landed and B pending (partly landed)" || fail "$path/B: landing record: $(wgd ticket landing 1)"

  echo "== $path: the provider accepts both =="
  world "$path-accept" none
  land_via "$path"; rc=$?
  [ "$rc" -eq 0 ] && [ "$(status)" = done ] && ok "$path/ok: both PRs merged, the ticket is done" || fail "$path/ok: rc=$rc status=$(status) $(tail -3 "$D/land.log" 2>/dev/null)"
  [ "$(upstream repoA)" = "repoA delivery" ] && [ "$(upstream repoB)" = "repoB delivery" ] && ok "$path/ok: both upstream mains moved" || fail "$path/ok: an upstream did not move"
  [ "$(calls)" = "repoA repoB" ] && ok "$path/ok: one PR merge per repo" || fail "$path/ok: provider calls: $(calls)"
done

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "secondary-pr-landing: ALL $PASS checks passed"; exit 0
else echo "secondary-pr-landing: ${#FAILURES[@]} FAILED (of $((PASS + ${#FAILURES[@]})))"; exit 1; fi
