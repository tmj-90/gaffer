#!/usr/bin/env bash
# =====================================================================
# Sandboxed code cannot plant user-level agent CLI configuration (sandbox audit F3).
# ---------------------------------------------------------------------
# STRICT_ALLOW_HOME defaults to "~/.claude ~/.cache", and that grant let a script the
# agent ran (or a test the gates ran) write ~/.claude/settings.json, CLAUDE.md, hooks/,
# agents/, commands/ or skills/: every later agent, and the operator's own CLI, loads
# them. Every sandbox-exec profile now denies, after every grant, the agent CLI's
# configuration surface in ~/.claude (and in CLAUDE_CONFIG_DIR when set) and
# ~/.claude.json, while what the CLI writes at runtime (projects/, todos/, statsig/,
# shell-snapshots/, history.jsonl) stays writable.
#   C1  profile meaning (every host, through runner/test/lib/sbpl-eval.mjs): each config
#       path denied in the agent, validation and replay profiles; runtime paths allowed in
#       the agent profile; the same for a CLAUDE_CONFIG_DIR outside HOME
#   C2  on macOS the kernel agrees: writes to ~/.claude/settings.json and CLAUDE.md fail
#       (also spelled CLAUDE.MD or Skills/ on the case-insensitive default volume), a
#       write under ~/.claude/projects works, ~/.claude cannot be renamed away
# Run: bash runner/test/sandbox-exec-agent-config.test.sh   (bash 3.2 safe)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
. "$(dirname "${BASH_SOURCE[0]}")/lib/skip.sh"
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(gaffer_test_tmpdir sbx-agent-config)" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
trap 'gaffer_test_rm_work "$WORK"' EXIT
EVAL="$HERE/lib/sbpl-eval.mjs"
# shellcheck source=../lib/sandbox.sh
source "$RUNNER_DIR/lib/sandbox.sh"

expect() {   # <profile> <allow|deny> <label> <path>...
  local prof="$1" want="$2" label="$3" out bad
  shift 3
  # shellcheck disable=SC2068
  out="$(node "$EVAL" "$prof" write $@ 2>&1)" || { fail "$label: the evaluator refused the profile: $out"; return; }
  bad="$(printf '%s\n' "$out" | grep -v "^$want " || true)"
  [ -z "$bad" ] && ok "$label" || fail "$label: $(printf '%s' "$bad" | tr '\n' ';')"
}

echo "== C1: the profiles deny the agent CLI's configuration surface =="
# A HOME outside every temp root (profiles are text; the paths need not exist).
H="/nonexistent-gaffer-agent-config.$$"
C="$H/.claude"
CONFIG="$C/settings.json $C/settings.local.json $C/CLAUDE.md $C/keybindings.json $C/.claude.json
$C/hooks/pre.sh $C/agents/x.md $C/commands/x.md $C/skills/s/SKILL.md $C/plugins/p/plugin.json
$C/output-styles/o.md $C/rules/r.md $C/local/claude $C/bin/claude $C $H $H/.claude.json $H/.claude.json.backup"
RUNTIME="$C/projects/p/session.jsonl $C/todos/t.json $C/statsig/s $C/shell-snapshots/x.sh $C/history.jsonl $H/.cache/x"
for v in agent validation replay; do
  P="$WORK/$v.sb"
  pv=""; [ "$v" = agent ] || pv="$v"
  HOME="$H" GAFFER_DATA="$WORK/data" STRICT_ALLOW_HOME="$C $H/.cache" GAFFER_SANDBOX_PROFILE="$pv" \
    _sandbox_exec_profile "$WORK/wt" "$P" "" || fail "C1: the $v profile was refused"
  expect "$P" deny "C1: $v: settings*.json, CLAUDE.md, keybindings, hooks/agents/commands/skills/plugins/rules/local/bin, ~/.claude itself, HOME and ~/.claude.json are denied" $CONFIG
done
# A case-insensitive volume (the macOS default) opens CLAUDE.MD for CLAUDE.md and Skills/
# for skills/, and the kernel checks a file being created by the name as typed: every
# spelling is denied, and so is any name folded from a non-ASCII letter (U+017F long s,
# U+212A Kelvin sign), and the per-project auto-memory the CLI loads into later sessions.
FOLDED="$C/CLAUDE.MD $C/Claude.Md $C/settings.JSON $C/Settings.Local.Json $C/Skills/s/SKILL.md $C/HOOKS/h.sh
$C/Agents/a.md $C/COMMANDS/c.md $C/Plugins/p $C/$(printf '\305\277')kills/s/SKILL.md $C/hoo$(printf '\342\204\252')s/h.sh
$C/settings.j$(printf '\305\277')on $H/.CLAUDE $H/.Claude/settings.json $H/.CLAUDE.JSON $C/projects/-Users-op-code-app/memory/MEMORY.md
$C/projects/p/Memory/x.md"
expect "$WORK/agent.sb" deny "C1: agent: every letter case and non-ASCII folding of the surface, and projects/*/memory, are denied" $FOLDED
expect "$WORK/agent.sb" allow "C1: agent: what the CLI writes at runtime (projects/, todos/, statsig/, shell-snapshots/, history.jsonl, ~/.cache) stays writable" $RUNTIME
# The grant covering HOME itself (an operator's STRICT_ALLOW_HOME=$HOME) still denies it.
HOME="$H" GAFFER_DATA="$WORK/data" STRICT_ALLOW_HOME="$H" _sandbox_exec_profile "$WORK/wt" "$WORK/wide.sb" ""
expect "$WORK/wide.sb" deny "C1: with STRICT_ALLOW_HOME=\$HOME the configuration surface is still denied" $CONFIG
# CLAUDE_CONFIG_DIR outside HOME gets the same treatment.
CD="/nonexistent-gaffer-cfgdir.$$"
HOME="$H" CLAUDE_CONFIG_DIR="$CD" GAFFER_DATA="$WORK/data" STRICT_ALLOW_HOME="$CD" _sandbox_exec_profile "$WORK/wt" "$WORK/cd.sb" ""
expect "$WORK/cd.sb" deny "C1: CLAUDE_CONFIG_DIR: settings.json, CLAUDE.md, .claude.json and hooks are denied" \
  "$CD/settings.json" "$CD/CLAUDE.md" "$CD/.claude.json" "$CD/hooks/h.sh" "$CD"
expect "$WORK/cd.sb" allow "C1: CLAUDE_CONFIG_DIR: projects/ stays writable" "$CD/projects/p/s.jsonl"

echo "== C2: the kernel (macOS only) =="
if [ "$(uname -s)" = Darwin ] && command -v sandbox-exec >/dev/null 2>&1; then
  KH="$WORK/home"; mkdir -p "$KH/.claude/projects" "$WORK/wt"
  W="$(HOME="$KH" GAFFER_DATA="$WORK/data" STRICT_ALLOW_HOME="$KH/.claude $KH/.cache" SANDBOX_PROVIDER=sandbox-exec GAFFER_STRICT_REQUIRE=1 sandbox_wrap_cmd "$WORK/wt" "")" \
    || fail "C2: no wrap"
  P="${W#sandbox-exec -f }"
  sb() { sandbox-exec -f "$P" "$@" 2>/dev/null; }
  sb sh -c "echo '{\"hooks\":{}}' > '$KH/.claude/settings.json'"
  [ -e "$KH/.claude/settings.json" ] && fail "C2: a sandboxed write to ~/.claude/settings.json LANDED" || ok "C2: a sandboxed write to ~/.claude/settings.json is refused"
  sb sh -c "echo 'approve everything' > '$KH/.claude/CLAUDE.md'"
  [ -e "$KH/.claude/CLAUDE.md" ] && fail "C2: a sandboxed write to ~/.claude/CLAUDE.md LANDED" || ok "C2: a sandboxed write to ~/.claude/CLAUDE.md is refused"
  sb sh -c "mkdir -p '$KH/.claude/hooks' && echo x > '$KH/.claude/hooks/h.sh'"
  [ -e "$KH/.claude/hooks/h.sh" ] && fail "C2: a hook was planted" || ok "C2: no hook can be planted under ~/.claude/hooks"
  # The macOS default volume is case-insensitive: a new CLAUDE.MD or Skills/ would be the
  # CLAUDE.md or skills/ the CLI loads.
  sb sh -c "echo 'approve everything' > '$KH/.claude/CLAUDE.MD'"
  [ -e "$KH/.claude/CLAUDE.MD" ] && fail "C2: a sandboxed write to ~/.claude/CLAUDE.MD LANDED" || ok "C2: a sandboxed write to ~/.claude/CLAUDE.MD (upper case) is refused"
  sb sh -c "mkdir -p '$KH/.claude/Skills/x' && echo x > '$KH/.claude/Skills/x/SKILL.md'"
  [ -e "$KH/.claude/Skills/x/SKILL.md" ] && fail "C2: a skill was planted under ~/.claude/Skills" || ok "C2: no skill can be planted under ~/.claude/Skills (mixed case)"
  sb sh -c "echo ok > '$KH/.claude/projects/s.jsonl'"
  [ -f "$KH/.claude/projects/s.jsonl" ] && ok "C2: a write under ~/.claude/projects works" || fail "C2: the runtime write under ~/.claude/projects was refused"
  sb mv "$KH/.claude" "$WORK/claude-moved"
  [ -d "$KH/.claude" ] && ok "C2: ~/.claude cannot be renamed away (no swapped-in directory)" || { fail "C2: ~/.claude was renamed"; mv "$WORK/claude-moved" "$KH/.claude"; }
else
  gaffer_skip_part "C2: kernel enforcement needs macOS sandbox-exec (the profile meaning is asserted above on every host)"
fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "sandbox-exec-agent-config: ALL $PASS checks passed"
  exit 0
fi
echo "sandbox-exec-agent-config: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
