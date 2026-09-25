# Gaffer worker seam — the ONE headless `claude -p` invocation for the bash runner.
# shellcheck shell=bash
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
# CLAUDE_FLAGS, --output-format json, --max-turns via GAFFER_MAX_TURNS_FLAG, the
# tick timeout, the log sink, the agent-env allowlist scrub) is fixed here. The
# unquoted expansions ($wrap, $model_flag, $CLAUDE_FLAGS, $GAFFER_MAX_TURNS_FLAG)
# preserve the original word-splitting semantics verbatim.
#
# Phase 2 (done) moved the Claude-JSON result PARSER behind the worker seam too:
# lib/worker.mjs owns parseResult, and the bash cap/spend guards in
# lib/delivery-recovery.sh read it via `node worker.mjs parse-result …`. This
# invocation seam still only produces $out_json + $?; the parsing of that capture
# now flows through the ONE worker-owned parser instead of open-coded node scripts.
#
# Phase 3 (this file) — PROVIDER DISPATCH (SEAM ONLY, honest fail-closed stubs).
# ------------------------------------------------------------------------------
# worker_deliver now dispatches on $GAFFER_WORKER_PROVIDER exactly the way
# lib/sandbox.sh dispatches on $SANDBOX_PROVIDER: a `case` with one real branch
# and honest stubs for the rest. The default provider is `claude-code`, whose
# branch is BYTE-IDENTICAL to the pre-Phase-3 invocation (the correctness
# invariant the delivery/e2e/decompose suites pin). Any OTHER provider
# (`codex`, `local`, …) is a stub that FAILS CLOSED: it refuses to run, returns
# non-zero, and writes NO envelope — it never spawns an agent.
#
# WHY FAIL CLOSED rather than degrade (the load-bearing safety reason): the
# PreToolUse containment hook is Claude-Code-native (safety-hook.mjs runs
# in-process inside `claude -p`). A non-Claude worker has NO equivalent
# in-process boundary, so running one would put an agent with a shell on the host
# with no containment. Until a real OS-sandbox provider exists we refuse rather
# than run blind. sandbox.sh can degrade to "no extra OS wrapping" because the
# safety hook still applies there; the WORKER seam cannot, because the missing
# piece IS the safety hook. See SECURITY.md ("worker provider containment").
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
#   Global array WORKER_CALL_ENV  interface: env — the per-call `KEY=VALUE` assignments
#                                        layered on top of the credential-stripped allowlist
#   Globals read (constant across sites):
#     GAFFER_TICK_TIMEOUT   interface: timeout
#     GAFFER_MAX_TURNS_FLAG interface: maxTurns
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
# The honest fail-closed message a non-Claude provider stub emits. Shared word-for-word
# with the mjs seam (lib/worker.mjs unsupportedProviderMessage) so both runtimes speak
# with one voice; the provider-stub tests pin this string.
_gaffer_worker_unsupported_msg() {
  printf 'worker provider %s not yet supported; safety-hook containment unavailable\n' "$1"
}

# True when the OS sandbox is ON (STRICT_MODE=1) or REQUIRED (GAFFER_STRICT_REQUIRE).
# `_sandbox_strict_required` lives in lib/sandbox.sh (sourced by factory.config.sh);
# guard the call so a bare `source lib/worker.sh` in a test still works.
_worker_sandbox_wanted() {
  [ "${STRICT_MODE:-0}" = "1" ] && return 0
  if command -v _sandbox_strict_required >/dev/null 2>&1; then
    _sandbox_strict_required && return 0
  else
    case "${GAFFER_STRICT_REQUIRE:-0}" in 1 | true | yes | on) return 0 ;; esac
  fi
  return 1
}

worker_deliver() {
  local cwd="$1" prompt="$2" model_flag="$3" mcp_config="$4" out_json="$5" wrap="${6:-}"
  case "${GAFFER_WORKER_PROVIDER:-claude-code}" in
    claude-code)
      # ── The real provider — BYTE-IDENTICAL to the pre-Phase-3 invocation. ──
      # C1/M2: strip ambient credentials from the live agent's env (allowlist via env -i).
      # Populated here so the scrub is byte-identical for every site (each site called
      # gaffer_agent_env immediately before its invocation previously).
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
      if [ -z "$wrap" ] && _worker_sandbox_wanted; then
        local _wr="" _rr="" _kv
        for _kv in ${WORKER_CALL_ENV[@]+"${WORKER_CALL_ENV[@]}"}; do
          case "$_kv" in
            GAFFER_WRITE_ROOTS=*) _wr="${_kv#GAFFER_WRITE_ROOTS=}" ;;
            GAFFER_READ_ROOTS=*)  _rr="${_kv#GAFFER_READ_ROOTS=}" ;;
          esac
        done
        [ -n "$_wr" ] || _wr="$cwd"
        if ! wrap="$(sandbox_wrap_cmd "$_wr" "$_rr" 2>>"$GAFFER_LOG")"; then
          : > "$out_json"
          printf 'worker: GAFFER_STRICT_REQUIRE demands an OS sandbox and none is available on this host — refusing to spawn the agent (fail closed)\n' >&2
          return 75
        fi
      fi
      # Inside the `docker` provider the HOST's claude binary path / HOME / PATH do not
      # exist — the image ships `claude` on its own PATH and root's HOME is /root (where
      # the credentials file is mounted). Substitute ONLY when a docker wrap is active;
      # the per-call env layers on top of the allowlist, so these win over host values.
      local _sbx_claude_bin="$CLAUDE_BIN" _sbx_env=()
      if [ -n "$wrap" ] && [ "${SANDBOX_PROVIDER:-sandbox-exec}" = "docker" ]; then
        _sbx_claude_bin="${GAFFER_SANDBOX_CLAUDE_BIN:-claude}"
        _sbx_env=( "HOME=${GAFFER_SANDBOX_HOME:-/root}"
                   "PATH=${GAFFER_SANDBOX_PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}" )
      fi
      # CLAUDE_BIN is rebound INSIDE the invocation subshell only (the docker case above
      # swaps in the image's binary; otherwise it is unchanged), so the single pinned
      # invocation site below stays exactly where the seam tests look for it.
      ( cd "$cwd" && CLAUDE_BIN="$_sbx_claude_bin" \
        && gaffer_timeout "$GAFFER_TICK_TIMEOUT" $wrap \
           env -i "${GAFFER_AGENT_ENV[@]}" "${WORKER_CALL_ENV[@]}" ${_sbx_env[@]+"${_sbx_env[@]}"} \
             "$CLAUDE_BIN" -p "$prompt" --output-format json --mcp-config "$mcp_config" $CLAUDE_FLAGS $model_flag $GAFFER_MAX_TURNS_FLAG \
      ) >"$out_json" 2>>"$GAFFER_LOG"
      ;;
    *)
      # ── codex / local / any non-Claude provider — honest stub, FAIL CLOSED. ──
      # No execution: a non-Claude worker has no in-process safety hook, so we
      # refuse rather than run an agent with a shell and no containment. Write NO
      # envelope (empty capture → parseResult reads "unknown", never a fake 0) and
      # return non-zero so the caller's existing error path treats it as a failure.
      : > "$out_json"
      _gaffer_worker_unsupported_msg "${GAFFER_WORKER_PROVIDER:-}" >&2
      return 70
      ;;
  esac
}
