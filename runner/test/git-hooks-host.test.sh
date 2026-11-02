#!/usr/bin/env bash
# =====================================================================
# External review #9, finding 2: a repository's git hooks never run on the host during
# the runner's own bookkeeping.
# ---------------------------------------------------------------------
# With a tracked, relative core.hooksPath (husky, .githooks), an agent could rewrite a
# hook script and stop without committing; the runner's auto-commit then ran
# `git commit` on the host and executed the edited hook outside every sandbox. Every git
# command the runner runs for bookkeeping now carries core.hooksPath=/dev/null and
# core.fsmonitor=false (lib/git-safe.sh, exported through GIT_CONFIG_COUNT), and any
# code-running key that points into the repository is neutralised.
# Driven through the REAL tick.sh with a stub agent (lib/stub-tick.sh, mode hook-edit):
#   H1. the fixture hook really runs for a plain `git commit` (the test can see it)
#   H2. a tick whose agent rewrote the hooks and left the change uncommitted: the
#       runner auto-commits it, and no hook (the operator's or the agent's) ran
#   H3. landing the approved branch (bin/merge-ticket.mjs, a host merge) runs no hook
# Run: bash runner/test/git-hooks-host.test.sh
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

# A host with no git identity (the GitHub ubuntu runners): the delivery auto-commit in tick.sh
# must pin its own, or an uncommitted delivery is parked as empty.
export GIT_CONFIG_GLOBAL=/dev/null

STUB_TICK_NAME=git-hooks-host
# shellcheck source=lib/stub-tick.sh
source "$HERE/lib/stub-tick.sh"

# The operator's repository runs hooks from a TRACKED directory (core.hooksPath is
# relative): every hook drops a line in $WORK/hook-ran.
mkdir -p "$R/.githooks"
for h in pre-commit prepare-commit-msg commit-msg post-commit post-checkout post-merge \
         pre-merge-commit pre-push post-rewrite reference-transaction pre-auto-gc; do
  printf '#!/bin/sh\necho "%s" >> "%s/hook-ran"\n' "$h" "$WORK" > "$R/.githooks/$h"
  chmod +x "$R/.githooks/$h"
done
git -C "$R" add -A && git -C "$R" -c user.email=t@t -c user.name=t commit -qm "tracked hooks"
git -C "$R" config core.hooksPath .githooks

echo "== H1. the fixture's hook runs for a plain git commit =="
( cd "$R" && env -u GIT_CONFIG_COUNT git -c user.email=t@t -c user.name=t commit -q --allow-empty -m probe )
[ -s "$WORK/hook-ran" ] && ok "H1: a plain commit ran the tracked hook (the fixture is live)" || fail "H1: the fixture hook did not run"
rm -f "$WORK/hook-ran"

echo "== H2. an agent rewrote the hooks and did not commit: the auto-commit runs none =="
echo hook-edit > "$MODE"
T="$(new_ready "Hook edit" "deliver a helper")"
run_tick >/dev/null
B="$(branch_of "$T")"
[ -n "$B" ] && [ "$(commits_on "$B")" != "BRANCH-GONE" ] && [ "$(commits_on "$B")" -ge 1 ] \
  && ok "H2: the runner auto-committed the agent's edits on $B" || fail "H2: no auto-commit (branch '$B', status $(st "$T"))"
grep -q "^deliver #$T" <<<"$(git -C "$R" log -1 --format=%s "$B" 2>/dev/null)" && ok "H2: the commit is the runner's auto-commit" || fail "H2: tip is '$(git -C "$R" log -1 --format=%s "$B" 2>/dev/null)'"
[ ! -e "$WORK/hook-pwned" ] && ok "H2: the agent's edited hook never ran on the host" || fail "H2: the edited hook ran: $(tr '\n' ' ' < "$WORK/hook-pwned")"
[ ! -e "$WORK/hook-ran" ] && ok "H2: no repository hook ran during the tick" || fail "H2: hooks ran during the tick: $(tr '\n' ' ' < "$WORK/hook-ran")"

echo "== H3. landing the approved branch runs no hook =="
if [ "$(st "$T")" = "in_review" ]; then
  wg review approve "$T" $(wg ticket diff "$T" --heads 2>/dev/null | sed 's/^/--commit /' | tr '\n' ' ') --reviewer human1 >/dev/null 2>&1
  node "$RUNNER_DIR/bin/merge-ticket.mjs" --ticket "$T" >"$WORK/merge.json" 2>"$WORK/merge.err" || true
  [ "$(st "$T")" = "done" ] && ok "H3: #$T landed through merge-ticket.mjs" || fail "H3: status $(st "$T") after merge-ticket: $(tail -3 "$WORK/merge.err" | tr '\n' '|' | cut -c1-300)"
  [ ! -e "$WORK/hook-pwned" ] && ok "H3: the edited hook did not run during landing" || fail "H3: the edited hook ran during landing: $(tr '\n' ' ' < "$WORK/hook-pwned")"
  [ ! -e "$WORK/hook-ran" ] && ok "H3: no repository hook ran during landing" || fail "H3: hooks ran during landing: $(tr '\n' ' ' < "$WORK/hook-ran")"
else
  fail "H3: #$T is $(st "$T"), not in_review (cannot land)"
fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS: $PASS checks"; exit 0; fi
echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"; exit 1
