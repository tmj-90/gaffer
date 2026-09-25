#!/usr/bin/env bash
# lib/agent-env.sh — the ONE verified settings.json writer and the worktree
# node_modules linker every spawn site uses (delivery, rework, reviewer, clarify).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok   $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }

_gaffer_sed_repl() { printf '%s' "$1" | sed -e 's/[\\&#]/\\&/g'; }
# shellcheck source=../lib/agent-env.sh
source "$RUNNER_DIR/lib/agent-env.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/agent-env.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT

echo "== 1: settings.json is rendered from the real template and verified wired =="
CLAUDE_SETTINGS="$RUNNER_DIR/claude/settings.json"
WT="$WORK/wt"; mkdir -p "$WT"
if gaffer_write_agent_settings "$WT"; then ok "returns 0 with the real template"; else fail "real template refused"; fi
[ -f "$WT/.claude/settings.json" ] && ok ".claude/settings.json written (dir created)" || fail "settings.json missing"
grep -qF "$RUNNER_DIR/safety-hook.mjs" "$WT/.claude/settings.json" && ok "\${RUNNER_DIR} substituted with the resolved hook path" || fail "hook path not substituted"
! grep -q '\${RUNNER_DIR}' "$WT/.claude/settings.json" && ok "no placeholder leaks" || fail "placeholder leaked"

echo "== 2: an UNWIRED template fails closed and leaves no file =="
CLAUDE_SETTINGS="$WORK/unwired.json"; printf '{"hooks":{}}\n' > "$CLAUDE_SETTINGS"
WT2="$WORK/wt2"; mkdir -p "$WT2/.claude"
if gaffer_write_agent_settings "$WT2" 2>/dev/null; then fail "unwired template accepted"; else ok "returns 1 for a template without PreToolUse wiring"; fi
[ ! -e "$WT2/.claude/settings.json" ] && ok "unwired settings.json removed (agent cannot load it)" || fail "unwired file survived"

echo "== 3: a MISSING template fails closed =="
CLAUDE_SETTINGS="$WORK/does-not-exist.json"
if gaffer_write_agent_settings "$WORK/wt3" 2>/dev/null; then fail "missing template accepted"; else ok "returns 1 when the template is unreadable"; fi
[ ! -e "$WORK/wt3/.claude/settings.json" ] && ok "no half-written file" || fail "half-written file left"

echo "== 4: the log goes through the caller's log() when defined =="
LOGGED=""; log() { LOGGED="$*"; }
gaffer_write_agent_settings "$WORK/wt4" >/dev/null 2>&1 || true
case "$LOGGED" in *"fail closed"*) ok "caller log() received the SAFETY line" ;; *) fail "log() not used (got '$LOGGED')" ;; esac
unset -f log

echo "== 5: node_modules linker — root + nested, never clobbers, no-op elsewhere =="
REPO="$WORK/repo"; mkdir -p "$REPO/node_modules/.bin" "$REPO/packages/a/node_modules/.bin" "$REPO/packages/b/node_modules" "$REPO/deep/x/y/z/node_modules"
LWT="$WORK/lwt"; mkdir -p "$LWT/packages/b"; printf 'keep\n' > "$LWT/packages/b/node_modules"   # pre-existing path must survive
gaffer_link_node_modules "$REPO" "$LWT"
[ -L "$LWT/node_modules" ] && [ "$(readlink "$LWT/node_modules")" = "$REPO/node_modules" ] && ok "root node_modules linked to the real checkout" || fail "root link wrong"
[ -L "$LWT/packages/a/node_modules" ] && ok "nested package node_modules linked (parent dir created)" || fail "nested link missing"
[ -f "$LWT/packages/b/node_modules" ] && [ "$(cat "$LWT/packages/b/node_modules")" = "keep" ] && ok "existing worktree path NOT clobbered" || fail "existing path clobbered"
[ ! -e "$LWT/deep/x/y/z/node_modules" ] && ok "depth >3 nested node_modules not followed (matches the historical bound)" || fail "too-deep path linked"
gaffer_link_node_modules "$REPO" "$LWT" && ok "idempotent second call returns 0" || fail "second call failed"
PY="$WORK/py"; mkdir -p "$PY"; PWT="$WORK/pwt"; mkdir -p "$PWT"
gaffer_link_node_modules "$PY" "$PWT"; [ -z "$(ls -A "$PWT")" ] && ok "non-JS repo: nothing linked" || fail "non-JS repo got links"
gaffer_link_node_modules "" "$PWT" && ok "empty args are a no-op (rc 0)" || fail "empty args failed"

echo; [ "$FAIL" -eq 0 ] && echo "agent-env: ALL $PASS checks passed" || { echo "agent-env: $FAIL FAILED"; exit 1; }
