#!/usr/bin/env bash
# =====================================================================
# PREVIEW IS PREVIEW — a --dry-run tick on a resume-requested paused ticket changes
# nothing (external review #8).
# ---------------------------------------------------------------------
# With a healthy database, a dry-run tick on a paused ticket after Continue used to call
# `resume-begin` before checking DRY_RUN: the ticket went paused → in_progress under a
# fresh lease and its resume request was consumed, while no worker ran. Driven through
# the REAL tick.sh with a stub agent (lib/stub-tick.sh):
#   D1. pause at the cap → Continue → DRY_RUN tick: still `paused`, still resume-
#       requested, no active claim, the paused context kept, and the tick says what it
#       would do; no agent call
#   D2. the next LIVE tick resumes it as before (in the same worktree)
# Run: bash runner/test/resume-dry-run.test.sh
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

STUB_TICK_NAME=resume-dry-run
# shellcheck source=lib/stub-tick.sh
source "$HERE/lib/stub-tick.sh"

active_claims() {
  node -e '
const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1], { readOnly: true });
const r = db.prepare("SELECT count(*) AS n FROM ticket_claims c JOIN tickets t ON t.id = c.ticket_id WHERE t.number = ? AND c.status = ?").get(Number(process.argv[2]), "active");
process.stdout.write(String(r.n));' "$DISPATCH_DB" "$1" 2>/dev/null
}
resume_requested() { wg ticket resume-requested 2>/dev/null | N="$1" jget '((d.tickets || d || []).some(t => String(t.number) === process.env.N)) ? "yes" : "no"' 2>/dev/null; }
agent_calls() { find "$CALLS" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' '; }

echo "== D1. pause → Continue → a DRY_RUN tick changes nothing =="
echo edit-nocommit-cap > "$MODE"
D1="$(new_ready "Resume preview" "deliver a helper")"
run_tick >/dev/null
[ "$(st "$D1")" = "paused" ] && ok "D1: #$D1 paused at the cap" || fail "D1: status=$(st "$D1")"
WT1="$(wg ticket paused-context "$D1" | jget 'd.context.worktree_path')"
wg ticket continue "$D1" >/dev/null 2>&1; rm -f "$GAFFER_DATA/.failed-tickets"
[ "$(resume_requested "$D1")" = "yes" ] && ok "D1: Continue recorded a resume request" || fail "D1: no resume request after Continue"
CALLS0="$(agent_calls)"
OUT="$( ( cd "$RUNNER_DIR" && DRY_RUN=1 bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT=' )"
[ "$(st "$D1")" = "paused" ] && ok "D1: after the dry run #$D1 is still paused (not in_progress)" || fail "D1: the dry run moved #$D1 to $(st "$D1")"
[ "$(resume_requested "$D1")" = "yes" ] && ok "D1: the resume request was NOT consumed" || fail "D1: the dry run consumed the resume request"
[ "$(active_claims "$D1")" = "0" ] && ok "D1: no lease/claim was taken" || fail "D1: the dry run took $(active_claims "$D1") claim(s)"
[ "$(wg ticket paused-context "$D1" | jget 'd.context ? "yes" : "no"')" = "yes" ] && ok "D1: the paused context is intact" || fail "D1: paused context lost"
[ -d "$WT1" ] && ok "D1: the paused worktree is untouched" || fail "D1: worktree $WT1 gone"
[ "$(agent_calls)" = "$CALLS0" ] && ok "D1: no agent ran" || fail "D1: an agent ran during the dry run"
grep -q "DRY_RUN: would resume paused #$D1" "$GAFFER_DATA/factory.log" && ok "D1: the dry run says what it would do" || fail "D1: no 'would resume' line ($OUT)"

echo "== D2. the next LIVE tick resumes it in the same worktree =="
echo deliver > "$MODE"
run_tick >/dev/null
grep -q "RESUME: reusing preserved worktree for repo .* at $WT1" "$GAFFER_DATA/factory.log" && ok "D2: the live tick resumed in the SAME worktree" || fail "D2: no reuse of $WT1"
[ "$(st "$D1")" = "in_review" ] && ok "D2: the resumed delivery reached in_review" || fail "D2: status after the live resume=$(st "$D1")"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
