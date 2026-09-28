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
# lands through the same gaffer_land_delivery. A ticket the policy holds is logged ONCE
# per run and left for a human ("ship what you've earned, hold the rest"); one whose
# landing fails (conflict, dirty checkout) is logged and skipped for the rest of the run.
# Never exits the tick: merging is bookkeeping, the tick goes on to deliver.
# shellcheck shell=bash
# shellcheck disable=SC2154  # globals provided by tick.sh at call time
_gaffer_merge_lane() {
  [ "${GAFFER_MERGE_LANE:-1}" = "1" ] || return 0
  declare -F gaffer_land_delivery >/dev/null 2>&1 || return 0
  local _HELD_FILE="$GAFFER_DATA/.merge-held-tickets"; touch "$_HELD_FILE"
  local _MJSON _MNUMS _n _show _repo _branch _def _dec _rc
  _MJSON="$(wg ticket list -s ready_for_merge 2>/dev/null || echo '[]')"
  _MNUMS="$(printf '%s' "$_MJSON" | jget '(d.tickets || d || []).map(t => t.number).filter(Boolean).join(" ")' 2>/dev/null || echo '')"
  [ -n "${_MNUMS// /}" ] || return 0
  for _n in $_MNUMS; do
    grep -qx "$_n" "$_HELD_FILE" 2>/dev/null && continue
    _show="$(wg ticket show "$_n" 2>/dev/null)" || continue
    _repo="$(echo "$_show" | jget '(((d.repositories||[]).find(r => r.access === "write" && r.local_path) || (d.repositories||[]).find(r => r.local_path) || {}).local_path) || ""' 2>/dev/null)"
    _def="$(echo "$_show" | jget '(((d.repositories||[]).find(r => r.access === "write" && r.local_path) || (d.repositories||[]).find(r => r.local_path) || {}).default_branch) || "main"' 2>/dev/null)"
    _branch="$(echo "$_show" | jget 'd.ticket.branch_name || ""' 2>/dev/null)"
    if [ -z "$_repo" ] || [ ! -d "$_repo" ] || [ -z "$_branch" ] \
       || ! git -C "$_repo" rev-parse --verify -q "refs/heads/$_branch" >/dev/null 2>&1; then
      log "MERGE: #$_n is ready_for_merge but its delivery branch cannot be resolved (repo='${_repo:-?}', branch='${_branch:-?}') — a human merges"
      _gaffer_locked .skip.lock _gaffer_append_line "$_HELD_FILE" "$_n"; continue
    fi
    if [ "${DRY_RUN:-0}" = "1" ]; then log "DRY_RUN: MERGE would ask the merge gate for #$_n and land $_branch → $_def in $_repo"; continue; fi
    _dec="$(gaffer_auto_decision "$_n" merge)"
    if [ "$_dec" != "allow" ]; then
      log "MERGE: #$_n approved but auto-merge NOT permitted by policy (merge gate held) — left in ready_for_merge for a human"
      _gaffer_locked .skip.lock _gaffer_append_line "$_HELD_FILE" "$_n"; continue
    fi
    log "MERGE: #$_n ready_for_merge + merge gate earned → landing $_branch → $_def in $_repo"
    gaffer_land_delivery "$_n" "$_repo" "$_branch" "$_def" "$_show" MERGE; _rc=$?
    [ "$_rc" -eq 0 ] || _gaffer_locked .skip.lock _gaffer_append_line "$_HELD_FILE" "$_n"
  done
  return 0
}
