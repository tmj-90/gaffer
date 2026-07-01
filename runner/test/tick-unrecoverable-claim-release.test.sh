#!/usr/bin/env bash
# Static test: verify all three UNRECOVERABLE delivery failure paths in tick.sh
# release the runner-held claim before exiting.
#
# RUNNER-OWNED-BOOKKEEPING: the runner now HOLDS the delivery claim, so an
# unrecoverable failure (no salvageable commits) must explicitly release it back to
# `ready` (a later tick can retry cleanly) via `gaffer_release_delivery ready …`
# immediately before `gaffer_skip_ticket`. This replaces the old
# `wg ticket move refining || wg block || true` submit-status fallback.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TICK="$HERE/../tick.sh"
PASS=0; FAIL=0
check() {
  local name="$1" pattern="$2"
  if perl -0777 -ne "exit 0 if /$pattern/ms; exit 1" "$TICK"; then
    echo "PASS: $name"; PASS=$((PASS+1))
  else
    echo "FAIL: $name — pattern not found"; FAIL=$((FAIL+1))
  fi
}

# Path A: agent non-zero exit / no commits → release to ready before skip.
check "path-A: release-to-ready before skip on no-commit agent failure" \
  'gaffer_release_delivery ready "delivery failed: agent exited non-zero \(rc=\$rc\) with no commits;[^\n]*\n[^\n]*gaffer_skip_ticket'

# Path B: wrong branch (HEAD is default branch) → release to ready before skip.
check "path-B: release-to-ready before skip on wrong-branch (default branch)" \
  'gaffer_release_delivery ready "delivery failed: worktree HEAD was[^\n]*\n[^\n]*gaffer_skip_ticket'

# Path C: wrong branch (not a gaffer/ branch) → release to ready before skip.
check "path-C: release-to-ready before skip on wrong-branch (non-gaffer branch)" \
  'gaffer_release_delivery ready "delivery failed: worktree HEAD[^\n]*is not a gaffer[^\n]*\n[^\n]*gaffer_skip_ticket'

# And the deleted submit-status fallback must be GONE from these failure paths:
# no unrecoverable path should still do `wg ticket move … refining … || wg block`.
if perl -0777 -ne 'exit 1 if /wg ticket move "\$NUM" refining --reason "delivery failed/ms; exit 0' "$TICK"; then
  echo "PASS: deleted submit-status move-or-block fallback is gone"; PASS=$((PASS+1))
else
  echo "FAIL: a deleted 'wg ticket move refining' failure fallback is still present"; FAIL=$((FAIL+1))
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
