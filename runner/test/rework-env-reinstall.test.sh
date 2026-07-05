#!/usr/bin/env bash
# =====================================================================
# REWORK RETRY — the agent environment must be RE-INSTALLED per attempt.
# ---------------------------------------------------------------------
# THE GAP (pre-merge containment): on a delivery REWORK attempt ≥2 the retry
# loop tears the worktree down (_recover_or_park → gaffer_cleanup_worktrees)
# and re-adds a FRESH checkout of the preserved branch — but the agent-env
# install that attempt 1 got happened ONCE, before the loop. Everything it
# wrote is untracked + git-excluded, so the fresh checkout contains NONE of:
#   • .claude/settings.json — which wires runner/safety-hook.mjs as the
#     PreToolUse hook, THE deterministic containment boundary;
#   • the .claude/skills mount;
#   • CLAUDE.factory.md (the agent brief);
#   • the per-worktree git exclude (its admin dir died with the worktree).
# Consequence: attempt ≥2's `claude -p` would run WITHOUT the safety hook.
#
# This test drives the REAL retry path (the worktree re-add block extracted
# verbatim from tick.sh, plus tick.sh's real teardown + install helpers and
# the real skills-mount/hygiene libs) through a forced attempt-2 and asserts
# the attempt-2 worktree HAS the full agent environment. It FAILS before the
# fix (nothing re-installs) and PASSES after (per-attempt install, fail-closed).
#
# Zero deps beyond git + sed/awk. Run: bash runner/test/rework-env-reinstall.test.sh
# =====================================================================
set -uo pipefail
TEST_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$TEST_HERE/.." && pwd)"
TICK="$RUNNER_DIR/tick.sh"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
[ -f "$TICK" ] || { echo "SKIP: tick.sh not found"; exit 0; }

# Extract a bash function body from a source file by name + closing-brace indent
# (same harness as rework-escalation.test.sh — real source, never a copy).
extract_fn() {
  awk -v name="$2" -v endln="$3" '
    $0 ~ ("^[[:space:]]*" name "\\(\\) \\{") { grab=1 }
    grab { print }
    grab && $0 == endln { exit }
  ' "$1"
}

# Extract tick.sh's retry worktree re-add block VERBATIM: from its sentinel
# comment to the closing `fi` of the `[ "$_DELIV_ATTEMPT" -gt 1 ]` guard.
extract_retry_block() {
  awk '
    /# On a retry the prior worktree was torn down/ { grab=1 }
    grab { print }
    grab && $0 == "  fi" { exit }
  ' "$TICK"
}

# ── Real helper libs (the ones tick.sh sources) ──────────────────────────────
# shellcheck source=../lib/skills-mount.sh
source "$RUNNER_DIR/lib/skills-mount.sh"
# shellcheck source=../lib/hygiene.sh
source "$RUNNER_DIR/lib/hygiene.sh"
# B-M1: gaffer_install_agent_env now escapes sed replacements via _gaffer_sed_repl
# (defined in factory.config.sh, which tick.sh sources before this helper runs). We
# extract the helper VERBATIM here without sourcing the whole config, so provide the
# same pure helper (identical to factory.config.sh's definition).
_gaffer_sed_repl() { printf '%s' "$1" | sed -e 's/[\\&#]/\\&/g'; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/rework-env.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

# ── Fixture: a real repo, ticket branch, single-row WT_ROWS (tick.sh shape) ──
REPO="$WORK/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" config user.email t@e && git -C "$REPO" config user.name t
echo seed > "$REPO/seed.txt"; git -C "$REPO" add -A; git -C "$REPO" commit -qm seed
BASE="$(git -C "$REPO" rev-parse --abbrev-ref HEAD)"

export GAFFER_DATA="$WORK/data"; mkdir -p "$GAFFER_DATA"
WORK_BRANCH="gaffer/ticket-77-env-reinstall"
WORKTREES_BASE="$WORK/wts"
WT="$WORKTREES_BASE/wt"
WT_ROWS=$(printf '%s\t%s\t%s\t%s\t%s' "rid1" "demo" "$REPO" "$BASE" "$WT")

# tick.sh globals the extracted code reads.
HERE="$RUNNER_DIR"                                  # tick.sh's HERE == runner dir
NUM=77
PRIMARY_REPO="$WT"
SKILLS="run-tests"; LENSES=""
SKILLS_DIR="$RUNNER_DIR/skills"
CLAUDE_SETTINGS="$RUNNER_DIR/claude/settings.json"
_DELIV_ATTEMPT=2
_MAX_DELIVERY_ATTEMPTS=3
_DELIV_OUTCOME=""

# Stubs: control-plane + logging are out of scope; _recover_or_park must NOT be
# reached on the happy path. The stub drops a marker file (the retry block runs
# in a SUBSHELL below — tick.sh's fail-closed path may `exit`, which must never
# kill this harness) so the outcome is assertable afterwards.
RECOVER_MARK="$WORK/recover-called"
log() { :; }
wg()  { return 0; }
result() { :; }
gaffer_skip_ticket() { :; }
_recover_or_park() { printf '%s' "$1" > "$RECOVER_MARK"; _DELIV_OUTCOME="parked"; return 0; }
# gaffer_install_agent_env now asserts the safety hook first (real tick.sh gate). Stub it to
# the pass path — the hook + deny-list exist in the real $RUNNER_DIR this test points at, and
# the assertion has its own coverage (safety-hook.test.mjs); this test is about env-reinstall
# idempotency, so the precondition check is orthogonal.
gaffer_assert_safety_hook() { return 0; }

# Run tick.sh's verbatim retry block in a subshell. A `for` wrapper absorbs the
# fail-closed `continue`; the subshell absorbs its `exit`.
run_retry_block() { ( for _once in 1; do eval "$RETRY_SRC"; done ); }

# tick.sh's real teardown + (post-fix) install helpers, extracted verbatim.
CLEANUP_SRC="$(extract_fn "$TICK" "gaffer_cleanup_worktrees" "  }")"
[ -n "$CLEANUP_SRC" ] && ok "extracted gaffer_cleanup_worktrees from tick.sh (real source)" \
  || fail "could not extract gaffer_cleanup_worktrees from tick.sh"
eval "$CLEANUP_SRC"
INSTALL_SRC="$(extract_fn "$TICK" "gaffer_install_agent_env" "  }")"
[ -n "$INSTALL_SRC" ] && eval "$INSTALL_SRC"

RETRY_SRC="$(extract_retry_block)"
printf '%s' "$RETRY_SRC" | grep -q 'worktree add' \
  && ok "extracted the retry worktree re-add block from tick.sh (real source)" \
  || fail "could not extract the retry re-add block from tick.sh"

env_installed() {  # $1 = worktree, $2 = label prefix
  local wt="$1" tag="$2" s="$1/.claude/settings.json"
  [ -f "$s" ] \
    && ok "$tag: .claude/settings.json present" \
    || fail "$tag: .claude/settings.json MISSING — agent would run with NO project-local config"
  grep -qs '"PreToolUse"' "$s" && grep -qs "$RUNNER_DIR/safety-hook.mjs" "$s" \
    && ok "$tag: settings wire $RUNNER_DIR/safety-hook.mjs as the PreToolUse hook" \
    || fail "$tag: settings do NOT wire safety-hook.mjs as PreToolUse — agent would run UNCONTAINED"
  [ -e "$wt/.claude/skills" ] \
    && ok "$tag: .claude/skills mount present" \
    || fail "$tag: .claude/skills mount MISSING"
  [ -f "$wt/CLAUDE.factory.md" ] \
    && ok "$tag: CLAUDE.factory.md brief present" \
    || fail "$tag: CLAUDE.factory.md brief MISSING"
  local excl; excl="$(git -C "$wt" rev-parse --git-path info/exclude 2>/dev/null)"
  [ -n "$excl" ] && grep -qsxF '.claude/' "$excl" \
    && ok "$tag: git exclude keeps runner config off the delivery branch" \
    || fail "$tag: git exclude for runner config MISSING (a git add -A would stage it)"
}

echo "== 1. attempt 1: worktree + agent-env install (as tick.sh does pre-loop) =="
mkdir -p "$WORKTREES_BASE"
git -C "$REPO" worktree add -B "$WORK_BRANCH" "$WT" "$BASE" >/dev/null 2>&1
if [ -n "$INSTALL_SRC" ]; then
  # Post-fix: the ONE install helper tick.sh calls before every launch.
  gaffer_install_agent_env && ok "attempt 1: gaffer_install_agent_env succeeded" \
    || fail "attempt 1: gaffer_install_agent_env failed on a healthy worktree"
else
  # Pre-fix: replicate tick.sh's inline attempt-1 install verbatim.
  gaffer_skills_mount "$PRIMARY_REPO" "$SKILLS, $LENSES" "delivery-$NUM"
  sed "s#\${RUNNER_DIR}#$RUNNER_DIR#g" "$CLAUDE_SETTINGS" > "$PRIMARY_REPO/.claude/settings.json"
  cp -f "$HERE/claude/CLAUDE.md" "$PRIMARY_REPO/CLAUDE.factory.md"
  gaffer_exclude_runner_config "$PRIMARY_REPO"
fi
env_installed "$WT" "attempt 1 (sanity)"

echo "== 2. recoverable gate failure: commit work, tear the worktree down =="
echo work > "$WT/feature.txt"; git -C "$WT" add feature.txt; git -C "$WT" commit -qm "deliver #77"
gaffer_cleanup_worktrees   # the _recover_or_park retry action: worktree gone, branch preserved
[ ! -e "$WT" ] && ok "retry teardown removed the worktree (runner config died with it)" \
  || fail "teardown left the worktree behind"
git -C "$REPO" show-ref --verify --quiet "refs/heads/$WORK_BRANCH" \
  && ok "branch preserved for rework (GUARD B invariant)" \
  || fail "teardown dropped the committed branch"

echo "== 3. attempt 2: the REAL retry path must re-install the agent env =="
rm -f "$RECOVER_MARK"
run_retry_block
[ -e "$WT" ] && ok "retry re-added the fresh worktree on branch $WORK_BRANCH" \
  || fail "retry block did not re-add the worktree"
[ "$(git -C "$WT" rev-parse --abbrev-ref HEAD 2>/dev/null)" = "$WORK_BRANCH" ] \
  && ok "attempt-2 worktree is on the preserved ticket branch" \
  || fail "attempt-2 worktree is not on $WORK_BRANCH"
[ -e "$RECOVER_MARK" ] \
  && fail "retry path fail-closed on a HEALTHY env ($(cat "$RECOVER_MARK")) — should only trip on install failure" \
  || ok "healthy install: the retry path did not spuriously fail closed"
env_installed "$WT" "attempt 2 (THE GAP)"

echo "== 4. fail-closed: an install failure must NOT launch the agent =="
if [ -n "$INSTALL_SRC" ]; then
  # Break the install (settings template gone) and re-run the retry path: it must
  # route through _recover_or_park (attempt failure), NEVER fall through to launch.
  gaffer_cleanup_worktrees
  rm -f "$RECOVER_MARK"
  CLAUDE_SETTINGS="$WORK/nonexistent-settings.json"
  run_retry_block
  [ -e "$RECOVER_MARK" ] \
    && ok "install failure → _recover_or_park '$(cat "$RECOVER_MARK")' (attempt failure; agent NOT launched)" \
    || fail "install failure did NOT fail closed (no _recover_or_park call)"
  [ -f "$WT/.claude/settings.json" ] \
    && fail "broken install still produced a settings.json (verification is not real)" \
    || ok "no settings.json written from the broken template (verification is real)"
  CLAUDE_SETTINGS="$RUNNER_DIR/claude/settings.json"
else
  fail "gaffer_install_agent_env missing from tick.sh — no per-attempt install to fail closed"
fi

echo "== 5. static guards against the REAL tick.sh (never weaken) =="
# Attempt-1's fail-closed hook-presence guard must survive the refactor.
grep -q 'refusing live run (fail closed)' "$TICK" \
  && ok "tick.sh still refuses a live run when safety-hook.mjs is missing" \
  || fail "tick.sh lost the fail-closed hook-presence guard"
# The retry block itself must call the installer (per-attempt, not pre-loop only).
printf '%s' "$RETRY_SRC" | grep -q 'gaffer_install_agent_env' \
  && ok "the retry path re-installs the agent env for every attempt" \
  || fail "the retry path does NOT re-install the agent env (attempt ≥2 runs without the safety hook)"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
