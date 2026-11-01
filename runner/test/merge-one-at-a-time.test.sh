#!/usr/bin/env bash
# =====================================================================
# ONE MERGE PER TICKET (exploratory finding api/F1), bin/merge-ticket.mjs.
# ---------------------------------------------------------------------
# Two merge runs on one ticket (two Merge clicks, `gaffer merge` beside the dashboard's)
# shared the ticket's merge-gate scratch checkout: the second removed the first's while it
# was merging, the first read the failed merge as a CONFLICT, and the resolver path sent
# the approved ticket back to review with main unchanged.
#   1. a run while another holds the ticket's merge lock does nothing (exit 4);
#   2. a stale lock (its pid is gone) is taken over and the merge lands;
#   3. two runs started together: the ticket is done, main has ONE merge, and the ticket
#      was never sent back to review;
#   4. a merge that fails in the scratch checkout WITHOUT unmerged paths is an error, not a
#      conflict (the resolver is never spawned for it).
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

WORK="$(gaffer_test_tmpdir merge-one-at-a-time)" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
DB="$WORK/dispatch.sqlite"
export GAFFER_DATA="$WORK"

wg()   { node "$CLI_JS" --db "$DB" "$@"; }
jget() { node "$RUNNER_DIR/lib/json-tool.mjs" expr "$1"; }
status_of() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status' 2>/dev/null || echo ''; }

REPO="$WORK/repo"
git init -q -b main "$REPO"
git -C "$REPO" config user.email gaffer@test
git -C "$REPO" config user.name gaffer-test
printf 'export const base = 0;\n' > "$REPO/mod.ts"
git -C "$REPO" add -A && git -C "$REPO" commit -qm init

wg init >/dev/null 2>&1
wg repo add -n repo --path "$REPO" --branch main --test "true" >/dev/null 2>&1
AGENT="$(wg agent register -n gaffer-factory --max-risk high 2>/dev/null | jget 'd.agent.id')"

approved_ticket() {  # $1 title → number; ready_for_merge with one commit on gaffer/t<N>
  local n ac tok br
  n="$(wg ticket create -t "$1" --description "one repo" --policy team_light --risk low 2>/dev/null | jget 'd.ticket.number')"
  ac="$(wg ac add "$n" -t "done" 2>/dev/null | jget 'd.ac_id')"
  wg ticket repo-access set "$n" repo --access write --relation confirmed >/dev/null 2>&1
  wg ticket ready "$n" >/dev/null 2>&1
  tok="$(wg claim-ticket "$n" --agent "$AGENT" --ttl 900 2>/dev/null | jget 'd.claimToken')"
  br="gaffer/t$n"
  git -C "$REPO" checkout -q -b "$br" main
  printf '// change %s\n' "$n" > "$REPO/t$n.ts"
  git -C "$REPO" add -A && git -C "$REPO" commit -qm "change $n"
  git -C "$REPO" checkout -q main
  wg evidence "$n" --token "$tok" --type test_output --summary "ok" --ac "$ac" >/dev/null 2>&1
  wg ticket repo-delivery record "$n" repo --branch "$br" >/dev/null 2>&1
  wg submit "$n" --token "$tok" --reason "delivered" >/dev/null 2>&1
  # shellcheck disable=SC2046
  wg review approve "$n" --reviewer human1 $(wg ticket diff "$n" --heads 2>/dev/null | sed 's/^/--commit /') >/dev/null 2>&1
  printf '%s' "$n"
}
MT() { env DISPATCH_DB="$DB" GAFFER_DATA="$WORK" CLAUDE_BIN=/bin/false node "$RUNNER_DIR/bin/merge-ticket.mjs" --ticket "$1" 2>>"$WORK/merge.log"; }

echo "== 1. another run holds the ticket's merge lock → nothing done, exit 4 =="
N="$(approved_ticket "first")"
[ "$(status_of "$N")" = "ready_for_merge" ] && ok "#$N approved" || fail "#$N not approved: $(status_of "$N")"
LOCK="$WORK/locks/merge-ticket-$N.lock"
mkdir -p "$LOCK" && printf '%s' "$$" > "$LOCK/pid"     # this shell: a live owner
MAIN0="$(git -C "$REPO" rev-parse main)"
OUT="$(MT "$N")"; RC=$?
[ "$RC" -eq 4 ] && ok "merge-ticket exits 4 while the lock is held" || fail "rc=$RC out=$OUT"
case "$(printf '%s' "$OUT" | jget 'd.error || ""')" in *"another merge of it is already running"*) ok "it says another merge is running" ;; *) fail "message: $OUT" ;; esac
[ "$(git -C "$REPO" rev-parse main)" = "$MAIN0" ] && ok "main untouched" || fail "main moved"
[ "$(status_of "$N")" = "ready_for_merge" ] && ok "ticket still ready_for_merge" || fail "status $(status_of "$N")"
[ -f "$LOCK/pid" ] && [ "$(cat "$LOCK/pid")" = "$$" ] && ok "the other run's lock is left alone" || fail "lock was touched"

echo "== 2. a stale lock (owner gone) is taken over; the merge lands and releases it =="
printf '%s' "999999" > "$LOCK/pid"
OUT2="$(MT "$N")"; RC2=$?
[ "$RC2" -eq 0 ] && [ "$(status_of "$N")" = "done" ] && ok "the merge landed (done)" || fail "rc=$RC2 out=$OUT2"
[ -d "$LOCK" ] && fail "the lock was not released" || ok "the lock is released after the run"

echo "== 3. two runs started together → one landing, never back to review =="
N2="$(approved_ticket "second")"
MERGES0="$(git -C "$REPO" rev-list --count main)"
( MT "$N2" > "$WORK/a.json" ) & PA=$!
( MT "$N2" > "$WORK/b.json" ) & PB=$!
wait "$PA"; RA=$?; wait "$PB"; RB=$?
[ "$(status_of "$N2")" = "done" ] && ok "#$N2 is done" || fail "#$N2 status $(status_of "$N2") (a=$RA $(cat "$WORK/a.json") b=$RB $(cat "$WORK/b.json"))"
REOPENED="$(wg ticket show "$N2" 2>/dev/null | jget '(d.events||[]).filter(e => e.event_type === "ticket.reopened_for_review").length' 2>/dev/null || echo '?')"
[ "$REOPENED" = "0" ] && ok "the ticket was never sent back to review" || fail "reopened_for_review events: $REOPENED"
grep -q '"phase":"conflict' "$WORK/a.json" "$WORK/b.json" && fail "a run reported a conflict" || ok "no run reported a conflict"
ADDED=$(( $(git -C "$REPO" rev-list --count main) - MERGES0 ))
# One landing adds the change (and at most one merge commit); a second landing would add more.
[ "$ADDED" -ge 1 ] && [ "$ADDED" -le 2 ] && ok "main gained one landing ($ADDED commit(s))" || fail "main gained $ADDED commits"
{ [ "$RA" -eq 0 ] || [ "$RB" -eq 0 ]; } && ok "one run merged (a=$RA b=$RB)" || fail "no run merged (a=$RA b=$RB)"

echo "== 4. a failed scratch merge with no unmerged paths is an error, not a conflict =="
# (Paths go in through the env: merge-ticket.mjs runs as a CLI when argv[1] names it.)
GATE="$(MT_JS="$RUNNER_DIR/bin/merge-ticket.mjs" GATE_REPO="$REPO" GATE_DIR="$WORK/worktrees/gate-probe" node --input-type=module -e '
  const { gateProposedMerge } = await import(process.env.MT_JS);
  const r = gateProposedMerge({ repoPath: process.env.GATE_REPO, branch: "gaffer/none", pin: "f".repeat(40),
    targetRef: "refs/heads/main", label: "repo", commands: { test: "", lint: "" }, gateDir: process.env.GATE_DIR });
  process.stdout.write(r.kind + "|" + r.reason);
' 2>/dev/null)"
case "$GATE" in error\|*"without a conflict"*) ok "kind=error: $GATE" ;; *) fail "gate result: $GATE" ;; esac

echo
echo "merge-one-at-a-time: $PASS passed, ${#FAILURES[@]} failed"
[ "${#FAILURES[@]}" -eq 0 ]
