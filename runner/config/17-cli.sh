# shellcheck shell=bash
# runner/config/17-cli.sh: the CLI helpers: the dist bins, the DB-var fail-closed guard, wg / fg / lg
# and the JSON helpers.
# Sourced by runner/factory.config.sh only, in its fixed order, never directly or on
# its own: it reads what the parts before it set. Lines moved verbatim from
# factory.config.sh. The last line tells factory.config.sh this part loaded whole.

# CLI helpers (use the built dist bins)
# memory-mcp uses its own bin layout + the MEMORY_DB env var (no --db flag).
MEMORY_CLI_BIN="${MEMORY_CLI_BIN:-$MEMORY_DIR/dist/bin/memory.js}"
MEMORY_MCP_BIN="${MEMORY_MCP_BIN:-$MEMORY_DIR/dist/bin/memory-mcp.js}"
DISPATCH_MCP_BIN="${DISPATCH_MCP_BIN:-$DISPATCH_DIR/dist/mcp/bin.js}"   # substituted into .mcp.json by tick.sh

# --- DB-var fail-CLOSED guard (P1-B) -----------------------------------------
# The .mcp.json ships "${DISPATCH_DB}" / "${MEMORY_DB}" placeholders that
# tick.sh sed-substitutes, and the lg/wg wrappers + the memory server launch
# pass these through to the MCP servers. If either var is EMPTY/unset, the sed
# substitution writes a literal value and a stray DB file named e.g.
# `${MEMORY_DB}` gets created in cwd — and the MCP servers silently point at
# the wrong (empty-named) database. Fail CLOSED instead: assert both are
# non-empty before any consumption, with a clear, actionable error.
#
# Call this immediately before a sed-substitution of the MCP config OR before
# launching anything (lg/wg/memory server) that relies on these vars.
gaffer_assert_db_vars() {
  local missing=()
  [ -n "${DISPATCH_DB:-}" ] || missing+=("DISPATCH_DB")
  [ -n "${MEMORY_DB:-}" ]  || missing+=("MEMORY_DB")
  if [ "${#missing[@]}" -gt 0 ]; then
    printf 'gaffer: refusing to run — required DB var(s) empty/unset: %s\n' "${missing[*]}" >&2
    printf 'gaffer: set them (factory.config.sh defaults to $GAFFER_DATA/*.sqlite) so the MCP\n' >&2
    printf 'gaffer: servers point at a real database and no literal-named ${...} DB file is\n' >&2
    printf 'gaffer: created in the working directory.\n' >&2
    return 1
  fi
  return 0
}

wg() {
  gaffer_assert_db_vars || return 1
  if [ -n "${_GAFFER_WG_PID:-}" ] && _gaffer_srv_usable "$_GAFFER_WG_DIR" "$_GAFFER_WG_PID"; then
    _gaffer_srv_nonce
    _gaffer_srv_send "$_GAFFER_WG_DIR" "$_GAFFER_WG_PID" "$GAFFER_WG_SERVE_TIMEOUT" --db "$DISPATCH_DB" "$@"
    case "$_GAFFER_SRV_STATE" in
      ran) _gaffer_srv_print "$_GAFFER_WG_DIR"; return "$_GAFFER_SRV_RC" ;;
      failed)
        # The call may have run: fail it closed, never run it again one-shot.
        _gaffer_srv_broken "$_GAFFER_WG_DIR" "$_GAFFER_WG_PID"
        printf '{"ok":false,"code":"WG_SERVER_FAILED","message":"the tick'"'"'s dispatch server %s; this call failed and the rest of the tick runs the dispatch CLI one-shot"}\n' "$_GAFFER_SRV_WHY" >&2
        return 1 ;;
    esac
    # notsent / notrun: nothing ran; the one-shot call below is the call.
  fi
  node "$DISPATCH_DIR/dist/cli/index.js" --db "$DISPATCH_DB" "$@"
}

# --- The tick's helper servers -------------------------------------------------
# A tick used to start ~85 node processes, ~25 dispatch CLI calls (`wg`, ~250 ms of
# module loading each) and ~50 JSON helper calls (`gaffer_json` / `jget`, ~60 ms each),
# for a few ms of work apiece. tick.sh now starts TWO long-lived processes, and `wg`
# and `gaffer_json` send each call the argv the one-shot call would have run:
#   * the dispatch server (packages/dispatch/src/cli/serveCore.ts) runs it through the
#     same code path as the one-shot CLI (parsing, principal and capability checks,
#     transactions, exit codes, stdout and stderr bytes);
#   * the JSON server (lib/json-serve.mjs) evaluates lib/json-tool.mjs afresh for each
#     call, with the call's argv, environment, cwd and stdin.
# Fail closed: when a server is not up, the call is not one it serves, or something it
# reads differs from a fresh process (a terminal on stdout/stderr, PATH, the start-up
# environment), the one-shot node call runs exactly as before. Once a `wg` call is sent,
# a server that dies, hangs past GAFFER_WG_SERVE_TIMEOUT or answers garbage fails THAT
# call (non-zero, a WG_SERVER_FAILED line, never a fabricated success); it is killed and
# every later call in the tick runs one-shot. json-tool only reads and prints, so a JSON
# call the server failed is simply run again one-shot (from the stdin it captured).
#
# Transport: named pipes in private 0700 dirs under $GAFFER_DATA/wg-serve (the
# sandbox-exec profiles deny writes under $GAFFER_DATA, docker masks it), not the
# servers' stdin/stdout: an fd the tick held open would be inherited by every child it
# starts, the agent included, and bash cannot mark one close-on-exec. A call costs one
# fork and one mkfifo (and a `cat` of the stdin a JSON call reads); it needs bash 4.4 or
# later (macOS's /bin/bash 3.2 runs every call one-shot). The state below is plain shell
# variables, never exported: a child script sources this file again and runs its own
# calls one-shot.
: "${GAFFER_WG_SERVE:=1}"   # 1 = a tick sends its dispatch CLI (`wg`) and JSON helper calls to two long-lived processes instead of starting node for each; 0 runs every call as its own process (troubleshooting).
: "${GAFFER_WG_SERVE_TIMEOUT:=120}"   # Seconds a served call waits for its reply. A `wg` call then fails (closed), a JSON helper call runs again one-shot, and the rest of the tick runs one-shot.
_GAFFER_WG_PID="${_GAFFER_WG_PID:-}"   # (both kept if this file is sourced again in the same shell)
_GAFFER_JS_PID="${_GAFFER_JS_PID:-}"

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

# Start one server: <script> <dir var> <pid var>. Prints nothing; on any failure the
# vars stay empty and those calls run one-shot.
_gaffer_srv_start() {
  local _bin="$1" _dirvar="$2" _pidvar="$3" _dir
  [ -f "$_bin" ] || return 0
  _dir="$(mktemp -d "$GAFFER_DATA/wg-serve/$$.XXXXXX" 2>/dev/null)" || return 0
  chmod 700 "$_dir" 2>/dev/null && mkfifo -m 600 "$_dir/req" 2>/dev/null || { rm -rf "$_dir"; return 0; }
  ( _gaffer_wg_close_fds; exec "$_GAFFER_WG_NODE" "$_bin" --fifo "$_dir" --owner-pid "$$" ) </dev/null >/dev/null 2>&1 &
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
  [ -p "$_dir/req" ] && printf 'Q\n' 2>/dev/null 1<>"$_dir/req"
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
  if ! printf '%s\n' "$__gwg_nonce" 2>/dev/null 1<>"$__gwg_dir/req"; then
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
  printf 'D %s\n' "$_GAFFER_SRV_NONCE" 2>/dev/null 1<>"$1/req"
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
# fg pins crew to the factory's $DISPATCH_DB (CREW_DISPATCH_DB beats crew.yaml's
# sqlite_path), so a drifted crew.yaml can't send drafts to a DB nobody reads.
# It also names the factory's memory store and the brownfield decomposer, as crew
# FALLBACKS (an explicit crew.yaml value wins): CREW_MEMORY_MCP_BIN + MEMORY_DB give
# the async idle loops a real memory client on the factory DB, CREW_DECOMPOSE_SCRIPT
# gives the feature-backlog loop its decomposer. Without them a `crew init` config
# left both null and the Settings "Feature backlog" toggle could never run.
fg() {
  CREW_DISPATCH_DB="${DISPATCH_DB:-}" MEMORY_DB="${MEMORY_DB:-}" \
  CREW_MEMORY_MCP_BIN="${CREW_MEMORY_MCP_BIN:-${MEMORY_MCP_BIN:-}}" \
  CREW_DECOMPOSE_SCRIPT="${CREW_DECOMPOSE_SCRIPT:-$RUNNER_DIR/bin/decompose.mjs}" \
    node "$CREW_DIR/dist/cli/index.js" -c "$CREW_CONFIG" "$@"
}
lg() { gaffer_assert_db_vars || return 1; MEMORY_DB="$MEMORY_DB" node "$MEMORY_CLI_BIN" "$@"; }

# The runner's JSON helpers (node — lib/json-tool.mjs replaces the former inline
# python3 programs; python3 is no longer a runtime dependency).
#   gaffer_json <subcommand> [args]   — see the table in lib/json-tool.mjs
#   jget '<js expression over d>'      — stdin JSON → d; prints the value ("" for
#                                        null); a parse/eval failure exits 1 with
#                                        no output so `|| echo <default>` applies.
gaffer_json() {
  if [ -n "${_GAFFER_JS_PID:-}" ] && _gaffer_srv_usable "$_GAFFER_JS_DIR" "$_GAFFER_JS_PID"; then
    _gaffer_json_served "$@"; return
  fi
  node "$RUNNER_DIR/lib/json-tool.mjs" "$@"
}
jget() { gaffer_json expr "$1"; }
# The runner libs name json-tool by their own path (_GAFFER_JSON_TOOL and friends) so a
# test can source one alone; through this they reach the JSON server like gaffer_json.
#   gaffer_json_at <path to json-tool.mjs> <subcommand> [args]
gaffer_json_at() {
  local __gja_tool="$1"
  shift
  if [ "$__gja_tool" -ef "$RUNNER_DIR/lib/json-tool.mjs" ]; then gaffer_json "$@"; else node "$__gja_tool" "$@"; fi
}
# Several jget reads of ONE document in one node process:
#   gaffer_json_vars "$JSON" VAR1 '<expr>' '<default>' [VAR2 '<expr>' '<default>']...
# sets each VAR to exactly what `VAR="$(printf '%s' "$JSON" | jget '<expr>' 2>/dev/null
# || echo '<default>')"` would (a default of '' for a read with no `|| echo`). The values
# come back NUL-separated and are read with `read -d ''` and assigned with printf -v:
# never eval'd, so a ticket title with quotes, `$`, backticks, tabs or newlines is only
# ever data. When the helper prints anything but one value per VAR (it did not run), every
# VAR gets its default. A VAR is assigned where the caller would assign it (its local,
# else a global). Returns 2, assigning nothing, on a malformed argument list.
gaffer_json_vars() {
  local __gjv_json="$1" __gjv_v __gjv_i
  shift
  local -a __gjv_names=() __gjv_dflt=() __gjv_args=() __gjv_vals=()
  while [ "$#" -ge 3 ]; do
    __gjv_names+=("$1"); __gjv_args+=("$2" "$3"); __gjv_dflt+=("$3"); shift 3
  done
  [ "$#" -eq 0 ] && [ "${#__gjv_names[@]}" -gt 0 ] || return 2
  while IFS= read -r -d '' __gjv_v; do
    __gjv_vals+=("$__gjv_v")
  done < <(printf '%s' "$__gjv_json" | gaffer_json fields "${__gjv_args[@]}" 2>/dev/null)
  for (( __gjv_i = 0; __gjv_i < ${#__gjv_names[@]}; __gjv_i++ )); do
    if [ "${#__gjv_vals[@]}" -eq "${#__gjv_names[@]}" ]; then
      printf -v "${__gjv_names[__gjv_i]}" '%s' "${__gjv_vals[__gjv_i]}"
    else
      # `|| echo <default>`: what a command substitution keeps of it.
      __gjv_v="${__gjv_dflt[__gjv_i]}"
      while [ "${__gjv_v%$'\n'}" != "$__gjv_v" ]; do __gjv_v="${__gjv_v%$'\n'}"; done
      printf -v "${__gjv_names[__gjv_i]}" '%s' "$__gjv_v"
    fi
  done
  return 0
}

_GAFFER_CONFIG_PART=17-cli
