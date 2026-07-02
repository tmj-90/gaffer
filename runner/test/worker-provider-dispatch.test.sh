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
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/worker-provider.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
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
  printf '%s' "$DELIVER_ERR" | grep -qE "$EXPECT_MSG_RE" \
    && ok "provider=$prov emits the honest containment message" \
    || fail "provider=$prov did not emit the fail-closed message (got: $DELIVER_ERR)"
  printf '%s' "$DELIVER_ERR" | grep -qF "$prov" \
    && ok "provider=$prov names itself in the message" || fail "provider=$prov not named in message"
  [ ! -s "$DELIVER_OUT" ] && ok "provider=$prov wrote NO envelope (empty capture → parseResult=unknown)" \
    || fail "provider=$prov wrote a capture — a stub must not fabricate an envelope"
done

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

echo "== PARITY: the safety-hook precondition still HARD-GATES the Claude path =="
# The invariant this seam must never weaken: tick.sh refuses to run a live agent
# when the deterministic PreToolUse safety hook is missing. Structural (grep) proof,
# matching the worker-seam-routing test's style — the four live-turn gates persist.
TICK="$RUNNER_DIR/tick.sh"
GATES="$(grep -cE '\[ -f "\$RUNNER_DIR/safety-hook\.mjs" \] \|\| \{ log "SAFETY: hook missing' "$TICK" || true)"
[ "$GATES" -ge 4 ] && ok "tick.sh still fail-closes on a missing safety hook at $GATES live sites (>=4)" \
  || fail "safety-hook hard-gate weakened: expected >=4 fail-closed sites in tick.sh (got $GATES)"
# And worker_deliver's Claude branch STILL runs under the env -i allowlist scrub +
# gaffer_timeout (the containment wrapper is inside the provider dispatch, unchanged).
WSH="$RUNNER_DIR/lib/worker.sh"
grep -qE 'env -i "\$\{GAFFER_AGENT_ENV\[@\]\}"' "$WSH" \
  && ok "claude-code branch still scrubs env via the env -i allowlist" \
  || fail "the env -i allowlist scrub vanished from the claude-code branch"
grep -qE 'gaffer_timeout "\$GAFFER_TICK_TIMEOUT"' "$WSH" \
  && ok "claude-code branch still runs under gaffer_timeout" \
  || fail "the gaffer_timeout wrapper vanished from the claude-code branch"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
