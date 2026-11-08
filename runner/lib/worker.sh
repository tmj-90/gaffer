# Gaffer worker seam — the ONE headless worker invocation (`claude -p`, or the
# command provider's program) for the bash runner.
# shellcheck shell=bash
_GAFFER_WORKER_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#
# WHAT THIS IS (Spec 3 / Phase 1 — consolidate the invocation, zero behaviour change)
# -----------------------------------------------------------------------------------
# Before this seam existed the runner open-coded the SAME `claude -p` invocation at
# four sites in tick.sh — the bootstrap (greenfield) delivery, the normal
# delivery/rework, the reviewer, and the intake/clarify pass. Each duplicated the
# timeout/orphan-reap wrapper, `--output-format json`, `--mcp-config`, the model
# flag, `--max-turns`, the credential-stripped child env (`env -i` + the
# `gaffer_agent_env` allowlist), and the usage-JSON capture. `worker_deliver`
# encapsulates that ONE invocation so there is a single place that WHAT is invoked
# lives — the four sites now only pick WHERE (cwd), WHICH prompt/model, and the
# per-call env.
#
# BYTE-IDENTICAL CONTRACT (the correctness invariant)
# ---------------------------------------------------
# The emitted argv + env + wrapper are EXACTLY what each site emitted before. Only
# the genuinely per-site inputs are parameters; every constant (CLAUDE_BIN,
# CLAUDE_FLAGS, --output-format json, the tick timeout, the log sink, the agent-env
# allowlist scrub) is fixed here. --max-turns is GAFFER_MAX_TURNS_FLAG unless the
# site passes its role cap ($7). The unquoted expansions ($wrap, $model_flag,
# $CLAUDE_FLAGS, $_turns_flag) preserve the original word-splitting semantics verbatim.
#
# Phase 2 (done) moved the Claude-JSON result PARSER behind the worker seam too:
# lib/worker.mjs owns parseResult, and the bash cap/spend guards in
# lib/delivery-recovery.sh read it via `node worker.mjs parse-result …`. This
# invocation seam still only produces $out_json + $?; the parsing of that capture
# now flows through the ONE worker-owned parser instead of open-coded node scripts.
#
# Phase 3 — PROVIDER DISPATCH. Two real providers, everything else fails closed.
# ------------------------------------------------------------------------------
# worker_deliver dispatches on $GAFFER_WORKER_PROVIDER the way lib/sandbox.sh
# dispatches on $SANDBOX_PROVIDER:
#   • claude-code (default): BYTE-IDENTICAL to the pre-Phase-3 invocation (the
#     correctness invariant the delivery/e2e/decompose suites pin).
#   • command: an operator-supplied program ($GAFFER_WORKER_COMMAND) under the
#     contract in docs/worker-providers.md. Same budget admission, same agent-env
#     scrub, same $wrap derivation, same timeout, same MCP bridge; the program gets
#     the call's inputs as GAFFER_WORKER_* variables and prints a small JSON envelope,
#     which lib/worker.mjs normalizeCommandEnvelope turns into the canonical shape
#     every downstream reader (parseResult, the ledger, the cap/spend guards) consumes.
#   • anything else (`codex`, `local`, …) refuses: rc 70, NO envelope, no spawn.
#
# CONTAINMENT (the load-bearing safety reason): the PreToolUse safety hook is
# native to claude-code (safety-hook.mjs runs in-process inside `claude -p`). A command
# worker has NO equivalent in-process boundary, so its containment has to come from
# the OS: launching one REQUIRES an active sandbox wrap (docker, or sandbox-exec on
# macOS) and refuses with rc 75 when none is available, whatever GAFFER_STRICT_REQUIRE
# says. The one exception is an explicit GAFFER_STRICT_REQUIRE=0, the operator's
# assertion that the whole runner is contained out-of-band (a VM or container): the
# worker then runs, with a loud WARNING at every spawn. sandbox.sh can degrade to "no
# extra OS wrapping" for claude-code because the safety hook still applies there; the
# command provider cannot, because the missing piece IS the safety hook. See
# SECURITY.md ("Command workers", under "The OS sandbox").
#
# INTERFACE  {prompt, model, env, mcpConfig, cwd, timeout, maxTurns}
#   $1 cwd        interface: cwd       — run the agent in this directory
#   $2 prompt     interface: prompt    — the `-p` argument (quoted; may contain spaces/newlines)
#   $3 model_flag interface: model     — the model flag string, word-split unquoted
#                                        (e.g. "--model claude-…" or "" for the default)
#   $4 mcp_config interface: mcpConfig — the `--mcp-config` path
#   $5 out_json                        — file to capture the JSON stdout (usage capture)
#   $6 wrap       (optional)           — OS-sandbox command prefix, word-split unquoted;
#                                        empty at three sites, "$WRAP" at the delivery site
#   $7 max_turns  (optional) interface: maxTurns — this call's turn cap (a number, from
#                                        gaffer_role_turns). Empty ⇒ $GAFFER_MAX_TURNS_FLAG,
#                                        the delivery cap, exactly as before.
#   $8… extra     (optional)           — extra claude flags for THIS call, appended AFTER
#                                        $CLAUDE_FLAGS so an operator override cannot undo
#                                        them (the text-only judge passes `--tools ""` here)
#   Global array WORKER_CALL_ENV  interface: env — the per-call `KEY=VALUE` assignments
#                                        layered on top of the credential-stripped allowlist
#   Globals read (constant across sites):
#     GAFFER_TICK_TIMEOUT   interface: timeout
#     GAFFER_MAX_TURNS_FLAG interface: maxTurns (when $7 is empty)
#     CLAUDE_BIN, CLAUDE_FLAGS, GAFFER_LOG, GAFFER_AGENT_ENV
#
# OUTPUT
#   stdout (the `--output-format json` envelope) → $out_json
#   stderr                                        → appended to $GAFFER_LOG
#   return status                                 → the invocation's exit code; the
#                                                   caller reads $? exactly as before
#     (resultText / usage / capHit / stopReason are DERIVED from $out_json by
#      lib/worker.mjs's parseResult — the ONE Phase-2 parser seam; the bash guards
#      call its `parse-result` CLI rather than re-parsing the envelope themselves).
# The honest fail-closed message an unknown provider emits. Shared word-for-word
# with the mjs seam (lib/worker.mjs unsupportedProviderMessage) so both runtimes speak
# with one voice; the provider-stub tests pin this string.
_gaffer_worker_unsupported_msg() {
  printf 'worker provider %s not yet supported; safety-hook containment unavailable\n' "$1"
}

# ── The command provider (GAFFER_WORKER_PROVIDER=command) ─────────────────────
# The runner runs an operator-supplied program instead of `claude -p`, under the
# contract in docs/worker-providers.md (shared word for word with lib/worker.mjs).
# These messages are the mjs seam's too (commandSandboxRefusalMessage /
# commandOptOutWarning / commandWorkerConfig), so both runtimes speak with one voice.
# _gaffer_worker_command_refusal_msg [why] → the refusal sentence (why: none,
# write-only, not-docker, legacy; lib/worker.mjs commandSandboxRefusalMessage prints it,
# so both seams speak with one voice).
_gaffer_worker_command_refusal_msg() {
  node "$_GAFFER_WORKER_LIB/worker.mjs" command-refusal "${1:-none}" 2>/dev/null \
    || printf '%s\n' "worker: GAFFER_WORKER_PROVIDER=command needs the docker sandbox and cannot get it here — refusing to spawn the worker (fail closed). Fix: set SANDBOX_PROVIDER=docker, or GAFFER_STRICT_REQUIRE=0 in the environment if you contain the whole runner out-of-band"
}
_gaffer_worker_command_optout_msg() {
  printf '%s\n' "WARNING: GAFFER_WORKER_PROVIDER=command with GAFFER_STRICT_REQUIRE=0 — the command worker runs with no OS sandbox requirement and no in-process safety hook. Only safe if you contain the runner out-of-band (a VM or container)."
}
# _gaffer_worker_command_bin [write-roots] [cwd] → prints $GAFFER_WORKER_COMMAND when it is
# an absolute path to an executable file outside every directory an agent can write
# ($GAFFER_DATA, the call's write roots and cwd; not through a symlink in one; not
# group- or world-writable); else prints the refusal to stderr and returns 1. The check
# is lib/worker.mjs commandWorkerConfig, the same one the Node seam runs.
_gaffer_worker_command_bin() {
  local out
  if ! command -v node >/dev/null 2>&1; then
    printf 'worker provider command: node is needed to check GAFFER_WORKER_COMMAND — no agent spawned\n' >&2
    return 1
  fi
  out="$(node "$_GAFFER_WORKER_LIB/worker.mjs" command-worker-check --write-roots "${1:-}" --cwd "${2:-}")" || return 1
  printf '%s' "$out"
}
# True only for an EXPLICIT GAFFER_STRICT_REQUIRE=0|false|no|off — the operator's
# assertion that the runner is contained out-of-band. Unset, empty or anything else
# keeps the command provider's sandbox requirement.
_gaffer_strict_require_opted_out() {
  [ -n "${GAFFER_STRICT_REQUIRE+x}" ] || return 1
  case "$(printf '%s' "$GAFFER_STRICT_REQUIRE" | tr '[:upper:]' '[:lower:]')" in
    0 | false | no | off) return 0 ;;
  esac
  return 1
}

# True when the OS sandbox is ON (STRICT_MODE=1) or REQUIRED (GAFFER_STRICT_REQUIRE:
# the default, so anything but an explicit 0/false/no/off is required).
# `_sandbox_strict_required` lives in lib/sandbox.sh (sourced by factory.config.sh);
# guard the call so a bare `source lib/worker.sh` in a test still works.
_worker_sandbox_wanted() {
  [ "${STRICT_MODE:-0}" = "1" ] && return 0
  if command -v _sandbox_strict_required >/dev/null 2>&1; then
    _sandbox_strict_required && return 0
  else
    _gaffer_strict_require_opted_out || return 0
  fi
  return 1
}

# GAFFER_MCP_BRIDGE: auto (default) ⇒ on except on macOS (Docker Desktop cannot
# bind-mount a host unix socket into the VM); 1/0 force. See lib/mcp-bridge.mjs.
_worker_mcp_bridge_on() {
  case "${GAFFER_MCP_BRIDGE:-auto}" in
    1 | true | yes | on) return 0 ;;
    0 | false | no | off) return 1 ;;
    *) [ "$(uname -s 2>/dev/null)" != "Darwin" ] ;;
  esac
}

# ── Per-call provenance: which model was asked for and which CLI ran it ─────
# gaffer_model_from_flag "<model flag>" → the id after `--model` (or `--model=`), or ""
# when the call runs on the CLI's default model (worker_deliver records that as
# `default`).
gaffer_model_from_flag() {
  local prev="" w
  # shellcheck disable=SC2086  # the flag string is word-split exactly as the spawn splits it
  for w in $1; do
    case "$w" in --model=*) printf '%s' "${w#--model=}"; return 0 ;; esac
    [ "$prev" = "--model" ] && { printf '%s' "$w"; return 0; }
    prev="$w"
  done
  return 0
}
# gaffer_claude_version <bin> → the CLI version (lib/claude-version.mjs), read once per
# process per binary. GAFFER_CLAUDE_VERSION pins it (an image whose CLI the host cannot
# inspect). Never fails: an unreadable version is `unknown`.
GAFFER_CLAUDE_VERSION="${GAFFER_CLAUDE_VERSION:-}"   # pin the Claude Code CLI version recorded per call (e.g. a docker image's CLI); empty = read it from the binary
_GAFFER_CLAUDE_VERSION_BIN=""; _GAFFER_CLAUDE_VERSION_VAL=""
gaffer_claude_version() {
  local bin="${1:-${CLAUDE_BIN:-claude}}"
  if [ -n "${GAFFER_CLAUDE_VERSION:-}" ]; then printf '%s' "$GAFFER_CLAUDE_VERSION"; return 0; fi
  if [ "$_GAFFER_CLAUDE_VERSION_BIN" != "$bin" ] || [ -z "$_GAFFER_CLAUDE_VERSION_VAL" ]; then
    _GAFFER_CLAUDE_VERSION_VAL="$(node "${RUNNER_DIR:-.}/lib/claude-version.mjs" "$bin" 2>/dev/null | head -1)"
    [ -n "$_GAFFER_CLAUDE_VERSION_VAL" ] || _GAFFER_CLAUDE_VERSION_VAL="unknown"
    _GAFFER_CLAUDE_VERSION_BIN="$bin"
  fi
  printf '%s' "$_GAFFER_CLAUDE_VERSION_VAL"
}

worker_deliver() {
  local cwd="$1" prompt="$2" model_flag="$3" mcp_config="$4" out_json="$5" wrap="${6:-}"
  # 1 after a call the budget admission refused (rc 77, nothing spawned): tick.sh
  # releases that delivery without counting an attempt.
  WORKER_LAST_BUDGET_REFUSED=0
  # Per-call turn cap: a role passes its own (already clamped to GAFFER_MAX_TURNS by
  # gaffer_role_turns); delivery/bootstrap pass none and keep the global flag.
  local _turns_flag="${GAFFER_MAX_TURNS_FLAG:-}"
  case "${7:-}" in '' | *[!0-9]* | 0) ;; *) _turns_flag="--max-turns $7" ;; esac
  local _extra=()
  [ "$#" -gt 7 ] && _extra=("${@:8}")
  # Opt-in per-call dollar cap (GAFFER_MAX_CALL_USD, clamped to the factory headroom):
  # appended unless the site already passed its own (the delivery passes one that also
  # carries the ticket's remaining ceiling). Unset knob → nothing appended.
  case " ${_extra[*]-} " in *" --max-budget-usd "*) ;; *)
    if command -v gaffer_call_budget_usd >/dev/null 2>&1; then
      local _cb; _cb="$(gaffer_call_budget_usd)"
      [ -n "$_cb" ] && _extra+=(--max-budget-usd "$_cb")
    fi ;;
  esac
  # How long the agent ran (whole seconds → ms), read by gaffer_usage_record so a
  # killed call's cost estimate scales with its run time. Reset first: a refused
  # spawn below must not inherit the previous call's figure.
  WORKER_LAST_ELAPSED_MS=0
  # Which model this call asks for ("" = the CLI default) and which CLI version runs
  # it, read by gaffer_usage_record (the ledger row) and the delivery's agent-run
  # evidence. Reset with the elapsed time, so a refused spawn inherits nothing.
  WORKER_LAST_MODEL="$(gaffer_model_from_flag "$model_flag")"
  [ -n "$WORKER_LAST_MODEL" ] || WORKER_LAST_MODEL="default"
  WORKER_LAST_CLAUDE_VERSION=""
  WORKER_LAST_PROVIDER="${GAFFER_WORKER_PROVIDER:-claude-code}"
  # The MCP config the AGENT is handed. Under the docker provider with the bridge on,
  # this becomes the BRIDGED copy (every server = `mcp-bridge.mjs connect`) while the
  # real servers — and their env, including the claim token — run host-side in `serve`.
  local _mcp_for_agent="$mcp_config" _bridge_pid="" _bridge_sock="" _bridge_dir="" _rc=0
  # This call's write and read roots (the per-call boundary vars; the cwd is the write
  # root when none is named): the sandbox wrap is derived from them, and the command
  # worker's program must live outside them.
  local _wr="" _rr="" _kv
  for _kv in ${WORKER_CALL_ENV[@]+"${WORKER_CALL_ENV[@]}"}; do
    case "$_kv" in
      GAFFER_WRITE_ROOTS=*) _wr="${_kv#GAFFER_WRITE_ROOTS=}" ;;
      GAFFER_READ_ROOTS=*)  _rr="${_kv#GAFFER_READ_ROOTS=}" ;;
    esac
  done
  [ -n "$_wr" ] || _wr="$cwd"
  # ── PROVIDER DISPATCH: claude-code and command are real; anything else refuses. ──
  local _provider="$WORKER_LAST_PROVIDER" _cmd_bin=""
  case "$_provider" in
    claude-code) ;;
    command)
      # The operator's worker program. A missing / relative / non-executable path, or
      # one an agent could rewrite, is a configuration error: refuse (rc 70, no
      # envelope), never guess.
      if ! _cmd_bin="$(_gaffer_worker_command_bin "$_wr" "$cwd")"; then
        : > "$out_json"
        return 70
      fi
      ;;
    *)
      # ── codex / local / any other value — honest stub, FAIL CLOSED. ──
      # No execution: a worker the runner has no contract for has no containment it
      # can rely on. Write NO envelope (empty capture → parseResult reads "unknown",
      # never a fake 0) and return non-zero so the caller's error path fires.
      : > "$out_json"
      _gaffer_worker_unsupported_msg "${GAFFER_WORKER_PROVIDER:-}" >&2
      return 70
      ;;
  esac
  # ── BUDGET ADMISSION (external review #6): the ONE check before EVERY paid launch
  # (lib/budget.sh → lib/budget-admission.mjs, shared with the Node seam), for every
  # provider. Daily or lifetime budget exhausted, or the spend unknowable with a cap
  # set ⇒ NO spawn: rc 77, empty envelope, nothing booked. GAFFER_LAUNCH_KIND names
  # the launcher. If budget.sh was not sourced, load the sibling copy; if the check
  # still cannot be asked, the launch is refused (fail closed), never waved through.
  if ! declare -F gaffer_paid_launch_admitted >/dev/null 2>&1 && [ -f "$_GAFFER_WORKER_LIB/budget.sh" ]; then
    # shellcheck source=budget.sh
    . "$_GAFFER_WORKER_LIB/budget.sh"
  fi
  if ! declare -F gaffer_paid_launch_admitted >/dev/null 2>&1 \
     || ! gaffer_paid_launch_admitted "${GAFFER_LAUNCH_KIND:-worker}"; then
    : > "$out_json"
    printf 'worker: budget admission refused the paid %s launch — no agent spawned\n' "${GAFFER_LAUNCH_KIND:-worker}" >&2
    WORKER_LAST_BUDGET_REFUSED=1
    return 77
  fi
  # C1/M2: strip ambient credentials from the live agent's env (allowlist via env -i).
  # Populated here so the scrub is byte-identical for every site (each site called
  # gaffer_agent_env immediately before its invocation previously). The allowlist is
  # provider-indirected (factory.config.sh): the command worker gets the agnostic base
  # plus the names GAFFER_WORKER_COMMAND_ENV lists, never the claude-code auth surface.
  gaffer_agent_env
  # ── OS-sandbox containment AT THE SEAM (every spawn site, not just delivery) ──
  # Before this, only tick.sh's delivery spawn passed a $wrap; the bootstrap,
  # reviewer, clarify and eval-judge spawns ran bare even under STRICT_MODE=1 —
  # and the reviewer reads an UNTRUSTED diff with a shell. When the sandbox is ON
  # (STRICT_MODE=1) or REQUIRED (GAFFER_STRICT_REQUIRE, auto-set by every autonomy
  # flag) and the caller passed no wrap, derive it here from the per-call boundary
  # vars (GAFFER_WRITE_ROOTS / GAFFER_READ_ROOTS in WORKER_CALL_ENV; the cwd is the
  # write root when none is named). FAIL CLOSED: a required sandbox that the host
  # cannot supply means NO spawn — rc 75, empty envelope — never a silent bare run.
  # With the sandbox off this block is inert and the invocation is byte-identical.
  #
  # THE COMMAND PROVIDER has no in-process safety hook (that lives inside `claude -p`),
  # so for it the sandbox is ALWAYS required, whatever GAFFER_STRICT_REQUIRE says —
  # unless the operator set GAFFER_STRICT_REQUIRE=0 explicitly to assert out-of-band
  # containment: then it runs, logged loudly here at every spawn, and is wrapped only
  # when STRICT_MODE=1 asks for it (degrading like claude-code does).
  local _cmd_needs_wrap=0
  if [ "$_provider" = command ]; then
    if _gaffer_strict_require_opted_out; then
      _gaffer_worker_command_optout_msg >&2
    else
      _cmd_needs_wrap=1
      # The only boundary that counts for a command worker is the docker sandbox WITH
      # the host-side MCP bridge (lib/worker.mjs commandContainmentProblem):
      # sandbox-exec leaves $GAFFER_DATA writable (settings.json, the databases, the
      # ledger) and only claude-code's in-process hook guards it; docker without the
      # bridge mounts the databases read-write. Refuse before anything is spawned.
      local _why_msg=""
      if ! _why_msg="$(SANDBOX_PROVIDER="${SANDBOX_PROVIDER:-sandbox-exec}" node "$_GAFFER_WORKER_LIB/worker.mjs" command-containment --mcp-config "$mcp_config" 2>/dev/null)"; then
        : > "$out_json"
        [ -n "$_why_msg" ] || _why_msg="$(_gaffer_worker_command_refusal_msg none)"
        printf '%s\n' "$_why_msg" >&2
        return 75
      fi
      # A wrap the CALLER composed (tick.sh's delivery) must be the docker wrapper too.
      if [ -n "$wrap" ]; then
        case "$wrap" in
          *sandbox-docker.sh*) ;;
          *) : > "$out_json"; _gaffer_worker_command_refusal_msg not-docker >&2; return 75 ;;
        esac
      fi
    fi
  fi
  if [ -z "$wrap" ] && { [ "$_cmd_needs_wrap" = 1 ] || _worker_sandbox_wanted; }; then
    local _wrap_ok=1
    if [ "$_cmd_needs_wrap" = 1 ]; then
      wrap="$(GAFFER_STRICT_REQUIRE=1 sandbox_wrap_cmd "$_wr" "$_rr" 2>>"$GAFFER_LOG")" || _wrap_ok=0
    else
      wrap="$(sandbox_wrap_cmd "$_wr" "$_rr" 2>>"$GAFFER_LOG")" || _wrap_ok=0
    fi
    if [ "$_wrap_ok" = 0 ] && [ "$_cmd_needs_wrap" = 0 ]; then
      : > "$out_json"
      if declare -F gaffer_sandbox_unavailable_hint >/dev/null 2>&1; then
        printf 'worker: refusing to spawn the agent (fail closed): %s\n' "$(gaffer_sandbox_unavailable_hint)" >&2
      else
        printf 'worker: GAFFER_STRICT_REQUIRE demands an OS sandbox and none is available on this host — refusing to spawn the agent (fail closed)\n' >&2
      fi
      return 75
    fi
    [ "$_wrap_ok" = 1 ] || wrap=""
  fi
  if [ "$_cmd_needs_wrap" = 1 ]; then
    case "$wrap" in
      "") : > "$out_json"; _gaffer_worker_command_refusal_msg none >&2; return 75 ;;
      *sandbox-docker.sh*) ;;
      *) : > "$out_json"; _gaffer_worker_command_refusal_msg not-docker >&2; return 75 ;;
    esac
  fi
  # Inside the `docker` provider the HOST's claude binary path / HOME / PATH do not
  # exist — the image ships `claude` on its own PATH and root's HOME is /root (where
  # the credentials file is mounted). Substitute ONLY when a docker wrap is active;
  # the per-call env layers on top of the allowlist, so these win over host values.
  # A command worker's program is the same path inside the container (the runner dir
  # and the write roots are mounted there) unless GAFFER_SANDBOX_WORKER_COMMAND names
  # where the image keeps it.
  local _sbx_claude_bin="$CLAUDE_BIN" _sbx_env=() _cmd_run="$_cmd_bin"
  [ "$_provider" = claude-code ] && WORKER_LAST_CLAUDE_VERSION="$(gaffer_claude_version "$CLAUDE_BIN")"
  if [ -n "$wrap" ] && [ "${SANDBOX_PROVIDER:-sandbox-exec}" = "docker" ]; then
    if [ "$_provider" = claude-code ]; then
      _sbx_claude_bin="${GAFFER_SANDBOX_CLAUDE_BIN:-claude}"
      # The image's CLI, not the host's: unknown unless the operator pinned it.
      WORKER_LAST_CLAUDE_VERSION="${GAFFER_CLAUDE_VERSION:-unknown (sandbox image)}"
    else
      _cmd_run="${GAFFER_SANDBOX_WORKER_COMMAND:-$_cmd_bin}"
    fi
    _sbx_env=( "HOME=${GAFFER_SANDBOX_HOME:-/root}"
               "PATH=${GAFFER_SANDBOX_PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}" )
    # The agent runs under `env -i <allowlist>` INSIDE the container, so the env the
    # wrapper (lib/sandbox-docker.sh) gives the container never reaches it unless it
    # is listed here too. Same values as the wrapper's: git's safe.directory (the
    # mounts are owned by the host uid, the container runs as root: without it every
    # git command inside fails "dubious ownership" on a Linux host whose user is not
    # root), the egress proxy (the container's only route out), and a TMPDIR that
    # exists in the container (the host's may not).
    _sbx_env+=( "GIT_CONFIG_COUNT=1" "GIT_CONFIG_KEY_0=safe.directory" "GIT_CONFIG_VALUE_0=*"
                "HTTP_PROXY=http://egress-proxy:8888" "HTTPS_PROXY=http://egress-proxy:8888"
                "http_proxy=http://egress-proxy:8888" "https_proxy=http://egress-proxy:8888"
                "NO_PROXY=localhost,127.0.0.1,egress-proxy" "no_proxy=localhost,127.0.0.1,egress-proxy"
                "TMPDIR=/tmp" )
    # ── MCP DATA PLANE ON THE HOST (external review, finding 2) ──────────────
    # The dispatch/memory MCP servers used to run INSIDE the container and write
    # the canonical SQLite files, which forced $GAFFER_DATA to be mounted rw.
    # Now `mcp-bridge.mjs serve` runs them here, on the host, from the rendered
    # runtime config (with its env + claim token), listening on a per-spawn unix
    # socket; the container gets a bridged config whose servers are
    # `mcp-bridge.mjs connect` over that socket. sandbox-docker.sh (reading
    # GAFFER_MCP_BRIDGE_SOCKET) then mounts the socket instead of $GAFFER_DATA.
    # FAIL CLOSED: if the bridge cannot be rendered or does not come up, no spawn.
    if _worker_mcp_bridge_on && [ -n "$mcp_config" ] && [ -f "$mcp_config" ]; then
      # The socket lives in a SHORT private dir, not under $GAFFER_DATA: a unix socket
      # path is capped at 104 bytes on macOS (108 on Linux) and a data dir under a
      # deep path (macOS TMPDIR, a nested checkout) pushed it over — `serve` could
      # not listen and every spawn was refused. /tmp/gaffer-mcp.XXXXXX is mode 700.
      _bridge_dir="$(mktemp -d /tmp/gaffer-mcp.XXXXXX 2>/dev/null)" || {
        : > "$out_json"
        printf 'worker: mcp bridge: could not create a private socket dir under /tmp — refusing to spawn the agent (fail closed)\n' >&2
        return 76
      }
      _bridge_sock="$_bridge_dir/b.sock"
      _mcp_for_agent="${mcp_config%.json}.bridge.json"
      if ! node "$RUNNER_DIR/lib/mcp-bridge.mjs" render --config "$mcp_config" --out "$_mcp_for_agent" \
             --socket "$_bridge_sock" --bridge "$RUNNER_DIR/lib/mcp-bridge.mjs" 2>>"$GAFFER_LOG"; then
        rm -rf "$_bridge_dir"
        : > "$out_json"
        printf 'worker: mcp bridge: could not render the bridged MCP config from %s — refusing to spawn the agent (fail closed)\n' "$mcp_config" >&2
        return 76
      fi
      # An EMPTY data plane (a config with no servers, e.g. `{}`) needs no bridge:
      # hand the original config through and tell the wrapper there is no data
      # plane to mount (GAFFER_SANDBOX_DATA_PLANE=none ⇒ $GAFFER_DATA stays out).
      local _nsrv
      _nsrv="$(node -e 'const c=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(Object.keys(c.mcpServers||{}).length))' "$_mcp_for_agent" 2>/dev/null || echo 0)"
      if [ "${_nsrv:-0}" -eq 0 ] 2>/dev/null; then
        rm -f "$_mcp_for_agent"; _mcp_for_agent="$mcp_config"; _bridge_sock=""
        rmdir "$_bridge_dir" 2>/dev/null || true; _bridge_dir=""
        unset GAFFER_MCP_BRIDGE_SOCKET
        export GAFFER_SANDBOX_DATA_PLANE=none
      else
        node "$RUNNER_DIR/lib/mcp-bridge.mjs" serve --socket "$_bridge_sock" --config "$mcp_config" >>"$GAFFER_LOG" 2>&1 &
        _bridge_pid=$!
        local _bw=0
        while [ ! -S "$_bridge_sock" ] && [ "$_bw" -lt 100 ]; do sleep 0.05; _bw=$((_bw + 1)); done
        if [ ! -S "$_bridge_sock" ]; then
          kill "$_bridge_pid" 2>/dev/null || true
          rm -f "$_mcp_for_agent"; rm -rf "$_bridge_dir"
          : > "$out_json"
          printf 'worker: mcp bridge did not start on %s — refusing to spawn the agent (fail closed)\n' "$_bridge_sock" >&2
          return 76
        fi
        unset GAFFER_SANDBOX_DATA_PLANE
        export GAFFER_MCP_BRIDGE_SOCKET="$_bridge_sock"
      fi
    else
      unset GAFFER_MCP_BRIDGE_SOCKET GAFFER_SANDBOX_DATA_PLANE
    fi
  fi
  local _t0=$SECONDS
  if [ "$_provider" = claude-code ]; then
    # CLAUDE_BIN is rebound INSIDE the invocation subshell only (the docker case above
    # swaps in the image's binary; otherwise it is unchanged), so the single pinned
    # invocation site below stays exactly where the seam tests look for it.
    ( cd "$cwd" && CLAUDE_BIN="$_sbx_claude_bin" \
      && gaffer_timeout "$GAFFER_TICK_TIMEOUT" $wrap \
         env -i "${GAFFER_AGENT_ENV[@]}" "${WORKER_CALL_ENV[@]}" ${_sbx_env[@]+"${_sbx_env[@]}"} \
           "$CLAUDE_BIN" -p "$prompt" --output-format json --mcp-config "$_mcp_for_agent" $CLAUDE_FLAGS $model_flag $_turns_flag ${_extra[@]+"${_extra[@]}"} \
    ) >"$out_json" 2>>"$GAFFER_LOG"
    _rc=$?
  else
    # ── THE COMMAND WORKER: the same wrap, timeout and scrubbed env as claude-code; the
    # program gets no arguments, the call's inputs ride the GAFFER_WORKER_* contract
    # (docs/worker-providers.md). CLAUDE_FLAGS belong to the claude CLI and are not passed.
    local _c_model="$WORKER_LAST_MODEL" _c_turns="" _c_budget="" _c_tools="all" _i
    [ "$_c_model" = default ] && _c_model=""
    case "$_turns_flag" in "--max-turns "*) _c_turns="${_turns_flag#--max-turns }" ;; esac
    case "$_c_turns" in '' | *[!0-9]*) _c_turns="" ;; esac
    _i=0
    while [ "$_i" -lt "${#_extra[@]}" ]; do
      case "${_extra[$_i]}" in
        --max-budget-usd) _c_budget="${_extra[$((_i + 1))]:-}"; _i=$((_i + 1)) ;;
        --tools) [ -z "${_extra[$((_i + 1))]:-}" ] && _c_tools="none"; _i=$((_i + 1)) ;;
      esac
      _i=$((_i + 1))
    done
    # The prompt goes in a private per-call file (always) and inline only when it fits
    # in one environment string (lib/worker.mjs COMMAND_PROMPT_INLINE_MAX, 64 KiB): a
    # long prompt in the environment fails the spawn with E2BIG (128 KiB per string on
    # Linux, about 1 MiB for argv plus env on macOS). The docker wrapper mounts the file.
    local _c_pfile="" _c_inline="$prompt" _c_bytes
    _c_bytes="$(printf '%s' "$prompt" | wc -c | tr -d ' ')"
    [ "${_c_bytes:-0}" -le 65536 ] 2>/dev/null || _c_inline=""
    mkdir -p "${GAFFER_DATA:-/tmp}" 2>/dev/null || true
    if ! _c_pfile="$(mktemp "${GAFFER_DATA:-/tmp}/worker-prompt.$$.XXXXXX" 2>/dev/null)"; then
      : > "$out_json"
      printf 'worker: could not create the command worker prompt file under %s — no agent spawned\n' "${GAFFER_DATA:-/tmp}" >&2
    else
      chmod 600 "$_c_pfile" 2>/dev/null || true
      printf '%s' "$prompt" > "$_c_pfile"
    fi
    local _cmd_env=(
      "GAFFER_WORKER_CONTRACT=1" "GAFFER_WORKER_PROMPT=$_c_inline" "GAFFER_WORKER_PROMPT_FILE=$_c_pfile"
      "GAFFER_WORKER_MCP_CONFIG=$_mcp_for_agent"
      "GAFFER_WORKER_MODEL=$_c_model" "GAFFER_WORKER_MAX_TURNS=$_c_turns" "GAFFER_WORKER_MAX_BUDGET_USD=$_c_budget"
      "GAFFER_WORKER_TOOLS=$_c_tools" "GAFFER_WORKER_ALLOWED_TOOLS=" "GAFFER_WORKER_DISALLOWED_TOOLS="
      "GAFFER_WORKER_KIND=${GAFFER_LAUNCH_KIND:-worker}" "GAFFER_WORKER_TIMEOUT_SECS=${GAFFER_TICK_TIMEOUT:-}"
    )
    if [ -n "$_c_pfile" ]; then
      ( cd "$cwd" \
        && gaffer_timeout "$GAFFER_TICK_TIMEOUT" $wrap \
           env -i "${GAFFER_AGENT_ENV[@]}" ${WORKER_CALL_ENV[@]+"${WORKER_CALL_ENV[@]}"} ${_sbx_env[@]+"${_sbx_env[@]}"} "${_cmd_env[@]}" \
             "$_cmd_run" </dev/null \
      ) >"$out_json.raw" 2>>"$GAFFER_LOG"
      _rc=$?
      rm -f "$_c_pfile"
      # The parser adapter (lib/worker.mjs normalizeCommandEnvelope): $out_json gets the
      # canonical envelope every downstream reader already consumes, or stays empty when
      # the worker printed no JSON object (the ledger then books a conservative estimate).
      # The cost floor: GAFFER_WORKER_COMMAND_COST_USD, else this call's dollar cap, else
      # the kill-estimate floor (commandCostFloorUsd).
      node "$_GAFFER_WORKER_LIB/worker.mjs" normalize-command-envelope --in "$out_json.raw" --out "$out_json" \
        --explicit-floor "${GAFFER_WORKER_COMMAND_COST_USD:-}" --per-call-usd "$_c_budget" \
        --kill-floor "${GAFFER_KILL_ESTIMATE_USD:-}" 2>>"$GAFFER_LOG" \
        || : > "$out_json"
      rm -f "$out_json.raw"
      # The runner's own refusal codes cannot come from the worker: a worker that exits
      # with one is a failed call, never "the budget refused" or "no sandbox".
      case "$_rc" in
        70 | 75 | 76 | 77)
          printf 'worker: the command worker exited %s, a code the runner reserves for its own refusals; recording it as a failed call (exit 1)\n' "$_rc" >>"$GAFFER_LOG"
          _rc=1 ;;
      esac
    else
      _rc=70   # no prompt file, no spawn: the runner's own refusal
    fi
  fi
  WORKER_LAST_ELAPSED_MS=$(( (SECONDS - _t0) * 1000 ))
  # Tear the bridge down with the agent: the host-side servers exit with their
  # connections; the socket + the bridged config (token-free, but per-spawn) go too.
  if [ -n "$_bridge_pid" ]; then
    kill "$_bridge_pid" 2>/dev/null || true
    wait "$_bridge_pid" 2>/dev/null || true
    rm -f "$_bridge_sock" "$_mcp_for_agent" 2>/dev/null || true
  fi
  [ -n "$_bridge_dir" ] && rm -rf "$_bridge_dir" 2>/dev/null || true
  unset GAFFER_MCP_BRIDGE_SOCKET GAFFER_SANDBOX_DATA_PLANE
  return "$_rc"
}
