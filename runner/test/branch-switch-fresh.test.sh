#!/usr/bin/env bash
# =====================================================================
# BRANCH-SWITCH RECOVERY (fresh tickets) — an agent that leaves the ticket branch
# loses nothing.
# ---------------------------------------------------------------------
# Driven through the REAL tick.sh with a stub agent (lib/stub-tick.sh):
#   S1. fresh ticket, `checkout -b x && commit` → fast-forwarded onto the ticket
#       branch, x deleted, in_review
#   S4. fresh ticket, detached HEAD + commit → recovered onto the ticket branch
# (Reworked tickets: branch-switch-recovery.test.sh.)
# Run: bash runner/test/branch-switch-fresh.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
command -v perl >/dev/null 2>&1 || { echo "SKIP: perl required (timeout primitive)"; exit 0; }
for f in packages/dispatch/dist/cli/index.js packages/memory/dist/bin/memory.js packages/crew/dist/cli/index.js; do
  [ -f "$ROOT/$f" ] || { echo "SKIP: $f not built (run pnpm -r build)"; exit 0; }
done

STUB_TICK_NAME=branch-switch-fresh
# shellcheck source=lib/stub-tick.sh
source "$HERE/lib/stub-tick.sh"

echo "== S1. fresh ticket: agent switches to its own branch → recovered =="
echo newbranch > "$MODE"
S1="$(new_ready "Side branch fresh" "deliver a helper")"
run_tick >/dev/null
BS1="$(branch_of "$S1")"
[ "$(st "$S1")" = "in_review" ] && ok "S1: #$S1 delivered → in_review" || fail "S1: status=$(st "$S1")"
[ -n "$BS1" ] && [ "$(commits_on "$BS1")" -ge 1 ] && ok "S1: the agent's commit is on $BS1" || fail "S1: $BS1 has $(commits_on "$BS1") commits"
[ -z "$(git -C "$R" branch --list 'agent-side-*')" ] && ok "S1: the stray agent branch was deleted (fully contained)" || fail "S1: stray branches left: $(git -C "$R" branch --list 'agent-side-*' | tr '\n' ' ')"

retire "$S1"; [ "$(st "$S1")" = cancelled ] || fail "S1: could not retire #$S1 (status $(st "$S1"))"

echo "== S4. fresh ticket: detached HEAD + commit → recovered =="
echo detached > "$MODE"
S4="$(new_ready "Detached fresh" "deliver a helper")"
run_tick >/dev/null
BS4="$(branch_of "$S4")"
[ "$(st "$S4")" = "in_review" ] && [ "$(commits_on "$BS4")" -ge 1 ] && ok "S4: detached commit recovered onto $BS4 → in_review" || fail "S4: status=$(st "$S4") commits=$(commits_on "$BS4")"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
