#!/usr/bin/env bash
# =====================================================================
# Worker Abstraction Seam — Phase 3 PROVIDER DISPATCH (Spec 3, bash side).
# ---------------------------------------------------------------------
# Proves the SEAM (not a second worker): worker_deliver dispatches on
# $GAFFER_WORKER_PROVIDER exactly the way sandbox.sh dispatches on
# $SANDBOX_PROVIDER, with ONE real provider and honest fail-closed stubs.
#
#   • provider=claude-code (default): BYTE-IDENTICAL to today — it actually spawns
#     the worker binary (positive control: a marker file appears).
#   • provider=command: the second real provider — it runs GAFFER_WORKER_COMMAND (not
#     claude) with the GAFFER_WORKER_* contract, and the parser adapter writes the
#     canonical envelope the bash guards read through parse-result.
#   • provider=codex / local / unknown: FAIL CLOSED — non-zero exit, the exact
#     message on stderr, NO spawn (negative control: the marker NEVER appears),
#     and NO envelope written to the capture file.
#   • model-flag emission is provider-indirected but claude-code stays `--model X`
#     byte-for-byte (GAFFER_*_MODEL_FLAG unchanged).
#   • gaffer_agent_env's allowlist is provider-indirected: claude-code keeps the
#     ANTHROPIC auth surface (survives the *_KEY/*_TOKEN deny); a non-Claude
#     provider does NOT (negative control — no accidental cross-provider leak).
#   • PARITY: the safety-hook fail-closed precondition still HARD-GATES the Claude
#     path in tick.sh (the invariant this seam must never weaken).
#
# Zero deps. Run: bash test/worker-provider-dispatch.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/worker-provider.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
export GAFFER_DATA="$WORK/.gaffer"
mkdir -p "$GAFFER_DATA"

# A fake worker binary that PROVES a spawn happened by creating a marker file at a
# path baked into the script (survives the env -i scrub, which clears the env).
MARKER="$WORK/spawned.marker"
FAKE_CLAUDE="$WORK/fake-claude"
cat > "$FAKE_CLAUDE" <<EOF
#!/usr/bin/env bash
: > "$MARKER"
printf '%s\n' '{"result":"ok","total_cost_usd":0.01,"num_turns":1}'
EOF
chmod +x "$FAKE_CLAUDE"

# Point the seam at the fake binary BEFORE sourcing config (CLAUDE_BIN uses ?=).
export CLAUDE_BIN="$FAKE_CLAUDE"
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh"

MCP="$WORK/mcp.json"; printf '{}' > "$MCP"
CWD="$WORK/cwd"; mkdir -p "$CWD"
# Non-empty so the "${WORKER_CALL_ENV[@]}" expansion is defined at every call.
WORKER_CALL_ENV=( GAFFER_PROVIDER_TEST=1 )

# Run worker_deliver for a provider; captures rc, out_json content, stderr.
run_deliver() {
  local provider="$1" out="$WORK/out.$1.json" errf="$WORK/err.$1"
  rm -f "$MARKER"
  GAFFER_WORKER_PROVIDER="$provider" \
    worker_deliver "$CWD" "the prompt" "$GAFFER_IMPL_MODEL_FLAG" "$MCP" "$out" "" 2>"$errf"
  DELIVER_RC=$?
  DELIVER_OUT="$out"
  DELIVER_ERR="$(cat "$errf")"
}

EXPECT_MSG_RE='not yet supported; safety-hook containment unavailable'

echo "== provider=claude-code (default) is the real path — it SPAWNS =="
run_deliver "claude-code"
[ "$DELIVER_RC" = "0" ] && ok "claude-code exits 0 (worker ran)" || fail "claude-code should exit 0 (got $DELIVER_RC)"
[ -f "$MARKER" ] && ok "claude-code actually spawned the worker (marker present)" \
  || fail "claude-code did not spawn the worker (no marker)"
grep -q '"result":"ok"' "$DELIVER_OUT" && ok "claude-code captured the JSON envelope to out_json" \
  || fail "claude-code did not capture the worker envelope"

echo "== the DEFAULT (unset provider) is claude-code — still spawns =="
rm -f "$MARKER"
unset GAFFER_WORKER_PROVIDER
worker_deliver "$CWD" "p" "$GAFFER_IMPL_MODEL_FLAG" "$MCP" "$WORK/out.default.json" "" 2>/dev/null
rc=$?
[ "$rc" = "0" ] && [ -f "$MARKER" ] && ok "unset provider defaults to claude-code (spawned, exit 0)" \
  || fail "unset provider should default to claude-code and spawn (rc=$rc marker=$( [ -f "$MARKER" ] && echo yes || echo no ))"

echo "== provider=codex / local / unknown FAIL CLOSED — non-zero, message, NO spawn =="
for prov in codex local made-up-provider; do
  run_deliver "$prov"
  [ "$DELIVER_RC" -ne 0 ] && ok "provider=$prov fails closed (non-zero exit: $DELIVER_RC)" \
    || fail "provider=$prov should exit non-zero (got 0)"
  [ ! -f "$MARKER" ] && ok "provider=$prov did NOT spawn a worker (no marker)" \
    || fail "provider=$prov spawned a worker — must fail closed BEFORE any execution"
  grep -qE "$EXPECT_MSG_RE" <<<"$DELIVER_ERR" \
    && ok "provider=$prov emits the honest containment message" \
    || fail "provider=$prov did not emit the fail-closed message (got: $DELIVER_ERR)"
  grep -qF "$prov" <<<"$DELIVER_ERR" \
    && ok "provider=$prov names itself in the message" || fail "provider=$prov not named in message"
  [ ! -s "$DELIVER_OUT" ] && ok "provider=$prov wrote NO envelope (empty capture → parseResult=unknown)" \
    || fail "provider=$prov wrote a capture — a stub must not fabricate an envelope"
done

echo "== provider=command is the second real provider — it runs GAFFER_WORKER_COMMAND, not claude =="
CMD_ENV_DUMP="$WORK/command-env"
FAKE_CMD="$WORK/fake-command-worker"
cat > "$FAKE_CMD" <<EOF
#!/usr/bin/env bash
env > "$CMD_ENV_DUMP"
pwd >> "$CMD_ENV_DUMP"
printf 'noise first\n'
printf '%s\n' '{"result":"cmd ok","cost_usd":0.25,"num_turns":3,"model":"m-cmd","cap_hit":true}'
EOF
chmod +x "$FAKE_CMD"
rm -f "$MARKER" "$CMD_ENV_DUMP"
# This suite has no OS sandbox, so it takes the explicit out-of-band opt-out (the
# containment rule itself is pinned by worker-command.test.sh).
GAFFER_WORKER_PROVIDER=command GAFFER_WORKER_COMMAND="$FAKE_CMD" GAFFER_STRICT_REQUIRE=0 \
  worker_deliver "$CWD" "the command prompt" "--model stub-m" "$MCP" "$WORK/out.command.json" "" 9 2>"$WORK/err.command"
crc=$?
[ "$crc" = "0" ] && ok "provider=command exits 0 (the worker program ran)" || fail "provider=command should exit 0 (got $crc: $(cat "$WORK/err.command"))"
[ ! -f "$MARKER" ] && ok "provider=command did NOT run the claude binary" || fail "provider=command ran CLAUDE_BIN"
[ -f "$CMD_ENV_DUMP" ] && ok "provider=command ran GAFFER_WORKER_COMMAND" || fail "the command worker never ran"
grep -qx "GAFFER_WORKER_PROMPT=the command prompt" "$CMD_ENV_DUMP" && grep -qx "GAFFER_WORKER_MODEL=stub-m" "$CMD_ENV_DUMP" \
  && grep -qx "GAFFER_WORKER_MAX_TURNS=9" "$CMD_ENV_DUMP" && grep -qx "GAFFER_WORKER_MCP_CONFIG=$MCP" "$CMD_ENV_DUMP" \
  && grep -qx "GAFFER_WORKER_CONTRACT=1" "$CMD_ENV_DUMP" && grep -qx "$CWD" "$CMD_ENV_DUMP" \
  && ok "the contract reached the worker (prompt, model, turn cap, MCP config) in the call's cwd" \
  || fail "contract env missing: $(grep '^GAFFER_WORKER_' "$CMD_ENV_DUMP" | cut -c1-80 | tr '\n' ' ')"
grep -q '"gaffer_worker_provider":"command"' "$WORK/out.command.json" \
  && ok "the parser adapter wrote the canonical envelope (stamped with the provider)" || fail "no canonical envelope: $(cat "$WORK/out.command.json")"
[ "$(node "$RUNNER_DIR/lib/worker.mjs" parse-result spend --json-file "$WORK/out.command.json")" = '$0.2500' ] \
  && [ "$(node "$RUNNER_DIR/lib/worker.mjs" parse-result num-turns --json-file "$WORK/out.command.json")" = 3 ] \
  && [ "$(node "$RUNNER_DIR/lib/worker.mjs" parse-result result-text --json-file "$WORK/out.command.json")" = "cmd ok" ] \
  && node "$RUNNER_DIR/lib/worker.mjs" parse-result stopreason-maxturns --json-file "$WORK/out.command.json" \
  && ok "the bash cap/spend guards read it through the same parse-result CLI (spend, turns, text, cap hit)" \
  || fail "parse-result could not read the command envelope"
grep -q "WARNING: GAFFER_WORKER_PROVIDER=command with GAFFER_STRICT_REQUIRE=0" "$WORK/err.command" \
  && ok "the out-of-band opt-out is logged loudly at the spawn" || fail "no opt-out warning at the spawn"

echo "== model-flag emission is provider-indirected but claude-code is byte-identical =="
GAFFER_WORKER_PROVIDER=claude-code
[ "$(gaffer_model_flag opus)" = "--model opus" ] && ok "gaffer_model_flag opus → '--model opus' (claude-code)" \
  || fail "claude-code model flag changed (got '$(gaffer_model_flag opus)')"
[ -z "$(gaffer_model_flag '')" ] && ok "empty model name → empty flag (fall back to default)" \
  || fail "empty model name should emit no flag"
[ "$GAFFER_PLAN_MODEL_FLAG" = "--model $GAFFER_PLAN_MODEL" ] \
  && ok "GAFFER_PLAN_MODEL_FLAG unchanged ('$GAFFER_PLAN_MODEL_FLAG')" \
  || fail "GAFFER_PLAN_MODEL_FLAG regressed (got '$GAFFER_PLAN_MODEL_FLAG')"
[ "$GAFFER_IMPL_MODEL_FLAG" = "--model $GAFFER_IMPL_MODEL" ] \
  && ok "GAFFER_IMPL_MODEL_FLAG unchanged ('$GAFFER_IMPL_MODEL_FLAG')" \
  || fail "GAFFER_IMPL_MODEL_FLAG regressed (got '$GAFFER_IMPL_MODEL_FLAG')"

echo "== gaffer_agent_env allowlist is provider-indirected (claude-code == today) =="
export ANTHROPIC_API_KEY="sk-test-abc"
export CLAUDE_CODE_SOMETHING="x"
GAFFER_WORKER_PROVIDER=claude-code gaffer_agent_env
env_has() { local k; for k in "${GAFFER_AGENT_ENV[@]}"; do [ "${k%%=*}" = "$1" ] && return 0; done; return 1; }
env_has ANTHROPIC_API_KEY && ok "claude-code keeps ANTHROPIC_API_KEY (auth survives the *_KEY deny)" \
  || fail "claude-code must keep ANTHROPIC_API_KEY"
env_has CLAUDE_CODE_SOMETHING && ok "claude-code keeps CLAUDE_* namespace (provider prefix)" \
  || fail "claude-code must keep CLAUDE_* vars"
# Negative control: a non-Claude provider does NOT carry Claude's auth surface.
GAFFER_WORKER_PROVIDER=codex gaffer_agent_env
env_has ANTHROPIC_API_KEY && fail "codex must NOT inherit ANTHROPIC_API_KEY (cross-provider leak)" \
  || ok "negative control: codex drops ANTHROPIC_API_KEY (provider-scoped auth surface)"
# command: the claude-code surface is dropped; the names GAFFER_WORKER_COMMAND_ENV lists survive
# the credential deny (the worker's own auth) except the runner-only secrets.
export OTHER_MODEL_API_KEY="other-test-key" GITHUB_TOKEN="ghp-test" DISPATCH_API_TOKEN="dsp-test"
GAFFER_WORKER_PROVIDER=command GAFFER_WORKER_COMMAND_ENV="OTHER_MODEL_API_KEY GITHUB_TOKEN DISPATCH_API_TOKEN" gaffer_agent_env
env_has ANTHROPIC_API_KEY && fail "command must NOT inherit ANTHROPIC_API_KEY" || ok "command drops ANTHROPIC_API_KEY"
env_has CLAUDE_CODE_SOMETHING && fail "command must NOT inherit CLAUDE_* vars" || ok "command drops the CLAUDE_* namespace"
env_has OTHER_MODEL_API_KEY && ok "command keeps a name GAFFER_WORKER_COMMAND_ENV lists (survives the *_KEY deny)" \
  || fail "command should pass OTHER_MODEL_API_KEY named in GAFFER_WORKER_COMMAND_ENV"
{ env_has GITHUB_TOKEN || env_has DISPATCH_API_TOKEN; } && fail "command must never receive GITHUB_TOKEN / DISPATCH_API_TOKEN" \
  || ok "command never receives the runner-only secrets, even when named"
GAFFER_WORKER_PROVIDER=command GAFFER_WORKER_COMMAND_ENV="" gaffer_agent_env
env_has OTHER_MODEL_API_KEY && fail "without GAFFER_WORKER_COMMAND_ENV the key must be scrubbed" || ok "unnamed credentials stay scrubbed for command"
unset OTHER_MODEL_API_KEY GITHUB_TOKEN DISPATCH_API_TOKEN
[ "$(GAFFER_WORKER_PROVIDER=command gaffer_model_flag opus)" = "--model opus" ] \
  && ok "command: the model flag string is the seam's currency (read back as GAFFER_WORKER_MODEL)" \
  || fail "command model flag changed (got '$(GAFFER_WORKER_PROVIDER=command gaffer_model_flag opus)')"

echo "== PARITY: the safety-hook precondition still HARD-GATES the Claude path =="
# The invariant this seam must never weaken: tick.sh refuses to run a live agent when the
# deterministic PreToolUse safety hook is missing. The check is now CENTRALISED in
# gaffer_assert_safety_hook() (fail-closes on BOTH the hook file AND its deny-list) and CALLED
# to hard-gate every live-agent entry point. Structural (grep) proof of the gate + call sites.
TICK="$RUNNER_DIR/tick.sh"
# 1) the centralised assertion exists and fail-closes on a missing hook…
grep -qE '^gaffer_assert_safety_hook\(\)' "$TICK" \
  && grep -qE '\[ -f "\$RUNNER_DIR/safety-hook\.mjs" \]' "$TICK" \
  && ok "gaffer_assert_safety_hook() centralises the fail-closed hook precondition" \
  || fail "the centralised safety-hook precondition is gone — containment gate lost"
# 2) …and it HARD-GATES the live path at >=3 call sites (bootstrap / live run / agent-env prep),
#    each refusing to proceed (exit/return) when the assertion fails — inline, or through
#    gaffer_abort_setup (which always exits the tick as setup_error).
GATES="$(grep -cE 'gaffer_assert_safety_hook \|\| (\{|gaffer_abort_setup )' "$TICK" || true)"
[ "$GATES" -ge 3 ] && ok "tick.sh fail-closes on a missing safety hook at $GATES live gate sites (>=3)" \
  || fail "safety-hook hard-gate weakened: expected >=3 gaffer_assert_safety_hook call sites (got $GATES)"
# And worker_deliver's Claude branch STILL runs under the env -i allowlist scrub +
# gaffer_timeout (the containment wrapper is inside the provider dispatch, unchanged).
WSH="$RUNNER_DIR/lib/worker.sh"
grep -qE 'env -i "\$\{GAFFER_AGENT_ENV\[@\]\}"' "$WSH" \
  && ok "claude-code branch still scrubs env via the env -i allowlist" \
  || fail "the env -i allowlist scrub vanished from the claude-code branch"
grep -qE 'gaffer_timeout "\$GAFFER_TICK_TIMEOUT"' "$WSH" \
  && ok "claude-code branch still runs under gaffer_timeout" \
  || fail "the gaffer_timeout wrapper vanished from the claude-code branch"
# The command branch spawns under the SAME wrap + timeout + env -i scrub.
N_TO="$(grep -cE 'gaffer_timeout "\$GAFFER_TICK_TIMEOUT" \$wrap' "$WSH" || true)"
[ "$N_TO" = "2" ] && ok "both providers' spawns run under gaffer_timeout + the same \$wrap" \
  || fail "expected 2 gaffer_timeout \$wrap spawns in lib/worker.sh (got $N_TO)"
N_ENV="$(grep -cE 'env -i "\$\{GAFFER_AGENT_ENV\[@\]\}"' "$WSH" || true)"
[ "$N_ENV" = "2" ] && ok "both providers' spawns run under the env -i allowlist scrub" \
  || fail "expected 2 env -i allowlist spawns in lib/worker.sh (got $N_ENV)"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
