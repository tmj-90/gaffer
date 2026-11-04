#!/usr/bin/env bash
# runner/lib/tick-helpers.sh
# Small shared helpers of one tick: the deadline clock, the locked per-run skip,
# marker and backpressure appends, the dry-run preview list and the setup-error exit.
#
# Sourced by runner/tick.sh only (required there: a missing file fails the tick
# closed). Function definitions only, so sourcing it runs nothing. Every body was
# moved verbatim out of tick.sh; the functions read and write tick.sh's globals
# (NUM, SHOW, WT_ROWS, CLAIM_TOKEN, ...) exactly as the inline code did, and the
# gaffer_tick_* / _gaffer_idle_* wrappers declare no locals, so every assignment in
# them stays global. See runner/CLAUDE.md for the map of the tick phases.

# Seconds left before the outer bound, less GAFFER_TICK_DEADLINE_MARGIN. Prints a huge
# number when there is no outer bound (0 = unbounded) or the guard is off.
gaffer_tick_remaining() {
  local _ob="${GAFFER_TICK_OUTER_TIMEOUT:-0}" _m="${GAFFER_TICK_DEADLINE_MARGIN:-60}"
  case "$_ob" in ''|*[!0-9]*) _ob=0 ;; esac
  case "$_m" in ''|*[!0-9]*) _m=60 ;; esac
  if [ "$_ob" -le 0 ] || [ "${GAFFER_TICK_DEADLINE_GUARD:-1}" = "0" ]; then echo 999999999; return 0; fi
  echo $(( _GAFFER_TICK_T0 + _ob - _m - $(date +%s) ))
}

# Append a ticket number to the per-run skip-file under .skip.lock so concurrent
# workers never lose or corrupt an entry (the skip-file stops one bad ticket
# starving the queue; a lost entry would let it be re-claimed forever).
gaffer_skip_ticket() { _gaffer_locked .skip.lock _gaffer_skip_ticket_unlocked "$1"; }
_gaffer_skip_ticket_unlocked() { echo "$1" >> "$SKIP_FILE"; }
# Generic locked single-line append: _gaffer_append_line <file> <line>. Used for
# the per-run reviewed/clarified marker files (same .skip.lock domain — they're
# all per-run bookkeeping appends).
_gaffer_append_line() { echo "$2" >> "$1"; }
# Locked backpressure-report append: _gaffer_bp_record <file> <repo> <triple> <reason>.
_gaffer_bp_record() { printf '%s\t%s\t%s\n' "$2" "$3" "$4" >> "$1"; }

# DRY RUN preview list (loop.sh exports GAFFER_DRY_PREVIEWED_FILE and empties it at the
# start of a dry run): a ticket previewed once this run is not previewed again.
# Unset (a hand-run dry tick, a dashboard Poll) → no list, every tick previews.
gaffer_dry_previewed() {
  [ "${DRY_RUN:-0}" = "1" ] && [ -n "${GAFFER_DRY_PREVIEWED_FILE:-}" ] && [ -f "$GAFFER_DRY_PREVIEWED_FILE" ] \
    && grep -qxF -- "$1" "$GAFFER_DRY_PREVIEWED_FILE"
}
gaffer_dry_mark_previewed() {
  [ -n "${GAFFER_DRY_PREVIEWED_FILE:-}" ] || return 0
  printf '%s\n' "$1" >> "$GAFFER_DRY_PREVIEWED_FILE" 2>/dev/null || true
}
# SETUP ERROR: one exit for every fail-closed SETUP failure (no agent launched: the
# dispatch CLI unbuilt, no timeout primitive, an unregistrable agent, the safety hook /
# agent env / DB vars / MCP or prompt render refusing). These used to `exit 1` with
# `error`: the crash trap then released the claim as "runner killed mid-delivery" (no
# kill happened), the ticket was re-claimed on the very next tick, and one broken
# install burned the whole MAX_TICKS_PER_DAY on claim/teardown churn. Now the claim is
# released (or a resume re-paused) with the REAL reason, the ticket is skipped for the
# run, the cause is written to $GAFFER_DATA/.setup-error for the loop / daemon, and the
# tick reports `setup_error` — which loop.sh / worker.sh treat as "stop this run" and
# the daemon backs off on (lib/daemon.sh). $1 = tag (SAFETY, MCP-RENDER, …), $2 = msg.
gaffer_abort_setup() {
  local tag="$1" msg="$2"
  log "$tag: $msg"
  _GAFFER_EXIT_CAUSE="setup error: $tag"
  ( umask 077; printf '%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$tag" "$msg" > "$GAFFER_DATA/.setup-error" ) 2>/dev/null || true
  if [ -n "${NUM:-}" ]; then
    if [ "${_RESUMING:-0}" = "1" ] && declare -F gaffer_resume_abort >/dev/null 2>&1; then
      gaffer_resume_abort "setup error: $tag — $msg"
    elif [ -n "${CLAIM_TOKEN:-}" ] && [ "${GAFFER_CLAIM_RESOLVED:-0}" != "1" ] \
         && declare -F gaffer_release_delivery >/dev/null 2>&1; then
      gaffer_release_delivery ready "setup error: $tag — $msg (no agent was launched)"
    fi
    [ -n "${SKIP_FILE:-}" ] && gaffer_skip_ticket "$NUM"
  fi
  result setup_error
  exit 1
}
