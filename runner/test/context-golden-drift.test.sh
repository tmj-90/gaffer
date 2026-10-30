#!/usr/bin/env bash
# =====================================================================
# TICK-CONTEXT GOLDEN DRIFT — the checked-in goldens under
# packages/crew/test/fixtures/tick-context/ must equal what the REAL bash delivery
# tick renders today. The crew suite byte-compares the TS renderer against those
# goldens, so a bash-only change to the render (e.g. a post-render JSON edit of the
# runtime .mcp.json) used to pass both suites while the two paths silently diverged —
# until the next regeneration broke crew. This runs capture-context-golden.sh in
# --check mode (writes nothing) and fails on any drift.
# Run: bash runner/test/context-golden-drift.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$HERE/capture-context-golden.sh" --check
