#!/usr/bin/env bash
# No test may touch the operator state a checkout's factory runs on. Every suite
# uses a private GAFFER_DATA / DISPATCH_DB / MEMORY_DB / crew event log; anything
# left in these (mostly gitignored, hence --ignored) paths means a test fell back
# to the checkout's defaults — which on a contributor's machine are their LIVE
# factory's DBs, audit log and settings.
#
# The package entries are `<glob>/*`, not `<glob>`: git never matches a wildcard
# pathspec against an ignored DIRECTORY entry, so 'packages/*/.crew' printed
# nothing even with packages/crew/.crew/events.jsonl on disk. Literal paths are
# fine either way. Locked by operator-state-guard.test.sh.
#
# Run from the checkout root: bash .github/scripts/operator-state-guard.sh
set -uo pipefail
STATE_PATHS=(.gaffer .dispatch .crew runner/.crew runner/.dispatch
             'packages/*/.crew/*' 'packages/*/.dispatch/*')
left="$(git status --porcelain --ignored -- "${STATE_PATHS[@]}")" || { echo "::error::git status failed"; exit 2; }
if [ -n "$left" ]; then
  echo "::error::tests wrote operator state into the checkout:"; printf '%s\n' "$left"; exit 1
fi
echo "clean: no .gaffer / .dispatch / .crew state in the checkout"
