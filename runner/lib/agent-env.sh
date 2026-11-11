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
#       VERIFY it by the ONE rule lib/agent-settings.mjs applies for the Node writer
#       too: the rendered file parses as JSON and carries runner/safety-hook.mjs as a
#       PreToolUse command hook covering every tool the hook decides, each entry with
#       "onFailure": "block" and a timeout (Claude Code otherwise runs the tool on a
#       hook timeout). A refused file is removed and the function returns 1; callers
#       fail CLOSED (never launch an agent whose deterministic containment boundary is
#       not wired).
#
#   NO WRITE FOLLOWS A LINK. Every write this file (and skills-mount.sh) makes into a
#   directory a repository controls goes through lib/safe-write.mjs (gaffer_safe_fs):
#   a destination that is a symlink or not a regular file, or a parent below <dir> that
#   is a symlink or not a directory, is REFUSED (the write is made by a rename in the
#   checked real directory, never through a link; the cleanup rm never deletes
#   through one). The refusal sets _GAFFER_UNSAFE_PATH_ERROR (`unsafe_worktree_path:
#   <path> in <dir> is a symbolic link ...; replace it ...`) and returns 1; the launch
#   sites park the ticket with that reason (gaffer_park_unsafe_path).
#
#   gaffer_link_node_modules <repo-path> <worktree>
#       Symlink the real checkout's node_modules (root AND each sub-package's, to
#       depth 3) into a fresh worktree so `pnpm test` / `vitest` / `tsc` resolve
#       there. node_modules is gitignored, lives only in the main checkout, and
#       installs are hook-blocked in the agent's worktree. Existing paths in the
#       worktree are never clobbered, and a link whose parent in the worktree is a
#       symlink is skipped (logged): the link is a convenience, so it fails soft. No-op
#       for non-JS repos.
# =====================================================================

# gaffer_safe_fs <verb> <root> <rel> [arg]: lib/safe-write.mjs (write | mkdir | check |
# remove | symlink; see that file). Returns its status (non-zero without node: fail
# closed). On a refusal (exit 4) sets _GAFFER_UNSAFE_PATH_ERROR to the reason
# (`unsafe_worktree_path: ...`); any other failure's last stderr line goes to
# _GAFFER_SAFE_FS_ERROR. Logs nothing: the caller says what the refusal stops.
_GAFFER_AGENT_ENV_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
_GAFFER_SAFE_WRITE_MJS="$_GAFFER_AGENT_ENV_LIB/safe-write.mjs"
gaffer_safe_fs() {
  local out rc
  _GAFFER_SAFE_FS_ERROR=""
  out="$(node "$_GAFFER_SAFE_WRITE_MJS" "$@" 2>&1)"
  rc=$?
  if [ "$rc" -eq 4 ]; then
    _GAFFER_UNSAFE_PATH_ERROR="$(printf '%s' "$out" | tail -n 1)"
  elif [ "$rc" -ne 0 ]; then
    _GAFFER_SAFE_FS_ERROR="$(printf '%s' "$out" | tail -n 1)"
  fi
  return "$rc"
}

# _gaffer_refuse_unsafe <what>: log a path refusal (fail closed) and return 1.
_gaffer_refuse_unsafe() {
  _agent_env_log "SAFETY: refusing to install the $1: ${_GAFFER_UNSAFE_PATH_ERROR:-${_GAFFER_SAFE_FS_ERROR:-path check failed}} (fail closed)"
  return 1
}

gaffer_write_agent_settings() {
  local dir="$1" out rc
  [ -n "$dir" ] || return 1
  # The directory itself is the caller's (a runner-chosen path); what is below it is not.
  [ -d "$dir" ] || mkdir -p "$dir" 2>/dev/null || true
  # Render, verify by the shared rule and write without following a link, all in
  # lib/agent-settings.mjs (the Node writer agent-home.mjs calls the same code).
  out="$(node "$_GAFFER_AGENT_ENV_LIB/agent-settings.mjs" write "$dir" .claude/settings.json "$CLAUDE_SETTINGS" "$RUNNER_DIR" 2>&1)"
  rc=$?
  [ "$rc" -eq 0 ] && return 0
  out="$(printf '%s' "$out" | tail -n 1)"
  if [ "$rc" -eq 4 ]; then
    _GAFFER_UNSAFE_PATH_ERROR="$out"
    _agent_env_log "SAFETY: $out (fail closed)"
  else
    _agent_env_log "SAFETY: could not write a verified $dir/.claude/settings.json from $CLAUDE_SETTINGS: ${out:-node failed (exit $rc)} (fail closed)"
  fi
  return 1
}

# gaffer_install_agent_dir <dir> <skills-csv> <mount-tag>
#   The ONE agent-directory installer every spawn site uses: mount the skill subset,
#   render + VERIFY .claude/settings.json, trust the workspace (so the allowlist is
#   honoured headless; trust not written is a failure, _GAFFER_TRUST_ERROR says why),
#   and install the CLAUDE.factory.md brief. Any failure returns
#   1 so the caller refuses the run (fail closed). The reviewer and clarify sites
#   previously copied the brief unguarded — a failed copy launched an agent with no
#   brief; now it refuses like the delivery site.
#   A repository path the runner would have to write through (a committed symlink at
#   .claude, .claude/skills, .claude/settings.json or CLAUDE.factory.md, or one that is
#   not a regular file / directory) is checked FIRST, before anything is written, and
#   refuses with _GAFFER_UNSAFE_PATH_ERROR naming the path.
gaffer_install_agent_dir() {
  local dir="$1" skills="$2" tag="$3"
  _GAFFER_TRUST_ERROR=""
  _GAFFER_UNSAFE_PATH_ERROR=""
  [ -n "$dir" ] || return 1
  gaffer_safe_fs check "$dir" .claude dir || { _gaffer_refuse_unsafe "agent directory"; return 1; }
  gaffer_safe_fs check "$dir" .claude/settings.json file || { _gaffer_refuse_unsafe "agent settings"; return 1; }
  gaffer_safe_fs check "$dir" CLAUDE.factory.md file || { _gaffer_refuse_unsafe "agent brief"; return 1; }
  gaffer_skills_mount "$dir" "$skills" "$tag" || return 1
  gaffer_write_agent_settings "$dir" || return 1
  # Trust not written → refuse: an agent whose project permissions are ignored cannot
  # read its ticket, test or commit (the caller reads _GAFFER_TRUST_ERROR for the why).
  if ! gaffer_trust_workspace "$dir"; then
    _agent_env_log "TRUST: ${_GAFFER_TRUST_ERROR:-trust_unwritable: $dir} (fail closed: no agent runs with its project permissions ignored)"
    return 1
  fi
  local brief="${HERE:-$RUNNER_DIR}/claude/CLAUDE.md"
  if [ ! -f "$brief" ] || ! gaffer_safe_fs write "$dir" CLAUDE.factory.md "$brief"; then
    [ -n "$_GAFFER_UNSAFE_PATH_ERROR" ] || gaffer_safe_fs remove "$dir" CLAUDE.factory.md
    _agent_env_log "SAFETY: could not install the CLAUDE.factory.md brief into $dir: ${_GAFFER_UNSAFE_PATH_ERROR:-${_GAFFER_SAFE_FS_ERROR:-no brief at $brief}} (fail closed)"
    return 1
  fi
  return 0
}

# gaffer_park_unsafe_path <ticket> [<what>]: park a delivery whose worktree holds a
# path the runner refused to write through (_GAFFER_UNSAFE_PATH_ERROR): release the
# claim to `blocked` with reason code unsafe_worktree_path and a reason that names the
# path and the fix, skip the ticket this run. A repository's committed link does not go
# away on a retry, so releasing to `ready` would only refuse again every tick.
# A RESUMED delivery (_RESUMING=1) goes back to `paused` instead (gaffer_resume_abort):
# its preserved worktree holds the paused attempt's uncommitted work, and a `blocked`
# ticket that a person unblocks is claimed afresh, and a fresh delivery clears the stale
# worktree before re-creating it. Paused, the worktree stays (the pause-keep invariant),
# the ticket names the link and the worktree, and Continue retries once the link is gone.
gaffer_park_unsafe_path() {
  local num="$1" what="${2:-agent}"
  log "SAFETY: refusing to launch the $what for #$num (fail closed, unsafe_worktree_path): $_GAFFER_UNSAFE_PATH_ERROR"
  if [ "${_RESUMING:-0}" = "1" ] && declare -F gaffer_resume_abort >/dev/null 2>&1; then
    gaffer_resume_abort "$_GAFFER_UNSAFE_PATH_ERROR. The paused work is kept in ${PRIMARY_REPO:-its preserved worktree}: remove or replace that link there, then press Continue. No agent was launched"
    gaffer_skip_ticket "$num"
    return 0
  fi
  wg attach-evidence "$num" --type manual_note \
    --summary "PARKED (unsafe_worktree_path): $_GAFFER_UNSAFE_PATH_ERROR" >/dev/null 2>&1 || true
  gaffer_release_delivery blocked "$_GAFFER_UNSAFE_PATH_ERROR, then unblock it ('gaffer wg unblock $num'). No agent was launched." unsafe_worktree_path
  gaffer_skip_ticket "$num"
}

gaffer_link_node_modules() {
  local rpath="$1" rwt="$2" _nm _rel
  [ -n "$rpath" ] && [ -n "$rwt" ] && [ -d "$rpath" ] && [ -d "$rwt" ] || return 0
  # Link the ROOT install only when it is non-empty: linking an EMPTY primary
  # node_modules (wiped by an agent's `npm ci` through an earlier worktree's link) would
  # make the DoD pre-gate installer see "deps present" and skip its per-worktree install.
  # gaffer_safe_fs symlink never clobbers an existing path (a dangling link included)
  # and refuses a parent in the worktree that is a symlink (logged; the link is skipped).
  if [ -e "$rpath/node_modules" ] && [ -n "$(ls -A "$rpath/node_modules" 2>/dev/null)" ]; then
    gaffer_safe_fs symlink "$rwt" node_modules "$rpath/node_modules" \
      || _agent_env_log "node_modules: not linked into $rwt: ${_GAFFER_UNSAFE_PATH_ERROR:-${_GAFFER_SAFE_FS_ERROR:-link failed}} (skipped)"
  fi
  # Workspaces (pnpm/yarn/npm monorepos) keep test/build binaries in PER-PACKAGE
  # node_modules/.bin, not the root — so also link each sub-package's node_modules,
  # or `vitest`/`tsc` are unresolvable in the worktree and the DoD gate fails to RUN.
  while IFS= read -r _nm; do
    _rel="${_nm#"$rpath"/}"
    [ "$_rel" = "node_modules" ] && continue
    case "$_rel" in node_modules/*|*/node_modules/*) continue ;; esac   # an install inside an install
    [ -e "$rwt/$_rel" ] && continue                                     # already there: never clobbered
    _GAFFER_UNSAFE_PATH_ERROR=""
    gaffer_safe_fs symlink "$rwt" "$_rel" "$_nm" \
      || _agent_env_log "node_modules: not linked into $rwt: ${_GAFFER_UNSAFE_PATH_ERROR:-$_rel: ${_GAFFER_SAFE_FS_ERROR:-link failed}} (skipped)"
  done < <(find "$rpath" -maxdepth 3 -name node_modules -type d 2>/dev/null)
  _GAFFER_UNSAFE_PATH_ERROR=""
  return 0
}

# Log through the caller's `log` when one is defined (tick.sh / review / clarify),
# else stderr — the helpers must work in the extracted-function test harnesses too.
_agent_env_log() {
  if declare -F log >/dev/null 2>&1; then log "$@"; else printf 'gaffer: %s\n' "$*" >&2; fi
}
