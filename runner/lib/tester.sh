# Gaffer INDEPENDENT TESTER pass — the testing analog of lib/review.sh. Sourced by
# tick.sh; runs at the end-of-tick flow after the agent review pass. When the
# GAFFER_TESTING lane is on, a ticket the review gate routed to `in_testing` is
# handed to the independent black-box tester agent (bin/tester-run.mjs --live), which
# tests it from the contract + acceptance criteria only and records PASS
# (→ ready_for_merge) or FAIL (→ refining) through the dispatch seam. A ticket the
# tester cannot decide (no verdict token, spawn failure) is HELD in_testing for a
# human and skipped for the rest of this run — never passed, never failed on silence.
# It relies on tick.sh runtime globals (log, wg, jget, result, GAFFER_DATA, …).
# shellcheck shell=bash
# shellcheck disable=SC2154  # globals provided by tick.sh at call time

_gaffer_tester_pass() {
  case "${GAFFER_TESTING:-0}" in 1|true|yes|on) ;; *) return 0 ;; esac
  [ "${DRY_RUN:-0}" = "1" ] && return 0
  TESTED_FILE="$GAFFER_DATA/.tested-tickets"; touch "$TESTED_FILE"
  TJSON="$(wg ticket list -s in_testing 2>/dev/null || echo '[]')"
  TNUM="$(echo "$TJSON" | gaffer_json pick-unskipped "$TESTED_FILE" 2>/dev/null)"
  [ -n "$TNUM" ] || return 0
  [ -f "$RUNNER_DIR/bin/tester-run.mjs" ] || { log "TESTER: bin/tester-run.mjs missing — cannot run the tester lane"; return 0; }
  log "TESTER: independent black-box tester for in_testing #$TNUM (lane on)"
  # Where a FAIL lands: when the autonomy policy lets the runner drive the review gate
  # for this ticket (the same approve decision the review pass asks), a FAIL is a
  # bounded REWORK (→ ready, the failing observation as feedback, the retry cap parks
  # at the threshold) — exactly like a reviewer's CHANGES. Otherwise (supervised /
  # unearned) it holds in refining for a human, as before. A live run parked a
  # tester FAIL for a human in autonomous mode and the ticket never moved again.
  _T_FAIL_TO=""
  [ "$(gaffer_auto_decision "$TNUM" approve)" = "allow" ] && _T_FAIL_TO=ready
  _T_OUT="$(GAFFER_DATA="$GAFFER_DATA" DISPATCH_DB="$DISPATCH_DB" MEMORY_DB="$MEMORY_DB" GAFFER_TESTER_FAIL_TO="$_T_FAIL_TO" \
    node "$RUNNER_DIR/bin/tester-run.mjs" --ticket "$TNUM" --live 2>>"$GAFFER_DATA/tester.log")"; _trc=$?
  _T_PHASE="$(printf '%s' "$_T_OUT" | jget 'd.phase || ""' 2>/dev/null || echo '')"
  _T_VERDICT="$(printf '%s' "$_T_OUT" | jget 'd.verdict || ""' 2>/dev/null || echo '')"
  _T_BRANCH="$(printf '%s' "$_T_OUT" | jget 'd.testsBranch || ""' 2>/dev/null || echo '')"
  case "$_T_PHASE" in
    verdict)
      _T_NOW="$(wg ticket show "$TNUM" 2>/dev/null | jget 'd.ticket.status' 2>/dev/null || echo '?')"
      log "TESTER: #$TNUM verdict=${_T_VERDICT} recorded${_T_BRANCH:+ (tests kept on $_T_BRANCH)} → $_T_NOW"
      [ "$_T_NOW" = "ready" ] && log "TESTER: #$TNUM FAIL re-queued for REWORK with the tester's observation as feedback (autonomous; the retry cap parks at the threshold)"
      ;;
    held)    log "TESTER: #$TNUM HELD in_testing — the tester produced no verdict token (rc=$_trc); a human decides${_T_BRANCH:+ (tests kept on $_T_BRANCH)}" ;;
    *)       log "TESTER: #$TNUM tester did not run cleanly (rc=$_trc, phase=${_T_PHASE:-none}) — left in_testing for a human; see tester.log" ;;
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
