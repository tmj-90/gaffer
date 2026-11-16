# Gaffer per-repo backpressure (sourced by factory.config.sh).
# shellcheck shell=bash
_GAFFER_JSON_TOOL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/json-tool.mjs"
# The JSON server reaches this lib's json-tool calls through gaffer_json_at
# (config/17-cli.sh); sourced alone (a test), they run json-tool directly.
declare -F gaffer_json_at >/dev/null 2>&1 || gaffer_json_at() { local t="$1"; shift; node "$t" "$@"; }
#
# Before claiming/delivering for a repo, count its OUTSTANDING work and refuse to
# pile up more than the configured cap. Outstanding work for a repo =
#   • ACTIVE unmerged gaffer/* branches in the REAL repo (delivery branches not yet
#     merged into the default branch). Branches preserved by PARKED tickets
#     (blocked/refining — awaiting a human) are EXCLUDED: they are not in-flight
#     work, and counting them would starve the repo for as long as the tickets sit
#     parked (the resume re-claim is gated behind this same check). Branches of
#     CANCELLED (won't do) tickets are EXCLUDED too: the work is terminal, and a
#     delivered ticket's branch is a recorded delivery artifact the abandoned sweep
#     deliberately KEEPS (it may be the only copy, and a won't-do can be reopened),
#     so counting it left the repo in backpressure for good after a few won't-dos
#     on delivered work. The claiming
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
    _bp_wg_list "$s" 2>/dev/null | gaffer_json_at "$_GAFFER_JSON_TOOL" numbers 2>/dev/null
  done
  return 0
}

# Print the ticket numbers whose preserved branches are NOT in-flight work: every
# PARKED ticket (gaffer_parked_ticket_numbers) plus every CANCELLED (won't do) and
# DONE one.
# A cancelled ticket is terminal — nothing will deliver on its branch again unless a
# human reopens it — but its branch is usually KEPT (a recorded delivery artifact is
# never swept, see gaffer_sweep_abandoned_branches), so it must not hold the repo's
# branch cap. Same batching and the same fail-SAFE as the parked list: a failed
# lookup excludes nothing. Never fatal.
#   gaffer_inactive_ticket_numbers
gaffer_inactive_ticket_numbers() {
  gaffer_parked_ticket_numbers
  _bp_wg_list cancelled 2>/dev/null | gaffer_json_at "$_GAFFER_JSON_TOOL" numbers 2>/dev/null
  # DONE is terminal too. Its branch is normally merged (and so never listed), but a
  # ticket closed with "I merged it by hand" after a squash or rebase merge — or a
  # hand-applied change — leaves its gaffer/ branch unmerged, and counting it held a
  # slot of the repo's branch cap for good.
  _bp_wg_list "done" 2>/dev/null | gaffer_json_at "$_GAFFER_JSON_TOOL" numbers 2>/dev/null
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
#   • CANCELLED (won't do): terminal; the branch is kept only as a record of the
#     delivered work (the sweep never deletes a recorded delivery artifact), so it
#     is not in-flight either — counting it starved the repo permanently.
#   • the CLAIMING ticket itself (<self-ticket>): a re-claim reuses/resets its
#     own preserved branch (worktree add -B), adding no new branch, so it must
#     not be starved by its own prior work.
# Fail SAFE: a branch that embeds no ticket number, or whose status lookup failed
# (empty inactive set), CANNOT be proven inactive and still counts.
#   gaffer_repo_active_unmerged_branches <repo-path> <default-branch> [self-ticket]
gaffer_repo_active_unmerged_branches() {
  local repo="$1" def="${2:-main}" self="${3:-}"
  local names parked b num count=0
  names="$(_gaffer_repo_unmerged_branch_names "$repo" "$def")"
  [ -n "$names" ] || { echo 0; return 0; }
  parked="$(gaffer_inactive_ticket_numbers)"
  while IFS= read -r b; do
    [ -n "$b" ] || continue
    num="$(printf '%s' "$b" | sed -nE 's#^gaffer/ticket-([0-9]+).*#\1#p')"
    if [ -n "$num" ]; then
      [ -n "$self" ] && [ "$num" = "$self" ] && continue          # own branch: reused, not added
      [ -n "$parked" ] && grep -qxF -- "$num" <<<"$parked" && continue  # parked/cancelled: not in-flight
    fi
    count=$((count + 1))
  done <<< "$names"
  echo "$count"
}

# BRANCH LEDGER: the record of the gaffer/ branches THIS factory cut, kept in its own
# data dir ($GAFFER_DATA/branch-ledger.tsv). A branch name only says "ticket-<n>"; the
# number is not proof, because ticket numbers restart at 1 when the factory is reset
# (the data dir deleted) or a second data dir points at the same checkout, and the
# ticket #n of the CURRENT database is then a different ticket. The ledger ties the
# branch to the ticket's id (a uuid, never reused) and to the repo it was cut in, and
# it lives and dies with the database it belongs to, so a reset factory has no row for
# an old factory's branch and keeps it. This is the strongest proof available: the
# ticket's own branch_name and its delivery rows are written only after a submit, so a
# ticket cancelled before it delivered has neither. One tab-separated line per event:
#   <kind>\t<ticket-id>\t<ticket-number>\t<repo-key>\t<branch>\t<epoch>
# kind "cut" when a tick creates the branch, "preserved" when a park or a pause keeps
# it for a later attempt. Appends are single short writes (atomic with O_APPEND).
gaffer_branch_ledger_file() {
  [ -n "${GAFFER_DATA:-}" ] || return 1
  printf '%s/branch-ledger.tsv\n' "$GAFFER_DATA"
}

# The repo identity a ledger row names: the absolute git common dir, so the main
# checkout and every worktree of it give the same key. Empty when not a git repo.
gaffer_branch_ledger_repo_key() {
  local cd
  cd="$(git -C "$1" rev-parse --git-common-dir 2>/dev/null)" || return 1
  [ -n "$cd" ] || return 1
  (cd "$1" 2>/dev/null && cd "$cd" 2>/dev/null && pwd -P)
}

#   gaffer_branch_ledger_note <cut|preserved> <ticket-id> <ticket-number> <repo-path> <branch>
# Best effort: a row that cannot be written only means the sweep keeps that branch.
gaffer_branch_ledger_note() {
  local kind="$1" tid="$2" num="$3" repo="$4" branch="$5" f key
  [ -n "$kind" ] && [ -n "$tid" ] && [ -n "$num" ] && [ -n "$branch" ] || return 0
  f="$(gaffer_branch_ledger_file)" || return 0
  key="$(gaffer_branch_ledger_repo_key "$repo")" || return 0
  [ -n "$key" ] || return 0
  case "$tid$num$key$branch" in *$'\t'*|*$'\n'*) return 0 ;; esac
  mkdir -p "$(dirname "$f")" 2>/dev/null || return 0
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$kind" "$tid" "$num" "$key" "$branch" "$(date +%s)" >> "$f" 2>/dev/null || true
  return 0
}

# True (0) when the ledger holds a <kind> row for exactly this ticket id, number,
# repo and branch. A missing or unreadable ledger proves nothing (1).
#   gaffer_branch_ledger_has <kind> <ticket-id> <ticket-number> <repo-key> <branch>
gaffer_branch_ledger_has() {
  local f
  f="$(gaffer_branch_ledger_file)" || return 1
  [ -r "$f" ] || return 1
  awk -F'\t' -v k="$1" -v t="$2" -v n="$3" -v r="$4" -v b="$5" \
    '$1==k && $2==t && $3==n && $4==r && $5==b {found=1} END {exit found?0:1}' "$f" 2>/dev/null
}

# Archive (never delete outright) a gaffer/ branch this factory can PROVE it cut for a
# ticket that is now POSITIVELY cancelled. Every condition must hold, or the branch is
# kept:
#   1. it is not merged into the default branch (merged ones are the merged sweep's);
#   2. the ticket the name points at reads `cancelled` (an unknown or unreadable status,
#      and every live or parked state, keeps the branch);
#   3. the branch ledger has a "cut" row for THIS ticket's id, number, repo and branch
#      (a number collision from a reset factory or a second data dir has none);
#   4. the ledger has no "preserved" row for it (a delivery parked for rework or paused
#      kept its branch on purpose; a Won't do on it must not lose that work);
#   5. it is not a recorded delivery artifact (gaffer_branch_is_delivery_artifact);
#   6. no worktree has it checked out.
# Won't do is reversible, so even then the commits are not dropped: the tip is first
# written to refs/gaffer/abandoned/<branch>-<sha12>, and the branch is removed only
# when that ref verifiably holds the same commit and the branch did not move. Restore
# with `git branch <branch> <archive-ref>` (RUNBOOK). Echoes "<branch>\t<archive-ref>"
# per archived branch; the caller logs each line. Best effort, never fatal.
#   gaffer_sweep_abandoned_branches <repo-path> <default-branch>
gaffer_sweep_abandoned_branches() {
  local repo="$1" def="${2:-main}"
  git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || return 0
  local b num tstatus merged show tid key sha aref checked
  key="$(gaffer_branch_ledger_repo_key "$repo")" || return 0
  [ -n "$key" ] || return 0
  merged="$(git -C "$repo" branch --format='%(refname:short)' --merged "$def" 2>/dev/null | grep -E '^gaffer/' | sort -u)"
  checked="$(git -C "$repo" worktree list --porcelain 2>/dev/null | sed -n 's#^branch refs/heads/##p')"
  # FINDING B-L1: read branch names line-by-line rather than an unquoted
  # `for b in $(...)` word-split.
  while IFS= read -r b; do
    [ -n "$b" ] || continue
    grep -qxF -- "$b" <<<"$merged" && continue   # merged → not our job
    grep -qxF -- "$b" <<<"$checked" && continue  # checked out somewhere → in use
    num="$(printf '%s' "$b" | sed -nE 's#^gaffer/ticket-([0-9]+).*#\1#p')"
    [ -n "$num" ] || continue
    show="$(_bp_wg_show "$num" 2>/dev/null)" || continue
    tstatus="$(printf '%s' "$show" | gaffer_json_at "$_GAFFER_JSON_TOOL" ticket-status 2>/dev/null)"
    [ "$tstatus" = "cancelled" ] || continue
    tid="$(printf '%s' "$show" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const v=JSON.parse(s).ticket.id;process.stdout.write(typeof v==="string"?v:"")}catch{}})' 2>/dev/null)"
    [ -n "$tid" ] || continue
    gaffer_branch_ledger_has cut "$tid" "$num" "$key" "$b" || continue
    gaffer_branch_ledger_has preserved "$tid" "$num" "$key" "$b" && continue
    gaffer_branch_is_delivery_artifact "$num" "$b" && continue
    sha="$(git -C "$repo" rev-parse --verify --quiet "refs/heads/$b^{commit}" 2>/dev/null)" || continue
    [ -n "$sha" ] || continue
    aref="refs/gaffer/abandoned/$b-${sha:0:12}"
    if ! git -C "$repo" rev-parse --verify --quiet "$aref" >/dev/null 2>&1; then
      git -C "$repo" update-ref "$aref" "$sha" "" >/dev/null 2>&1 || continue
    fi
    [ "$(git -C "$repo" rev-parse --verify --quiet "$aref^{commit}" 2>/dev/null)" = "$sha" ] || continue
    git -C "$repo" update-ref -d "refs/heads/$b" "$sha" >/dev/null 2>&1 || continue
    printf '%s\t%s\n' "$b" "$aref"
  done < <(git -C "$repo" for-each-ref --format='%(refname:short)' 'refs/heads/gaffer/*' 2>/dev/null)
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
  # unparseable → fail safe (treat as recorded → keep)
  printf '%s' "$out" | gaffer_json_at "$_GAFFER_JSON_TOOL" branch-recorded "$branch"
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
  nums="$(_bp_wg_list "$status" 2>/dev/null | gaffer_json_at "$_GAFFER_JSON_TOOL" numbers-joined 2>/dev/null)"
  local count=0
  for n in $nums; do
    if _bp_wg_show "$n" 2>/dev/null | gaffer_json_at "$_GAFFER_JSON_TOOL" repo-matches "$target"; then
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
