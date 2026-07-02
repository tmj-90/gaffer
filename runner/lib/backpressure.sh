# Gaffer per-repo backpressure (sourced by factory.config.sh).
# shellcheck shell=bash
#
# Before claiming/delivering for a repo, count its OUTSTANDING work and refuse to
# pile up more than the configured cap. Outstanding work for a repo =
#   • ACTIVE unmerged gaffer/* branches in the REAL repo (delivery branches not yet
#     merged into the default branch). Branches preserved by PARKED tickets
#     (blocked/refining — awaiting a human) are EXCLUDED: they are not in-flight
#     work, and counting them would starve the repo for as long as the tickets sit
#     parked (the resume re-claim is gated behind this same check). The claiming
#     ticket's OWN preserved branch is also excluded — a re-claim reuses that
#     branch, it adds nothing new. Fail SAFE: a branch whose ticket cannot be
#     resolved (unmappable name, failed status lookup) always counts.
#   • in_review tickets targeting the repo (the "open PR" equivalent), and
#   • active (unexpired) claims targeting the repo (concurrent in-flight tickets).
#
# At/over ANY cap the repo is in BACKPRESSURE: the loop SKIPS new claims for it and
# prioritises review/merge/cleanup/blocked work, so the per-repo cap is never
# exceeded by piling on more deliveries.
#
# Caps (factory.config.sh; 0 = that dimension unlimited):
#   MAX_OPEN_AGENT_BRANCHES_PER_REPO   unmerged gaffer/* branches
#   MAX_OPEN_AGENT_PRS_PER_REPO        in_review tickets
#   MAX_CONCURRENT_TICKETS_PER_REPO    active claims
#
# Dispatch access is injected via GAFFER_WG_LIST_CMD (a command that prints the
# `ticket list -s <status>` JSON for a given status, appended as the last arg) and
# GAFFER_WG_SHOW_CMD (prints `ticket show <ref>` JSON). They default to the real
# `wg` helper from factory.config.sh, but tests override them to run hermetically.

# List unmerged gaffer/* branch NAMES in a REAL repo: local branches matching
# gaffer/* whose tip is NOT already contained in the default branch. `git branch
# --merged` lists branches fully merged into <default>; the unmerged gaffer/ set
# is the difference. A repo that is not on disk contributes nothing.
#   _gaffer_repo_unmerged_branch_names <repo-path> <default-branch>
_gaffer_repo_unmerged_branch_names() {
  local repo="$1" def="${2:-main}"
  git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || return 0
  local all merged
  all="$(git -C "$repo" for-each-ref --format='%(refname:short)' 'refs/heads/gaffer/*' 2>/dev/null | sort -u)"
  [ -n "$all" ] || return 0
  merged="$(git -C "$repo" branch --format='%(refname:short)' --merged "$def" 2>/dev/null | grep -E '^gaffer/' | sort -u)"
  comm -23 <(printf '%s\n' "$all") <(printf '%s\n' "$merged")
}

# Count ALL unmerged gaffer/* branches (raw, status-blind).
#   gaffer_repo_unmerged_branches <repo-path> <default-branch>
gaffer_repo_unmerged_branches() {
  local n
  n="$(_gaffer_repo_unmerged_branch_names "$1" "${2:-main}" | grep -c .)" || true
  echo "${n:-0}"
}

# Print the ticket numbers of every PARKED ticket — parked = set aside for a
# human (rework loop parks to `blocked`, other recovery paths to `refining`).
# NOTE `paused` is deliberately NOT parked here: a paused delivery is live
# in-flight work (worktree kept alive for one-click resume) and must keep
# pressuring its repo. BATCHED: one `ticket list -s <status>` call per parked
# status — never a per-branch `ticket show`. Fail SAFE: a failed/unparseable
# list yields nothing for that status, so callers exclude nothing (branches keep
# counting — a lookup failure throttles, never unthrottles). Never fatal.
#   gaffer_parked_ticket_numbers
gaffer_parked_ticket_numbers() {
  local s
  for s in blocked refining; do
    _bp_wg_list "$s" 2>/dev/null | python3 -c "import sys,json
try: d=json.load(sys.stdin)
except Exception: d=[]
for t in (d if isinstance(d, list) else []):
    n=(t or {}).get('number')
    if n is not None: print(n)" 2>/dev/null
  done
  return 0
}

# Count ACTIVE unmerged gaffer/* branches — the branch-pressure dimension.
# Like gaffer_repo_unmerged_branches, but a branch is excluded when its ticket
# (derived from the `gaffer/ticket-<n>-…` name, the same mapping the sweep uses)
# is either:
#   • PARKED (blocked/refining): the ticket is waiting on a HUMAN; its preserved
#     branch is not in-flight work. Counting it would starve the repo for the
#     whole parked lifetime — the parked ticket's own resumption re-claim is
#     gated behind this same check, so nothing could ever relieve the pressure.
#   • the CLAIMING ticket itself (<self-ticket>): a re-claim reuses/resets its
#     own preserved branch (worktree add -B), adding no new branch, so it must
#     not be starved by its own prior work.
# Fail SAFE: a branch that embeds no ticket number, or whose parked-status
# lookup failed (empty parked set), CANNOT be proven inactive and still counts.
#   gaffer_repo_active_unmerged_branches <repo-path> <default-branch> [self-ticket]
gaffer_repo_active_unmerged_branches() {
  local repo="$1" def="${2:-main}" self="${3:-}"
  local names parked b num count=0
  names="$(_gaffer_repo_unmerged_branch_names "$repo" "$def")"
  [ -n "$names" ] || { echo 0; return 0; }
  parked="$(gaffer_parked_ticket_numbers)"
  while IFS= read -r b; do
    [ -n "$b" ] || continue
    num="$(printf '%s' "$b" | sed -nE 's#^gaffer/ticket-([0-9]+).*#\1#p')"
    if [ -n "$num" ]; then
      [ -n "$self" ] && [ "$num" = "$self" ] && continue          # own branch: reused, not added
      [ -n "$parked" ] && printf '%s\n' "$parked" | grep -qxF "$num" && continue  # parked: not in-flight
    fi
    count=$((count + 1))
  done <<< "$names"
  echo "$count"
}

# Delete ONLY genuinely-abandoned unmerged gaffer/* branches. A "genuinely
# abandoned" branch is one whose ticket is POSITIVELY cancelled (a terminal,
# killed ticket) AND which is NOT recorded as a delivery artifact.
#
# DATA-LOSS GUARD (the reason this is deny-by-default): a delivery branch is
# frequently the ONLY copy of committed delivery work. A ticket parked for rework
# PRESERVES its branch — the rework loop parks to `blocked`, other recovery paths
# park to `refining`, and both keep the branch alive for the next attempt. The
# in-flight preserved/live states are therefore NEVER swept:
#   refining · blocked · in_progress · paused · claimed  (non-terminal preserved)
#   ready · in_review · done · draft                     (other live tickets)
# Anything we cannot POSITIVELY confirm abandoned — an unknown status, or a status
# lookup that fails/returns empty (transient `wg` error) — is KEPT: losing
# committed work is far worse than a lingering branch. Keeping a PARKED branch is
# cheap because the pressure count excludes parked (blocked/refining) tickets'
# branches (gaffer_repo_active_unmerged_branches), so preservation never throttles
# the repo; a branch kept because its status is UNRESOLVABLE, however, DOES keep
# counting toward the cap (fail-safe) until the status resolves. Merged branches
# are left to the normal merged sweep. Echoes each deleted branch name.
# Best-effort — never fatal.
#   gaffer_sweep_abandoned_branches <repo-path> <default-branch>
gaffer_sweep_abandoned_branches() {
  local repo="$1" def="${2:-main}"
  git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || return 0
  local b num tstatus merged
  merged="$(git -C "$repo" branch --format='%(refname:short)' --merged "$def" 2>/dev/null | grep -E '^gaffer/' | sort -u)"
  for b in $(git -C "$repo" for-each-ref --format='%(refname:short)' 'refs/heads/gaffer/*' 2>/dev/null); do
    printf '%s\n' "$merged" | grep -qxF "$b" && continue   # merged → not our job
    num="$(printf '%s' "$b" | sed -nE 's#^gaffer/ticket-([0-9]+).*#\1#p')"
    [ -n "$num" ] || continue
    tstatus="$(_bp_wg_show "$num" 2>/dev/null | python3 -c "import sys,json
try: print(json.load(sys.stdin)['ticket']['status'])
except Exception: print('')" 2>/dev/null)"
    # PRESERVE unless the ticket is POSITIVELY cancelled. Every live/preserved
    # state, and every ambiguous/unresolvable status, keeps the branch.
    [ "$tstatus" = "cancelled" ] || continue
    # A cancelled ticket whose branch is a RECORDED delivery artifact is still
    # kept — never nuke recorded delivery work.
    gaffer_branch_is_delivery_artifact "$num" "$b" && continue
    git -C "$repo" branch -D "$b" >/dev/null 2>&1 && echo "$b"
  done
}

# True (0) when branch $2 is recorded as a per-repo delivery artifact for ticket
# $1. Reads the ticket's delivery rows via _bp_wg_deliveries (stubbable). Fails
# SAFE: an accessor error or unparseable payload is treated as "recorded" (0) so
# a branch we cannot prove is NOT a delivery artifact is kept. An empty `[]` list
# is a valid "no delivery for this branch" answer (1 → eligible for sweep).
#   gaffer_branch_is_delivery_artifact <ticket-number> <branch-name>
gaffer_branch_is_delivery_artifact() {
  local num="$1" branch="$2" out
  out="$(_bp_wg_deliveries "$num" 2>/dev/null)" || return 0
  printf '%s' "$out" | python3 -c "import sys,json
b=sys.argv[1]
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)  # unparseable → fail safe (treat as recorded → keep)
rows = d if isinstance(d, list) else (d.get('deliveries') or [])
sys.exit(0 if any((r or {}).get('branch_name') == b for r in rows) else 1)" "$branch"
}

# Default Dispatch accessors (overridable by tests). Each appends its argument.
# No eval: the override command is read into an argv array and invoked directly, so
# the appended argument can never be re-interpreted as shell (mirrors run-summary.sh).
_bp_wg_list() {
  if [ -n "${GAFFER_WG_LIST_CMD:-}" ]; then local -a c; read -ra c <<<"$GAFFER_WG_LIST_CMD"; "${c[@]}" "$1"
  else wg ticket list -s "$1"; fi
}
_bp_wg_show() {
  if [ -n "${GAFFER_WG_SHOW_CMD:-}" ]; then local -a c; read -ra c <<<"$GAFFER_WG_SHOW_CMD"; "${c[@]}" "$1"
  else wg ticket show "$1"; fi
}
# Prints the ticket's per-repo delivery artifacts JSON (`wg ticket repo-delivery
# list <ref>`). Overridable by tests via GAFFER_WG_DELIVERIES_CMD (the ref is
# appended as the last arg, same no-eval argv contract as the accessors above).
_bp_wg_deliveries() {
  if [ -n "${GAFFER_WG_DELIVERIES_CMD:-}" ]; then local -a c; read -ra c <<<"$GAFFER_WG_DELIVERIES_CMD"; "${c[@]}" "$1"
  else wg ticket repo-delivery list "$1"; fi
}

# Count tickets of a given STATUS whose (first) repo local_path matches the target.
# Resolves each ticket's repo via `ticket show` (ticket list carries no repo). The
# target is matched by absolute local_path OR by repo name, so callers can pass
# whichever they hold.
#   gaffer_repo_tickets_in_status <status> <repo-path-or-name>
gaffer_repo_tickets_in_status() {
  local status="$1" target="$2"
  local nums n
  nums="$(_bp_wg_list "$status" 2>/dev/null | python3 -c "import sys,json
try: d=json.load(sys.stdin)
except Exception: d=[]
print(' '.join(str(t['number']) for t in d))" 2>/dev/null)"
  local count=0
  for n in $nums; do
    if _bp_wg_show "$n" 2>/dev/null | python3 -c "import sys,json
target=sys.argv[1]
try: d=json.load(sys.stdin)
except Exception: sys.exit(1)
for r in (d.get('repositories') or []):
    if (r.get('local_path') or '')==target or (r.get('name') or '')==target:
        sys.exit(0)
sys.exit(1)" "$target"; then
      count=$((count + 1))
    fi
  done
  echo "$count"
}

# Compute a repo's pressure across all three dimensions and echo a single line:
#   "<branches> <in_review> <claims>"
# The branch dimension counts ACTIVE branches only (parked blocked/refining
# tickets' preserved branches and the claiming ticket's own branch are excluded —
# see gaffer_repo_active_unmerged_branches). Pass the candidate ticket number as
# <self-ticket> so a parked ticket re-claiming its own preserved branch is never
# starved by it. The active-claims count is the number of IN-FLIGHT tickets for
# the repo. An in-flight delivery is `claimed` for essentially its whole lifetime
# — Dispatch moves a ticket to `claimed` on claim and only flips it to
# `in_progress` for the brief window inside submitForReview. Counting
# `in_progress` alone would leave the cap inert during live delivery, so we count
# BOTH live statuses (claimed + in_progress). If a future status name represents
# live work, extend the set here.
#   gaffer_repo_pressure <repo-path> <default-branch> [repo-name] [self-ticket]
gaffer_repo_pressure() {
  local repo="$1" def="${2:-main}" name="${3:-}" self="${4:-}"
  local key="$repo"
  local branches inreview claims
  branches="$(gaffer_repo_active_unmerged_branches "$repo" "$def" "$self")"
  inreview="$(gaffer_repo_tickets_in_status in_review "$key")"
  # Live work = claimed (the steady state of an in-flight delivery) + in_progress
  # (the brief submit-for-review window). Sum both so the cap throttles real work.
  claims="$(gaffer_repo_tickets_in_status claimed "$key")"
  claims=$(( ${claims:-0} + $(gaffer_repo_tickets_in_status in_progress "$key") ))
  # If repo name differs from path and path-keyed lookups found nothing, also try
  # the name so either identifier works.
  if [ -n "$name" ] && [ "$name" != "$repo" ]; then
    if [ "${inreview:-0}" = "0" ]; then inreview="$(gaffer_repo_tickets_in_status in_review "$name")"; fi
    if [ "${claims:-0}" = "0" ]; then
      claims="$(gaffer_repo_tickets_in_status claimed "$name")"
      claims=$(( ${claims:-0} + $(gaffer_repo_tickets_in_status in_progress "$name") ))
    fi
  fi
  printf '%s %s %s\n' "${branches:-0}" "${inreview:-0}" "${claims:-0}"
}

# Decide whether a repo is in BACKPRESSURE given its pressure triple. At/over ANY
# cap → in backpressure (return 0). Sets GAFFER_BACKPRESSURE_REASON to the breached
# dimension(s). A cap of 0 disables that dimension.
#   gaffer_repo_in_backpressure <branches> <in_review> <claims>
gaffer_repo_in_backpressure() {
  local branches="${1:-0}" inreview="${2:-0}" claims="${3:-0}"
  local cb="${MAX_OPEN_AGENT_BRANCHES_PER_REPO:-3}"
  local cp="${MAX_OPEN_AGENT_PRS_PER_REPO:-3}"
  local cc="${MAX_CONCURRENT_TICKETS_PER_REPO:-2}"
  GAFFER_BACKPRESSURE_REASON=""
  local reasons=""
  [ "${cb:-0}" -gt 0 ] && [ "${branches:-0}" -ge "$cb" ] && reasons+="branches ${branches}/${cb}; "
  [ "${cp:-0}" -gt 0 ] && [ "${inreview:-0}" -ge "$cp" ] && reasons+="in_review ${inreview}/${cp}; "
  [ "${cc:-0}" -gt 0 ] && [ "${claims:-0}" -ge "$cc" ] && reasons+="claims ${claims}/${cc}; "
  if [ -n "$reasons" ]; then
    GAFFER_BACKPRESSURE_REASON="${reasons%; }"
    return 0
  fi
  return 1
}
