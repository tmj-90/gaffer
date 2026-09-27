#!/usr/bin/env bash
# =====================================================================
# GAFFER_REQUIRE_CI without GAFFER_CREATE_PR — skip with one warning, never reject.
# ---------------------------------------------------------------------
# The CI gate reads checks off the delivery PR (`gh pr checks <branch>`). With CI
# required but PR creation OFF there is no PR, so the gate polled a PR that never
# existed and, under the strict timeout policy, auto-rejected EVERY delivery back to
# rework after the poll window. Through the real tick with a GitHub-named remote and a
# stub `gh` that would report RED, the delivery now reaches in_review, the factory log
# carries one clear warning naming both knobs, and gh is never consulted.
# Run: bash runner/test/ci-gate-needs-pr.test.sh
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

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ci-needs-pr.XXXXXX")"; WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/data" "$WORK/bin"

R="$WORK/repo"; mkdir -p "$R/src" "$R/test"
( cd "$R" && git init -q -b main
  printf '{ "name": "r", "version": "0.1.0", "private": true, "type": "module", "scripts": { "test": "node --test", "lint": "node -e 0" } }\n' > package.json
  printf 'export function addTask(l, t) { return [...l, { t }]; }\n' > src/tasks.js
  printf 'import test from "node:test"; import assert from "node:assert/strict";\nimport { addTask } from "../src/tasks.js";\ntest("adds", () => { assert.equal(addTask([], "a").length, 1); });\n' > test/tasks.test.js
  git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init
  # A GitHub-named remote so the gate's own remote check would let it poll.
  git remote add origin git@github.com:example/repo.git )

cat > "$WORK/bin/claude" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
if [ -e .git ] && [ -f package.json ]; then
  fn="helper${GAFFER_TICKET:-0}"
  grep -q "$fn" src/tasks.js || { printf 'export function %s(l){return l;}\n' "$fn" >> src/tasks.js; git -c user.email=s@s -c user.name=s add -A >/dev/null; git -c user.email=s@s -c user.name=s commit -qm "feat: $fn" >/dev/null; }
  printf '{"type":"result","subtype":"success","is_error":false,"result":"done.\\n\\nSmallest-change note: modified src/tasks.js only.","total_cost_usd":0.02,"num_turns":3}\n'; exit 0
fi
printf '{"type":"result","subtype":"success","is_error":false,"result":"ok"}\n'
STUB
chmod +x "$WORK/bin/claude"
# Stub gh: records every call and reports a RED check — if the gate ever polled it, the
# delivery would be rejected.
cat > "$WORK/bin/gh" <<'GH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "__GH_CALLS__"
printf 'build\tcompleted\tfailure\thttps://github.com/example/repo/actions/runs/1\n'
GH
sed -i.bak "s|__GH_CALLS__|$WORK/data/gh-calls.log|" "$WORK/bin/gh" && rm -f "$WORK/bin/gh.bak"; chmod +x "$WORK/bin/gh"

export GAFFER_DATA="$WORK/data" CLAUDE_BIN="$WORK/bin/claude" CLAUDE_FLAGS="" \
       GAFFER_TICK_TIMEOUT=60 GAFFER_MAX_TURNS=10 GAFFER_CARD_MODEL=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
       REVIEW_MODE=human DRY_RUN=0 GAFFER_MAINTENANCE=0 \
       GAFFER_REQUIRE_CI=1 GAFFER_CREATE_PR=0 GAFFER_GH_BIN="$WORK/bin/gh" \
       GAFFER_CI_POLL_ATTEMPTS=1 GAFFER_CI_POLL_INTERVAL_SECS=0
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
wg repo add -n repo --path "$R" --branch main --test "npm test" --lint "npm run lint" >/dev/null 2>&1

run_tick() { ( cd "$RUNNER_DIR" && bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT=' ; }
st() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status'; }
mkticket() {
  local n
  n="$(wg ticket create -t "$1" -d "deliver without a PR" 2>/dev/null | jget 'd.ticket.number')"
  wg ac add "$n" -t "helper added" >/dev/null 2>&1
  wg ticket repo-access set "$n" repo --access write --relation confirmed >/dev/null 2>&1
  wg ticket ready "$n" >/dev/null 2>&1
  printf '%s' "$n"
}

echo "== A. REQUIRE_CI=1 + CREATE_PR=0 → delivery reaches in_review; gate skipped with a warning =="
N1="$(mkticket "CI probe one")"
OUT1="$(run_tick)"
echo "$OUT1" | grep -q '^TICK_RESULT=worked$' && ok "A: delivery tick → worked" || fail "A: tick result: $OUT1 ($(tail -3 "$GAFFER_DATA/factory.log" | tr '\n' '|'))"
[ "$(st "$N1")" = "in_review" ] && ok "A: #$N1 is in_review (NOT rejected to rework)" || fail "A: #$N1 status $(st "$N1")"
grep -q 'GAFFER_REQUIRE_CI is on but GAFFER_CREATE_PR is off' "$GAFFER_DATA/factory.log" \
  && ok "A: one clear warning names both knobs" || fail "A: no dependency warning: $(grep 'H3' "$GAFFER_DATA/factory.log" | tail -2 | tr '\n' '|')"
grep -q "CI gate is SKIPPED for #$N1" "$GAFFER_DATA/factory.log" && ok "A: the skip is logged for the ticket" || fail "A: skip not logged"
[ ! -s "$GAFFER_DATA/gh-calls.log" ] && ok "A: gh was never consulted (no PR to poll)" || fail "A: gh was called: $(cat "$GAFFER_DATA/gh-calls.log")"
grep -q 'CI FAILED\|auto-rejecting' "$GAFFER_DATA/factory.log" && fail "A: the gate still rejected the delivery" || ok "A: no auto-reject fired"

echo "== B. a second delivery in the same run stays quiet (warned once) =="
N2="$(mkticket "CI probe two")"
OUT2="$(run_tick)"
echo "$OUT2" | grep -q '^TICK_RESULT=worked$' && [ "$(st "$N2")" = "in_review" ] \
  && ok "B: #$N2 delivered → in_review" || fail "B: tick $OUT2 status=$(st "$N2")"
[ "$(grep -c 'GAFFER_REQUIRE_CI is on but GAFFER_CREATE_PR is off' "$GAFFER_DATA/factory.log")" = "1" ] \
  && ok "B: still exactly one warning in the log" \
  || fail "B: warning repeated $(grep -c 'GAFFER_REQUIRE_CI is on' "$GAFFER_DATA/factory.log") times"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
