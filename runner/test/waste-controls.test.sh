#!/usr/bin/env bash
# =====================================================================
# WASTE CONTROLS — a capped, timed-out or reworked delivery never starts from scratch.
# ---------------------------------------------------------------------
# Three loss paths a hard budget made expensive, driven through the REAL tick.sh with a
# stub agent (real dispatch, real git):
#   A. TURN CAP before the agent's first commit: the runner now commits a WIP checkpoint
#      of the uncommitted work and PAUSES in place (paused, reason cap_hit, worktree +
#      branch kept). Before: no commit → no pause → the attempt was burned and the retry
#      started over.
#   B. WALL-CLOCK TIMEOUT (rc 124) mid-delivery: pause-eligible like a cap (reason
#      `timeout`), work checkpointed. Before: a plain failure.
#   C. REWORK after review CHANGES: the next attempt re-enters on the EXISTING branch with
#      the previous commits kept (the agent sees them at spawn). Before: `worktree add -B`
#      reset the branch to base and the agent re-implemented everything.
#   D. GAFFER_RETRY_FRESH_BRANCH=1 restores the clean-slate reset (opt-in).
# Run: bash runner/test/waste-controls.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
command -v perl >/dev/null 2>&1 || { echo "SKIP: perl required (timeout primitive)"; exit 0; }
for f in packages/dispatch/dist/cli/index.js packages/memory/dist/bin/memory.js packages/crew/dist/cli/index.js; do
  [ -f "$ROOT/$f" ] || { echo "SKIP: $f not built (run pnpm -r build)"; exit 0; }
done

PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/waste-controls.XXXXXX")"; WORK="$(cd "$WORK" && pwd -P)"
[ "${KEEP:-0}" = 1 ] || trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/data" "$WORK/bin" "$WORK/calls"
CALLS="$WORK/calls"

R="$WORK/repo"; mkdir -p "$R/src" "$R/test"
( cd "$R" && git init -q -b main
  printf '{ "name": "r", "version": "0.1.0", "private": true, "type": "module", "scripts": { "test": "node --test", "lint": "node -e 0" } }\n' > package.json
  printf 'export function a() { return 1; }\n' > src/a.js
  printf 'import test from "node:test"; import assert from "node:assert/strict";\nimport { a } from "../src/a.js";\ntest("a", () => { assert.equal(a(), 1); });\n' > test/a.test.js
  git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init )

# The stub agent's MODE file decides what it does on a delivery turn:
#   edit-nocommit-cap   write a file, do NOT commit, report num_turns at the cap
#   edit-nocommit-hang  write a file, do NOT commit, sleep past the tick timeout
#   deliver             commit a helper (normal delivery)
# Every spawn records `git log --oneline main..HEAD | wc -l` as seen AT SPAWN (before it
# edits anything), so case C can prove the prior commits were on the branch.
MODE="$WORK/mode"; echo deliver > "$MODE"
REVIEW="$WORK/review"; echo approve > "$REVIEW"
cat > "$WORK/bin/claude" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
CALLS="__CALLS__"; MODE="$(cat "__MODE__")"; REVIEW="$(cat "__REVIEW__")"
prompt=""; prev=""
for a in "$@"; do [ "$prev" = "-p" ] && prompt="$a"; prev="$a"; done
n="$(ls -1 "$CALLS" 2>/dev/null | wc -l | tr -d ' ')"; n=$((n + 1))
D="$CALLS/$(printf '%03d' "$n")"; mkdir -p "$D"
printf '%s' "$prompt" > "$D/prompt"
case "$prompt" in
  *"REVIEWER agent"*)
    echo review > "$D/kind"
    if [ "$REVIEW" = "changes" ]; then
      printf '{"type":"result","subtype":"success","is_error":false,"result":"Finding: helper lacks a test.\\nRECOMMEND CHANGES\\n{\\"verdict\\":\\"CHANGES\\"}","total_cost_usd":0.01,"num_turns":2}\n'
    else
      printf '{"type":"result","subtype":"success","is_error":false,"result":"RECOMMEND APPROVE\\n{\\"verdict\\":\\"APPROVE\\"}","total_cost_usd":0.01,"num_turns":2}\n'
    fi
    exit 0 ;;
esac
if [ -e .git ]; then
  echo delivery > "$D/kind"
  git log --oneline main..HEAD 2>/dev/null | wc -l | tr -d ' ' > "$D/commits-at-spawn"
  git log --oneline main..HEAD 2>/dev/null > "$D/log-at-spawn"
  fn="helper${GAFFER_TICKET:-0}"
  case "$MODE" in
    edit-nocommit-cap)
      printf 'export function partial(){return 0;}\n' > "src/partial-$fn.js"
      printf '{"type":"result","subtype":"error_max_turns","is_error":false,"result":"ran out of turns","total_cost_usd":0.05,"num_turns":3}\n'; exit 0 ;;
    edit-nocommit-hang)
      printf 'export function partial(){return 0;}\n' > "src/partial-$fn.js"
      sleep 30; exit 0 ;;
    *)
      grep -q "$fn" src/a.js || printf 'export function %s(){return 2;}\n' "$fn" >> src/a.js
      [ "$MODE" = "deliver-with-test" ] && printf 'import test from "node:test"; import assert from "node:assert/strict";\nimport { %s } from "../src/a.js";\ntest("%s", () => { assert.equal(%s(), 2); });\n' "$fn" "$fn" "$fn" > "test/$fn.test.js"
      git -c user.email=s@s -c user.name=s add -A >/dev/null; git -c user.email=s@s -c user.name=s commit -qm "feat: $fn ($MODE)" >/dev/null 2>&1 || true
      printf '{"type":"result","subtype":"success","is_error":false,"result":"done.\\n\\nSmallest-change note: helper.","total_cost_usd":0.02,"num_turns":1}\n'; exit 0 ;;
  esac
fi
echo other > "$D/kind"; printf '{"type":"result","subtype":"success","is_error":false,"result":"ok"}\n'
STUB
sed -i.bak "s|__CALLS__|$CALLS|; s|__MODE__|$MODE|; s|__REVIEW__|$REVIEW|" "$WORK/bin/claude" && rm -f "$WORK/bin/claude.bak"; chmod +x "$WORK/bin/claude"

export GAFFER_DATA="$WORK/data" CLAUDE_BIN="$WORK/bin/claude" CLAUDE_FLAGS="" \
       GAFFER_MAX_TURNS=3 GAFFER_TICK_TIMEOUT=60 GAFFER_CARD_MODEL=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
       REVIEW_MODE=human DRY_RUN=0 GAFFER_MAINTENANCE=0 AUTO_MERGE=0 GAFFER_STRICT_REQUIRE=0 GAFFER_SECURITY_REVIEW=0 GAFFER_TESTING=0 \
       MAX_OPEN_AGENT_BRANCHES_PER_REPO=10 MAX_IN_REVIEW_PER_REPO=10   # five cases leave five open branches; keep backpressure out of the way
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
wg repo add -n repo --path "$R" --branch main --stack node --test "npm test" --lint "npm run lint" >/dev/null 2>&1

run_tick() { ( cd "$RUNNER_DIR" && bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT=' ; }
review_tick() { rm -f "$GAFFER_DATA/.reviewed-tickets"; ( cd "$RUNNER_DIR" && REVIEW_MODE=agent DISPATCH_ALLOW_AGENT_APPROVE=1 bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT='; }
st() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status'; }
new_ready() { local n; n="$(wg ticket create -t "$1" -d "$2" --risk low 2>/dev/null | jget 'd.ticket.number')"; wg ac add "$n" -t "helper added" >/dev/null 2>&1; wg ticket repo-access set "$n" repo --access write --relation confirmed >/dev/null 2>&1; wg ticket ready "$n" >/dev/null 2>&1; printf '%s' "$n"; }
branch_of() { git -C "$R" branch --list "gaffer/ticket-$1-*" | tr -d ' *+' | head -1; }
last_delivery() { grep -lx delivery "$CALLS"/*/kind 2>/dev/null | tail -1 | xargs -I{} dirname {}; }
pause_reason() { wg ticket show "$1" 2>/dev/null | jget '(d.events||[]).filter(e => e.event_type === "ticket.paused").map(e => { try { return JSON.parse(e.payload_json).reason } catch { return "" } }).pop() || ""'; }

echo "== A. turn cap BEFORE the first commit → WIP checkpoint + pause (work kept) =="
echo edit-nocommit-cap > "$MODE"
A="$(new_ready "Cap before commit" "deliver a helper")"
OUTA="$(run_tick)"
echo "$OUTA" | grep -q '^TICK_RESULT=paused$' && ok "A: tick result paused" || fail "A: tick result $OUTA"
[ "$(st "$A")" = "paused" ] && ok "A: #$A is paused (not refining / failed)" || fail "A: #$A is '$(st "$A")'"
[ "$(pause_reason "$A")" = "cap_hit" ] && ok "A: pause reason cap_hit" || fail "A: pause reason '$(pause_reason "$A")'"
BA="$(branch_of "$A")"
[ -n "$BA" ] && [[ "$(git -C "$R" log --oneline "main..$BA")" == *"wip #$A: checkpoint at cap"* ]] && ok "A: a WIP checkpoint commit holds the uncommitted work on $BA" || fail "A: no WIP checkpoint on '$BA': $(git -C "$R" log --oneline "main..${BA:-main}" 2>/dev/null | tr '\n' '|')"
[[ "$(git -C "$R" show "$BA" --stat --format= 2>/dev/null)" == *"partial-helper$A"* ]] && ok "A: the checkpoint contains the agent's partial file" || fail "A: checkpoint lacks the partial file"
grep -q "CAP: #$A had uncommitted work at the cap — WIP checkpoint committed" "$GAFFER_DATA/factory.log" && ok "A: runner logged the checkpoint" || fail "A: no checkpoint log line"
WTA="$(wg ticket show "$A" | jget '(d.events||[]).filter(e => e.event_type === "ticket.paused").map(e => { try { return JSON.parse(e.payload_json).worktree_path } catch { return "" } }).pop() || ""')"
[ -n "$WTA" ] && [ -d "$WTA" ] && ok "A: paused worktree preserved at $(basename "$WTA")" || fail "A: paused worktree missing ('$WTA')"

echo "== B. wall-clock timeout mid-delivery → pause (reason timeout), work kept =="
echo edit-nocommit-hang > "$MODE"
B="$(new_ready "Timeout mid-delivery" "deliver a helper")"
OUTB="$(GAFFER_TICK_TIMEOUT=3 GAFFER_REAP_GRACE=1 run_tick)"
echo "$OUTB" | grep -q '^TICK_RESULT=paused$' && ok "B: tick result paused" || fail "B: tick result $OUTB"
[ "$(st "$B")" = "paused" ] && ok "B: #$B is paused" || fail "B: #$B is '$(st "$B")'"
[ "$(pause_reason "$B")" = "timeout" ] && ok "B: pause reason timeout" || fail "B: pause reason '$(pause_reason "$B")'"
BB="$(branch_of "$B")"
[ -n "$BB" ] && [[ "$(git -C "$R" log --oneline "main..$BB")" == *"wip #$B"* ]] && ok "B: WIP checkpoint on $BB after the kill" || fail "B: no checkpoint after timeout on '$BB'"

echo "== C. rework after review CHANGES re-enters on the existing branch (commits kept) =="
echo deliver > "$MODE"; echo changes > "$REVIEW"
C="$(new_ready "Reworked helper" "deliver a helper")"
run_tick >/dev/null; [ "$(st "$C")" = "in_review" ] && ok "C: #$C delivered → in_review" || fail "C: status=$(st "$C")"
BC="$(branch_of "$C")"; N1="$(git -C "$R" rev-list --count "main..$BC" 2>/dev/null)"
[ "${N1:-0}" -ge 1 ] && ok "C: first attempt left $N1 commit(s) on $BC" || fail "C: no commits after first attempt"
review_tick >/dev/null
[ "$(st "$C")" = "ready" ] && ok "C: reviewer CHANGES → re-queued (ready)" || fail "C: after review status=$(st "$C")"
echo approve > "$REVIEW"; echo deliver-with-test > "$MODE"
run_tick >/dev/null
D2="$(last_delivery)"
[ -n "$D2" ] && [ "$(cat "$D2/commits-at-spawn")" -ge 1 ] && ok "C: the rework agent saw $(cat "$D2/commits-at-spawn") prior commit(s) at spawn (branch kept, not reset)" || fail "C: rework spawned on a reset branch (commits-at-spawn=$(cat "$D2/commits-at-spawn" 2>/dev/null))"
grep -q "reused worktree for repo .* on EXISTING branch $BC .* prior commit(s) kept" "$GAFFER_DATA/factory.log" && ok "C: runner logged the branch reuse" || fail "C: no reuse log: $(grep -E 'worktree for repo' "$GAFFER_DATA/factory.log" | tail -2 | tr '\n' '|' | cut -c1-300)"
grep -q "previous attempt's commits are\|prior\nattempt's commits\|ALREADY on this branch" "$D2/prompt" && ok "C: rework prompt tells the agent the prior commits are on the branch" || fail "C: rework prompt lacks the kept-commits note"
[ "$(st "$C")" = "in_review" ] && ok "C: rework re-delivered → in_review" || fail "C: rework status=$(st "$C")"
# Clear the review lane before the next case (a tick reviews the OLDEST in_review ticket first).
review_tick >/dev/null
[ "$(st "$C")" = "ready_for_merge" ] && ok "C: rework approved → ready_for_merge" || fail "C: after approve status=$(st "$C")"

echo "== D. GAFFER_RETRY_FRESH_BRANCH=1 restores the clean-slate reset =="
echo deliver > "$MODE"; echo changes > "$REVIEW"
E="$(new_ready "Fresh-branch helper" "deliver a helper")"
run_tick >/dev/null; review_tick >/dev/null
[ "$(st "$E")" = "ready" ] && ok "D: #$E re-queued after CHANGES" || fail "D: status=$(st "$E")"
echo approve > "$REVIEW"
GAFFER_RETRY_FRESH_BRANCH=1 run_tick >/dev/null
D3="$(last_delivery)"
[ -n "$D3" ] && [ "$(cat "$D3/commits-at-spawn")" = "0" ] && ok "D: with the override the retry spawned on a branch reset to base (0 prior commits)" || fail "D: override did not reset (commits-at-spawn=$(cat "$D3/commits-at-spawn" 2>/dev/null))"
review_tick >/dev/null   # clear the review lane before case E

echo "== E. a bootstrap REWORK (repo already registered) runs as a normal delivery with feedback =="
# LIVE FINDING: after the scaffold was reviewed (CHANGES) the ticket still carried
# bootstrap=1, so the retry re-entered the create-a-repo path — whose prompt has no
# review-feedback block — and paid for a second blind scaffold pass. Once the repo is
# registered and linked, a bootstrap rework is a normal delivery on the kept branch.
echo deliver > "$MODE"; echo approve > "$REVIEW"
F="$(wg ticket create -t "Bootstrap the r repo" -d "scaffold the repo" --risk low --bootstrap 2>/dev/null | jget 'd.ticket.number')"
wg ac add "$F" -t "helper added" >/dev/null 2>&1
wg ticket repo-access set "$F" repo --access write --relation confirmed >/dev/null 2>&1
# Simulate the prior bootstrap pass: its scaffold commit already sits on the ticket branch.
ticket_slug() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' | tr -s '-' | sed -E 's/^-+//; s/-+$//' | cut -d- -f1-6 | cut -c1-50 | sed -E 's/-+$//'; }  # mirrors tick.sh gaffer_ticket_slug
BF="gaffer/ticket-$F-$(ticket_slug "Bootstrap the r repo")"
git -C "$R" branch "$BF" main >/dev/null 2>&1
git -C "$R" worktree add -q "$WORK/wt-f" "$BF" >/dev/null 2>&1
printf 'export const scaffold = 1;\n' > "$WORK/wt-f/src/scaffold.js"
git -C "$WORK/wt-f" -c user.email=t@t -c user.name=t add -A >/dev/null 2>&1
git -C "$WORK/wt-f" -c user.email=t@t -c user.name=t commit -qm "deliver #$F: scaffold" >/dev/null 2>&1
git -C "$R" worktree remove --force "$WORK/wt-f" >/dev/null 2>&1
wg ticket ready "$F" >/dev/null 2>&1
[ "$(wg ticket show "$F" | jget '[1, true].includes(d.ticket.bootstrap) ? 1 : 0')" = "1" ] && ok "E: #$F is a bootstrap ticket with a REGISTERED repo linked" || fail "E: fixture is not a bootstrap ticket"
run_tick >/dev/null
grep -q "BOOTSTRAP #$F: repo already registered at .* rework runs as a normal delivery" "$GAFFER_DATA/factory.log" && ok "E: runner routed the bootstrap rework to the normal delivery path" || fail "E: no routing log line"
grep -q "BOOTSTRAP #$F ('Bootstrap the r repo') → create new repo" "$GAFFER_DATA/factory.log" && fail "E: the create-a-repo path ran for a registered repo" || ok "E: the create-a-repo path did NOT run"
D4="$(last_delivery)"
[ -n "$D4" ] && [ "$(cat "$D4/commits-at-spawn")" -ge 1 ] && ok "E: the rework agent saw the prior scaffold commit at spawn (branch $BF kept)" || fail "E: rework did not keep the scaffold commit (commits-at-spawn=$(cat "$D4/commits-at-spawn" 2>/dev/null))"
[ "$(st "$F")" = "in_review" ] && ok "E: bootstrap rework re-delivered → in_review" || fail "E: status=$(st "$F")"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
