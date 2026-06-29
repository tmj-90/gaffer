#!/usr/bin/env bash
# =====================================================================
# C1/M2 — the live `claude -p` launches must NOT inherit ambient
# credentials. tick.sh wraps every agent launch in
#   env -i "${GAFFER_AGENT_ENV[@]}" …
# where GAFFER_AGENT_ENV is built by gaffer_agent_env (factory.config.sh)
# as an ALLOWLIST. This test proves the helper:
#   - DROPS the dangerous ambient credentials (GITHUB_TOKEN, AWS access
#     keys/secret/session token, DISPATCH_API_TOKEN, generic *_TOKEN /
#     *_SECRET / *_KEY / *_PASSWORD), and
#   - KEEPS exactly what `claude -p` + its MCP tools need (PATH, HOME,
#     ANTHROPIC_API_KEY, MCP_CONFIG, DISPATCH_DB/MEMORY_DB, CLAUDE_*,
#     GAFFER_* boundary vars).
# It also proves an env-diff: the produced env excludes the dangerous
# vars even when they are present in the parent.
#
# Zero deps. Run: bash test/agent-env-scrub.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

# Build the allowlisted env in a SUBSHELL that carries a representative parent
# environment (both dangerous and legitimate vars). Print it as KEY lines so we
# can assert presence/absence deterministically. We invoke the helper exactly as
# tick.sh does and then dump the resulting GAFFER_AGENT_ENV array.
AGENT_ENV="$(
  env -i \
    PATH="/usr/bin:/bin" HOME="/home/agent" \
    ANTHROPIC_API_KEY="sk-ant-keepme" \
    ANTHROPIC_BASE_URL="https://api.anthropic.com" \
    MCP_CONFIG="/tmp/.mcp.json" DISPATCH_DB="/tmp/wg.sqlite" MEMORY_DB="/tmp/lg.sqlite" \
    CLAUDE_BIN="claude" CLAUDE_FLAGS="--permission-mode acceptEdits" \
    GAFFER_PLAN_MODEL="opus" GAFFER_MAX_TURNS="200" \
    GITHUB_TOKEN="gh-LEAK" GH_TOKEN="gh2-LEAK" \
    AWS_ACCESS_KEY_ID="AKIA-LEAK" AWS_SECRET_ACCESS_KEY="aws-secret-LEAK" \
    AWS_SESSION_TOKEN="aws-session-LEAK" AWS_REGION="eu-west-2" \
    DISPATCH_API_TOKEN="bearer-LEAK" DB_PASSWORD="hunter2-LEAK" \
    SOME_API_KEY="generic-LEAK" SOME_SECRET="generic-secret-LEAK" \
    GAFFER_NOTIFY_WEBHOOK_URL="https://hooks.example.com/secret-LEAK" \
    GAFFER_NOTIFY_SLACK_URL="https://hooks.slack.com/T123/secret-LEAK" \
    GAFFER_DASHBOARD_URL="http://127.0.0.1:8787-LEAK" \
    GAFFER_SLACK_WEBHOOK="https://hooks.slack.com/legacy-LEAK" \
    RUNNER_DIR="$RUNNER_DIR" \
    bash -c '
      source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
      gaffer_agent_env
      for kv in "${GAFFER_AGENT_ENV[@]}"; do printf "%s\n" "${kv%%=*}"; done
    '
)"

has() { printf '%s\n' "$AGENT_ENV" | grep -qx "$1"; }

echo "== dangerous ambient credentials are DROPPED (C1/M2) =="
for danger in GITHUB_TOKEN GH_TOKEN AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY \
              AWS_SESSION_TOKEN DISPATCH_API_TOKEN DB_PASSWORD SOME_API_KEY SOME_SECRET; do
  if has "$danger"; then fail "$danger leaked into the agent env"; else ok "$danger is stripped"; fi
done

echo "== outbound endpoint / notify config is STRIPPED (FIX #1 — exfiltration channel) =="
for endpoint in GAFFER_NOTIFY_WEBHOOK_URL GAFFER_NOTIFY_SLACK_URL \
                GAFFER_DASHBOARD_URL GAFFER_SLACK_WEBHOOK; do
  if has "$endpoint"; then fail "$endpoint leaked into the agent env (outbound channel)"; else ok "$endpoint is stripped"; fi
done

echo "== claude -p auth + MCP wiring SURVIVE (don't break the agent) =="
for keep in PATH HOME ANTHROPIC_API_KEY ANTHROPIC_BASE_URL MCP_CONFIG DISPATCH_DB MEMORY_DB \
            CLAUDE_BIN CLAUDE_FLAGS GAFFER_PLAN_MODEL GAFFER_MAX_TURNS AWS_REGION; do
  if has "$keep"; then ok "$keep is preserved"; else fail "$keep was dropped (would break the agent)"; fi
done

echo "== ANTHROPIC_API_KEY survives despite ending in _KEY =="
if has ANTHROPIC_API_KEY; then ok "ANTHROPIC_API_KEY kept (claude auth)"; else fail "ANTHROPIC_API_KEY wrongly stripped"; fi

echo "== ANTHROPIC_BASE_URL survives despite ending in _URL (explicit keep) =="
if has ANTHROPIC_BASE_URL; then ok "ANTHROPIC_BASE_URL kept (claude base URL override)"; else fail "ANTHROPIC_BASE_URL wrongly stripped"; fi

echo "== values are preserved verbatim (no truncation/quoting damage) =="
VAL="$(
  env -i RUNNER_DIR="$RUNNER_DIR" ANTHROPIC_API_KEY="sk-ant has spaces=and-eq" PATH="/usr/bin:/bin" \
    bash -c '
      source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
      gaffer_agent_env
      for kv in "${GAFFER_AGENT_ENV[@]}"; do
        [ "${kv%%=*}" = "ANTHROPIC_API_KEY" ] && printf "%s" "${kv#*=}"
      done
    '
)"
if [ "$VAL" = "sk-ant has spaces=and-eq" ]; then
  ok "value with spaces and '=' is preserved verbatim"
else
  fail "value mangled: got '$VAL'"
fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
