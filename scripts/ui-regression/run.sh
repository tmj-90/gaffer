#!/usr/bin/env bash
# =====================================================================
# UI REGRESSION — drive the REAL dashboard end to end in a browser, with a stub
# worker standing in for `claude` (no model key needed).
#
#   onboard a sample repo (Memory view) → create a ticket (Create view) → add a
#   machine-checkable AC (ticket view) → mark ready → Poll for work (a live tick:
#   worktree, stub delivery, DoD gate, AC check, hygiene, minimalism, submit) →
#   Review (server diff, arm + confirm Approve) → merge runner → done →
#   Suggest work (product-owner run) → every view renders clean → SSE live refresh.
#
# Opt-in (needs a browser); NOT wired into CI. Run from the repo root:
#
#   pnpm -r build
#   npx playwright install chromium            # once, or point PLAYWRIGHT_CHROMIUM at a binary
#   bash scripts/ui-regression/run.sh          # ~2 min; writes <out>/results.json + screenshots
#
# Env: UI_REGRESS_PORT (default 8797) · UI_REGRESS_OUT (default /tmp/gaffer-ui-regression)
#      PLAYWRIGHT_CHROMIUM (chromium binary; default: playwright-core's resolution)
#      KEEP_DASHBOARD=1 leaves the dashboard up for manual poking (token printed).
# Everything lives under UI_REGRESS_OUT (a throwaway GAFFER_DATA + sample repo); the
# repo checkout's own .gaffer/ state is never touched.
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${UI_REGRESS_OUT:-/tmp/gaffer-ui-regression}"
PORT="${UI_REGRESS_PORT:-8797}"
# A previous KEEP_DASHBOARD=1 run leaves its dashboard bound to $PORT; its pid
# file lives under $OUT, so stop it BEFORE the wipe below — otherwise the new
# dashboard dies with EADDRINUSE and every call 401s against the stale token.
if [ -f "$OUT/data/dashboard.pid" ]; then
  _old="$(cat "$OUT/data/dashboard.pid" 2>/dev/null)"
  [ -n "$_old" ] && kill "$_old" 2>/dev/null && sleep 1
fi
rm -rf "$OUT"; mkdir -p "$OUT/data" "$OUT/shots" "$OUT/bin"

# ── playwright-core (no browser download) + axe-core (a11y audit) into the out dir ──
if ! node -e 'require.resolve("playwright-core"); require.resolve("axe-core")' >/dev/null 2>&1; then
  ( cd "$OUT" && npm init -y >/dev/null 2>&1 && npm install --silent playwright-core axe-core >/dev/null 2>&1 ) \
    || { echo "could not install playwright-core / axe-core (npm)"; exit 2; }
  export PW_CORE_ROOT="$OUT"   # regress.mjs resolves both from here (ESM ignores NODE_PATH)
fi

# ── sample target repo: a tiny node project with a real, passing test command ──
R="$OUT/taskflow-mini"; mkdir -p "$R/src" "$R/test"
( cd "$R" && git init -q -b main
  cat > package.json <<'JSON'
{ "name": "taskflow-mini", "version": "0.1.0", "private": true, "type": "module",
  "scripts": { "test": "node --test", "lint": "node -e \"process.exit(0)\"" } }
JSON
  cat > src/tasks.js <<'JS'
export function addTask(list, title) { return [...list, { title, done: false }]; }
export function completeTask(list, title) { return list.map(t => t.title === title ? { ...t, done: true } : t); }
JS
  cat > test/tasks.test.js <<'JS'
import test from "node:test"; import assert from "node:assert/strict";
import { addTask, completeTask } from "../src/tasks.js";
test("addTask appends", () => { assert.equal(addTask([], "a").length, 1); });
test("completeTask marks done", () => { assert.equal(completeTask(addTask([], "a"), "a")[0].done, true); });
JS
  printf '# taskflow-mini\nA tiny task list library used to regression-test the Gaffer dashboard.\n' > README.md
  git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm "init taskflow-mini" )

# ── stub worker + throwaway factory state, then the dashboard (the supported launch path) ──
cp "$HERE/stub-claude.sh" "$OUT/bin/claude"; chmod +x "$OUT/bin/claude"
export GAFFER_DATA="$OUT/data" DISPATCH_API_PORT="$PORT" CLAUDE_BIN="$OUT/bin/claude" CLAUDE_FLAGS="" \
       GAFFER_TICK_TIMEOUT=120 GAFFER_MAX_TURNS=50 GAFFER_CARD_MODEL=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub
# shellcheck source=../../runner/factory.config.sh
source "$ROOT/runner/factory.config.sh" >/dev/null 2>&1
node "$DISPATCH_DIR/dist/cli/index.js" --db "$DISPATCH_DB" init >/dev/null || { echo "dispatch init failed (run pnpm -r build)"; exit 2; }
lg init >/dev/null
[ -f "$CREW_CONFIG" ] || node "$CREW_DIR/dist/cli/index.js" init -d "$GAFFER_DATA" -n gaffer >/dev/null
sed -i.bak "s#sqlite_path:.*#sqlite_path: $DISPATCH_DB#" "$CREW_CONFIG" && rm -f "$CREW_CONFIG.bak"
bash "$ROOT/runner/gaffer" dashboard --restart >/dev/null 2>&1
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 0.5; done
TOKEN="$(cat "$GAFFER_DATA/dashboard-token" 2>/dev/null)"
[ -n "$TOKEN" ] || { echo "dashboard did not come up (see $GAFFER_DATA/dashboard.log)"; exit 2; }
# Prove the server on $PORT is OURS (accepts this run's token) — a foreign process
# on the port would pass /healthz and then fail every authenticated call.
curl -sf -H "authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/dashboard" >/dev/null \
  || { echo "a server on :$PORT rejects this run's token — another dashboard is bound there (see $GAFFER_DATA/dashboard.log)"; exit 2; }

echo "== UI regression against http://127.0.0.1:$PORT (out: $OUT) =="
BASE="http://127.0.0.1:$PORT" TOKEN="$TOKEN" REPO_PATH="$R" OUT="$OUT/shots" node "$HERE/regress.mjs"
rc=$?

if [ "${KEEP_DASHBOARD:-0}" = "1" ]; then
  echo "dashboard left running: http://127.0.0.1:$PORT/?token=$TOKEN"
else
  pid="$(cat "$GAFFER_DATA/dashboard.pid" 2>/dev/null)"; [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
fi
exit $rc
