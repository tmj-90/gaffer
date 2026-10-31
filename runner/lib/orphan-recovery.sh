# Gaffer orphaned-worktree recovery (A-1 parallel execution).
# shellcheck shell=bash
_GAFFER_JSON_TOOL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/json-tool.mjs"
#
# A killed worker (SIGKILL, a crashed host, an OOM) leaves its per-ticket worktree
# dir under $GAFFER_DATA/worktrees/ticket-<NUM>/ behind, and its claim is reaped
# separately by the existing `wg expire-claims` (claim TTL) at loop start. The
# worktree dir itself is NOT reaped by anything — so over time dead workers litter
# the data dir with stale checkouts (and their `gaffer/ticket-*` branches linger in
# the real repos). gaffer_cleanup_orphaned_worktrees sweeps them.
#
# SAFETY — a worktree is removed ONLY when a successful dispatch read gives its ticket
# a definite TERMINAL status (done, failed, cancelled). Everything else is kept: an
# UNKNOWN status (a failed read, or a ticket dispatch does not know), a LIVE worker's
# ticket (`claimed` / `in_progress`), a PAUSED delivery (PAUSE-ON-CAP: its committed AND
# uncommitted work must survive for the one-click resume), and every other definite
# status (draft, ready, blocked, in_review, in_testing, ready_for_merge, …). A "clean"
# check is not enough to remove a non-terminal ticket's worktree: `git status` cannot
# see gitignored files (a local .env, build state), so such a worktree is kept and
# reported. The next delivery of the ticket clears its own stale worktree first
# (tick.sh gaffer_cleanup_worktrees), and the sweep removes it once the ticket ends.
# Nothing is removed under DRY_RUN (see gaffer_cleanup_orphaned_worktrees).
#
# The worktree's owning real-repo is unknown from the dir alone (the dir holds one
# leaf per write repo), so removal is done with `git worktree remove` issued from
# EACH real repo we can discover via the worktree's own `.git` gitdir pointer, with
# a plain `rm -rf` fallback. Best-effort and never fatal — a recovery hiccup must
# never abort the loop.
#
# Dispatch access is injected via GAFFER_WG_SHOW_CMD (prints `ticket show <ref>`
# JSON; appended as the last arg), defaulting to the real `wg` helper. Tests
# override it to run hermetically (mirrors backpressure.sh).

# Print a ticket's `ticket show` JSON via dispatch (exit status preserved). Mirrors
# backpressure.sh's accessor seam.
_orphan_wg_show() {
  if [ -n "${GAFFER_WG_SHOW_CMD:-}" ]; then
    local -a c; read -ra c <<<"$GAFFER_WG_SHOW_CMD"; "${c[@]}" "$1"
  else
    wg ticket show "$1"
  fi
}

# The ticket's status from a SUCCESSFUL dispatch read, or the literal UNKNOWN: any
# dispatch error (no DB, a timeout, an unbuilt CLI, a ticket that does not resolve) or an
# unreadable answer. UNKNOWN is never a licence to delete (external review #4).
_orphan_ticket_status() {
  local out rc=0 st
  out="$(_orphan_wg_show "$1" 2>/dev/null)" || rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$out" ]; then echo UNKNOWN; return 0; fi
  st="$(printf '%s' "$out" | node "$_GAFFER_JSON_TOOL" ticket-status 2>/dev/null || true)"
  case "$st" in
    draft|refining|ready|claimed|in_progress|blocked|in_review|in_testing|ready_for_merge|done|failed|cancelled|paused) echo "$st" ;;
    *) echo UNKNOWN ;;
  esac
}

# Remove one worktree base dir (and detach its git worktree registrations). The
# dir contains one leaf per write repo; each leaf's .git file points at the real
# repo's gitdir, from which we can issue `git worktree remove`. Fallback: rm -rf.
_orphan_remove_worktree_dir() {
  local base="$1" leaf gitdir realrepo
  [ -d "$base" ] || return 0
  for leaf in "$base"/*; do
    [ -e "$leaf" ] || continue
    # A linked worktree has a `.git` FILE: "gitdir: /real/repo/.git/worktrees/<id>".
    if [ -f "$leaf/.git" ]; then
      gitdir="$(sed -n 's/^gitdir: //p' "$leaf/.git" 2>/dev/null | head -1)"
      # /real/repo/.git/worktrees/<id> → /real/repo
      realrepo="$(printf '%s' "$gitdir" | sed -E 's#/\.git/worktrees/[^/]+/?$##')"
      if [ -n "$realrepo" ] && git -C "$realrepo" rev-parse --git-dir >/dev/null 2>&1; then
        git -C "$realrepo" worktree remove --force "$leaf" >/dev/null 2>&1 || rm -rf "$leaf"
        git -C "$realrepo" worktree prune >/dev/null 2>&1 || true
        continue
      fi
    fi
    rm -rf "$leaf" 2>/dev/null || true
  done
  rmdir "$base" >/dev/null 2>&1 || rm -rf "$base" 2>/dev/null || true
}

# Sweep the leftover $GAFFER_DATA/worktrees/ticket-<NUM>/ dirs, on POSITIVE EVIDENCE only
# (external review #4: a failed database read used to read as "orphaned" and deleted a
# worktree holding uncommitted work, even under --dry-run):
#   UNKNOWN status (any dispatch error / timeout / missing DB / unknown ticket) → KEPT
#   claimed | in_progress | paused (a live worker, or a delivery awaiting Continue) → KEPT
#   done | failed | cancelled (a definite terminal status)                       → removed
#   any other definite status (draft, ready, blocked, in_review, …)              → KEPT
# DRY_RUN=1 never removes anything: it reports what it would do. Echoes each removed
# ticket number on stdout; a kept one is reported on stderr with the reason. Best-effort;
# returns 0 always.
#   gaffer_cleanup_orphaned_worktrees
gaffer_cleanup_orphaned_worktrees() {
  local wtroot="${GAFFER_DATA:-}/worktrees"
  [ -d "$wtroot" ] || return 0
  local d num status why
  for d in "$wtroot"/ticket-*; do
    [ -d "$d" ] || continue
    num="$(basename "$d" | sed -nE 's/^ticket-([0-9]+).*/\1/p')"
    [ -n "$num" ] || continue
    status="$(_orphan_ticket_status "$num")"
    why=""
    case "$status" in
      UNKNOWN)
        why="ticket status is UNKNOWN (dispatch could not be read) — kept; nothing is deleted without a definite status" ;;
      claimed|in_progress|paused)
        # A live concurrent worker owns this ticket (claimed/in_progress), or it is
        # a PAUSED delivery awaiting resume (PAUSE-ON-CAP) — DO NOT touch its worktree.
        why="" ; continue ;;
      done|failed|cancelled) : ;;
      *)
        # Not terminal: the ticket may be delivered again, and a clean `git status`
        # cannot see gitignored files, so nothing here is provably disposable.
        why="ticket is $status, not terminal — kept; only a done, failed or cancelled ticket's worktree is removed" ;;
    esac
    if [ -n "$why" ]; then
      printf 'gaffer: orphan-recovery: #%s %s (%s)\n' "$num" "$why" "$d" >&2
      continue
    fi
    if [ "${DRY_RUN:-0}" = "1" ]; then
      printf 'gaffer: orphan-recovery: DRY_RUN: would remove the leftover worktree of #%s (%s) — nothing removed\n' "$num" "$status" >&2
      continue
    fi
    _orphan_remove_worktree_dir "$d"
    echo "$num"
  done
  return 0
}
