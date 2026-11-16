# shellcheck shell=bash
# runner/lib/helper-servers.sh: the tick's helper servers (config/17-cli.sh says what they
# are; wg and gaffer_json there call into this file). Sourced by config/19-libs.sh. Every
# function here runs only under bash 4.4 or later (gaffer_wg_serve_start refuses to start a
# server on an older bash, and the clients run only once a server is up), so it may use
# associative arrays and `exec {fd}<>`, which the bash 3.2 config parts may not.

# Remove the server dirs of ticks that are gone (named <pid>.<random>).
_gaffer_wg_serve_sweep() {
  local _root="$GAFFER_DATA/wg-serve" _d _pid
  [ -d "$_root" ] || return 0
  for _d in "$_root"/*.*; do
    [ -d "$_d" ] && [ ! -L "$_d" ] || continue
    _pid="${_d##*/}"; _pid="${_pid%%.*}"
    case "$_pid" in ''|*[!0-9]*) continue ;; esac
    [ "$_pid" = "$$" ] && continue
    kill -0 "$_pid" 2>/dev/null && continue
    rm -rf "$_d" 2>/dev/null || true
  done
  return 0
}

# Close every inherited fd above 2 (a server must not hold a tick's lock fds or the
# pipe of a `$(...)` it was started under).
_gaffer_wg_close_fds() {
  local _f _n
  for _f in /dev/fd/*; do
    _n="${_f##*/}"
    case "$_n" in ''|*[!0-9]*) continue ;; esac
    [ "$_n" -gt 2 ] && eval "exec $_n>&-" 2>/dev/null
  done
  return 0
}

# THE TICK KEY. The pipe directories are 0700, which stops no process of the same user,
# and the agent runs as the tick's user: without more, agent code that finds a request
# FIFO (GAFFER_DATA is in its environment) could have the dispatch server run a
# control-plane command, with a one-liner the safety hook does not recognise as a write.
# So every message on a request FIFO ends with this key: 128 bits from /dev/urandom, made
# once per tick, kept ONLY in this shell's memory (a plain variable, never exported, so
# no child gets it in its environment; never in an argv or a file) and handed to each
# server through a pipe on its stdin. The servers ignore any line without it. Requests
# are only in flight while the tick itself makes a call, never while the agent runs.
# Sets _GAFFER_WG_KEY; returns 1 (no servers start) when there is no randomness.
_gaffer_wg_new_key() {
  local _k=""
  _k="$(od -An -N16 -tx1 /dev/urandom 2>/dev/null)" || return 1
  _k="${_k//[!0-9a-f]/}"
  [ "${#_k}" -eq 32 ] || return 1
  _GAFFER_WG_KEY="$_k"
}

# Start one server: <script> <dir var> <pid var>. Prints nothing; on any failure the
# vars stay empty and those calls run one-shot. The server reads the tick key from its
# stdin (a process substitution: a pipe, never a file) and refuses to serve without it.
_gaffer_srv_start() {
  local _bin="$1" _dirvar="$2" _pidvar="$3" _dir
  [ -f "$_bin" ] || return 0
  [ "${#_GAFFER_WG_KEY}" -eq 32 ] || return 0
  _dir="$(mktemp -d "$GAFFER_DATA/wg-serve/$$.XXXXXX" 2>/dev/null)" || return 0
  chmod 700 "$_dir" 2>/dev/null && mkfifo -m 600 "$_dir/req" 2>/dev/null || { rm -rf "$_dir"; return 0; }
  ( _gaffer_wg_close_fds; exec "$_GAFFER_WG_NODE" "$_bin" --fifo "$_dir" --owner-pid "$$" < <(printf '%s\n' "$_GAFFER_WG_KEY") ) </dev/null >/dev/null 2>&1 &
  printf -v "$_pidvar" '%s' "$!"
  printf -v "$_dirvar" '%s' "$_dir"
  return 0
}

# Start this tick's servers (tick.sh calls it once, from its main shell, after the
# traps are in place). Never fails the tick: what cannot start stays one-shot.
gaffer_wg_serve_start() {
  [ "${GAFFER_WG_SERVE:-1}" = 1 ] || return 0
  [ -z "${_GAFFER_WG_PID:-}${_GAFFER_JS_PID:-}" ] || return 0
  [ "${BASH_VERSINFO[0]:-0}" -gt 4 ] || { [ "${BASH_VERSINFO[0]:-0}" -eq 4 ] && [ "${BASH_VERSINFO[1]:-0}" -ge 4 ]; } || return 0
  # A subshell cannot hand the pids back to the shell whose traps stop the servers.
  [ "$BASHPID" = "$$" ] || return 0
  local _n
  _GAFFER_WG_NODE="$(type -P node 2>/dev/null)" || return 0
  [ -n "$_GAFFER_WG_NODE" ] || return 0
  ( umask 077 && mkdir -p "$GAFFER_DATA/wg-serve" ) 2>/dev/null || return 0
  chmod 700 "$GAFFER_DATA/wg-serve" 2>/dev/null || return 0
  _gaffer_wg_serve_sweep
  _GAFFER_WG_KEY=""
  _gaffer_wg_new_key || return 0
  # The environment the servers start with; each request sends its change from this.
  declare -gA _GAFFER_WG_ENV0=()
  for _n in $(compgen -e); do [ "$_n" = _ ] || _GAFFER_WG_ENV0[$_n]="${!_n}"; done
  _GAFFER_WG_PATH="$PATH"
  _GAFFER_WG_N=0
  if gaffer_assert_db_vars >/dev/null 2>&1; then
    _gaffer_srv_start "${_GAFFER_WG_SERVE_BIN:-$DISPATCH_DIR/dist/cli/serve.js}" _GAFFER_WG_DIR _GAFFER_WG_PID
  fi
  _gaffer_srv_start "${_GAFFER_JS_SERVE_BIN:-$RUNNER_DIR/lib/json-serve.mjs}" _GAFFER_JS_DIR _GAFFER_JS_PID
  return 0
}

# Stop one server: <pid> <dir>. Asks it to stop (Q), kills what does not.
_gaffer_srv_stop() {
  local _pid="$1" _dir="$2" _i
  [ -n "$_pid" ] || return 0
  [ -p "$_dir/req" ] && printf 'Q %s\n' "$_GAFFER_WG_KEY" 2>/dev/null 1<>"$_dir/req"
  for _i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    kill -0 "$_pid" 2>/dev/null || break
    sleep 0.1
  done
  kill -KILL "$_pid" 2>/dev/null || true
  wait "$_pid" 2>/dev/null || true
  [ -n "$_dir" ] && rm -rf "$_dir" 2>/dev/null
  return 0
}

# Stop them (the tick's EXIT/INT/TERM handlers, after the crash cleanup, which still
# makes wg calls). Idempotent.
gaffer_wg_serve_stop() {
  [ -n "${_GAFFER_WG_PID:-}${_GAFFER_JS_PID:-}" ] || return 0
  [ "$BASHPID" = "$$" ] || return 0
  local _wp="${_GAFFER_WG_PID:-}" _jp="${_GAFFER_JS_PID:-}"
  _GAFFER_WG_PID=""; _GAFFER_JS_PID=""
  _gaffer_srv_stop "$_wp" "${_GAFFER_WG_DIR:-}"
  _gaffer_srv_stop "$_jp" "${_GAFFER_JS_DIR:-}"
  return 0
}

# A server that cannot be trusted any more: mark it (the marker reaches every subshell,
# not only this one) and kill it. <dir> <pid>
_gaffer_srv_broken() {
  : > "$1/broken" 2>/dev/null
  kill -KILL "$2" 2>/dev/null
  return 0
}

# 0 when a call may be sent to the server in <dir> (pid <pid>) now. Nothing is sent.
_gaffer_srv_usable() {
  # `ready`: the server holds its request FIFO open (a line written before that is lost
  # when its writer closes it); until then calls run one-shot.
  [ -p "$1/req" ] && [ -e "$1/ready" ] && [ ! -e "$1/broken" ] || return 1
  kill -0 "$2" 2>/dev/null || return 1
  # Commander sizes help and usage errors to a terminal (json-tool colours for one);
  # node is found through PATH.
  if [ -t 1 ] || [ -t 2 ] || [ "$PATH" != "${_GAFFER_WG_PATH:-}" ]; then return 1; fi
  return 0
}

# A fresh request id (this process, a counter, a random number) in _GAFFER_SRV_NONCE.
_gaffer_srv_nonce() {
  _GAFFER_WG_N=$(( ${_GAFFER_WG_N:-0} + 1 ))
  _GAFFER_SRV_NONCE="$BASHPID.$_GAFFER_WG_N.$RANDOM"
}

# Send one call: <dir> <pid> <timeout s> <argv...>, as request _GAFFER_SRV_NONCE (a
# stdin file the caller put at <dir>/i.<nonce> goes with it). Sets _GAFFER_SRV_STATE:
#   notsent  nothing was sent (the caller runs the call one-shot)
#   notrun   the server answered that it did not run it (likewise)
#   failed   sent, and the server died, hung, answered garbage or lost a reply file; the
#            call may have run. _GAFFER_SRV_WHY says what happened.
#   ran      answered: _GAFFER_SRV_RC is the exit code, _GAFFER_SRV_SEGS the output
#            segments (every file present; _gaffer_srv_print prints them).
_gaffer_srv_send() {
  local __gwg_dir="$1" __gwg_pid="$2" __gwg_wait="$3"
  shift 3
  local __gwg_info __gwg_um __gwg_n __gwg_nonce="$_GAFFER_SRV_NONCE" __gwg_fd
  local __gwg_line="" __gwg_part __gwg_rc __gwg_end __gwg_i __gwg_seg
  local -a __gwg_set=() __gwg_unset=()
  local -A __gwg_seen=()
  local IFS=$' \t\n'
  _GAFFER_SRV_STATE=notsent; _GAFFER_SRV_WHY=""; _GAFFER_SRV_RC=1; _GAFFER_SRV_SEGS="-"
  __gwg_info="$(umask; compgen -e)" || return 0
  __gwg_um="${__gwg_info%%$'\n'*}"
  for __gwg_n in ${__gwg_info#*$'\n'}; do
    # `_` is the shell's last argument; a child gets the command's path there, and the
    # server got the same node path when it started.
    [ "$__gwg_n" = "$__gwg_um" ] || [ "$__gwg_n" = _ ] && continue
    __gwg_seen[$__gwg_n]=1
    if [ -z "${_GAFFER_WG_ENV0[$__gwg_n]+x}" ] || [ "${_GAFFER_WG_ENV0[$__gwg_n]}" != "${!__gwg_n}" ]; then
      __gwg_set+=("$__gwg_n" "${!__gwg_n}")
    fi
  done
  for __gwg_n in "${!_GAFFER_WG_ENV0[@]}"; do
    [ -n "${__gwg_seen[$__gwg_n]+x}" ] || __gwg_unset+=("$__gwg_n")
  done
  {
    printf '%s\0' GWG1 "$__gwg_nonce" "${PWD:-}" "$__gwg_um" "$(( ${#__gwg_set[@]} / 2 ))"
    [ "${#__gwg_set[@]}" -gt 0 ] && printf '%s\0' "${__gwg_set[@]}"
    printf '%s\0' "${#__gwg_unset[@]}"
    [ "${#__gwg_unset[@]}" -gt 0 ] && printf '%s\0' "${__gwg_unset[@]}"
    printf '%s\0' "$#" "$@"
  } 2>/dev/null > "$__gwg_dir/q.$__gwg_nonce" || return 0
  mkfifo -m 600 "$__gwg_dir/r.$__gwg_nonce" 2>/dev/null || return 0
  [ -p "$__gwg_dir/r.$__gwg_nonce" ] || return 0
  exec {__gwg_fd}<>"$__gwg_dir/r.$__gwg_nonce" || return 0
  if ! printf '%s %s\n' "$__gwg_nonce" "$_GAFFER_WG_KEY" 2>/dev/null 1<>"$__gwg_dir/req"; then
    exec {__gwg_fd}<&-
    return 0
  fi
  # From here the request may have run.
  _GAFFER_SRV_STATE=failed
  __gwg_end=$(( SECONDS + __gwg_wait ))
  while :; do
    __gwg_part=""
    if IFS= read -r -t 1 -u "$__gwg_fd" __gwg_part; then
      __gwg_line+="$__gwg_part"
      break
    fi
    __gwg_rc=$?
    __gwg_line+="$__gwg_part"
    if [ "$__gwg_rc" -le 128 ]; then
      exec {__gwg_fd}<&-; _GAFFER_SRV_WHY="closed its reply"; return 0
    fi
    if ! kill -0 "$__gwg_pid" 2>/dev/null; then
      exec {__gwg_fd}<&-; _GAFFER_SRV_WHY="died during the call"; return 0
    fi
    if [ "$SECONDS" -ge "$__gwg_end" ]; then
      exec {__gwg_fd}<&-; _GAFFER_SRV_WHY="did not answer within ${__gwg_wait}s"; return 0
    fi
  done
  exec {__gwg_fd}<&-
  if [[ ! "$__gwg_line" =~ ^GWG1\ ([0-9.]+)\ (R\ ([0-9]{1,3})\ ([oeOE]{1,64}|-)|N\ ([a-z-]{1,32})|F)$ ]] \
     || [ "${BASH_REMATCH[1]}" != "$__gwg_nonce" ]; then
    _GAFFER_SRV_WHY="answered garbage"; return 0
  fi
  case "${BASH_REMATCH[2]}" in
    N\ *) _GAFFER_SRV_STATE=notrun; return 0 ;;
    F) _GAFFER_SRV_WHY="failed after the call started"; return 0 ;;
  esac
  __gwg_rc="${BASH_REMATCH[3]}"; __gwg_seg="${BASH_REMATCH[4]}"
  if [ "$__gwg_seg" != "-" ]; then
    for (( __gwg_i = 0; __gwg_i < ${#__gwg_seg}; __gwg_i++ )); do
      [ -f "$__gwg_dir/s.$__gwg_nonce.$__gwg_i" ] || { _GAFFER_SRV_WHY="lost a reply segment"; return 0; }
    done
  fi
  _GAFFER_SRV_STATE=ran; _GAFFER_SRV_RC="$__gwg_rc"; _GAFFER_SRV_SEGS="$__gwg_seg"
  return 0
}

# Print the segments of the call _gaffer_srv_send answered, in write order, and let the
# server remove its files. <dir>
_gaffer_srv_print() {
  local __gwp_dir="$1" __gwp_i __gwp_f __gwp_v __gwp_seg="$_GAFFER_SRV_SEGS"
  if [ "$__gwp_seg" != "-" ]; then
    for (( __gwp_i = 0; __gwp_i < ${#__gwp_seg}; __gwp_i++ )); do
      __gwp_f="$__gwp_dir/s.$_GAFFER_SRV_NONCE.$__gwp_i"
      case "${__gwp_seg:__gwp_i:1}" in
        o) __gwp_v=""; IFS= read -r -d '' __gwp_v < "$__gwp_f" || :; printf '%s' "$__gwp_v" ;;
        e) __gwp_v=""; IFS= read -r -d '' __gwp_v < "$__gwp_f" || :; printf '%s' "$__gwp_v" >&2 ;;
        # A NUL byte: bash cannot hold it in a variable.
        O) cat "$__gwp_f" ;;
        E) cat "$__gwp_f" >&2 ;;
      esac
    done
  fi
  _gaffer_srv_done "$__gwp_dir"
}

# Tell the server the caller is done with request _GAFFER_SRV_NONCE (it removes the files).
_gaffer_srv_done() {
  printf 'D %s %s\n' "$_GAFFER_SRV_NONCE" "$_GAFFER_WG_KEY" 2>/dev/null 1<>"$1/req"
  return 0
}

# The json-tool subcommands that read stdin (a test pins this list to json-tool.mjs).
# Only for these does a served call capture stdin (an expr reads it unless --file).
_gaffer_json_reads_stdin() {
  case "${1:-}" in
    expr) case " $* " in *" --file "*) return 1 ;; esac; return 0 ;;
    ac-check-rows|accepted-change|approval-actor|bootstrap-repo-name|branch-recorded|ci-check-rows|\
cleanup-owner|context-file-cards|context-primed|context-product|delivery-metric|diagnostics-warn|\
dod-cmd-map|entered-status-at|eval-summary|fields|inherit-amb-argv|inherit-amb-bin|inherit-amb-count|\
inherit-amb-field|inherit-links|latest-claim-id|loop-count|lore-drafts|numbers|numbers-joined|partition|\
pick-unskipped|\
quarantine|repo-matches|resolved-decisions|resume-pick|review-comments|review-feedback|\
smallest-change-note|status-acceptance-rows|status-count|status-hq-count|status-hq-lines|\
status-replay-holds|status-repo-lines|status-tester-counts|status-tester-holds|ticket-named-code|\
ticket-status|tsv-object|worktree-rows-json) return 0 ;;
  esac
  return 1
}

# A JSON helper call through the JSON server. json-tool only reads and prints, so any
# call the server does not answer is run one-shot (on the stdin captured for it).
_gaffer_json_served() {
  local __gjs_in="" __gjs_rc
  _gaffer_srv_nonce
  if _gaffer_json_reads_stdin "$@" && [ ! -t 0 ]; then
    __gjs_in="$_GAFFER_JS_DIR/i.$_GAFFER_SRV_NONCE"
    cat > "$__gjs_in" 2>/dev/null || { node "$RUNNER_DIR/lib/json-tool.mjs" "$@" < "$__gjs_in"; return; }
  fi
  _gaffer_srv_send "$_GAFFER_JS_DIR" "$_GAFFER_JS_PID" "$GAFFER_WG_SERVE_TIMEOUT" "$@"
  case "$_GAFFER_SRV_STATE" in
    ran) _gaffer_srv_print "$_GAFFER_JS_DIR"; return "$_GAFFER_SRV_RC" ;;
    failed) _gaffer_srv_broken "$_GAFFER_JS_DIR" "$_GAFFER_JS_PID" ;;
  esac
  if [ -n "$__gjs_in" ]; then
    node "$RUNNER_DIR/lib/json-tool.mjs" "$@" < "$__gjs_in"; __gjs_rc=$?
    [ "$_GAFFER_SRV_STATE" = notrun ] && _gaffer_srv_done "$_GAFFER_JS_DIR"
    [ "$_GAFFER_SRV_STATE" = notsent ] && rm -f "$__gjs_in"
    return "$__gjs_rc"
  fi
  [ "$_GAFFER_SRV_STATE" = notrun ] && _gaffer_srv_done "$_GAFFER_JS_DIR"
  node "$RUNNER_DIR/lib/json-tool.mjs" "$@"
}
