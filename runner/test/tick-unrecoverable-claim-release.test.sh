#!/usr/bin/env bash
# Static test: verify all three unrecoverable delivery failure paths in tick.sh
# release the claim (move to refining or block) before exiting.
#
# Each path is identified by its gaffer_cleanup_worktrees drop-branch + gaffer_skip_ticket
# pair, with a claim-release command inserted immediately before the skip.
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

# Path A: agent non-zero exit / no commits
check "path-A: release before skip on no-commit agent failure" \
  'wg ticket move.*refining.*delivery failed.*no commits.*\n.*\|\|.*wg block.*\n.*\|\|.*true\s*\n[^\n]*gaffer_skip_ticket'

# Path B: wrong branch (HEAD is default branch)
check "path-B: release before skip on wrong-branch (default branch)" \
  'wg ticket move.*refining.*HEAD was.*expected gaffer.*\n.*\|\|.*wg block.*\n.*\|\|.*true\s*\n[^\n]*gaffer_skip_ticket'

# Path C: wrong branch (not a gaffer/ branch)
check "path-C: release before skip on wrong-branch (non-gaffer branch)" \
  'wg ticket move.*refining.*HEAD.*is not a gaffer.*\n.*\|\|.*wg block.*\n.*\|\|.*true\s*\n[^\n]*gaffer_skip_ticket'

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
