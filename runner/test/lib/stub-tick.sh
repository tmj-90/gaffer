# shellcheck shell=bash
# Shared harness for the tick-level branch-retention tests (branch-retention,
# branch-switch-recovery, resume-abort): a real repo, the REAL dispatch + memory
# CLIs, the REAL tick.sh, and a stub `claude` whose MODE file decides what a delivery
# turn does. Sourced AFTER the caller defined HERE/RUNNER_DIR/ROOT and checked deps;
# set STUB_TICK_NAME to name the temp dir. KEEP=1 keeps the temp dir for debugging.
. "$(dirname "${BASH_SOURCE[0]}")/tmpdir.sh"  # mktemp guard + safe temp removal
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/${STUB_TICK_NAME:-stub-tick}.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
[ "${KEEP:-0}" = 1 ] || trap 'gaffer_test_rm_work "$WORK"' EXIT
mkdir -p "$WORK/data" "$WORK/bin" "$WORK/calls"
CALLS="$WORK/calls"

mkrepo() {
  mkdir -p "$1/src" "$1/test"
  ( cd "$1" && git init -q -b main
    printf '{ "name": "r", "version": "0.1.0", "private": true, "type": "module", "scripts": { "test": "node --test", "lint": "node -e 0" } }\n' > package.json
    printf 'export function a() { return 1; }\n' > src/a.js
    printf 'import test from "node:test"; import assert from "node:assert/strict";\nimport { a } from "../src/a.js";\ntest("a", () => { assert.equal(a(), 1); });\n' > test/a.test.js
    git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init )
}
R="$WORK/repo"; mkrepo "$R"

# The stub agent's MODE file decides what a delivery turn does (see the cases below).
# Every spawn records the worktree's branch + commit count AT SPAWN.
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
  git rev-parse --abbrev-ref HEAD > "$D/branch-at-spawn" 2>/dev/null
  git log --oneline main..HEAD 2>/dev/null | wc -l | tr -d ' ' > "$D/commits-at-spawn"
  fn="helper${GAFFER_TICKET:-0}x$n"
  commit() { printf 'export function %s(){return 2;}\n' "$fn" >> src/a.js
             git -c user.email=s@s -c user.name=s commit -qam "feat: $fn ($1)" >/dev/null 2>&1; }
  done_json() { printf '{"type":"result","subtype":"success","is_error":false,"result":"done.\\n\\nSmallest-change note: helper.","total_cost_usd":0.02,"num_turns":1}\n'; }
  case "$MODE" in
    hang) touch "$D/hanging"; sleep 60; exit 0 ;;
    edit-nocommit-cap)
      printf 'export function partial(){return 0;}\n' > "src/partial-$fn.js"
      printf '{"type":"result","subtype":"error_max_turns","is_error":false,"result":"ran out of turns","total_cost_usd":0.05,"num_turns":3}\n'; exit 0 ;;
    newbranch) git checkout -q -b "agent-side-$n" >/dev/null 2>&1; commit side; done_json; exit 0 ;;
    detached) git checkout -q --detach >/dev/null 2>&1; commit detached; done_json; exit 0 ;;
    userbranch) git checkout -q user-feature >/dev/null 2>&1; commit onuser; done_json; exit 0 ;;
    userbranch-nocommit) git checkout -q user-feature2 >/dev/null 2>&1; done_json; exit 0 ;;
    diverge-once)
      if [ ! -e "$CALLS/diverged" ]; then
        touch "$CALLS/diverged"; git checkout -q -b "agent-off-main-$n" main >/dev/null 2>&1; commit diverged
      else
        commit retry
      fi
      done_json; exit 0 ;;
    *) commit "$MODE"; done_json; exit 0 ;;
  esac
fi
echo other > "$D/kind"; printf '{"type":"result","subtype":"success","is_error":false,"result":"ok"}\n'
STUB
sed -i.bak "s|__CALLS__|$CALLS|; s|__MODE__|$MODE|; s|__REVIEW__|$REVIEW|" "$WORK/bin/claude" && rm -f "$WORK/bin/claude.bak"; chmod +x "$WORK/bin/claude"

export GAFFER_DATA="$WORK/data" CLAUDE_BIN="$WORK/bin/claude" CLAUDE_FLAGS="" \
       GAFFER_MAX_TURNS=3 GAFFER_TICK_TIMEOUT=90 GAFFER_CARD_MODEL=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
       REVIEW_MODE=human DRY_RUN=0 GAFFER_MAINTENANCE=0 AUTO_MERGE=0 GAFFER_STRICT_REQUIRE=0 GAFFER_SECURITY_REVIEW=0 GAFFER_TESTING=0 \
       MAX_OPEN_AGENT_BRANCHES_PER_REPO=50 MAX_OPEN_AGENT_PRS_PER_REPO=50 GAFFER_REAP_GRACE=2
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
wg repo add -n repo --path "$R" --branch main --stack node --test "npm test" --lint "npm run lint" >/dev/null 2>&1

run_tick() { ( cd "$RUNNER_DIR" && bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT=' ; }
review_tick() { rm -f "$GAFFER_DATA/.reviewed-tickets"; ( cd "$RUNNER_DIR" && REVIEW_MODE=agent DISPATCH_ALLOW_AGENT_APPROVE=1 bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT='; }
st() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status'; }
new_ready() { local n; n="$(wg ticket create -t "$1" -d "$2" --risk low 2>/dev/null | jget 'd.ticket.number')"; wg ac add "$n" -t "helper added" >/dev/null 2>&1; wg ticket repo-access set "$n" repo --access write --relation confirmed >/dev/null 2>&1; wg ticket ready "$n" >/dev/null 2>&1; printf '%s' "$n"; }
branch_of() { git -C "${2:-$R}" branch --list "gaffer/ticket-$1-*" | tr -d ' *+' | head -1; }
commits_on() { git -C "${2:-$R}" rev-list --count "main..$1" 2>/dev/null || echo "BRANCH-GONE"; }
last_delivery() { grep -lx delivery "$CALLS"/*/kind 2>/dev/null | tail -1 | xargs -I{} dirname {}; }
reworked_ticket() {  # deliver once, reviewer CHANGES → back to ready with a reviewed branch
  local t; t="$(new_ready "$1" "deliver a helper")"
  echo deliver > "$MODE"; run_tick >/dev/null
  echo changes > "$REVIEW"; review_tick >/dev/null; echo approve > "$REVIEW"
  rm -f "$GAFFER_DATA/.failed-tickets"
  printf '%s' "$t"
}
# Take a finished case's ticket out of the queue so a later case's tick cannot pick it.
retire() { wg wont-do "$1" --reason "test case done" >/dev/null 2>&1 || true; }
# A background tick runs in its OWN process group (perl setpgrp — macOS has no setsid)
# so `kill -TERM -- -$TP` signals it the way the outer per-tick timeout does: the tick
# AND its foreground agent wrapper, not just a bash that defers the trap to the agent.
wait_hanging() { local _; for _ in $(seq 1 300); do ls "$CALLS"/*/hanging >/dev/null 2>&1 && return 0; sleep 0.2; done; return 1; }
