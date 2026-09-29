#!/usr/bin/env bash
# =====================================================================
# MERGE LANE — a ticket that reaches ready_for_merge by any route lands autonomously.
# ---------------------------------------------------------------------
# The agent review pass merged only what IT approved. A ticket a HUMAN approved (the
# dashboard, `wg review approve`) or the independent TESTER passed reached
# ready_for_merge and then waited for the dashboard's Merge button — in autonomous mode
# too. A live run stalled that way with nine dependents starving behind a human-approved
# bootstrap. lib/merge-lane.sh runs at the start of every tick and lands every
# ready_for_merge ticket the merge policy permits, through the SAME gaffer_land_delivery
# the review pass uses. Proven against the REAL dispatch + tick.sh with a stub agent:
#   A  autonomous (merge env floor on): human-approved ticket → merged into main, done,
#      branch deleted, and its DEPENDENT is delivered in the SAME tick;
#   B  supervised (merge floor off, no policy): held for a human, logged ONCE per run,
#      the second tick stays silent (skip file), loop.sh resets the skip file;
#   C  GAFFER_MERGE_LANE=0 disables the lane (nothing merged, nothing logged);
#   D  wiring: tick.sh sources lib/land.sh + lib/merge-lane.sh and runs the lane before
#      the candidate scan; review.sh lands through the shared function;
#   E  a merge CONFLICT spawns the conflict resolver (bin/merge-ticket.mjs) once: the
#      branch gets the resolution, the ticket returns to in_review, main is untouched,
#      the spend is ledgered; re-approval lands it with both sides intact;
#   F  a second conflict after a resolver pass is held for a human; the knob turns the
#      resolver off.
# Run: bash runner/test/merge-lane.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CLI_JS="$ROOT/packages/dispatch/dist/cli/index.js"
[ -f "$CLI_JS" ] || { echo "SKIP: dispatch CLI not built"; exit 0; }
[ -f "$ROOT/packages/crew/dist/runtime/context/renderPromptCli.js" ] || { echo "SKIP: crew not built"; exit 0; }

PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/merge-lane.XXXXXX")"; WORK="$(cd "$WORK" && pwd -P)"
[ "${KEEP:-0}" = 1 ] || trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/data" "$WORK/bin" "$WORK/calls"; CALLS="$WORK/calls"

R="$WORK/repo"; mkdir -p "$R/src" "$R/test"
( cd "$R" && git init -q -b main
  printf '{ "name": "r", "version": "0.1.0", "private": true, "type": "module", "scripts": { "test": "node --test", "lint": "node -e 0" } }\n' > package.json
  printf 'export function a() { return 1; }\n' > src/a.js
  printf 'import test from "node:test"; import assert from "node:assert/strict";\nimport { a } from "../src/a.js";\ntest("a", () => { assert.equal(a(), 1); });\n' > test/a.test.js
  git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init )

# Stub agent: on a delivery turn commits one helper (named after the ticket) and reports.
cat > "$WORK/bin/claude" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
CALLS="__CALLS__"
n="$(ls -1 "$CALLS" 2>/dev/null | wc -l | tr -d ' ')"; n=$((n + 1)); D="$CALLS/$(printf '%03d' "$n")"; mkdir -p "$D"
prompt=""; prev=""; for a in "$@"; do [ "$prev" = "-p" ] && prompt="$a"; prev="$a"; done; printf '%s' "$prompt" > "$D/prompt"
if printf '%s' "$prompt" | grep -q 'resolve-merge-conflict skill'; then
  # Conflict RESOLVER turn (case E): merge main INTO the branch in this worktree, keep
  # both sides' helpers, commit the merge on the branch, report a summary.
  echo resolver > "$D/kind"
  def="$(printf '%s' "$prompt" | sed -n 's/.*Merge the default branch "\([^"]*\)".*/\1/p' | head -1)"; def="${def:-main}"
  if ! git -c user.email=s@s -c user.name=s merge --no-edit "$def" >/dev/null 2>&1; then
    { git show ":2:src/a.js" 2>/dev/null; git show ":3:src/a.js" 2>/dev/null; } | awk '!seen[$0]++' > src/a.js.merged && mv src/a.js.merged src/a.js
    git -c user.email=s@s -c user.name=s add -A >/dev/null; git -c user.email=s@s -c user.name=s commit -qm "resolve: keep both helpers" >/dev/null 2>&1 || true
  fi
  printf '{"type":"result","subtype":"success","is_error":false,"result":"resolved: kept both helpers; tests pass.","total_cost_usd":0.03,"num_turns":2}\n'; exit 0
fi
if [ -e .git ]; then
  fn="helper${GAFFER_TICKET:-0}"; echo "$fn" > "$D/kind"
  grep -q "$fn" src/a.js || printf 'export function %s(){return 2;}\n' "$fn" >> src/a.js
  git -c user.email=s@s -c user.name=s add -A >/dev/null; git -c user.email=s@s -c user.name=s commit -qm "feat: $fn" >/dev/null 2>&1 || true
  printf '{"type":"result","subtype":"success","is_error":false,"result":"done.\\n\\nSmallest-change note: helper.","total_cost_usd":0.02,"num_turns":1}\n'; exit 0
fi
echo other > "$D/kind"; printf '{"type":"result","subtype":"success","is_error":false,"result":"ok"}\n'
STUB
sed -i.bak "s|__CALLS__|$CALLS|" "$WORK/bin/claude" && rm -f "$WORK/bin/claude.bak"; chmod +x "$WORK/bin/claude"

export GAFFER_DATA="$WORK/data" CLAUDE_BIN="$WORK/bin/claude" CLAUDE_FLAGS="" \
       GAFFER_MAX_TURNS=3 GAFFER_TICK_TIMEOUT=60 GAFFER_CARD_MODEL=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
       REVIEW_MODE=human DRY_RUN=0 GAFFER_MAINTENANCE=0 GAFFER_STRICT_REQUIRE=0 GAFFER_SECURITY_REVIEW=0 GAFFER_TESTING=0 \
       MAX_OPEN_AGENT_BRANCHES_PER_REPO=10 MAX_IN_REVIEW_PER_REPO=10
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
wg repo add -n repo --path "$R" --branch main --stack node --test "npm test" --lint "npm run lint" >/dev/null 2>&1

run_tick() { ( cd "$RUNNER_DIR" && bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT=' ; }
st() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status'; }
new_ticket() { local n; n="$(wg ticket create -t "$1" -d "$2" --risk low 2>/dev/null | jget 'd.ticket.number')"; wg ac add "$n" -t "helper added" >/dev/null 2>&1; wg ticket repo-access set "$n" repo --access write --relation confirmed >/dev/null 2>&1; printf '%s' "$n"; }
branch_of() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.branch_name || ""'; }
LOGF="$GAFFER_DATA/factory.log"

echo "== A. autonomous: a HUMAN-approved ticket lands at the start of the next tick; its dependent delivers in the same tick =="
A="$(new_ticket "Landed helper" "deliver a helper")"; wg ticket ready "$A" >/dev/null 2>&1
DEP="$(new_ticket "Dependent helper" "deliver a helper after #$A")"; wg ticket dep add "$DEP" "$A" >/dev/null 2>&1; wg ticket ready "$DEP" >/dev/null 2>&1
AUTO_MERGE=0 run_tick >/dev/null
[ "$(st "$A")" = "in_review" ] && ok "A: #$A delivered → in_review" || fail "A: status=$(st "$A")"
AUTO_MERGE=0 run_tick >/dev/null
[ "$(st "$DEP")" = "ready" ] && ok "A: dependent #$DEP is NOT deliverable while #$A is unmerged (the edge is real)" || fail "A: dependent status=$(st "$DEP") before the merge — the dependency edge did not hold"
BA="$(branch_of "$A")"; [ -n "$BA" ] && ok "A: delivery branch recorded ($BA)" || fail "A: no branch_name recorded"
wg review approve "$A" --reviewer human1 >/dev/null 2>&1
[ "$(st "$A")" = "ready_for_merge" ] && ok "A: human approve → ready_for_merge (nobody has merged yet)" || fail "A: after approve status=$(st "$A")"
MAIN0="$(git -C "$R" rev-parse main)"
OUT="$(GAFFER_MODE=autonomous AUTO_MERGE=1 DISPATCH_ALLOW_AGENT_APPROVE=1 MERGE_ON_AGENT_REVIEW=1 run_tick)"
[ "$(st "$A")" = "done" ] && ok "A: merge lane landed #$A → done" || fail "A: after tick status=$(st "$A") ($OUT)"
_MLOG="$(git -C "$R" log --oneline main)"   # string match, not `| grep -q`: under pipefail grep's early exit can SIGPIPE git (seen on macOS CI)
if [ "$(git -C "$R" rev-parse main)" != "$MAIN0" ] && [[ "$_MLOG" == *"helper$A"* ]]; then ok "A: main now carries the helper commit"; else fail "A: main did not gain the helper commit (main $(git -C "$R" rev-parse --short main) vs before $(printf '%s' "$MAIN0" | cut -c1-7); log: $(git -C "$R" log --oneline -3 main | tr '\n' '|'); stub commits: $(grep -l . "$CALLS"/*/kind 2>/dev/null | xargs -I{} cat {} 2>/dev/null | tr '\n' ','))"; fi
git -C "$R" rev-parse --verify -q "refs/heads/$BA" >/dev/null 2>&1 && fail "A: merged branch $BA still exists" || ok "A: merged branch deleted"
grep -q "MERGE: #$A ready_for_merge + merge gate earned → landing $BA → main" "$LOGF" && ok "A: lane logged the landing" || fail "A: no landing log line"
grep -q "MERGE: #$A merged ($BA → main, via local) and marked done" "$LOGF" && ok "A: shared landing logged under the MERGE prefix" || fail "A: no MERGE-prefixed merged line: $(grep "#$A" "$LOGF" | tail -3 | tr '\n' '|' | cut -c1-300)"
# autonomous turns auto-push on; the fixture repo has no origin. That is "nothing to push",
# never a rejected push (seen live: every merge of a greenfield run logged a failed push).
grep -q "MERGE: main merged locally — no origin remote, nothing to push" "$LOGF" && ok "A: no-origin repo logs 'nothing to push' (not a failed push)" || fail "A: no-origin push line missing or wrong: $(grep -i 'push' "$LOGF" | tail -2 | tr '\n' '|' | cut -c1-300)"
[ "$(st "$DEP")" = "in_review" ] && ok "A: dependent #$DEP was unblocked AND delivered in the SAME tick (lane runs before the scan)" || fail "A: dependent status=$(st "$DEP") — expected in_review"
echo "$OUT" | grep -q '^TICK_RESULT=worked$' && ok "A: the tick still reports its delivery (lane never exits the tick)" || fail "A: tick result $OUT"

echo "== B. supervised: the merge gate holds; logged once per run; loop.sh resets the skip file =="
B="$(new_ticket "Held helper" "deliver a helper")"; wg ticket ready "$B" >/dev/null 2>&1
AUTO_MERGE=0 run_tick >/dev/null; wg review approve "$B" --reviewer human1 >/dev/null 2>&1
[ "$(st "$B")" = "ready_for_merge" ] && ok "B: #$B human-approved → ready_for_merge" || fail "B: status=$(st "$B")"
AUTO_MERGE=0 GAFFER_MODE=supervised run_tick >/dev/null
[ "$(st "$B")" = "ready_for_merge" ] && ok "B: supervised → NOT merged (held for a human)" || fail "B: status=$(st "$B")"
N1="$(grep -c "MERGE: #$B approved but auto-merge NOT permitted by policy" "$LOGF")"
[ "$N1" = "1" ] && ok "B: the hold is logged once" || fail "B: hold logged $N1 times"
AUTO_MERGE=0 GAFFER_MODE=supervised run_tick >/dev/null
N2="$(grep -c "MERGE: #$B approved but auto-merge NOT permitted by policy" "$LOGF")"
[ "$N2" = "1" ] && ok "B: a second tick in the same run stays silent (skip file)" || fail "B: hold logged $N2 times after the second tick"
grep -qx "$B" "$GAFFER_DATA/.merge-held-tickets" && ok "B: #$B recorded in .merge-held-tickets" || fail "B: skip file lacks #$B"
grep -q '"\$GAFFER_DATA/.merge-held-tickets"' "$RUNNER_DIR/loop.sh" && ok "B: loop.sh resets .merge-held-tickets each run" || fail "B: loop.sh does not reset the skip file"
# The hold lasts for the RUN (like .reviewed-tickets): the next run (loop.sh resets the
# skip file) re-asks the policy, and with the merge floor on the held ticket lands.
rm -f "$GAFFER_DATA/.merge-held-tickets"
GAFFER_MODE=autonomous AUTO_MERGE=1 DISPATCH_ALLOW_AGENT_APPROVE=1 MERGE_ON_AGENT_REVIEW=1 run_tick >/dev/null
[ "$(st "$B")" = "done" ] && ok "B: next run with the merge floor on → the held ticket lands" || fail "B: status=$(st "$B") after floor on"

echo "== C. GAFFER_MERGE_LANE=0 disables the lane =="
C="$(new_ticket "Lane-off helper" "deliver a helper")"; wg ticket ready "$C" >/dev/null 2>&1
AUTO_MERGE=0 run_tick >/dev/null; wg review approve "$C" --reviewer human1 >/dev/null 2>&1
GAFFER_MERGE_LANE=0 GAFFER_MODE=autonomous AUTO_MERGE=1 DISPATCH_ALLOW_AGENT_APPROVE=1 MERGE_ON_AGENT_REVIEW=1 run_tick >/dev/null
[ "$(st "$C")" = "ready_for_merge" ] && ok "C: lane off → #$C stays ready_for_merge" || fail "C: status=$(st "$C")"
grep -q "MERGE: #$C" "$LOGF" && fail "C: lane logged with the switch off" || ok "C: lane silent with the switch off"

resolver_turns() { grep -l "resolve a merge conflict on the delivery branch" "$CALLS"/*/prompt 2>/dev/null | xargs -r grep -l "(ticket #$1)" 2>/dev/null | wc -l | tr -d ' '; }
echo "== E. autonomous: a CONFLICT spawns the resolver once, the ticket returns to review, and lands after re-approval =="
E="$(new_ticket "Conflicting helper" "deliver a helper that will conflict")"; wg ticket ready "$E" >/dev/null 2>&1
AUTO_MERGE=0 run_tick >/dev/null
[ "$(st "$E")" = "in_review" ] && ok "E: #$E delivered → in_review" || fail "E: status=$(st "$E")"
BE="$(branch_of "$E")"
# A sibling lands on main touching the SAME line region (append to src/a.js) → conflict.
( cd "$R" && printf 'export function mainSide() { return 3; }\n' >> src/a.js && git -c user.email=t@t -c user.name=t commit -qam "feat: mainSide" )
wg review approve "$E" --reviewer human1 >/dev/null 2>&1
[ "$(st "$E")" = "ready_for_merge" ] && ok "E: human approve → ready_for_merge" || fail "E: after approve status=$(st "$E")"
MAIN_E="$(git -C "$R" rev-parse main)"
GAFFER_MODE=autonomous AUTO_MERGE=1 DISPATCH_ALLOW_AGENT_APPROVE=1 MERGE_ON_AGENT_REVIEW=1 GAFFER_MERGE_TIMEOUT_MS=60000 run_tick >/dev/null
grep -q "MERGE: #$E conflict — spawning the conflict resolver" "$LOGF" && ok "E: the lane spawned the resolver on the conflict" || fail "E: no resolver spawn logged: $(grep "#$E" "$LOGF" | tail -3 | tr '\n' '|' | cut -c1-400)"
[ "$(st "$E")" = "in_review" ] && ok "E: resolved ticket reopened for RE-REVIEW (in_review), not landed" || fail "E: status=$(st "$E") after the resolver"
[ "$(git -C "$R" rev-parse main)" = "$MAIN_E" ] && ok "E: main untouched by the resolver (proposed on the branch only)" || fail "E: main moved during resolution"
[ "$(git -C "$R" rev-list --merges --count "main..$BE")" -ge 1 ] && ok "E: the branch carries the resolver's merge commit" || fail "E: no merge commit on $BE"
grep -qx "$E" "$GAFFER_DATA/.merge-conflict-resolved" && ok "E: #$E recorded in .merge-conflict-resolved (one resolver pass per ticket)" || fail "E: marker file lacks #$E"
[ "$(resolver_turns "$E")" = "1" ] && ok "E: exactly one resolver turn spawned for #$E" || fail "E: resolver turns for #$E = $(resolver_turns "$E")"
grep -q '"kind":"merge-resolver"' "$GAFFER_DATA/usage-ledger.jsonl" 2>/dev/null && ok "E: the resolver's spend is ledgered as kind=merge-resolver" || fail "E: no merge-resolver ledger row"
# Re-approval of the resolved diff → the lane lands it cleanly on the next tick OF THE
# SAME RUN: a resolved conflict must not sit in the run's held file (it did, live: the
# re-approved ticket waited at ready_for_merge until the next run).
grep -qx "$E" "$GAFFER_DATA/.merge-held-tickets" 2>/dev/null && fail "E: a resolved conflict was added to .merge-held-tickets (would not land this run)" || ok "E: resolved ticket is NOT held for the run"
wg review approve "$E" --reviewer human1 >/dev/null 2>&1
GAFFER_MODE=autonomous AUTO_MERGE=1 DISPATCH_ALLOW_AGENT_APPROVE=1 MERGE_ON_AGENT_REVIEW=1 run_tick >/dev/null
[ "$(st "$E")" = "done" ] && ok "E: re-approved resolved branch lands → done" || fail "E: status=$(st "$E") after re-approval"
_ME="$(git -C "$R" show main:src/a.js)"; [[ "$_ME" == *"helper$E"* ]] && [[ "$_ME" == *"mainSide"* ]] && ok "E: main carries BOTH sides after the landing" || fail "E: main lost a side: $(printf '%s' "$_ME" | tr '\n' '|')"

echo "== F. a SECOND conflict for a ticket that already had its resolver pass is held for a human; GAFFER_CONFLICT_RESOLVER=0 never spawns =="
F="$(new_ticket "Twice-conflicting helper" "deliver a helper")"; wg ticket ready "$F" >/dev/null 2>&1
AUTO_MERGE=0 run_tick >/dev/null; BF="$(branch_of "$F")"
( cd "$R" && printf 'export function mainSide2() { return 4; }\n' >> src/a.js && git -c user.email=t@t -c user.name=t commit -qam "feat: mainSide2" )
wg review approve "$F" --reviewer human1 >/dev/null 2>&1
echo "$F" >> "$GAFFER_DATA/.merge-conflict-resolved"   # pretend a resolver pass already happened
rm -f "$GAFFER_DATA/.merge-held-tickets"
GAFFER_MODE=autonomous AUTO_MERGE=1 DISPATCH_ALLOW_AGENT_APPROVE=1 MERGE_ON_AGENT_REVIEW=1 run_tick >/dev/null
[ "$(st "$F")" = "ready_for_merge" ] && ok "F: second conflict → held at ready_for_merge for a human" || fail "F: status=$(st "$F")"
grep -q "MERGE: #$F conflicted AGAIN after a resolver pass" "$LOGF" && ok "F: the hold says why (no second resolver)" || fail "F: no 'conflicted AGAIN' line"
grep -q "MERGE: #$F approved but merge hit a CONFLICT — left on $BF for a human" "$LOGF" && ok "F: the classic conflict hold line is still logged" || fail "F: no conflict hold line"
[ "$(resolver_turns "$F")" = "0" ] && ok "F: no resolver turn for #$F" || fail "F: resolver turns for #$F = $(resolver_turns "$F")"
G="$(new_ticket "Lane-off conflicting helper" "deliver a helper")"; wg ticket ready "$G" >/dev/null 2>&1
AUTO_MERGE=0 run_tick >/dev/null
( cd "$R" && printf 'export function mainSide3() { return 5; }\n' >> src/a.js && git -c user.email=t@t -c user.name=t commit -qam "feat: mainSide3" )
wg review approve "$G" --reviewer human1 >/dev/null 2>&1; rm -f "$GAFFER_DATA/.merge-held-tickets"
GAFFER_CONFLICT_RESOLVER=0 GAFFER_MODE=autonomous AUTO_MERGE=1 DISPATCH_ALLOW_AGENT_APPROVE=1 MERGE_ON_AGENT_REVIEW=1 run_tick >/dev/null
[ "$(st "$G")" = "ready_for_merge" ] && grep -q "MERGE: #$G conflict — the resolver lane is off" "$LOGF" && ok "F: GAFFER_CONFLICT_RESOLVER=0 → held, resolver never spawned" || fail "F: lane-off status=$(st "$G")"
[ "$(resolver_turns "$G")" = "0" ] && ok "F: lane off spawned no resolver for #$G" || fail "F: resolver turns for #$G = $(resolver_turns "$G")"

echo "== D. wiring =="
grep -q 'source "$HERE/lib/land.sh"' "$RUNNER_DIR/tick.sh" && grep -q 'source "$HERE/lib/merge-lane.sh"' "$RUNNER_DIR/tick.sh" && ok "D: tick.sh sources lib/land.sh + lib/merge-lane.sh" || fail "D: tick.sh does not source the lane libs"
grep -q 'gaffer_land_delivery "$RNUM" "$RREPO" "$RBRANCH" "$RDEFAULT" "$RSHOW" AFK' "$RUNNER_DIR/lib/review.sh" && ok "D: the review pass lands through the shared gaffer_land_delivery" || fail "D: review.sh does not use gaffer_land_delivery"
_lane_line="$(grep -n '_gaffer_merge_lane$' "$RUNNER_DIR/tick.sh" | head -1 | cut -d: -f1)"; _scan_line="$(grep -n 'ready-candidate scan\|How many tickets are claimable' "$RUNNER_DIR/tick.sh" | head -1 | cut -d: -f1)"
[ -n "$_lane_line" ] && [ -n "$_scan_line" ] && [ "$_lane_line" -lt "$_scan_line" ] && ok "D: the lane runs before the candidate scan (line $_lane_line < $_scan_line)" || fail "D: lane not before the scan ($_lane_line vs $_scan_line)"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "merge-lane: PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
