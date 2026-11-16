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

# The servers' start/stop and the request client live in lib/helper-servers.sh (loaded
# by 19-libs.sh; it needs bash 4.4, which a config part may not use).

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
