#!/usr/bin/env bash
# =====================================================================
# RESUME ABORT — a resumed delivery that does not finish goes back to `paused`.
# ---------------------------------------------------------------------
# Driven through the REAL tick.sh with a stub agent (lib/stub-tick.sh):
#   R1. pause → Continue → SIGTERM mid-resume → back to `paused` (context + worktree
#       kept, Continue works again, the next tick resumes in the same worktree)
#   R2. a resume whose paused worktree cannot be reused → back to `paused`
# (A SIGKILL never runs the trap; the lapsed resume lease covers that in dispatch.)
# Run: bash runner/test/resume-abort.test.sh
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

STUB_TICK_NAME=resume-abort
# shellcheck source=lib/stub-tick.sh
source "$HERE/lib/stub-tick.sh"

echo "== R1. SIGTERM mid-resume → back to paused, Continue works again =="
echo edit-nocommit-cap > "$MODE"
R1="$(new_ready "Resume crash" "deliver a helper")"
run_tick >/dev/null
[ "$(st "$R1")" = "paused" ] && ok "R1: #$R1 paused at the cap" || fail "R1: status=$(st "$R1")"
WT1="$(wg ticket paused-context "$R1" | jget 'd.context.worktree_path')"
wg ticket continue "$R1" >/dev/null 2>&1; rm -f "$GAFFER_DATA/.failed-tickets"
echo hang > "$MODE"
( cd "$RUNNER_DIR" && exec perl -e 'setpgrp(0, 0); exec @ARGV' bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" >"$WORK/resume.out" ) &
TP=$!
wait_hanging || fail "R1: the resumed agent never started"
kill -TERM -- "-$TP"; wait "$TP"
rm -f "$CALLS"/*/hanging
[ "$(st "$R1")" = "paused" ] && ok "R1: the killed resume is back to paused (not stranded in_progress)" || fail "R1: status=$(st "$R1")"
[ "$(wg ticket paused-context "$R1" | jget 'd.context ? "yes" : "no"')" = "yes" ] && ok "R1: the resume context survived" || fail "R1: resume context lost"
[ -d "$WT1" ] && ok "R1: the paused worktree is still on disk" || fail "R1: worktree $WT1 gone"
wg ticket continue "$R1" >/dev/null 2>&1 && ok "R1: Continue works again" || fail "R1: Continue refused"
rm -f "$GAFFER_DATA/.failed-tickets"
echo deliver > "$MODE"
run_tick >/dev/null
grep -q "RESUME: reusing preserved worktree for repo .* at $WT1" "$GAFFER_DATA/factory.log" && ok "R1: the next tick resumed in the SAME worktree" || fail "R1: no reuse of $WT1"
[ "$(st "$R1")" = "in_review" ] && ok "R1: the resumed delivery reached in_review" || fail "R1: status after resume=$(st "$R1")"

echo "== R2. a resume whose worktree cannot be reused → back to paused =="
echo edit-nocommit-cap > "$MODE"
R2="$(new_ready "Resume wt fail" "deliver a helper")"
run_tick >/dev/null
WT2="$(wg ticket paused-context "$R2" | jget 'd.context.worktree_path')"
wg ticket continue "$R2" >/dev/null 2>&1; rm -f "$GAFFER_DATA/.failed-tickets"
git -C "$R" worktree remove --force "$WT2" >/dev/null 2>&1; rm -rf "$WT2"; mkdir -p "$WT2"; echo junk > "$WT2/junk"   # not a worktree, not empty
run_tick >/dev/null
grep -q "RESUME FAILED for #$R2" "$GAFFER_DATA/factory.log" && ok "R2: the resume could not reuse its worktree" || fail "R2: the WT_FAILED resume path did not run"
[ "$(st "$R2")" = "paused" ] && ok "R2: #$R2 is back to paused (not stranded in_progress)" || fail "R2: status=$(st "$R2")"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
