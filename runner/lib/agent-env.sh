#!/usr/bin/env bash
# shellcheck shell=bash
# =====================================================================
# Agent-environment helpers shared by EVERY spawn site (delivery, rework
# re-install, reviewer, clarify). Sourced by factory.config.sh.
#
# Two things every worktree the agent runs in needs, written ONE way:
#
#   gaffer_write_agent_settings <dir>
#       Render runner/claude/settings.json into <dir>/.claude/settings.json and
#       VERIFY the wiring: the file must name "PreToolUse" and the resolved
#       runner/safety-hook.mjs path. A half-written or unwired file is removed
#       and the function returns 1 — callers fail CLOSED (never launch an agent
#       whose deterministic containment boundary is not wired). Previously only
#       the delivery site verified; the reviewer and clarify sites wrote the file
#       blind, so a bad template or a full disk could launch them uncontained.
#
#   gaffer_link_node_modules <repo-path> <worktree>
#       Symlink the real checkout's node_modules (root AND each sub-package's, to
#       depth 3) into a fresh worktree so `pnpm test` / `vitest` / `tsc` resolve
#       there. node_modules is gitignored, lives only in the main checkout, and
#       installs are hook-blocked in the agent's worktree. Existing paths in the
#       worktree are never clobbered. No-op for non-JS repos.
# =====================================================================

gaffer_write_agent_settings() {
  local dir="$1"
  [ -n "$dir" ] || return 1
  local target="$dir/.claude/settings.json"
  mkdir -p "$dir/.claude" 2>/dev/null || true
  if ! sed "s#\${RUNNER_DIR}#$(_gaffer_sed_repl "$RUNNER_DIR")#g" "$CLAUDE_SETTINGS" > "$target" 2>/dev/null; then
    rm -f "$target"   # never leave a truncated half-write behind
    _agent_env_log "SAFETY: could not write $target from $CLAUDE_SETTINGS (fail closed)"
    return 1
  fi
  # Verify the WIRING, not just the write: the settings the agent will load must
  # reference the resolved hook path as a PreToolUse hook.
  if ! grep -q '"PreToolUse"' "$target" 2>/dev/null \
     || ! grep -qF "$RUNNER_DIR/safety-hook.mjs" "$target" 2>/dev/null; then
    rm -f "$target"   # an unwired settings file must not survive
    _agent_env_log "SAFETY: $target lacks the PreToolUse safety-hook wiring (fail closed)"
    return 1
  fi
  return 0
}

# gaffer_install_agent_dir <dir> <skills-csv> <mount-tag>
#   The ONE agent-directory installer every spawn site uses: mount the skill subset,
#   render + VERIFY .claude/settings.json, trust the workspace (so the allowlist is
#   honoured headless), and install the CLAUDE.factory.md brief. Any failure returns
#   1 so the caller refuses the run (fail closed). The reviewer and clarify sites
#   previously copied the brief unguarded — a failed copy launched an agent with no
#   brief; now it refuses like the delivery site.
gaffer_install_agent_dir() {
  local dir="$1" skills="$2" tag="$3"
  [ -n "$dir" ] || return 1
  gaffer_skills_mount "$dir" "$skills" "$tag"
  gaffer_write_agent_settings "$dir" || return 1
  gaffer_trust_workspace "$dir"
  local brief="${HERE:-$RUNNER_DIR}/claude/CLAUDE.md"
  if ! cp -f "$brief" "$dir/CLAUDE.factory.md" 2>/dev/null; then
    rm -f "$dir/CLAUDE.factory.md"
    _agent_env_log "SAFETY: could not install the CLAUDE.factory.md brief into $dir (fail closed)"
    return 1
  fi
  return 0
}

gaffer_link_node_modules() {
  local rpath="$1" rwt="$2" _nm _rel
  [ -n "$rpath" ] && [ -n "$rwt" ] && [ -d "$rpath" ] && [ -d "$rwt" ] || return 0
  [ -e "$rpath/node_modules" ] && [ ! -e "$rwt/node_modules" ] && ln -sfn "$rpath/node_modules" "$rwt/node_modules"
  # Workspaces (pnpm/yarn/npm monorepos) keep test/build binaries in PER-PACKAGE
  # node_modules/.bin, not the root — so also link each sub-package's node_modules,
  # or `vitest`/`tsc` are unresolvable in the worktree and the DoD gate fails to RUN.
  while IFS= read -r _nm; do
    _rel="${_nm#"$rpath"/}"
    [ "$_rel" = "node_modules" ] && continue
    [ -e "$rwt/$_rel" ] && continue
    mkdir -p "$(dirname "$rwt/$_rel")" 2>/dev/null && ln -sfn "$_nm" "$rwt/$_rel"
  done < <(find "$rpath" -maxdepth 3 -name node_modules -type d 2>/dev/null)
  return 0
}

# Log through the caller's `log` when one is defined (tick.sh / review / clarify),
# else stderr — the helpers must work in the extracted-function test harnesses too.
_agent_env_log() {
  if declare -F log >/dev/null 2>&1; then log "$@"; else printf 'gaffer: %s\n' "$*" >&2; fi
}
