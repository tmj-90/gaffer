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
# dispatch api bin. A missing or stale PID file degrades gracefully to "not running";
# the port's listener (gaffer_dashboard_find below) covers a server whose PID file is
# gone, so a crashed/old PID never wedges things and never hides a running server.

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

# ── Who holds the port, and stopping a server ───────────────────────────────
# `gaffer dashboard --restart` / `--stop` must find the server even when the PID file
# is missing, stale or garbage (a crash, a deleted file, a --foreground server): the
# port's listener is the next place to look, and it is only ever stopped when its
# command line IS the dispatch api bin (the same marker check as the PID file).

# gaffer_port_listener_pid <port> — the PID listening on TCP <port> (lsof, then ss, then
# fuser), or nothing + rc 1 when none is found or no tool can tell.
gaffer_port_listener_pid() {
  local port="$1" p=""
  case "$port" in ''|*[!0-9]*) return 1 ;; esac
  if command -v lsof >/dev/null 2>&1; then
    p="$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -1)"
  fi
  if [ -z "$p" ] && command -v ss >/dev/null 2>&1; then
    p="$(ss -ltnpH "sport = :$port" 2>/dev/null | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -1)"
  fi
  if [ -z "$p" ] && command -v fuser >/dev/null 2>&1; then
    p="$(fuser -n tcp "$port" 2>/dev/null | tr -s ' \t' '\n' | sed -n 's/^\([0-9][0-9]*\).*/\1/p' | head -1)"
  fi
  case "$p" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$p"
}

# gaffer_port_bind_check <host> <port> — try the bind the server is about to make.
# 0 = free; 1 = taken (prints the error code, e.g. EADDRINUSE); 0 as well when node
# cannot run the probe (the server then reports for itself).
gaffer_port_bind_check() {
  command -v node >/dev/null 2>&1 || return 0
  node -e '
    const s = require("net").createServer();
    s.once("error", (e) => { process.stdout.write(String(e.code || e.message)); process.exit(1); });
    s.listen(Number(process.argv[2]), process.argv[1], () => s.close(() => process.exit(0)));
  ' "$1" "$2" 2>/dev/null
}

# _gaffer_pid_data_dir <pid> — the GAFFER_DATA in <pid>'s environment, when the OS
# shows it (Linux /proc, macOS `ps -E` for our own processes); nothing otherwise.
_gaffer_pid_data_dir() {
  local pid="$1" v=""
  if [ -r "/proc/$pid/environ" ]; then
    v="$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | sed -n 's/^GAFFER_DATA=//p' | head -1)"
  elif [ "$(uname -s 2>/dev/null)" = Darwin ]; then
    v="$(ps -E -ww -o command= -p "$pid" 2>/dev/null | tr ' ' '\n' | sed -n 's/^GAFFER_DATA=//p' | head -1)"
  fi
  printf '%s' "$v"
}

# gaffer_dashboard_find <port> — "<pid> pidfile" for the recorded dashboard, else
# "<pid> port" for a dispatch api server listening on <port> with no (valid) PID file,
# else "<pid> other <its GAFFER_DATA>" when that server visibly belongs to ANOTHER
# factory (a different GAFFER_DATA — never stopped from here). Nothing + rc 1 when the
# port is free or held by something that is not a dispatch api server.
gaffer_dashboard_find() {
  local pid dd mine
  if pid="$(gaffer_dashboard_pid 2>/dev/null)"; then printf '%s pidfile\n' "$pid"; return 0; fi
  if pid="$(gaffer_port_listener_pid "$1")" && _gaffer_dashboard_pid_is_ours "$pid"; then
    dd="$(_gaffer_pid_data_dir "$pid")"
    if [ -n "$dd" ]; then
      mine="$(cd "$GAFFER_DATA" 2>/dev/null && pwd -P)"
      [ "$(cd "$dd" 2>/dev/null && pwd -P)" = "$mine" ] || { printf '%s other %s\n' "$pid" "$dd"; return 0; }
    fi
    printf '%s port\n' "$pid"; return 0
  fi
  return 1
}

# gaffer_dashboard_stop_pid <pid> — SIGTERM, up to 5 s for a clean exit (an open
# browser stream can hold server.close() open), then SIGKILL. 0 once it is gone.
gaffer_dashboard_stop_pid() {
  local pid="$1" i=0
  kill -0 "$pid" 2>/dev/null || return 0
  kill "$pid" 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
    i=0; while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 20 ]; do sleep 0.1; i=$((i + 1)); done
  fi
  ! kill -0 "$pid" 2>/dev/null
}

# gaffer_dashboard_pidfile_state — what the PID file says, for `gaffer status`:
# "missing", "running <pid>", or "stale <first 20 chars of its content>".
gaffer_dashboard_pidfile_state() {
  local f pid
  f="$(gaffer_dashboard_pidfile)"
  [ -s "$f" ] || { echo "missing"; return 0; }
  if pid="$(gaffer_dashboard_pid 2>/dev/null)"; then echo "running $pid"; return 0; fi
  pid="$(head -c 20 "$f" 2>/dev/null | tr -d ' \t\r\n')"
  echo "stale ${pid:-?}"
}

# Env flags (`-u KEY …`) that strip CONFIG-DERIVED setting values from the dashboard
# process's environment. `gaffer dashboard` sources factory.config.sh, which exports
# settings.json values and `:=` defaults for many UI-editable keys; inherited as env,
# the dashboard reported every one of them "set by env" and refused UI edits (15
# settings were locked that way). Only a key the OPERATOR had in the environment
# before the config ran (_GAFFER_ENV_AT_SOURCE) is a real override and stays. The
# dashboard re-applies settings.json to its own env at startup (applySettingsToEnv),
# so nothing is lost — it just stops mistaking its own defaults for locks. The six
# tick-only knobs are always unset, as before. With no dispatch dist the list is just
# those six (there is no server to launch either). A dist that IS there but cannot be
# read is NOT silently skipped: that regression (a static `import … from
# process.argv[1]`, a syntax error swallowed by `|| true`) left 18 settings locked and
# made every saved setting read-only after the next restart. It now warns on stderr.
gaffer_dashboard_setting_keys() {
  local _settings_js="${1:?settings.js path}"
  # A dynamic import: a static `import` needs a string-literal specifier.
  node --input-type=module -e '
    import { pathToFileURL } from "node:url";
    const { SETTING_DEFS } = await import(pathToFileURL(process.argv[1]).href);
    if (!Array.isArray(SETTING_DEFS) || SETTING_DEFS.length === 0) {
      console.error("SETTING_DEFS is empty");
      process.exit(3);
    }
    for (const d of SETTING_DEFS) console.log(d.key);
  ' "$_settings_js"
}

gaffer_dashboard_env_unset_flags() {
  local _flags="-u GAFFER_TICK_TIMEOUT -u GAFFER_MAX_TURNS -u GAFFER_PLAN_DEBATE -u GAFFER_PLAN_DEBATE_MODELS -u GAFFER_PLAN_DEBATE_MAX_ROUNDS -u GAFFER_PLAN_DEBATE_MIN_ESTIMATE"
  local _settings_js="${DISPATCH_DIR:-}/dist/api/settings.js" _k _keys
  if [ -f "$_settings_js" ] && command -v node >/dev/null 2>&1; then
    if ! _keys="$(gaffer_dashboard_setting_keys "$_settings_js")" || [ -z "$_keys" ]; then
      printf 'gaffer: could not read the setting keys from %s — settings the config defaulted will show as env-locked in the dashboard (rebuild: pnpm -C packages/dispatch build)\n' "$_settings_js" >&2
      _keys=""
    fi
    while IFS= read -r _k; do
      [ -n "$_k" ] || continue
      case " ${_GAFFER_ENV_AT_SOURCE:-} " in *" $_k "*) continue ;; esac   # operator override → keep
      case "$_flags" in *" -u $_k"*|*"-u $_k "*) continue ;; esac
      _flags="$_flags -u $_k"
    done <<< "$_keys"
  fi
  # Bounds the config DERIVED from those tick-only knobs (attempts × GAFFER_TICK_TIMEOUT
  # + margin) go too, unless the operator set them: inherited, they kept the
  # launcher's figure while the knob they came from was dropped — an operator's
  # GAFFER_TICK_TIMEOUT=120 left every dashboard-spawned tick with a 480s outer bound
  # under a 1800s per-call cap, so the deadline guard refused every in-tick rework.
  for _k in GAFFER_TICK_OUTER_TIMEOUT GAFFER_CLAIM_TTL; do
    case " ${_GAFFER_ENV_AT_SOURCE:-} " in *" $_k "*) ;; *) _flags="$_flags -u $_k" ;; esac
  done
  # The re-source bookkeeping (factory.config.sh) is the launcher's, not the
  # server's: the dashboard is a fresh root for the processes it spawns.
  _flags="$_flags -u _GAFFER_OPERATOR_ENV -u _GAFFER_MODE_WARNED"
  while IFS= read -r _k; do
    [ -n "$_k" ] && _flags="$_flags -u $_k"
  done < <(compgen -v _GAFFER_DV_ 2>/dev/null)
  printf '%s' "$_flags"
}
