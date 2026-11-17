# shellcheck shell=bash
# Shared world for the WASTE CONTROLS tests (waste-controls.test.sh A-C, the cap, the
# timeout and the rework that keep their work; waste-controls-fresh-branch.test.sh D-F,
# GAFFER_RETRY_FRESH_BRANCH and the bootstrap rework): a real repo, the REAL dispatch +
# memory CLIs and tick.sh, and a stub claude whose MODE / REVIEW files decide each turn.
# Each file builds its own world (nothing is shared between the files): one file with
# every case took 200 s at -j 2. Sourced after the caller set HERE/RUNNER_DIR/ROOT and
# sourced lib/tmpdir.sh; WASTE_NAME names the temp dir.
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
command -v perl >/dev/null 2>&1 || { echo "SKIP: perl required (timeout primitive)"; exit 0; }
for f in packages/dispatch/dist/cli/index.js packages/memory/dist/bin/memory.js packages/crew/dist/cli/index.js; do
  [ -f "$ROOT/$f" ] || { echo "SKIP: $f not built (run pnpm -r build)"; exit 0; }
done

PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/${WASTE_NAME:-waste-controls}.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
[ "${KEEP:-0}" = 1 ] || trap 'gaffer_test_rm_work "$WORK"' EXIT
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
    fail-then-fix)
      # Attempt 1 (nothing on the branch yet) commits a helper whose test FAILS the
      # test gate; any later attempt fixes the test on top.
      grep -q "$fn" src/a.js || printf 'export function %s(){return 2;}\n' "$fn" >> src/a.js
      want=2; [ "$(cat "$D/commits-at-spawn")" = "0" ] && want=3
      printf 'import test from "node:test"; import assert from "node:assert/strict";\nimport { %s } from "../src/a.js";\ntest("%s", () => { assert.equal(%s(), %s); });\n' "$fn" "$fn" "$fn" "$want" > "test/$fn.test.js"
      git -c user.email=s@s -c user.name=s add -A >/dev/null; git -c user.email=s@s -c user.name=s commit -qm "feat: $fn (want $want)" >/dev/null 2>&1 || true
      printf '{"type":"result","subtype":"success","is_error":false,"result":"done.\\n\\nSmallest-change note: helper.","total_cost_usd":0.02,"num_turns":1}\n'; exit 0 ;;
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
       GAFFER_MAX_TURNS=3 GAFFER_TICK_TIMEOUT=60 GAFFER_ROLE_MODELS=card=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
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
# Take a finished case's ticket out of the queue (a person's won't-do) so the next case
# starts with an empty review lane.
retire() { wg wont-do "$1" --reason "test case done" >/dev/null 2>&1; [ "$(st "$1")" = cancelled ] || fail "setup: could not retire #$1 (status $(st "$1"))"; }

