# shellcheck shell=bash
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
#   GAFFER_DAEMON_SETUP_BACKOFF_MAX  ceiling (seconds) of the setup-error back-off (default 1800)
#
# SETUP-ERROR BACK-OFF: loop.sh exits 3 when a tick hit a fail-closed SETUP error (an
# unbuilt CLI, a broken template, a missing safety hook — $GAFFER_DATA/.setup-error
# names it). Re-running it every interval would claim, set up, tear down and release
# the same ticket forever, so the wait doubles per consecutive setup-error pass (from
# the interval up to the ceiling) and resets on the first pass that gets past setup.
# Reads gaffer_day_cap_ok / MAX_TICKS_PER_DAY from budget.sh when available.
#
# FRESH CONFIG PER PASS: with GAFFER_DAEMON_CONFIG naming factory.config.sh (`gaffer run
# --daemon` sets it), the cap check runs in a FRESH bash that re-sources the config, so
# a dashboard edit to MAX_TICKS_PER_DAY / GAFFER_DAILY_BUDGET_USD applies to the very
# next pass instead of the values the daemon read when it started. (Each pass's loop.sh
# is a child process and re-sources the config itself.) Unset, the caps are read from
# this shell, as before (the unit test's stubbed caps).

# Echo why today's caps refuse a pass and return 1, or return 0 when a pass may run.
_gaffer_daemon_cap_check() {
  if [ "${_GAFFER_SETTINGS_UNREADABLE:-0}" != 0 ]; then
    # settings.json exists but does not parse (or node is missing): the caps it holds
    # cannot be read, so no pass runs until it is fixed (factory.config.sh FAIL CLOSED).
    printf 'gaffer daemon: settings.json (%s) cannot be read — idle until it parses again\n' "${GAFFER_DATA:-.}/settings.json"
    return 1
  elif declare -F gaffer_day_cap_ok >/dev/null 2>&1 && ! gaffer_day_cap_ok; then
    printf 'gaffer daemon: per-day cap (MAX_TICKS_PER_DAY=%s) reached — idle until the next calendar day\n' "${MAX_TICKS_PER_DAY:-}"
    return 1
  elif declare -F gaffer_day_usd_cap_ok >/dev/null 2>&1 && ! gaffer_day_usd_cap_ok; then
    # Part B: per-UTC-day USD ceiling. Same graceful back-off as the tick-count cap
    # — idle (no new loop pass) until the next calendar day rolls the window over.
    printf 'gaffer daemon: per-day USD cap (GAFFER_DAILY_BUDGET_USD=%s) reached — idle until the next calendar day\n' "${GAFFER_DAILY_BUDGET_USD:-}"
    return 1
  elif declare -F gaffer_budget_headroom_ok >/dev/null 2>&1 && ! gaffer_budget_headroom_ok; then
    # The lifetime ceiling never rolls over: idle until the operator raises it.
    printf 'gaffer daemon: lifetime budget (GAFFER_BUDGET_USD=%s) exhausted — idle until it is raised\n' "${GAFFER_BUDGET_USD:-}"
    return 1
  fi
  return 0
}

# Run _gaffer_daemon_cap_check against the CURRENT config (see FRESH CONFIG PER PASS).
_gaffer_daemon_caps_ok() {
  local cfg="${GAFFER_DAEMON_CONFIG:-}"
  if [ -n "$cfg" ] && [ -f "$cfg" ]; then
    # A fresh process, not a subshell: a subshell keeps this shell's unexported
    # defaults, which would shadow a value newly saved to settings.json.
    bash -c 'source "$1" >/dev/null 2>&1; '"$(declare -f _gaffer_daemon_cap_check)"'; _gaffer_daemon_cap_check' _ "$cfg" >&2
  else
    _gaffer_daemon_cap_check >&2
  fi
}

gaffer_run_daemon() {
  local interval="${1:-30}"
  local loop_sh="${GAFFER_LOOP_SH:-${RUNNER_DIR:-.}/loop.sh}"
  local max="${GAFFER_DAEMON_MAX_CYCLES:-0}"
  local cycles=0 passes=0 rc=0 setup_fails=0 wait_s backoff_max
  backoff_max="${GAFFER_DAEMON_SETUP_BACKOFF_MAX:-1800}"
  case "$backoff_max" in ''|*[!0-9]*) backoff_max=1800 ;; esac
  _GAFFER_DAEMON_STOP=0
  # A stop signal finishes the current pass, then exits — graceful, never mid-delivery.
  trap '_GAFFER_DAEMON_STOP=1' INT TERM
  while [ "$_GAFFER_DAEMON_STOP" = "0" ]; do
    if _gaffer_daemon_caps_ok; then
      bash "$loop_sh"; rc=$?
      passes=$((passes + 1))
      if [ "$rc" -eq 3 ]; then setup_fails=$((setup_fails + 1)); else setup_fails=0; fi
    fi
    cycles=$((cycles + 1))
    [ "$_GAFFER_DAEMON_STOP" = "1" ] && break
    [ "$max" -gt 0 ] 2>/dev/null && [ "$cycles" -ge "$max" ] && break
    wait_s="$interval"
    if [ "$setup_fails" -gt 0 ]; then
      local _k=1
      case "$interval" in ''|*[!0-9]*) wait_s=1 ;; esac   # fractional/odd interval: double from 1s
      [ "$wait_s" -ge 1 ] || wait_s=1
      while [ "$_k" -lt "$setup_fails" ] && [ "$wait_s" -lt "$backoff_max" ]; do wait_s=$((wait_s * 2)); _k=$((_k + 1)); done
      [ "$wait_s" -gt "$backoff_max" ] && wait_s="$backoff_max"
      printf 'gaffer daemon: setup error (%s) — %s consecutive pass(es) stopped before any agent ran; next pass in %ss\n' \
        "$(cut -f2- "${GAFFER_DATA:-.}/.setup-error" 2>/dev/null | head -1 | tr '\t' ' ' | cut -c1-200)" "$setup_fails" "$wait_s" >&2
    fi
    # Interruptible sleep: a stop signal during the wait returns immediately, so the
    # daemon never waits out a whole interval after being told to stop.
    sleep "$wait_s" &
    wait "$!" 2>/dev/null || true
  done
  printf 'gaffer daemon: stopped (%s pass(es) run)\n' "$passes" >&2
  return 0
}
