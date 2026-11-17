# shellcheck shell=bash
# Shared world for the MERGE LANE tests (merge-lane.test.sh A-D, merge-lane-conflict.test.sh
# E-G): a fixture repo, a stub claude that delivers one helper per ticket and resolves a
# merge conflict when asked, the REAL dispatch + memory CLIs and tick.sh, and the ticket
# helpers. Each test file builds its own world (nothing is shared between the files):
# split in two so neither file carries the whole 18-tick scenario (265 s at -j 2).
# Sourced after the caller set HERE/RUNNER_DIR/ROOT and sourced lib/tmpdir.sh; set
# MERGE_LANE_NAME to name the temp dir.
CLI_JS="$ROOT/packages/dispatch/dist/cli/index.js"
[ -f "$CLI_JS" ] || { echo "SKIP: dispatch CLI not built"; exit 0; }
[ -f "$ROOT/packages/crew/dist/runtime/context/renderPromptCli.js" ] || { echo "SKIP: crew not built"; exit 0; }

PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/${MERGE_LANE_NAME:-merge-lane}.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
[ "${KEEP:-0}" = 1 ] || trap 'gaffer_test_rm_work "$WORK"' EXIT
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
if grep -q 'resolve-merge-conflict skill' <<<"$prompt"; then
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
       GAFFER_MAX_TURNS=3 GAFFER_TICK_TIMEOUT=60 GAFFER_ROLE_MODELS=card=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
       REVIEW_MODE=human DRY_RUN=0 GAFFER_MAINTENANCE=0 GAFFER_STRICT_REQUIRE=0 GAFFER_SECURITY_REVIEW=0 GAFFER_TESTING=0 \
       MAX_OPEN_AGENT_BRANCHES_PER_REPO=10 MAX_IN_REVIEW_PER_REPO=10
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
wg repo add -n repo --path "$R" --branch main --stack node --test "npm test" --lint "npm run lint" >/dev/null 2>&1

run_tick() { ( cd "$RUNNER_DIR" && bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT=' ; }
st() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status'; }
new_ticket() { local n; n="$(wg ticket create -t "$1" -d "$2" --risk low 2>/dev/null | jget 'd.ticket.number')"; wg ac add "$n" -t "helper added" >/dev/null 2>&1; wg ticket repo-access set "$n" repo --access write --relation confirmed >/dev/null 2>&1; printf '%s' "$n"; }
# STALE REVISION: an approval names the commit(s) it reviewed — the heads `ticket diff`
# reports, exactly what the dashboard sends.
approve_heads() { wg ticket diff "$1" --heads 2>/dev/null | sed 's/^/--commit /' | tr '\n' ' '; }
branch_of() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.branch_name || ""'; }
LOGF="$GAFFER_DATA/factory.log"
