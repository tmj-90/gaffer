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
worker_deliver() {
  local cwd="$1" prompt="$2" model_flag="$3" mcp_config="$4" out_json="$5" wrap="${6:-}"
  # C1/M2: strip ambient credentials from the live agent's env (allowlist via env -i).
  # Populated here so the scrub is byte-identical for every site (each site called
  # gaffer_agent_env immediately before its invocation previously).
  gaffer_agent_env
  ( cd "$cwd" \
    && gaffer_timeout "$GAFFER_TICK_TIMEOUT" $wrap \
       env -i "${GAFFER_AGENT_ENV[@]}" "${WORKER_CALL_ENV[@]}" \
         "$CLAUDE_BIN" -p "$prompt" --output-format json --mcp-config "$mcp_config" $CLAUDE_FLAGS $model_flag $GAFFER_MAX_TURNS_FLAG \
  ) >"$out_json" 2>>"$GAFFER_LOG"
}
