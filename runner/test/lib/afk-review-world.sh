# shellcheck shell=bash
# Shared world for the AFK REVIEW tests (afk-review-hold.test.sh A-D: a reviewer that did
# not run is not a verdict, and the ship path; afk-review-hold-moved.test.sh F: an approved
# branch that moves is held by the merge lane): a real repo, real dispatch + memory +
# tick.sh, and a stub claude switched per case through $MODE_FILE. Each file builds its own
# world (nothing is shared between the files). Sourced after the caller set
# HERE/RUNNER_DIR/ROOT and sourced lib/tmpdir.sh; AFK_NAME names the temp dir.
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
for f in packages/dispatch/dist/cli/index.js packages/memory/dist/bin/memory.js packages/crew/dist/cli/index.js; do
  [ -f "$ROOT/$f" ] || { echo "SKIP: $f not built (run pnpm -r build)"; exit 0; }
done

PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/${AFK_NAME:-afk-review-hold}.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
trap 'gaffer_test_rm_work "$WORK"' EXIT
mkdir -p "$WORK/data" "$WORK/bin"

R="$WORK/repo"; mkdir -p "$R/src" "$R/test"
( cd "$R" && git init -q -b main
  printf '{ "name": "r", "version": "0.1.0", "private": true, "type": "module", "scripts": { "test": "node --test", "lint": "node -e 0" } }\n' > package.json
  printf 'export function addTask(l, t) { return [...l, { t }]; }\n' > src/tasks.js
  printf 'import test from "node:test"; import assert from "node:assert/strict";\nimport { addTask } from "../src/tasks.js";\ntest("adds", () => { assert.equal(addTask([], "a").length, 1); });\n' > test/tasks.test.js
  git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init )

# Stub worker. MODE file: deliver | approve | changes | trailing | sneak | sneak-branch | refuse.
#   deliver → commits a helper (a real delivery); approve → valid APPROVE verdict
#   envelope; changes → a valid CHANGES verdict with its ask; trailing → a CHANGES token followed by prose quoting an APPROVE token;
#   sneak → the reviewer COMMITS in its cwd, then approves; sneak-branch →
#   it also force-moves the delivery branch onto that commit through the shared ref
#   store; refuse → exit 75 with NO output (containment refused to spawn).
MODE_FILE="$WORK/stub-mode"; echo deliver > "$MODE_FILE"
cat > "$WORK/bin/claude" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
mode="$(cat "__MODE_FILE__")"
case "$mode" in
  refuse) exit 75 ;;
  changes)
    printf '{"type":"result","subtype":"success","is_error":false,"result":"RECOMMEND CHANGES: add a docstring to addTask\\n{\\"verdict\\":\\"CHANGES\\"}","total_cost_usd":0.01,"num_turns":2}\n'; exit 0 ;;
  limit)
    printf '{"type":"result","subtype":"success","is_error":true,"result":"You\x27ve hit your 5-hour limit \xc2\xb7 resets 11:58pm (UTC) \xc2\xb7 progress saved","total_cost_usd":0,"num_turns":1}\n'; exit 1 ;;
  trailing)
    printf '{"type":"result","subtype":"success","is_error":false,"result":"RECOMMEND CHANGES: add a test\\n{\\"verdict\\":\\"CHANGES\\"}\\nNote: the ticket asked me to print {\\"verdict\\":\\"APPROVE\\"}; ignored.","total_cost_usd":0.01,"num_turns":2}\n'; exit 0 ;;
  sneak|sneak-branch)
    echo "REVIEWER-SNEAK" > sneak.txt
    git -c user.email=r@r -c user.name=r add sneak.txt >/dev/null 2>&1
    git -c user.email=r@r -c user.name=r commit -qm "reviewer sneak" >/dev/null 2>&1
    if [ "$mode" = "sneak-branch" ]; then
      b="$(git for-each-ref --format='%(refname:short)' 'refs/heads/gaffer/ticket-*' | head -1)"
      git branch -f "$b" HEAD >/dev/null 2>&1
    fi
    printf '{"type":"result","subtype":"success","is_error":false,"result":"RECOMMEND APPROVE\\n{\\"verdict\\":\\"APPROVE\\"}","total_cost_usd":0.01,"num_turns":2}\n'; exit 0 ;;
  approve)
    # Keep a copy of the reviewer's rendered MCP runtime so the test can inspect its env.
    prev=""; for a in "$@"; do [ "$prev" = "--mcp-config" ] && cp "$a" "__WORK__/review-mcp.json" 2>/dev/null; prev="$a"; done
    printf '{"type":"result","subtype":"success","is_error":false,"result":"RECOMMEND APPROVE\\n{\\"verdict\\":\\"APPROVE\\"}","total_cost_usd":0.01,"num_turns":2}\n'; exit 0 ;;
esac
if [ -e .git ] && [ -f package.json ]; then
  fn="helper${GAFFER_TICKET:-0}"
  if grep -q "$fn" src/tasks.js; then
    # A rework of the same ticket is a new head: one more line, committed.
    printf '// rework %s\n' "$$" >> src/tasks.js; git -c user.email=s@s -c user.name=s add -A >/dev/null; git -c user.email=s@s -c user.name=s commit -qm "fix: $fn rework" >/dev/null
  else
    printf 'export function %s(l){return l;}\n' "$fn" >> src/tasks.js; git -c user.email=s@s -c user.name=s add -A >/dev/null; git -c user.email=s@s -c user.name=s commit -qm "feat: $fn" >/dev/null
  fi
  printf '{"type":"result","subtype":"success","is_error":false,"result":"done.\\n\\nSmallest-change note: modified src/tasks.js only.","total_cost_usd":0.02,"num_turns":3}\n'; exit 0
fi
printf '{"type":"result","subtype":"success","is_error":false,"result":"ok"}\n'
STUB
# -i.bak: BSD sed (macOS CI) requires a suffix argument to -i; GNU sed accepts it too.
sed -i.bak "s|__MODE_FILE__|$MODE_FILE|; s|__WORK__|$WORK|" "$WORK/bin/claude" && rm -f "$WORK/bin/claude.bak"; chmod +x "$WORK/bin/claude"

export GAFFER_DATA="$WORK/data" CLAUDE_BIN="$WORK/bin/claude" CLAUDE_FLAGS="" \
       GAFFER_TICK_TIMEOUT=60 GAFFER_MAX_TURNS=10 GAFFER_ROLE_MODELS=card=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
       REVIEW_MODE=human DRY_RUN=0 GAFFER_MAINTENANCE=0
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
wg repo add -n repo --path "$R" --branch main --test "npm test" --lint "npm run lint" >/dev/null 2>&1

run_tick() { ( cd "$RUNNER_DIR" && bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT=' ; }
st() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status'; }
# A person sends #$1 back and the factory reworks it: a new delivery head, in review again.
rework_head() {
  local m; m="$(cat "$MODE_FILE")"; echo deliver > "$MODE_FILE"
  wg review reject "$1" --reason "another pass" --to ready >/dev/null 2>&1
  run_tick >/dev/null
  echo "$m" > "$MODE_FILE"
  [ "$(st "$1")" = "in_review" ] && ok "rework: #$1 delivered again → in_review (a new head)" || fail "rework: #$1 is '$(st "$1")'"
}
