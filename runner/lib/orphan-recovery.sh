# Gaffer orphaned-worktree recovery (A-1 parallel execution).
# shellcheck shell=bash
#
# A killed worker (SIGKILL, a crashed host, an OOM) leaves its per-ticket worktree
# dir under $GAFFER_DATA/worktrees/ticket-<NUM>/ behind, and its claim is reaped
# separately by the existing `wg expire-claims` (claim TTL) at loop start. The
# worktree dir itself is NOT reaped by anything — so over time dead workers litter
# the data dir with stale checkouts (and their `gaffer/ticket-*` branches linger in
# the real repos). gaffer_cleanup_orphaned_worktrees sweeps them.
#
# SAFETY — never remove a LIVE worker's worktree. A worktree is only swept when its
# ticket is in a TERMINAL or UNCLAIMED state. A ticket actively being delivered by a
# concurrent worker is `claimed` or `in_progress`; those are PROTECTED and never
# touched. Everything else (done/failed/cancelled/ready/draft/blocked/in_review/…,
# or a ticket that no longer exists) means no worker is mid-delivery on it, so its
# leftover worktree is safe to remove.
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

# Echo a ticket's status via dispatch, or "" if it can't be resolved (treated as
# orphaned → sweepable). Mirrors backpressure.sh's accessor seam.
_orphan_wg_show() {
  if [ -n "${GAFFER_WG_SHOW_CMD:-}" ]; then
    local -a c; read -ra c <<<"$GAFFER_WG_SHOW_CMD"; "${c[@]}" "$1"
  else
    wg ticket show "$1"
  fi
}

_orphan_ticket_status() {
  _orphan_wg_show "$1" 2>/dev/null | python3 -c "import sys,json
try: print(json.load(sys.stdin)['ticket']['status'])
except Exception: print('')" 2>/dev/null
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

# Sweep every $GAFFER_DATA/worktrees/ticket-<NUM>/ whose ticket is NOT actively
# being delivered (status ∉ {claimed,in_progress}). Echoes each removed ticket
# number. Best-effort; returns 0 always.
#   gaffer_cleanup_orphaned_worktrees
gaffer_cleanup_orphaned_worktrees() {
  local wtroot="${GAFFER_DATA:-}/worktrees"
  [ -d "$wtroot" ] || return 0
  local d num status
  for d in "$wtroot"/ticket-*; do
    [ -d "$d" ] || continue
    num="$(basename "$d" | sed -nE 's/^ticket-([0-9]+).*/\1/p')"
    [ -n "$num" ] || continue
    status="$(_orphan_ticket_status "$num")"
    case "$status" in
      claimed|in_progress)
        # A live concurrent worker owns this ticket — DO NOT touch its worktree.
        : ;;
      *)
        # Terminal/unclaimed/unknown → no worker mid-delivery → safe to reclaim.
        _orphan_remove_worktree_dir "$d"
        echo "$num" ;;
    esac
  done
  return 0
}
