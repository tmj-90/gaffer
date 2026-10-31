#!/usr/bin/env bash
# =====================================================================
# UI SCENARIOS — the browser-driven scenario suites (scripts/ui-regression/suites/),
# each a product flow beyond the golden path (rework, won't do, unblock, pause,
# tester verdicts, decisions, settings, memory, map, squad, specs, plans, health,
# autonomy) driven in a real browser against the real server and runner, with the
# stub worker (stub-claude.sh: modes per ticket from $GAFFER_DATA/stub-mode.json)
# and no model call.
#
#   pnpm -r build
#   bash scripts/ui-regression/run-suites.sh               # every suite, in run order
#   bash scripts/ui-regression/run-suites.sh s1-rework s3-blocked   # just these
#
# The world is the golden path's (setup.sh, shared with run.sh: throwaway
# GAFFER_DATA, the taskflow-mini sample repo, the stub worker, the dashboard via
# `gaffer dashboard --restart`), plus two canned planning bins for the suites that
# plan or author (GAFFER_DECOMPOSE_BIN, GAFFER_SPEC_AUTHOR_BIN → suites/bin/) and one
# operator-exported setting (GAFFER_NOTIFY_DESKTOP=0) so the Settings suite can
# prove an env-locked row is read-only.
# Prints one line per suite and "UI scenarios: N ok, N FAIL"; exits 1 on any FAIL.
# Env: UI_REGRESS_PORT (default 8798) · UI_REGRESS_OUT (default /tmp/gaffer-ui-scenarios)
#      UI_SUITES (space/comma list, same as argv) · KEEP_DASHBOARD=1 · PLAYWRIGHT_CHROMIUM
# `run-suites.sh --serve` only builds the world and leaves the dashboard up, printing
# the env to drive `node run-suites.mjs <suite>` against it while writing a suite.
# =====================================================================
set -uo pipefail
UI_SETUP_DEFAULT_OUT=/tmp/gaffer-ui-scenarios
UI_SETUP_DEFAULT_PORT=8798
ui_setup_before_dashboard() {
  # Canned planning bins (no model): the dashboard's plan-build / spec-build runners
  # spawn these instead of `claude`.
  export GAFFER_DECOMPOSE_BIN="$HERE/suites/bin/decompose-stub.mjs"
  export GAFFER_SPEC_AUTHOR_BIN="$HERE/suites/bin/spec-author-stub.mjs"
  # An operator override the Settings suite asserts is env-locked (read-only).
  export GAFFER_NOTIFY_DESKTOP=0
}
# shellcheck source=setup.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/setup.sh"

if [ "${1:-}" = "--serve" ]; then
  printf 'BASE=http://127.0.0.1:%s TOKEN=%s REPO_PATH=%s OUT=%s ROOT=%s GAFFER_DATA=%s PW_CORE_ROOT=%s\n' \
    "$PORT" "$TOKEN" "$R" "$OUT/shots" "$ROOT" "$GAFFER_DATA" "${PW_CORE_ROOT:-}"
  exit 0
fi
echo "== UI scenarios against http://127.0.0.1:$PORT (out: $OUT) =="
BASE="http://127.0.0.1:$PORT" TOKEN="$TOKEN" REPO_PATH="$R" OUT="$OUT/shots" ROOT="$ROOT" \
  GAFFER_DATA="$GAFFER_DATA" node "$HERE/run-suites.mjs" "$@"
rc=$?

ui_teardown
exit $rc
