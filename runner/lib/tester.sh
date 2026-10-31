# Gaffer INDEPENDENT TESTER pass — the testing analog of lib/review.sh. Sourced by
# tick.sh; runs at the end-of-tick flow after the agent review pass. When the
# GAFFER_TESTING lane is on, a ticket the review gate routed to `in_testing` is
# handed to the independent black-box tester agent (bin/tester-run.mjs --live), which
# tests it from the contract + acceptance criteria only and records PASS
# (→ ready_for_merge) or FAIL (→ refining) through the dispatch seam. A ticket the
# tester cannot decide (no verdict token, the tester changed implementation files,
# a PASS that failed its clean replay, …) is HELD in_testing for a human — never
# passed, never failed on silence. The hold says WHY: the tester-run reason is
# logged and attached to the ticket as a `tester held: <reason>` manual_note, and
# the hold is remembered in $GAFFER_DATA/.tester-held (kept across runs, unlike the
# per-run .tested-tickets) keyed on when the ticket entered in_testing, so the same
# stay is never re-tested at another paid tester call. It is tested again once it
# leaves in_testing and comes back (a rework, a human re-route). A tester-run that
# errors before deciding is skipped for the rest of this run only.
# It relies on tick.sh runtime globals (log, wg, jget, result, GAFFER_DATA, …).
# shellcheck shell=bash
# shellcheck disable=SC2154  # globals provided by tick.sh at call time

_gaffer_tester_pass() {
  local _lane_on=0
  case "${GAFFER_TESTING:-0}" in 1|true|yes|on) _lane_on=1 ;; esac
  [ "${DRY_RUN:-0}" = "1" ] && return 0
  TESTED_FILE="$GAFFER_DATA/.tested-tickets"; touch "$TESTED_FILE"
  local _held_file="$GAFFER_DATA/.tester-held" _list_ok=1
  TJSON="$(wg ticket list -s in_testing 2>/dev/null)" || { TJSON='[]'; _list_ok=0; }
  # Forget holds for tickets no longer in_testing: their key (the entry time) can
  # never match again, so the file only ever holds live stays. Only from a listing
  # that succeeded — a failed one would forget every hold and re-spend on them.
  if [ "$_list_ok" -eq 1 ] && [ -s "$_held_file" ]; then
    _gaffer_locked .skip.lock _gaffer_tester_prune_held "$_held_file" \
      "$(printf '%s' "$TJSON" | jget '(Array.isArray(d) ? d : []).map(t => t && t.number).filter(n => n != null).join(" ")' 2>/dev/null || echo '')"
  fi
  # ACCEPTANCE GATE: an epic's ACCEPTANCE ticket (tickets.acceptance = 1) is tested even
  # when the lane is OFF — dispatch routes it to in_testing regardless of GAFFER_TESTING,
  # so leaving it there would strand the build as "not accepted" for a human with nothing
  # said. With the lane off, only acceptance tickets are picked; everything else in
  # in_testing (a human's manual routing) is left alone as before.
  if [ "$_lane_on" -eq 0 ]; then
    TJSON="$(printf '%s' "$TJSON" | jget 'JSON.stringify((Array.isArray(d) ? d : []).filter(t => t && (t.acceptance === 1 || t.acceptance === true)))' 2>/dev/null || echo '[]')"
    case "$TJSON" in ""|"[]"|"null") return 0 ;; esac
  fi
  # Pick the first in_testing ticket not tried this run and not already HELD for a
  # human during its current stay in_testing (a held stay is skipped, never re-spun).
  local _t_entered="" _t_tries=0
  while :; do
    TNUM="$(echo "$TJSON" | gaffer_json pick-unskipped "$TESTED_FILE" 2>/dev/null)"
    [ -n "$TNUM" ] || return 0
    _t_entered="$(wg ticket show "$TNUM" 2>/dev/null | gaffer_json entered-status-at in_testing 2>/dev/null || echo '')"
    grep -qxF "$TNUM"$'\t'"${_t_entered:--}" "$_held_file" 2>/dev/null || break
    log "TESTER: #$TNUM is still HELD in_testing for a human (since ${_t_entered:-an unknown time}) — not re-testing it; move it out of in_testing to have it tested again"
    _gaffer_locked .skip.lock _gaffer_append_line "$TESTED_FILE" "$TNUM"
    _t_tries=$((_t_tries + 1)); [ "$_t_tries" -lt 50 ] || return 0
  done
  [ -f "$RUNNER_DIR/bin/tester-run.mjs" ] || { log "TESTER: bin/tester-run.mjs missing — cannot run the tester lane"; return 0; }
  if [ "$_lane_on" -eq 1 ]; then log "TESTER: independent black-box tester for in_testing #$TNUM (lane on)"
  else log "TESTER: independent black-box tester for ACCEPTANCE #$TNUM (lane off — acceptance is a gate, not an option)"; fi
  # Where a FAIL lands: when the autonomy policy lets the runner drive the review gate
  # for this ticket (the same approve decision the review pass asks), a FAIL is a
  # bounded REWORK (→ ready, the failing observation as feedback, the retry cap parks
  # at the threshold) — exactly like a reviewer's CHANGES. Otherwise (supervised /
  # unearned) it holds in refining for a human, as before. A live run parked a
  # tester FAIL for a human in autonomous mode and the ticket never moved again.
  _T_FAIL_TO=""
  [ "$(gaffer_auto_decision "$TNUM" approve)" = "allow" ] && _T_FAIL_TO=ready
  # The tester-run hands back its raw claude envelope here, so a usage-window refusal
  # is classified and recorded by the same locked helper the delivery path uses.
  local _t_env="$GAFFER_DATA/.usage-tester-$TNUM.json" _t_ul_rc=1 _t_ul_line=""
  rm -f "$_t_env"
  _T_OUT="$(GAFFER_DATA="$GAFFER_DATA" DISPATCH_DB="$DISPATCH_DB" MEMORY_DB="$MEMORY_DB" GAFFER_TESTER_FAIL_TO="$_T_FAIL_TO" \
    GAFFER_TESTER_ENVELOPE_OUT="$_t_env" \
    node "$RUNNER_DIR/bin/tester-run.mjs" --ticket "$TNUM" --live 2>>"$GAFFER_DATA/tester.log")"; _trc=$?
  # USAGE WINDOW (lib/usage-pause.sh, rc 0/1/2 as in tick.sh): a tester refused by the
  # plan's usage window / a rate limit tested nothing. It is NOT a hold for a human (a
  # hold is remembered across runs and the ticket would never be re-tested): record the
  # pause, skip the ticket for this run only, and test it again once the window resets.
  if [ -s "$_t_env" ] && declare -F gaffer_usage_pause_record >/dev/null 2>&1; then
    gaffer_usage_pause_record "$_t_env" "$TNUM" tester >/dev/null; _t_ul_rc=$?
  fi
  rm -f "$_t_env"
  if [ "$_t_ul_rc" != 1 ]; then
    _t_ul_line="$(gaffer_usage_pause_active 2>/dev/null || echo "the pause could not be written under $GAFFER_DATA")"
    log "TESTER: #$TNUM refused by the usage window ($(printf '%s' "$_T_OUT" | jget 'String(d.reason || "").slice(0, 300)' 2>/dev/null)) — not a verdict and not a hold; tested again after the pause ($_t_ul_line)"
    _gaffer_locked .skip.lock _gaffer_append_line "$TESTED_FILE" "$TNUM"
    result usage_paused; exit 0
  fi
  _T_PHASE="$(printf '%s' "$_T_OUT" | jget 'd.phase || ""' 2>/dev/null || echo '')"
  _T_VERDICT="$(printf '%s' "$_T_OUT" | jget 'd.verdict || ""' 2>/dev/null || echo '')"
  _T_BRANCH="$(printf '%s' "$_T_OUT" | jget 'd.testsBranch || ""' 2>/dev/null || echo '')"
  # WHY the tester-run did not record a verdict (held: d.reason; error: d.error).
  local _t_reason
  _t_reason="$(printf '%s' "$_T_OUT" | jget 'String(d.reason || d.error || "").replace(/\s+/g, " ").slice(0, 600)' 2>/dev/null || echo '')"
  case "$_T_PHASE" in
    verdict)
      _T_NOW="$(wg ticket show "$TNUM" 2>/dev/null | jget 'd.ticket.status' 2>/dev/null || echo '?')"
      log "TESTER: #$TNUM verdict=${_T_VERDICT} recorded${_T_BRANCH:+ (tests kept on $_T_BRANCH)} → $_T_NOW"
      [ "$_T_NOW" = "ready" ] && log "TESTER: #$TNUM FAIL re-queued for REWORK with the tester's observation as feedback (autonomous; the retry cap parks at the threshold)"
      ;;
    held)
      log "TESTER: #$TNUM HELD in_testing — ${_t_reason:-the tester-run gave no reason} (rc=$_trc); a human decides${_T_BRANCH:+ (tests kept on $_T_BRANCH)}"
      # The reason goes ON the ticket (a human otherwise sees an in_testing ticket with
      # no why anywhere but data/tester.log), and the hold is remembered for this stay.
      wg attach-evidence "$TNUM" --type manual_note \
        --summary "tester held: ${_t_reason:-the tester-run gave no reason} — held in_testing for a human${_T_BRANCH:+; its tests are kept on $_T_BRANCH}. It is not re-tested while it stays in_testing; move it out (e.g. back to rework) to have it tested again." >/dev/null 2>&1 \
        || log "TESTER: WARNING — could not attach the held reason to #$TNUM"
      _gaffer_locked .skip.lock _gaffer_append_line "$_held_file" "$TNUM"$'\t'"${_t_entered:--}"
      ;;
    *)       log "TESTER: #$TNUM tester did not run cleanly (rc=$_trc, phase=${_T_PHASE:-none}${_t_reason:+: $_t_reason}) — left in_testing for a human; see tester.log" ;;
  esac
  # One attempt per ticket per run for a ticket the tester could NOT decide (held /
  # errored): it is not re-spun every tick. A RECORDED verdict moves the ticket out of
  # in_testing, and if it comes back this run (a FAIL reworked and re-approved) that is
  # a new attempt that must be tested again — marking it here skipped the retest and
  # deadlocked the run: the ticket sat in_testing, its dependents stayed blocked, and
  # the loop gave up on empty polls (seen live). Mirrors review.sh, which marks only
  # the held outcomes.
  [ "$_T_PHASE" = "verdict" ] || _gaffer_locked .skip.lock _gaffer_append_line "$TESTED_FILE" "$TNUM"
  result tested; exit 0
}

# Rewrite the held-ticket file keeping only the lines whose ticket number is in $2
# (space-separated: the tickets in_testing now). Called under the .skip.lock.
_gaffer_tester_prune_held() {
  local file="$1" live=" $2 " num rest tmp
  tmp="$file.tmp.$$"
  : > "$tmp" || return 0
  while IFS=$'\t' read -r num rest; do
    [ -n "$num" ] || continue
    case "$live" in *" $num "*) printf '%s\t%s\n' "$num" "$rest" >> "$tmp" ;; esac
  done < "$file"
  mv -f "$tmp" "$file" 2>/dev/null || rm -f "$tmp"
}
