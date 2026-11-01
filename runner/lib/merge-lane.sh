# Gaffer MERGE LANE — land what has been approved. Sourced by tick.sh and run at the
# START of every tick, before the ready-candidate scan, so a merge frees its dependents
# in the same tick.
#
# The agent review pass lands a ticket itself on a ship verdict. Every OTHER route to
# ready_for_merge — a human's approve (dashboard / `wg review approve`), the independent
# tester's PASS, an approve whose merge gate was held at review time and has since been
# earned — left the ticket waiting for the dashboard's Merge button, in autonomous mode
# too: a live run stalled with nine dependent tickets starving behind a human-approved
# bootstrap, and with GAFFER_TESTING on EVERY ticket would have stopped there. This lane
# asks the same merge policy the review pass asks (`wg ticket auto-decision --gate merge`:
# the env floor OR an earned per-repo/risk `auto` row — it adds no policy of its own) and
# lands through the same gaffer_land_delivery. A ticket a HUMAN approved also lands when
# AUTO_MERGE ("Auto-merge on approval") is on: that switch is the operator's standing
# instruction to land what a person approved. It is NOT the agent ship floor — an
# agent-approved ticket still needs the merge gate (AUTO_MERGE AND MERGE_ON_AGENT_REVIEW,
# or an earned `auto` merge row). A ticket the policy holds is logged ONCE
# per run and left for a human ("ship what you've earned, hold the rest"); one whose
# landing fails (conflict, dirty checkout) is logged and skipped for the rest of the run.
# A PARTLY LANDED ticket (some write repos landed, some not) is always merge work: the
# lane lands the remaining repos (the landing already started under the approval).
# Never exits the tick: merging is bookkeeping, the tick goes on to deliver.
# shellcheck shell=bash
# shellcheck disable=SC2154  # globals provided by tick.sh at call time
_gaffer_merge_lane() {
  case "$(printf '%s' "${GAFFER_MERGE_LANE:-1}" | tr '[:upper:]' '[:lower:]')" in 0|false|no|off) return 0 ;; esac
  declare -F gaffer_land_delivery >/dev/null 2>&1 || return 0
  local _HELD_FILE="$GAFFER_DATA/.merge-held-tickets"; touch "$_HELD_FILE"
  local _MJSON _MNUMS _n _show _repo _branch _def _dec _rc _via
  _MJSON="$(wg ticket list -s ready_for_merge 2>/dev/null || echo '[]')"
  _MNUMS="$(printf '%s' "$_MJSON" | jget '(d.tickets || d || []).map(t => t.number).filter(Boolean).join(" ")' 2>/dev/null || echo '')"
  [ -n "${_MNUMS// /}" ] || return 0
  for _n in $_MNUMS; do
    grep -qx "$_n" "$_HELD_FILE" 2>/dev/null && continue
    _show="$(wg ticket show "$_n" 2>/dev/null)" || continue
    _repo="$(echo "$_show" | jget '(((d.repositories||[]).find(r => r.access === "write" && r.local_path) || (d.repositories||[]).find(r => r.local_path) || {}).local_path) || ""' 2>/dev/null)"
    _def="$(echo "$_show" | jget '(((d.repositories||[]).find(r => r.access === "write" && r.local_path) || (d.repositories||[]).find(r => r.local_path) || {}).default_branch) || "main"' 2>/dev/null)"
    _branch="$(echo "$_show" | jget 'd.ticket.branch_name || ""' 2>/dev/null)"
    # PARTLY LANDED (external review #7): some write repos' approved commits landed, some
    # did not (a dirty checkout, an unavailable branch, a held repo). The landing started
    # under an approval the landing paths acted on, so finishing it is merge work: the
    # remaining repos land through the same landing check and merge gate (a landed repo is
    # never merged again). Poll for work used to report no_work here while `gaffer merge`
    # would finish the ticket. The primary repo's branch may be gone once it landed, so the
    # plan's per-repo branches are what is checked.
    _partial="$(printf '%s' "$_show" | jget '(d.landing && d.landing.partial) ? "1" : ""' 2>/dev/null || echo '')"
    if [ "$_partial" = "1" ]; then
      [ -n "$_branch" ] || _branch="$(printf '%s' "$_show" | jget '(((d.landing && d.landing.repos) || []).find(r => !r.landed && r.branch) || {}).branch || ""' 2>/dev/null || echo '')"
    fi
    if [ "$_partial" != "1" ] && { [ -z "$_repo" ] || [ ! -d "$_repo" ] || [ -z "$_branch" ] \
       || ! git -C "$_repo" rev-parse --verify -q "refs/heads/$_branch" >/dev/null 2>&1; }; then
      log "MERGE: #$_n is ready_for_merge but its delivery branch cannot be resolved (repo='${_repo:-?}', branch='${_branch:-?}') — a human merges"
      _gaffer_locked .skip.lock _gaffer_append_line "$_HELD_FILE" "$_n"; continue
    fi
    if [ "$_partial" = "1" ] && { [ -z "$_repo" ] || [ -z "$_branch" ]; }; then
      log "MERGE: #$_n is partly landed but no repository is left to land from (repo='${_repo:-?}', branch='${_branch:-?}') — a human merges"
      _gaffer_locked .skip.lock _gaffer_append_line "$_HELD_FILE" "$_n"; continue
    fi
    if [ "${DRY_RUN:-0}" = "1" ]; then log "DRY_RUN: MERGE would ask the merge gate for #$_n and land $_branch → $_def in $_repo"; continue; fi
    _dec="$(gaffer_auto_decision "$_n" merge)"
    _via="merge gate earned"
    if [ "$_dec" != "allow" ] && _gaffer_flag_on "${AUTO_MERGE:-0}"; then
      # AUTO_MERGE on its own lands HUMAN approvals (the dashboard Approve does the same
      # through the merge runner). The approver is read from the dispatch event log
      # (approval-actor), never from anything an agent writes.
      case "$(printf '%s' "$_show" | gaffer_json approval-actor 2>/dev/null)" in
        human|admin) _dec=allow; _via="human-approved + AUTO_MERGE on" ;;
      esac
    fi
    if [ "$_dec" != "allow" ] && [ "$_partial" = "1" ]; then
      _dec=allow; _via="partly landed: finishing the approved landing (the remaining repositories)"
    fi
    if [ "$_dec" != "allow" ]; then
      log "MERGE: #$_n approved but auto-merge NOT permitted by policy (merge gate held) — left in ready_for_merge for a human"
      _gaffer_locked .skip.lock _gaffer_append_line "$_HELD_FILE" "$_n"; continue
    fi
    # REQUIRED CI, re-read before landing: a result that turned red after the approval (a
    # re-run, a late check) is recorded, and dispatch HOLDS the ticket for a human
    # (blocked, ci_red) instead of it landing on the earlier green.
    if declare -F gaffer_ci_check_once >/dev/null 2>&1 && gaffer_ci_gate_enabled \
       && ! { declare -F gaffer_ci_gate_needs_pr >/dev/null 2>&1 && gaffer_ci_gate_needs_pr; } \
       && [ "$(wg ticket ci-status "$_n" 2>/dev/null | jget 'd.required ? "1" : ""' 2>/dev/null)" = "1" ]; then
      gaffer_ci_check_once "$_n" "$_repo" "$_branch"; _rc=$?
      case "$_rc" in
        2) log "MERGE: #$_n required CI is RED for $_branch (re-checked before landing) — HELD for a human (blocked, ci_red); nothing merged"
           _gaffer_locked .skip.lock _gaffer_append_line "$_HELD_FILE" "$_n"; continue ;;
        1) log "MERGE: #$_n required CI has no current PASS for $_branch (pending or unreadable) — not landing this run" ;;
      esac
      # rc 1 falls through: the landing decision refuses a pin without a recorded PASS.
    fi
    log "MERGE: #$_n ready_for_merge + $_via → landing $_branch → $_def in $_repo"
    gaffer_land_delivery "$_n" "$_repo" "$_branch" "$_def" "$_show" MERGE; _rc=$?
    # rc 5 = a conflict the resolver just fixed ON the branch; the ticket is back in
    # review and returns to ready_for_merge in THIS run once re-approved (and tested).
    # It must not be held for the run — that stranded a resolved ticket at
    # ready_for_merge until the next run while its dependents starved (seen live).
    case "$_rc" in 0|5) ;; *) _gaffer_locked .skip.lock _gaffer_append_line "$_HELD_FILE" "$_n" ;; esac
    # The tick reports `merged` (not no_work) when the lane landed something and nothing
    # else ran (tick.sh result): a landing is work, and Poll for work must say so.
    [ "$_rc" -eq 0 ] && _GAFFER_MERGE_LANE_LANDED=$(( ${_GAFFER_MERGE_LANE_LANDED:-0} + 1 ))
  done
  return 0
}
