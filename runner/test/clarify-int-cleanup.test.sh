#!/usr/bin/env bash
# =====================================================================
# B-H1 — Ctrl-C DURING a clarify run must not leak runner config into the
#         contributor's REAL repo.
# ---------------------------------------------------------------------
# The clarify pass injects CLAUDE.factory.md / .claude/settings.json /
# .claude/skills DIRECTLY into the registered repo (clarify is read-only, so it
# runs in place — there is NO throwaway worktree whose teardown would take the
# residue with it). _clarify_cleanup is the ONLY thing that removes that residue.
#
# The bug: the clarify block installed a cleanup on EXIT ONLY. On a real Ctrl-C the
# GLOBAL INT handler (gaffer_on_signal) fires — and its FIRST act is `trap - EXIT`,
# which DISARMS the clarify EXIT cleanup — then it runs gaffer_crash_cleanup, which
# knows nothing about the injected config. Result: CLAUDE.factory.md / .claude/…
# were left behind in the contributor's real repo after an interrupted clarify.
#
# The fix (mirroring the reviewer block) installs EXIT *and* INT *and* TERM traps
# that each run _clarify_cleanup before chaining the crash cleanup. This test drives
# the REAL _gaffer_clarify_pass from lib/clarify.sh, simulates a Ctrl-C arriving
# mid-agent (a stub worker_deliver raises SIGINT), and asserts the repo is clean.
#
# Hermetic: stubs every collaborator; never invokes claude/git/wg for real.
# Run: bash runner/test/clarify-int-cleanup.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_RUNNER="$(cd "$HERE/.." && pwd)"   # where the real lib/clarify.sh lives

command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required"; exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/clarify-int.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

# ── Fixtures ─────────────────────────────────────────────────────────────────
export GAFFER_DATA="$WORK/data";  mkdir -p "$GAFFER_DATA"
export GAFFER_LOG="$GAFFER_DATA/factory.log"; : > "$GAFFER_LOG"
CREPO="$WORK/real-repo";          mkdir -p "$CREPO"
# The runner "environment" files the clarify pass templates from.
FAKE_RUNNER="$WORK/runner"; mkdir -p "$FAKE_RUNNER/claude"
: > "$FAKE_RUNNER/safety-hook.mjs"
printf '{"settings":"${RUNNER_DIR}"}\n' > "$FAKE_RUNNER/settings.tmpl.json"
printf '{"mcp":"${DISPATCH_DB}"}\n'      > "$FAKE_RUNNER/mcp.tmpl.json"
printf '# brief\n'                        > "$FAKE_RUNNER/claude/CLAUDE.md"

# Globals the clarify body reads (normally provided by tick.sh at call time).
export CLARIFY_DRAFTS_WHEN_IDLE=1
export DRY_RUN=0
export HERE="$FAKE_RUNNER"
export CLAUDE_SETTINGS="$FAKE_RUNNER/settings.tmpl.json"
export MCP_CONFIG="$FAKE_RUNNER/mcp.tmpl.json"
export DISPATCH_DB="$WORK/dispatch.db" MEMORY_DB="$WORK/memory.db"
export DISPATCH_MCP_BIN="/bin/true" MEMORY_MCP_BIN="/bin/true"
export CLAIM_TOKEN=""
export GAFFER_PLAN_MODEL_FLAG="--model opus"
export RUNNER_DIR="$FAKE_RUNNER"   # clarify checks "$RUNNER_DIR/safety-hook.mjs"

# ── Stub collaborators ───────────────────────────────────────────────────────
log()   { printf '%s\n' "$*" >> "$GAFFER_LOG"; }
result(){ printf 'TICK_RESULT=%s\n' "$1" >> "$GAFFER_LOG"; }
jget()  { python3 -c "import sys,json; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
wg() {
  case "$*" in
    "ticket list -s draft") printf '[{"number":42,"title":"Ambiguous draft"}]' ;;
    "ticket show 42") printf '{"ticket":{"title":"Ambiguous draft","description":"d"},"repositories":[{"local_path":"%s"}]}' "$CREPO" ;;
    *) printf '{}' ;;
  esac
}
_gaffer_sed_repl() { printf '%s' "$1" | sed -e 's/[\\&#]/\\&/g'; }
gaffer_trust_workspace() { :; }
gaffer_assert_db_vars()  { return 0; }
gaffer_prime_context_block() { printf ''; }
gaffer_usage_record() { :; }
_gaffer_locked() { shift; "$@"; }
_gaffer_append_line() { printf '%s\n' "$2" >> "$1"; }
# The real skills mount would create $CREPO/.claude/skills; reproduce that so the
# cleanup has the exact residue to remove.
gaffer_skills_mount() { mkdir -p "$CREPO/.claude"; ln -sfn "$WORK/mount-$3" "$CREPO/.claude/skills"; }
gaffer_skills_mount_cleanup() { :; }
# gaffer_crash_cleanup does NOT know about the injected clarify config (this models
# reality — it only handles worktrees/claims/skill mounts). If the fix is absent,
# nothing removes the clarify residue and the repo leaks.
gaffer_crash_cleanup() { :; }
# The GLOBAL signal/exit handlers, exactly as tick.sh installs them at top level.
gaffer_on_exit()   { local rc=$?; trap - EXIT INT TERM; gaffer_crash_cleanup; exit "$rc"; }
gaffer_on_signal() { trap - EXIT INT TERM; gaffer_crash_cleanup; exit "$1"; }

# The interrupted agent: raise SIGINT at the subshell running the clarify pass,
# exactly as a contributor's Ctrl-C would mid-run.
# $BASHPID (the current subshell's PID) is bash 4+; macOS /bin/bash is 3.2. Fall back
# to a portable self-PID — `exec sh` replaces the command-substitution subshell so its
# $PPID is this shell — which resolves to the same PID BASHPID would give here.
worker_deliver() { kill -INT "${BASHPID:-$(exec sh -c 'echo $PPID')}"; sleep 5; return 0; }

# shellcheck source=../lib/clarify.sh
source "$REAL_RUNNER/lib/clarify.sh"

echo "== B-H1: SIGINT during clarify fires _clarify_cleanup (repo left clean) =="
# Run the clarify pass in a subshell with the GLOBAL traps armed FIRST (mirrors
# tick.sh). The clarify pass overrides INT/TERM with its own cleanup-first handlers;
# the stub worker raises SIGINT, which must route through the clarify INT handler.
(
  trap gaffer_on_exit EXIT
  trap 'gaffer_on_signal 130' INT
  trap 'gaffer_on_signal 143' TERM
  _gaffer_clarify_pass
)
rc=$?

[ "$rc" = "130" ] \
  && ok "interrupted clarify exited 130 (SIGINT), not a normal 0" \
  || fail "expected exit 130 from the interrupted clarify, got $rc"

[ ! -e "$CREPO/CLAUDE.factory.md" ] \
  && ok "CLAUDE.factory.md removed from the real repo after Ctrl-C" \
  || fail "LEAK: CLAUDE.factory.md left in the real repo after Ctrl-C"
[ ! -e "$CREPO/.claude/settings.json" ] \
  && ok ".claude/settings.json removed from the real repo after Ctrl-C" \
  || fail "LEAK: .claude/settings.json left in the real repo after Ctrl-C"
[ ! -e "$CREPO/.claude/skills" ] \
  && ok ".claude/skills symlink removed from the real repo after Ctrl-C" \
  || fail "LEAK: .claude/skills left in the real repo after Ctrl-C"
[ ! -d "$CREPO/.claude" ] \
  && ok "empty .claude/ dir removed from the real repo after Ctrl-C" \
  || fail "LEAK: .claude/ dir left in the real repo after Ctrl-C"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS ($PASS checks)"; exit 0
else
  printf 'FAILED (%d of %d):\n' "${#FAILURES[@]}" "$((PASS + ${#FAILURES[@]}))"
  printf '  - %s\n' "${FAILURES[@]}"; exit 1
fi
