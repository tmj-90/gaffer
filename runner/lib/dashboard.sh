# Gaffer dashboard process tracking (sourced by factory.config.sh).
# shellcheck shell=bash
#
# The dashboard is the dispatch api server (packages/dispatch/dist/api/bin.js),
# launched detached by `gaffer dashboard`. To find / restart / report on it we used
# to `pgrep -f "dist/api/bin.js"`, which can match ANOTHER checkout's server or an
# unrelated process that merely has that string on its command line.
#
# Instead we record OUR server's PID in a file under $GAFFER_DATA and validate it
# before trusting it: the PID must be alive AND its command must actually be the
# dispatch api bin. A missing or stale PID file degrades gracefully to "not running"
# (the caller then starts a fresh server), so a crashed/old PID never wedges things.

# Path to the dashboard PID file under the factory's data dir.
gaffer_dashboard_pidfile() {
  printf '%s\n' "${GAFFER_DATA:?GAFFER_DATA unset}/dashboard.pid"
}

# Record a freshly-launched dashboard PID (0600). Best-effort — never fatal.
#   gaffer_dashboard_write_pid <pid>
gaffer_dashboard_write_pid() {
  local pid="$1" f
  f="$(gaffer_dashboard_pidfile)"
  ( umask 077; printf '%s\n' "$pid" > "$f" ) 2>/dev/null || true
}

# Marker substring that identifies the dispatch api server on a command line.
GAFFER_DASHBOARD_CMD_MARKER="${GAFFER_DASHBOARD_CMD_MARKER:-dist/api/bin.js}"

# Is <pid> a live process whose command is the dispatch api bin? Returns 0/1.
# Used to confirm a recorded PID is really OUR dashboard and not a recycled PID.
#   _gaffer_dashboard_pid_is_ours <pid>
_gaffer_dashboard_pid_is_ours() {
  local pid="$1" cmd
  [ -n "$pid" ] || return 1
  case "$pid" in *[!0-9]*) return 1 ;; esac   # digits only
  kill -0 "$pid" 2>/dev/null || return 1       # alive?
  # Confirm the command line is the dispatch api server (guards against PID reuse).
  cmd="$(ps -o command= -p "$pid" 2>/dev/null || ps -o args= -p "$pid" 2>/dev/null)"
  case "$cmd" in *"$GAFFER_DASHBOARD_CMD_MARKER"*) return 0 ;; *) return 1 ;; esac
}

# Echo the validated, live dashboard PID (from the PID file) or nothing. A missing,
# unreadable, non-numeric, dead, or mismatched PID yields empty output + rc 1, so a
# stale file is treated as "not running". Keep output to the single PID on success.
gaffer_dashboard_pid() {
  local f pid
  f="$(gaffer_dashboard_pidfile)"
  [ -s "$f" ] || return 1
  pid="$(tr -d ' \t\r\n' < "$f" 2>/dev/null)"
  if _gaffer_dashboard_pid_is_ours "$pid"; then printf '%s\n' "$pid"; return 0; fi
  return 1
}
