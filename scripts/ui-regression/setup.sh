# shellcheck shell=bash
# =====================================================================
# Shared setup for the browser harnesses: run.sh (the golden path) and
# run-suites.sh (the scenario suites) SOURCE this file. It builds the throwaway
# world both drive and leaves these set for the caller:
#
#   HERE ROOT OUT PORT   this dir, the repo root, the out dir, the dashboard port
#   R                    the sample target repo (taskflow-mini, a real git repo)
#   TOKEN                the dashboard bearer token
#   GAFFER_DATA …        the factory env (factory.config.sh sourced)
#
# Steps: stop a dashboard a previous KEEP_DASHBOARD=1 run left on $PORT, wipe
# $OUT, install playwright-core + axe-core into it (no browser download), write
# the sample repo, install the stub worker as $OUT/bin/claude, init the dispatch
# + memory databases, seed one lore draft, and launch the dashboard through the
# supported path (`gaffer dashboard --restart`). A caller may define
#   ui_setup_before_dashboard   a function run before the factory env is sourced and
#                               the dashboard launched (export operator env the
#                               server must see, plant extra fixtures)
# and must set UI_SETUP_DEFAULT_OUT / UI_SETUP_DEFAULT_PORT for the defaults.
# ui_teardown stops the dashboard unless KEEP_DASHBOARD=1.
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${UI_REGRESS_OUT:-${UI_SETUP_DEFAULT_OUT:-/tmp/gaffer-ui-regression}}"
PORT="${UI_REGRESS_PORT:-${UI_SETUP_DEFAULT_PORT:-8797}}"
# A previous KEEP_DASHBOARD=1 run leaves its dashboard bound to $PORT; its pid
# file lives under $OUT, so stop it BEFORE the wipe below — otherwise the new
# dashboard dies with EADDRINUSE and every call 401s against the stale token.
if [ -f "$OUT/data/dashboard.pid" ]; then
  _old="$(cat "$OUT/data/dashboard.pid" 2>/dev/null)"
  [ -n "$_old" ] && kill "$_old" 2>/dev/null && sleep 1
fi
rm -rf "$OUT"; mkdir -p "$OUT/data" "$OUT/shots" "$OUT/bin"

# ── playwright-core (no browser download) + axe-core (a11y audit) into the out dir ──
# UI_PW_CACHE (run-suites.sh sets it): install once into that dir, which the wipe above
# never touches, so every world of a run (the shared one, each own-server one) reuses it.
if ! node -e 'require.resolve("playwright-core"); require.resolve("axe-core")' >/dev/null 2>&1; then
  _pw="${UI_PW_CACHE:-$OUT}"; mkdir -p "$_pw"
  if [ ! -d "$_pw/node_modules/playwright-core" ] || [ ! -d "$_pw/node_modules/axe-core" ]; then
    # Pinned: CI installs the matching Chromium with `npx playwright@<same version> install`.
    ( cd "$_pw" && npm init -y >/dev/null 2>&1 && npm install --silent playwright-core@1.63.0 axe-core@4.13.0 >/dev/null 2>&1 ) \
      || { echo "could not install playwright-core / axe-core (npm)"; exit 2; }
  fi
  export PW_CORE_ROOT="$_pw"   # regress.mjs resolves both from here (ESM ignores NODE_PATH)
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
  # A planted 520-line god-file so the idle tech-debt lane has something to find
  # when the regression turns maintenance on (step 6c).
  { echo "// legacy module — deliberately oversized so the tech-debt scan flags it"; for i in $(seq 1 520); do echo "export const legacy$i = $i;"; done; } > src/legacy.js
  printf '# taskflow-mini\nA tiny task list library used to regression-test the Gaffer dashboard.\n' > README.md
  git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm "init taskflow-mini" )

# ── stub worker + throwaway factory state, then the dashboard (the supported launch path) ──
cp "$HERE/stub-claude.sh" "$OUT/bin/claude"; chmod +x "$OUT/bin/claude"
cp "$HERE/stub-worker.mjs" "$OUT/bin/stub-worker.mjs"
# The caller's hook runs BEFORE factory.config.sh is sourced, so what it exports is
# recorded as operator env (an override the dashboard keeps and shows env-locked).
if declare -F ui_setup_before_dashboard >/dev/null; then ui_setup_before_dashboard || { echo "setup hook failed"; exit 2; }; fi
export GAFFER_DATA="$OUT/data" DISPATCH_API_PORT="$PORT" CLAUDE_BIN="$OUT/bin/claude" CLAUDE_FLAGS="" \
       GAFFER_TICK_TIMEOUT=120 GAFFER_MAX_TURNS=50 GAFFER_CARD_MODEL=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub
# shellcheck source=../../runner/factory.config.sh
source "$ROOT/runner/factory.config.sh" >/dev/null 2>&1
node "$DISPATCH_DIR/dist/cli/index.js" --db "$DISPATCH_DB" init >/dev/null || { echo "dispatch init failed (run pnpm -r build)"; exit 2; }
lg init >/dev/null
# Seed ONE lore draft for the sample repo so the regression can ratify it from the
# Memory view (step 2b in regress.mjs): drafts used to be approvable only via the CLI.
lg suggest --title "UI regression draft lore" \
  --summary "A seeded draft the browser regression approves from the Memory view." \
  --body "Seeded by scripts/ui-regression/run.sh so the dashboard's approve path is exercised end to end." \
  --repo taskflow-mini --kind convention --tag ui-regression >/dev/null \
  || { echo "could not seed the lore draft (memory CLI)"; exit 2; }
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


ui_teardown() {
  if [ "${KEEP_DASHBOARD:-0}" = "1" ]; then
    echo "dashboard left running: http://127.0.0.1:$PORT/?token=$TOKEN"
  else
    local pid; pid="$(cat "$GAFFER_DATA/dashboard.pid" 2>/dev/null)"
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  fi
}
