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
# Runs in CI (the `ui-regression` job) and locally. From the repo root:
#
#   pnpm -r build
#   npx playwright@1.63.0 install chromium     # once (same version as the pinned playwright-core),
#                                              # or point PLAYWRIGHT_CHROMIUM at a chromium binary
#   bash scripts/ui-regression/run.sh          # ~3 min; writes <out>/shots/results.json + screenshots
#
# Env: UI_REGRESS_PORT (default 8797) · UI_REGRESS_OUT (default /tmp/gaffer-ui-regression)
#      PLAYWRIGHT_CHROMIUM (chromium binary; default: playwright-core's resolution)
#      KEEP_DASHBOARD=1 leaves the dashboard up for manual poking (token printed).
# Everything lives under UI_REGRESS_OUT (a throwaway GAFFER_DATA + sample repo); the
# repo checkout's own .gaffer/ state is never touched.
# =====================================================================
set -uo pipefail
# shellcheck source=setup.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/setup.sh"

echo "== UI regression against http://127.0.0.1:$PORT (out: $OUT) =="
BASE="http://127.0.0.1:$PORT" TOKEN="$TOKEN" REPO_PATH="$R" OUT="$OUT/shots" node "$HERE/regress.mjs"
rc=$?

ui_teardown
exit $rc
