#!/usr/bin/env bash
# =====================================================================
# PR LANDING, LOCAL DEFAULT NOT FAST-FORWARDED (review of exploratory finding cli-wg/F-01).
# ---------------------------------------------------------------------
# bin/merge-ticket.mjs merges a ticket with a PR through `gh pr merge`, then fast-forwards
# the local default branch. When that fast-forward fails (the local default has a commit
# the remote does not), the PR still merged upstream. The landing must be recorded as
# `pr-stale` (checked against the remote-tracking default, which the fetch updated), not
# `pr` (checked against the local default, which cannot show it): recorded as `pr` it was
# refused and the ticket stayed ready_for_merge with its PR already merged.
#   1. gh merges the PR upstream, the local main diverged → the ticket is done, landed 1;
#   2. a gh that reports success but merged nothing upstream → no landing, not done.
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

WORK="$(gaffer_test_tmpdir pr-landing-noff)" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
DB="$WORK/dispatch.sqlite"
export GAFFER_DATA="$WORK"

wg()   { node "$CLI_JS" --db "$DB" "$@"; }
jget() { node "$RUNNER_DIR/lib/json-tool.mjs" expr "$1"; }
status_of() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status' 2>/dev/null || echo ''; }
gitc() { git -c user.email=gaffer@test -c user.name=gaffer-test "$@"; }

git init -q --bare -b main "$WORK/origin.git"
REPO="$WORK/repo"
git clone -q "$WORK/origin.git" "$REPO" 2>/dev/null
git -C "$REPO" checkout -q -b main 2>/dev/null
printf 'export const base = 0;\n' > "$REPO/mod.ts"
git -C "$REPO" add -A && gitc -C "$REPO" commit -qm init && git -C "$REPO" push -q origin main 2>/dev/null

wg init >/dev/null 2>&1
wg repo add -n repo --path "$REPO" --branch main --test "true" >/dev/null 2>&1
AGENT="$(wg agent register -n gaffer-factory --max-risk high 2>/dev/null | jget 'd.agent.id')"

# pr_ticket <title> → number: approved, its branch pushed, a PR on record.
pr_ticket() {
  local n ac tok br
  n="$(wg ticket create -t "$1" --description "pr" --policy team_light --risk low 2>/dev/null | jget 'd.ticket.number')"
  ac="$(wg ac add "$n" -t "done" 2>/dev/null | jget 'd.ac_id')"
  wg ticket repo-access set "$n" repo --access write --relation confirmed >/dev/null 2>&1
  wg ticket ready "$n" >/dev/null 2>&1
  tok="$(wg claim-ticket "$n" --agent "$AGENT" --ttl 900 2>/dev/null | jget 'd.claimToken')"
  br="gaffer/t$n"
  git -C "$REPO" checkout -q -b "$br" main
  printf '// change %s\n' "$n" > "$REPO/t$n.ts"
  git -C "$REPO" add -A && gitc -C "$REPO" commit -qm "change $n"
  git -C "$REPO" push -q origin "$br" 2>/dev/null
  git -C "$REPO" checkout -q main
  wg evidence "$n" --token "$tok" --type test_output --summary "ok" --ac "$ac" >/dev/null 2>&1
  wg ticket repo-delivery record "$n" repo --branch "$br" >/dev/null 2>&1
  wg submit "$n" --token "$tok" --reason "delivered" >/dev/null 2>&1
  # shellcheck disable=SC2046
  wg review approve "$n" --reviewer human1 $(wg ticket diff "$n" --heads 2>/dev/null | sed 's/^/--commit /') >/dev/null 2>&1
  node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);d.prepare("UPDATE tickets SET pr_url=? WHERE number=?").run(process.argv[3],Number(process.argv[2]));d.close()' "$DB" "$n" "https://github.com/o/r/pull/$n" 2>/dev/null
  printf '%s' "$n"
}
# A gh whose `pr merge` merges the PR's branch into the remote's main (what GitHub does).
mkdir -p "$WORK/bin"
cat > "$WORK/bin/gh" <<GH
#!/usr/bin/env bash
case "\$*" in *"pr merge"*) ;; *) exit 0 ;; esac
n="\$(printf '%s' "\$*" | sed -n 's|.*/pull/\([0-9]*\).*|\1|p')"
c="$WORK/gh-clone"; rm -rf "\$c"; git clone -q -b main "$WORK/origin.git" "\$c" 2>/dev/null
git -C "\$c" fetch -q origin "gaffer/t\$n" 2>/dev/null
git -C "\$c" -c user.email=gh@test -c user.name=gh merge -q --no-ff -m "Merge pull request #\$n" FETCH_HEAD
git -C "\$c" push -q origin HEAD:main 2>/dev/null
GH
printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/bin/gh-noop"   # says merged, merged nothing
chmod +x "$WORK/bin/gh" "$WORK/bin/gh-noop"
MT() { ( cd "$RUNNER_DIR" && env DISPATCH_DB="$DB" GAFFER_DATA="$WORK" GAFFER_GH_BIN="$2" CLAUDE_BIN=/bin/false node bin/merge-ticket.mjs --ticket "$1" ) 2>>"$WORK/merge.log"; }

echo "== 1. the PR merged upstream, the local main diverged (no fast-forward) → done =="
N="$(pr_ticket "first")"
[ "$(status_of "$N")" = "ready_for_merge" ] && ok "#$N approved with a PR on record" || fail "#$N: $(status_of "$N")"
printf 'local\n' > "$REPO/local.txt"; git -C "$REPO" add local.txt && gitc -C "$REPO" commit -qm "local only, not pushed"
OUT="$(MT "$N" "$WORK/bin/gh")"; RC=$?
[ "$RC" -eq 0 ] && [ "$(printf '%s' "$OUT" | jget 'String(d.fastForwarded)')" = "false" ] && ok "merged through the PR, local main not fast-forwarded" || fail "rc=$RC out=$OUT"
git -C "$WORK/origin.git" merge-base --is-ancestor "$(git -C "$REPO" rev-parse "gaffer/t$N")" main && ok "the remote main carries the change" || fail "the stub gh did not merge upstream"
[ "$(wg ticket landing "$N" 2>/dev/null | jget 'd.landed')" = "1" ] && ok "the landing is recorded (pr-stale, against origin/main)" || fail "no landing recorded: $(tail -3 "$WORK/merge.log" | tr '\n' '|')"
[ "$(status_of "$N")" = "done" ] && ok "#$N is done" || fail "#$N status $(status_of "$N")"

echo "== 2. gh reports a merge that never reached the remote → no landing, not done =="
git -C "$REPO" fetch -q origin 2>/dev/null; git -C "$REPO" reset -q --hard origin/main
N2="$(pr_ticket "second")"
OUT2="$(MT "$N2" "$WORK/bin/gh-noop")"; RC2=$?
[ "$(wg ticket landing "$N2" 2>/dev/null | jget 'd.landed')" = "0" ] && ok "no landing is recorded" || fail "a landing was recorded for a PR that never merged (rc=$RC2 $OUT2)"
[ "$(status_of "$N2")" = "ready_for_merge" ] && ok "#$N2 stays ready_for_merge" || fail "#$N2 status $(status_of "$N2")"

echo
echo "pr-landing-not-fast-forwarded: $PASS passed, ${#FAILURES[@]} failed"
[ "${#FAILURES[@]}" -eq 0 ]
