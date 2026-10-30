#!/usr/bin/env bash
# =====================================================================
# BRANCH-SWITCH RECOVERY (fresh tickets) — an agent that leaves the ticket branch
# loses nothing.
# ---------------------------------------------------------------------
# Driven through the REAL tick.sh with a stub agent (lib/stub-tick.sh):
#   S1. fresh ticket, `checkout -b x && commit` → fast-forwarded onto the ticket
#       branch, x deleted, in_review
#   S4. fresh ticket, detached HEAD + commit → recovered onto the ticket branch
#   U1. the agent checks out the USER's pre-existing branch and commits → its commit
#       is delivered, the user's branch is kept and put back where it was
#   U2. the agent checks out a user's branch carrying the user's own commit and
#       commits nothing → the user's commit is NOT delivered, the branch is kept
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

retire "$S4"; [ "$(st "$S4")" = cancelled ] || fail "S4: could not retire #$S4 (status $(st "$S4"))"

# The user's own branches in the real repo, made before any agent ran.
git -C "$R" branch user-feature main
git -C "$R" branch user-feature2 main
( cd "$R" && git checkout -q user-feature2 && echo "user work" > USER.md && git add USER.md \
    && git -c user.email=u@u -c user.name=u commit -qm "user: my own work" && git checkout -q main )
UF1="$(git -C "$R" rev-parse user-feature)"; UF2="$(git -C "$R" rev-parse user-feature2)"

echo "== U1. agent commits on the user's pre-existing branch → delivered, the user's branch kept as it was =="
echo userbranch > "$MODE"
U1="$(new_ready "User branch commit" "deliver a helper")"
run_tick >/dev/null
BU1="$(branch_of "$U1")"
[ "$(st "$U1")" = "in_review" ] && [ "$(commits_on "$BU1")" = 1 ] && ok "U1: the agent's own commit delivered on $BU1 → in_review" || fail "U1: status=$(st "$U1") commits=$(commits_on "$BU1")"
[ "$(git -C "$R" rev-parse --verify --quiet refs/heads/user-feature)" = "$UF1" ] && ok "U1: user-feature still exists, back at its pre-spawn sha" || fail "U1: user-feature is $(git -C "$R" rev-parse --verify --quiet refs/heads/user-feature || echo DELETED) (was $UF1)"
retire "$U1"; [ "$(st "$U1")" = cancelled ] || fail "U1: could not retire #$U1 (status $(st "$U1"))"

echo "== U2. agent checks out a user's branch with the user's commit, commits nothing → nothing delivered =="
echo userbranch-nocommit > "$MODE"
U2="$(new_ready "User branch idle" "deliver a helper")"
R2="$(run_tick)"
BU2="$(branch_of "$U2")"
[ "$R2" != "TICK_RESULT=worked" ] && [ "$(st "$U2")" = "ready" ] && ok "U2: not delivered ($R2), #$U2 back to ready" || fail "U2: $R2 status=$(st "$U2")"
{ [ -z "$BU2" ] || ! git -C "$R" log --format=%s "main..$BU2" | grep -q "user: my own work"; } && ok "U2: the user's commit is not on a ticket branch" || fail "U2: the user's commit was absorbed into $BU2"
[ "$(git -C "$R" rev-parse --verify --quiet refs/heads/user-feature2)" = "$UF2" ] && ok "U2: user-feature2 kept at its own sha" || fail "U2: user-feature2 is $(git -C "$R" rev-parse --verify --quiet refs/heads/user-feature2 || echo DELETED) (was $UF2)"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
