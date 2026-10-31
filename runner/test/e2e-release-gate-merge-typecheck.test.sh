#!/usr/bin/env bash
# =====================================================================
# RELEASE GATE 2, typecheck variant — the merge gate runs the SAME gates as the delivery
# gate, including the typecheck command auto-detected from the repo's package.json.
# ---------------------------------------------------------------------
# The field-rename pair of e2e-release-gate-merge-combination, with the only check that
# catches it moved to the `typecheck` script (`test` is `node -e 0`). Before the fix
# bin/dod-regate.sh read only GAFFER_DOD_TYPECHECK_CMD, SKIPPED the auto-detected
# typecheck, logged MERGE GATE PASS, B landed, main failed `npm run typecheck` and B read
# "done". Same scenarios, same assertions: B is held, main stays green.
# Run: bash runner/test/e2e-release-gate-merge-typecheck.test.sh
# =====================================================================
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RG2_GATE=typecheck exec bash "$HERE/e2e-release-gate-merge-combination.test.sh" "$@"
