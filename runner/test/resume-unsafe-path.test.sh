#!/usr/bin/env bash
# =====================================================================
# A RESUMED delivery whose preserved worktree holds a link the runner refuses to write
# through keeps its partial work.
# ---------------------------------------------------------------------
# A paused delivery keeps its worktree (committed AND uncommitted work) for Continue. If
# that worktree now holds a symlink where the runner writes the agent's files (here the
# paused agent left CLAUDE.factory.md as a link to a file outside), the resumed tick
# refuses to write through it (unsafe_worktree_path). Parking it `blocked` lost the work:
# after `gaffer wg unblock` the ticket is claimed afresh, and a fresh delivery clears the
# stale worktree (uncommitted files included) before it re-creates it. So a refused resume
# goes back to `paused` instead: no agent launched, the outside file untouched, the
# worktree, its uncommitted file and the branch kept, the reason on the ticket naming the
# link and the worktree, and Continue resumes in the same worktree once the link is gone.
# Real tick.sh + dispatch + a stub agent (lib/stub-tick.sh).
# Run: bash runner/test/resume-unsafe-path.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
for f in packages/dispatch/dist/cli/index.js packages/memory/dist/bin/memory.js packages/crew/dist/cli/index.js; do
  [ -f "$ROOT/$f" ] || { echo "SKIP: $f not built (run pnpm -r build)"; exit 0; }
done

STUB_TICK_NAME=resume-unsafe-path
# shellcheck source=lib/stub-tick.sh
source "$HERE/lib/stub-tick.sh"
deliveries() { grep -lx delivery "$CALLS"/*/kind 2>/dev/null | wc -l | tr -d ' '; }

echo "== pause with uncommitted work, then a link appears in the preserved worktree =="
echo edit-nocommit-cap > "$MODE"
N="$(new_ready "Resume unsafe" "deliver a helper")"
run_tick >/dev/null
[ "$(st "$N")" = "paused" ] && ok "#$N paused at the cap" || fail "status=$(st "$N")"
WT="$(wg ticket paused-context "$N" | jget 'd.context.worktree_path')"
BR="$(branch_of "$N")"
PARTIAL="$(cd "$WT" 2>/dev/null && ls src/partial-*.js 2>/dev/null | head -1)"
[ -n "$PARTIAL" ] && ok "the paused delivery left its partial file ($PARTIAL)" || fail "no partial file in $WT"
# Work that is certainly UNCOMMITTED (the pause may have committed the agent's own edit).
UNC="src/uncommitted-work.js"; printf 'export const kept = 1;\n' > "$WT/$UNC"
[ -n "$(git -C "$WT" status --porcelain -- "$UNC")" ] && ok "the preserved worktree holds uncommitted work ($UNC)" || fail "$UNC is not uncommitted"
mkdir -p "$WORK/outside"; SENT="$WORK/outside/operator-notes.md"
printf '# operator notes, do not touch\n' > "$SENT"; cp "$SENT" "$SENT.orig"
rm -f "$WT/CLAUDE.factory.md"; ln -s "$SENT" "$WT/CLAUDE.factory.md"

echo "== Continue: the resume is refused and goes back to paused, nothing lost =="
wg ticket continue "$N" >/dev/null 2>&1; rm -f "$GAFFER_DATA/.failed-tickets"
echo deliver > "$MODE"
D0="$(deliveries)"
OUT="$(run_tick)"
[ "$(deliveries)" = "$D0" ] && ok "no agent was launched ($OUT)" || fail "$(( $(deliveries) - D0 )) delivery call(s) made"
cmp -s "$SENT" "$SENT.orig" && ok "the outside file is byte-identical" || fail "the outside file changed"
[ "$(st "$N")" = "paused" ] && ok "#$N is back to paused (Continue, not a fresh claim that clears the worktree)" \
  || fail "#$N is '$(st "$N")': $(grep -E 'SAFETY|RESUME' "$GAFFER_DATA/factory.log" | tail -3 | tr '\n' '|')"
[ -d "$WT" ] && [ -f "$WT/$UNC" ] && [ -f "$WT/$PARTIAL" ] && ok "the preserved worktree and its uncommitted work survive" || fail "worktree, $UNC or $PARTIAL gone"
[ -n "$BR" ] && git -C "$R" rev-parse --verify --quiet "refs/heads/$BR" >/dev/null && ok "the branch $BR survives" || fail "branch '$BR' gone"
[ "$(wg ticket paused-context "$N" | jget 'd.context.worktree_path || ""')" = "$WT" ] && ok "the resume context still names the worktree" || fail "resume context lost"
TRAIL="$(wg ticket show "$N" 2>/dev/null | tr '\n' ' ')"
case "$TRAIL" in *unsafe_worktree_path*CLAUDE.factory.md*) ok "the ticket names the refused link" ;; *) fail "no unsafe_worktree_path reason on #$N" ;; esac
grep -qF "$WT" <<<"$TRAIL" && ok "the ticket says where the work is ($WT)" || fail "the ticket does not name $WT"

echo "== the link removed, Continue resumes in the SAME worktree =="
rm -f "$WT/CLAUDE.factory.md"
wg ticket continue "$N" >/dev/null 2>&1; rm -f "$GAFFER_DATA/.failed-tickets" "$GAFFER_DATA"/.skip* 2>/dev/null
REUSE0="$(grep -c "RESUME: reusing preserved worktree for repo .* at $WT" "$GAFFER_DATA/factory.log")"
run_tick >/dev/null
[ "$(grep -c "RESUME: reusing preserved worktree for repo .* at $WT" "$GAFFER_DATA/factory.log")" -gt "$REUSE0" ] && ok "the next tick resumed in the same worktree" || fail "no reuse of $WT"
[ "$(st "$N")" = "in_review" ] && ok "the resumed delivery reached in_review" || fail "status after resume=$(st "$N")"
git -C "$R" show "$BR:$UNC" >/dev/null 2>&1 && ok "the uncommitted work reached the branch" || fail "$UNC is not on $BR"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
