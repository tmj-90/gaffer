#!/usr/bin/env bash
# =====================================================================
# BRANCH-SWITCH RECOVERY — an agent that leaves the ticket branch loses nothing.
# ---------------------------------------------------------------------
# Driven through the REAL tick.sh with a stub agent (lib/stub-tick.sh):
#   S2. rework, `checkout -b x && commit` → reviewed + new commit on the ticket branch, in_review,
#       not counted as a no-commit failure
#   S3. rework, `checkout -b x main && commit` (diverged) → reviewed commit untouched,
#       x kept for salvage, a recoverable retry that spawns on the ticket branch
# (Fresh tickets and a detached HEAD: branch-switch-fresh.test.sh.)
# Run: bash runner/test/branch-switch-recovery.test.sh
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

STUB_TICK_NAME=branch-switch-recovery
# shellcheck source=lib/stub-tick.sh
source "$HERE/lib/stub-tick.sh"

echo "== S2. rework: agent switches to its own branch → reviewed + new commit kept =="
S2="$(reworked_ticket "Side branch rework")"; BS2="$(branch_of "$S2")"; N2="$(commits_on "$BS2")"
echo newbranch > "$MODE"
run_tick >/dev/null
[ "$(st "$S2")" = "in_review" ] && ok "S2: #$S2 re-delivered → in_review" || fail "S2: status=$(st "$S2")"
[ "$(commits_on "$BS2")" = "$((N2 + 1))" ] && ok "S2: $BS2 holds the reviewed commit(s) AND the agent's new one ($(commits_on "$BS2"))" || fail "S2: $BS2 is $(commits_on "$BS2") (had $N2)"
[ -z "$(git -C "$R" branch --list 'agent-side-*')" ] && ok "S2: no stray agent branch left" || fail "S2: stray branches left: $(git -C "$R" branch --list 'agent-side-*' | tr '\n' ' ')"
NC_FILE="$GAFFER_DATA/.nocommit-failures/$S2"
[ ! -s "$NC_FILE" ] && ok "S2: not counted as a no-commit failure" || fail "S2: no-commit counter is $(cat "$NC_FILE")"

retire "$S2"; [ "$(st "$S2")" = cancelled ] || fail "S2: could not retire #$S2 (status $(st "$S2"))"

echo "== S3. rework: agent branches off main (diverged) → reviewed work untouched, retried on the ticket branch =="
S3="$(reworked_ticket "Diverged rework")"; BS3="$(branch_of "$S3")"; SHA3="$(git -C "$R" rev-parse "$BS3")"
echo diverge-once > "$MODE"; rm -f "$CALLS/diverged"
run_tick >/dev/null
STRAY3="$(git -C "$R" branch --list 'agent-off-main-*' | tr -d ' *+' | head -1)"
[ -n "$STRAY3" ] && [ "$(commits_on "$STRAY3")" = 1 ] && ok "S3: the agent's diverged branch $STRAY3 is KEPT for salvage" || fail "S3: diverged branch missing ('$STRAY3')"
git -C "$R" merge-base --is-ancestor "$SHA3" "$BS3" 2>/dev/null && ok "S3: the reviewed commit is still on $BS3" || fail "S3: $BS3 lost the reviewed commit"
DL3="$(last_delivery)"
[ "$(cat "$DL3/branch-at-spawn" 2>/dev/null)" = "$BS3" ] && ok "S3: the retry attempt spawned on $BS3" || fail "S3: retry spawned on '$(cat "$DL3/branch-at-spawn" 2>/dev/null)'"
[ "$(st "$S3")" = "in_review" ] && ok "S3: the retry delivered → in_review" || fail "S3: status=$(st "$S3")"
grep -q "RECOVER: #$S3 branch failed on attempt 1" "$GAFFER_DATA/factory.log" && ok "S3: handled as a recoverable 'branch' failure (not a no-commit release)" || fail "S3: no recoverable branch-failure log"

retire "$S3"; [ "$(st "$S3")" = cancelled ] || fail "S3: could not retire #$S3 (status $(st "$S3"))"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
