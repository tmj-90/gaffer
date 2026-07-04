# Gaffer AFK daemon (C1) — the portable "walk away and it keeps working" loop.
#
# runner/loop.sh is a SINGLE supervisor pass: it drains the ready queue (honouring the
# per-day cap gaffer_day_cap_ok) and EXITS when the queue is empty or the cap is hit.
# To actually loop unattended it must be RE-RUN — on macOS a launchd/AFK path did that,
# but on Linux nothing did, so "walk away" was broken there. gaffer_run_daemon is a
# platform-agnostic supervisor: re-run the loop every N seconds, honouring the same
# per-day cap, until a stop signal — SIGINT/SIGTERM finish the CURRENT pass (never kill
# a delivery mid-flight) and then exit cleanly.
#
# Env / knobs:
#   $1                       sleep seconds between passes (default 30)
#   GAFFER_LOOP_SH           the supervisor script to run (default $RUNNER_DIR/loop.sh)
#   GAFFER_DAEMON_MAX_CYCLES test-only bound on total cycles (0 = run until signalled)
# Reads gaffer_day_cap_ok / MAX_TICKS_PER_DAY from budget.sh when available.

gaffer_run_daemon() {
  local interval="${1:-30}"
  local loop_sh="${GAFFER_LOOP_SH:-${RUNNER_DIR:-.}/loop.sh}"
  local max="${GAFFER_DAEMON_MAX_CYCLES:-0}"
  local cycles=0 passes=0
  _GAFFER_DAEMON_STOP=0
  # A stop signal finishes the current pass, then exits — graceful, never mid-delivery.
  trap '_GAFFER_DAEMON_STOP=1' INT TERM
  while [ "$_GAFFER_DAEMON_STOP" = "0" ]; do
    if declare -F gaffer_day_cap_ok >/dev/null 2>&1 && ! gaffer_day_cap_ok; then
      printf 'gaffer daemon: per-day cap (MAX_TICKS_PER_DAY=%s) reached — idle until the next calendar day\n' "${MAX_TICKS_PER_DAY:-}" >&2
    else
      bash "$loop_sh" || true
      passes=$((passes + 1))
    fi
    cycles=$((cycles + 1))
    [ "$_GAFFER_DAEMON_STOP" = "1" ] && break
    [ "$max" -gt 0 ] 2>/dev/null && [ "$cycles" -ge "$max" ] && break
    # Interruptible sleep: a stop signal during the wait returns immediately, so the
    # daemon never waits out a whole interval after being told to stop.
    sleep "$interval" &
    wait "$!" 2>/dev/null || true
  done
  printf 'gaffer daemon: stopped (%s pass(es) run)\n' "$passes" >&2
  return 0
}
