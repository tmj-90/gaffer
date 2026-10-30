#!/usr/bin/env bash
# =====================================================================
# REVIEW LANE WEDGE — one unreviewable in_review ticket must not stall the lane.
# ---------------------------------------------------------------------
# The agent-review pass picks the FIRST in_review ticket not yet skipped this run. Its
# pre-spawn refusals used to `result error; exit 1` without skipping the ticket, so a
# ticket whose delivery branch was deleted (or a review worktree a killed tick left
# behind) came back first on EVERY tick: no other in_review ticket was ever reviewed,
# the tester lane after the pass never ran, and each error tick reset the loop's
# empty-poll counter and burned a day-cap slot. Now:
#   A. a deleted delivery branch HOLDS that ticket (skipped for the run, a note on the
#      ticket, no error tick) and the next tick reviews the next ticket;
#   B. a REGISTERED stale review worktree is swept and the review proceeds first time;
#   C. an UNREGISTERED stale review-wt directory likewise;
#   D. a SYSTEMIC refusal (the MCP runtime cannot be rendered) still errors and skips
#      nothing (skipping would walk every ticket without reviewing any);
#   E. a live review claim held by another lane is respected (no double review).
# Real dispatch + real tick.sh with a stub `claude`. Run: bash runner/test/review-wedge.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
for f in packages/dispatch/dist/cli/index.js packages/memory/dist/bin/memory.js packages/crew/dist/cli/index.js; do
  [ -f "$ROOT/$f" ] || { echo "SKIP: $f not built (run pnpm -r build)"; exit 0; }
done

PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/review-wedge.XXXXXX")"; WORK="$(cd "$WORK" && pwd -P)"
SLEEPER=""
trap '[ -n "$SLEEPER" ] && kill "$SLEEPER" 2>/dev/null; rm -rf "$WORK"' EXIT
mkdir -p "$WORK/data" "$WORK/bin"

R="$WORK/repo"; mkdir -p "$R/src" "$R/test"
( cd "$R" && git init -q -b main
  printf '{ "name": "r", "version": "0.1.0", "private": true, "type": "module", "scripts": { "test": "node --test", "lint": "node -e 0" } }\n' > package.json
  printf 'export function addTask(l, t) { return [...l, { t }]; }\n' > src/tasks.js
  printf 'import test from "node:test"; import assert from "node:assert/strict";\nimport { addTask } from "../src/tasks.js";\ntest("adds", () => { assert.equal(addTask([], "a").length, 1); });\n' > test/tasks.test.js
  git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init )

# Stub worker. MODE file: deliver (commit a helper) | approve (a valid APPROVE verdict).
MODE_FILE="$WORK/stub-mode"; echo deliver > "$MODE_FILE"
cat > "$WORK/bin/claude" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
if [ "$(cat "__MODE_FILE__")" = "approve" ]; then
  printf '{"type":"result","subtype":"success","is_error":false,"result":"RECOMMEND APPROVE\\n{\\"verdict\\":\\"APPROVE\\"}","total_cost_usd":0.01,"num_turns":2}\n'; exit 0
fi
if [ -e .git ] && [ -f package.json ]; then
  fn="helper${GAFFER_TICKET:-0}"
  grep -q "$fn" src/tasks.js || { printf 'export function %s(l){return l;}\n' "$fn" >> src/tasks.js; git -c user.email=s@s -c user.name=s add -A >/dev/null; git -c user.email=s@s -c user.name=s commit -qm "feat: $fn" >/dev/null; }
  printf '{"type":"result","subtype":"success","is_error":false,"result":"done.\\n\\nSmallest-change note: modified src/tasks.js only.","total_cost_usd":0.02,"num_turns":3}\n'; exit 0
fi
printf '{"type":"result","subtype":"success","is_error":false,"result":"ok"}\n'
STUB
sed -i.bak "s|__MODE_FILE__|$MODE_FILE|" "$WORK/bin/claude" && rm -f "$WORK/bin/claude.bak"; chmod +x "$WORK/bin/claude"

export GAFFER_DATA="$WORK/data" CLAUDE_BIN="$WORK/bin/claude" CLAUDE_FLAGS="" \
       GAFFER_TICK_TIMEOUT=60 GAFFER_MAX_TURNS=10 GAFFER_CARD_MODEL=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
       REVIEW_MODE=human DRY_RUN=0 GAFFER_MAINTENANCE=0 MAX_OPEN_AGENT_BRANCHES_PER_REPO=10 MAX_OPEN_AGENT_PRS_PER_REPO=10
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
wg repo add -n repo --path "$R" --branch main --test "npm test" --lint "npm run lint" >/dev/null 2>&1

run_tick() { ( cd "$RUNNER_DIR" && bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT=' ; }
st() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status'; }
branch_of() { git -C "$R" branch --list "gaffer/ticket-$1-*" | tr -d ' *' | head -1; }
reviewed() { grep -c "agent review of #$1 finished" "$GAFFER_DATA/factory.log" 2>/dev/null || true; }

NUMS=()
for t in one two three four; do
  n="$(wg ticket create -t "Wedge $t" -d "deliver then review" 2>/dev/null | jget 'd.ticket.number')"
  wg ac add "$n" -t "helper added" >/dev/null 2>&1
  wg ticket repo-access set "$n" repo --access write --relation confirmed >/dev/null 2>&1
  wg ticket ready "$n" >/dev/null 2>&1
  run_tick >/dev/null
  [ "$(st "$n")" = "in_review" ] && ok "setup: #$n delivered → in_review" || fail "setup: #$n is '$(st "$n")'"
  NUMS+=("$n")
done
N1="${NUMS[0]}" N2="${NUMS[1]}" N3="${NUMS[2]}" N4="${NUMS[3]}"
echo approve > "$MODE_FILE"; rm -f "$GAFFER_DATA/.reviewed-tickets"

# A: #1's branch is gone · B: a REGISTERED stale review worktree for #2 (a SIGKILLed tick)
# · C: an UNREGISTERED leftover review-wt dir for #3 (its git metadata already pruned).
git -C "$R" branch -D "$(branch_of "$N1")" >/dev/null 2>&1
mkdir -p "$GAFFER_DATA/worktrees"
git -C "$R" worktree add -q --detach "$GAFFER_DATA/worktrees/review-wt-$N2" "$(branch_of "$N2")" >/dev/null 2>&1
mkdir -p "$GAFFER_DATA/worktrees/review-wt-$N3"; echo junk > "$GAFFER_DATA/worktrees/review-wt-$N3/leftover"

echo "== A. a deleted delivery branch holds THAT ticket, not the lane =="
OUT1="$(REVIEW_MODE=agent run_tick)"
[ "$OUT1" != "TICK_RESULT=error" ] && ok "A: no error tick ($OUT1)" || fail "A: tick 1 was an error tick"
grep -qx "$N1" "$GAFFER_DATA/.reviewed-tickets" 2>/dev/null && ok "A: #$N1 skipped for the rest of the run" || fail "A: #$N1 not in .reviewed-tickets"
grep -q "REVIEW-HELD: #$N1 cannot be agent-reviewed — delivery branch" "$GAFFER_DATA/factory.log" \
  && ok "A: logged REVIEW-HELD with the reason" || fail "A: no REVIEW-HELD line: $(tail -3 "$GAFFER_DATA/factory.log" | tr '\n' '|')"
wg ticket show "$N1" 2>/dev/null | grep -q "agent review could not run" && ok "A: a note on the ticket says why" || fail "A: no manual note on #$N1"
[ "$(st "$N1")" = "in_review" ] && ok "A: #$N1 stays in_review for a human" || fail "A: #$N1 became '$(st "$N1")'"

echo "== B. a registered stale review worktree is swept; the review proceeds first time =="
OUT2="$(REVIEW_MODE=agent run_tick)"
[ "$OUT2" = "TICK_RESULT=reviewed" ] && [ "$(reviewed "$N2")" -ge 1 ] && ok "B: #$N2 reviewed on the next tick" || fail "B: tick 2 → $OUT2, #$N2 reviewed=$(reviewed "$N2")"

echo "== C. an unregistered leftover review-wt directory is swept too =="
OUT3="$(REVIEW_MODE=agent run_tick)"
[ "$OUT3" = "TICK_RESULT=reviewed" ] && [ "$(reviewed "$N3")" -ge 1 ] && ok "C: #$N3 reviewed" || fail "C: tick 3 → $OUT3, #$N3 reviewed=$(reviewed "$N3")"
grep -q "REVIEW-ERROR\|failed to create review worktree" "$GAFFER_DATA/factory.log" && fail "C: a review worktree error was logged" || ok "C: no review-worktree errors in the run"
[ ! -e "$GAFFER_DATA/worktrees/review-wt-$N3" ] && ok "C: the review worktree is gone after the pass" || fail "C: review-wt-$N3 left behind"

echo "== E. a review claim held by a LIVE lane is respected =="
sleep 300 & SLEEPER=$!
mkdir -p "$GAFFER_DATA/.review-$N4.lock.d"; echo "$SLEEPER" > "$GAFFER_DATA/.review-$N4.lock.d/pid"
OUT4="$(REVIEW_MODE=agent run_tick)"
[ "$(reviewed "$N4")" -eq 0 ] && grep -q "review of #$N4 is already running in another lane" "$GAFFER_DATA/factory.log" \
  && ok "E: #$N4 not reviewed twice ($OUT4)" || fail "E: #$N4 reviewed=$(reviewed "$N4") despite a live claim"
grep -qx "$N4" "$GAFFER_DATA/.reviewed-tickets" 2>/dev/null && fail "E: #$N4 skip-listed (the live lane owns it)" || ok "E: #$N4 not skip-listed"
kill "$SLEEPER" 2>/dev/null; wait "$SLEEPER" 2>/dev/null; SLEEPER=""
[ -d "$GAFFER_DATA/.review-$N4.lock.d" ] && ok "E: the other lane's claim was left alone" || fail "E: the live claim was removed"

echo "== D. a SYSTEMIC refusal still errors and skips nothing =="
OUT5="$(REVIEW_MODE=agent MCP_CONFIG="$WORK/no-such-mcp.json" run_tick)"
[ "$OUT5" = "TICK_RESULT=error" ] && ok "D: MCP render failure → error tick" || fail "D: tick → $OUT5"
grep -qx "$N4" "$GAFFER_DATA/.reviewed-tickets" 2>/dev/null && fail "D: #$N4 skip-listed on a systemic failure" || ok "D: nothing skip-listed"
OUT6="$(REVIEW_MODE=agent run_tick)"
[ "$OUT6" = "TICK_RESULT=reviewed" ] && [ "$(reviewed "$N4")" -ge 1 ] && ok "D: with the fault gone (dead claim reaped) #$N4 is reviewed" || fail "D: tick → $OUT6, #$N4 reviewed=$(reviewed "$N4")"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
