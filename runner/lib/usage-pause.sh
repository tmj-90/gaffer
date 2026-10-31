# shellcheck shell=bash
# Gaffer factory — USAGE-WINDOW PAUSE helpers (bash side of lib/usage-pause.mjs).
#
# A model call refused by the plan's usage window / a rate limit (lib/worker.mjs
# detectUsageLimit) writes $GAFFER_DATA/usage-pause.json; every admission point reads
# it and waits instead of spinning:
#   tick.sh      pre-claim gate (no claim, no spawn while paused) + the delivery path
#                that records the pause and releases the claim without an attempt
#   loop.sh      sleeps until the pause ends before admitting the next tick
#   worker.sh    a pool worker stops admitting (sleeps) until it ends
#   daemon.sh    `gaffer run --daemon` sleeps instead of starting a pass
#   status.sh    prints "paused until <time>: usage limit"
# The state, the timing rules and the floor live in usage-pause.mjs; these helpers
# only call it. Fail-soft on a missing node: no pause can be read, so none applies
# (the tick's own setup checks refuse to run without node anyway).

_GAFFER_UP_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${GAFFER_USAGE_PAUSE_MJS:=$_GAFFER_UP_LIB/usage-pause.mjs}"
# The classifier (parse-result usage-limit). Its own variable, not GAFFER_WORKER_MJS,
# so a test that points the pause store elsewhere still classifies with the real table.
: "${GAFFER_USAGE_WORKER_MJS:=$_GAFFER_UP_LIB/worker.mjs}"

# Run usage-pause.mjs with the pause store's settings handed over EXPLICITLY.
# factory.config.sh leaves GAFFER_DATA a plain, unexported shell variable
# (`: "${GAFFER_DATA:=$GAFFER_HOME/.gaffer}"`), so a node child that only read its
# environment saw no data dir: an operator's `gaffer run` from a plain shell recorded
# no pause (every refusal fell to the fail-closed skip) and read none. The same rule
# as every other runner node child: GAFFER_DATA="$GAFFER_DATA" on the command.
_gaffer_up_node() {
  env GAFFER_DATA="${GAFFER_DATA:-}" GAFFER_USAGE_PAUSE_FILE="${GAFFER_USAGE_PAUSE_FILE:-}" \
    GAFFER_USAGE_PAUSE_DEFAULT_MIN="${GAFFER_USAGE_PAUSE_DEFAULT_MIN:-}" node "$@"
}

# gaffer_usage_pause_record <json-file> <ticket> <lane>
# Exit 0 and echo the TSV record line (<until s>\t<ISO>\t<kind>\t<basis>\t<message>)
# when the captured envelope is a usage/rate-limit refusal and the pause was written;
# exit 1 when it is an ordinary result; exit 2 when it IS a refusal but the pause could
# not be written (the caller must then fail closed).
#
# Two steps, in this order, so a broken pause store can never turn an ordinary result
# into a "refusal":
#   1. CLASSIFY, without the lock: `worker.mjs parse-result usage-limit` (the same
#      parseResult the record step uses). Anything but exit 0 with the detection JSON
#      on stdout — exit 1 (not a refusal), a node crash, a lock-less CLI that printed
#      nothing — is an ordinary result (rc 1), and the caller takes the normal path
#      (review, the no-commit park, the attempt ladder). Only a confirmed refusal
#      goes on.
#   2. RECORD, under the lock (two pool workers that hit the limit together keep the
#      longer wait). Only now may a failure — a lock that could not be taken, a write
#      that failed, a crash — return 2.
gaffer_usage_pause_record() {
  local jf="$1" num="${2:-}" lane="${3:-delivery}" out rc
  [ -f "$jf" ] || return 1
  command -v node >/dev/null 2>&1 || return 1
  out="$(node "$GAFFER_USAGE_WORKER_MJS" parse-result usage-limit --json-file "$jf" 2>/dev/null)" || return 1
  case "$out" in "{"*) ;; *) return 1 ;; esac
  # `record` exits 10 for "not a refusal"; any other non-zero (a write failure, a
  # lock that could not be taken) is a refusal whose pause was NOT recorded.
  if declare -F gaffer_with_lock >/dev/null 2>&1 && [ -n "${GAFFER_DATA:-}" ]; then
    out="$(gaffer_with_lock "$GAFFER_DATA/.usage-pause.lock" _gaffer_up_node "$GAFFER_USAGE_PAUSE_MJS" record --json-file "$jf" ${num:+--ticket "$num"} --lane "$lane" 2>/dev/null)"; rc=$?
  else
    out="$(_gaffer_up_node "$GAFFER_USAGE_PAUSE_MJS" record --json-file "$jf" ${num:+--ticket "$num"} --lane "$lane" 2>/dev/null)"; rc=$?
  fi
  [ "$rc" -eq 10 ] && return 1
  [ "$rc" -eq 0 ] || return 2
  case "$out" in [0-9]*"	"*) printf '%s\n' "$out" ;; *) return 2 ;; esac
}

# gaffer_usage_pause_active — exit 0 (and echo "paused until <time>: <kind>") while a
# pause is in force; exit 1 otherwise.
gaffer_usage_pause_active() {
  local line
  command -v node >/dev/null 2>&1 || return 1
  line="$(_gaffer_up_node "$GAFFER_USAGE_PAUSE_MJS" status 2>/dev/null)" || return 1
  case "$line" in "paused until "*) printf '%s\n' "$line" ;; *) return 1 ;; esac
}

# gaffer_usage_pause_until — echo the pause's end (epoch seconds); exit 1 when none.
gaffer_usage_pause_until() {
  local s
  command -v node >/dev/null 2>&1 || return 1
  s="$(_gaffer_up_node "$GAFFER_USAGE_PAUSE_MJS" until 2>/dev/null)" || return 1
  case "$s" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$s"
}

# gaffer_usage_pause_wait [stop-check-fn]
# Sleep until the pause ends, re-reading the file at most every
# GAFFER_USAGE_PAUSE_POLL_SECS (default 60) so a human who clears it early is
# honoured within that time, and a pause another worker extended is waited out too.
# Interruptible: each slice is `sleep & wait`, so a trapped stop signal returns at
# once; when <stop-check-fn> is given and returns 0 the wait ends early (rc 1).
# Returns 0 once no pause is in force.
gaffer_usage_pause_wait() {
  local stop_fn="${1:-}" poll="${GAFFER_USAGE_PAUSE_POLL_SECS:-60}" until now left
  case "$poll" in ''|*[!0-9]*|0) poll=60 ;; esac
  while until="$(gaffer_usage_pause_until)"; do
    [ -n "$stop_fn" ] && "$stop_fn" && return 1
    now="$(date +%s)"
    left=$(( until - now ))
    [ "$left" -gt 0 ] 2>/dev/null || left=1
    [ "$left" -gt "$poll" ] && left="$poll"
    sleep "$left" &
    wait "$!" 2>/dev/null || true
    [ -n "$stop_fn" ] && "$stop_fn" && return 1
  done
  return 0
}
