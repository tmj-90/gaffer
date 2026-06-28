# Gaffer per-repo backpressure (sourced by factory.config.sh).
# shellcheck shell=bash
#
# Before claiming/delivering for a repo, count its OUTSTANDING work and refuse to
# pile up more than the configured cap. Outstanding work for a repo =
#   • unmerged gaffer/* branches in the REAL repo (delivery branches not yet merged
#     into the default branch),
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

# Count unmerged gaffer/* branches in a REAL repo: local branches matching gaffer/*
# whose tip is NOT already contained in the default branch. `git branch --merged`
# lists branches fully merged into <default>; the unmerged gaffer/ set is the
# difference. A repo that is not on disk contributes 0 (cannot pressure it).
#   gaffer_repo_unmerged_branches <repo-path> <default-branch>
gaffer_repo_unmerged_branches() {
  local repo="$1" def="${2:-main}"
  git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || { echo 0; return 0; }
  local all merged
  all="$(git -C "$repo" for-each-ref --format='%(refname:short)' 'refs/heads/gaffer/*' 2>/dev/null | sort -u)"
  [ -n "$all" ] || { echo 0; return 0; }
  merged="$(git -C "$repo" branch --format='%(refname:short)' --merged "$def" 2>/dev/null | grep -E '^gaffer/' | sort -u)"
  comm -23 <(printf '%s\n' "$all") <(printf '%s\n' "$merged") | grep -c . || echo 0
}

# Delete unmerged gaffer/* branches whose ticket is ABANDONED (parked to refining,
# back to draft, or cancelled). These otherwise linger after a rejected delivery
# and count against the backpressure cap (a rejected ticket's branch shouldn't
# pressure the repo). Branches for ACTIVE tickets (ready/in_review/claimed/done)
# are always kept; merged branches are left to the normal merged sweep. Echoes
# each deleted branch name. Best-effort — never fatal.
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
    case "$tstatus" in
      refining|draft|cancelled)
        git -C "$repo" branch -D "$b" >/dev/null 2>&1 && echo "$b" ;;
    esac
  done
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
# The active-claims count is the number of IN-FLIGHT tickets for the repo. An
# in-flight delivery is `claimed` for essentially its whole lifetime — Dispatch
# moves a ticket to `claimed` on claim and only flips it to `in_progress` for the
# brief window inside submitForReview. Counting `in_progress` alone would leave the
# cap inert during live delivery, so we count BOTH live statuses (claimed +
# in_progress). If a future status name represents live work, extend the set here.
#   gaffer_repo_pressure <repo-path> <default-branch> [repo-name]
gaffer_repo_pressure() {
  local repo="$1" def="${2:-main}" name="${3:-}"
  local key="$repo"
  local branches inreview claims
  branches="$(gaffer_repo_unmerged_branches "$repo" "$def")"
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
