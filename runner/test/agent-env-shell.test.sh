#!/bin/bash
# =====================================================================
# Shell-path coverage for gaffer_agent_env (runner/factory.config.sh).
# ---------------------------------------------------------------------
# The JS agentChildEnv is tested in agent-env-scrub.test.sh (which uses
# env -i + bash to invoke the shell function).  This file is a dedicated
# /bin/bash-locked test that:
#   - exports the full set of sensitive vars the PR review identified:
#       GAFFER_NOTIFY_WEBHOOK_URL, FOO_URL, MY_WEBHOOK_URL,
#       SLACK_WEBHOOK_TOKEN, GITHUB_TOKEN  (must be ABSENT)
#   - exports the vars that must SURVIVE:
#       ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, GAFFER_MAX_TURNS
#   - asserts the absent vars produce zero output lines.
#   - asserts the surviving vars are present with their exact values.
#
# Locks to /bin/bash because the POSIX exec(2) used by env -i must hand
# control to the same interpreter that handles the factory process on the
# runner; sourcing factory.config.sh under /bin/sh (dash on Ubuntu) would
# exercise a different parser.
#
# Zero deps beyond /bin/bash and the factory.config.sh file.
# Run: bash runner/test/agent-env-shell.test.sh
# =====================================================================
# shellcheck shell=bash
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

[ -f "$RUNNER_DIR/factory.config.sh" ] || { echo "SKIP: factory.config.sh not found"; exit 0; }

# ---------------------------------------------------------------------------
# Build the filtered env via a /bin/bash subshell that sources factory.config.sh
# exactly as tick.sh does, then dumps GAFFER_AGENT_ENV key names one-per-line.
# env -i gives a clean slate; we inject only the representative parent vars.
# ---------------------------------------------------------------------------
AGENT_KEYS="$(
  env -i \
    PATH="/usr/bin:/bin" \
    HOME="$HOME" \
    SHELL="/bin/bash" \
    RUNNER_DIR="$RUNNER_DIR" \
    ANTHROPIC_API_KEY="sk-ant-keepme" \
    ANTHROPIC_BASE_URL="https://api.anthropic.com" \
    ANTHROPIC_AUTH_TOKEN="" \
    GAFFER_MAX_TURNS="200" \
    GAFFER_PLAN_MODEL="sonnet" \
    GITHUB_TOKEN="gh-LEAK" \
    GAFFER_NOTIFY_WEBHOOK_URL="https://hooks.example.com/notify-LEAK" \
    FOO_URL="https://foo.example.com/LEAK" \
    MY_WEBHOOK_URL="https://my.example.com/LEAK" \
    SLACK_WEBHOOK_TOKEN="xoxb-LEAK" \
    /bin/bash -c '
      source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
      gaffer_agent_env
      for kv in "${GAFFER_AGENT_ENV[@]}"; do printf "%s\n" "${kv%%=*}"; done
    '
)"

has() { printf '%s\n' "$AGENT_KEYS" | grep -qx "$1"; }

echo "== URL/webhook/notify/credential vars must be ABSENT from the agent env =="
# *_URL pattern (deny: outbound endpoint exfiltration channel)
if has GAFFER_NOTIFY_WEBHOOK_URL; then
  fail "GAFFER_NOTIFY_WEBHOOK_URL leaked (outbound notify endpoint)"
else
  ok "GAFFER_NOTIFY_WEBHOOK_URL is stripped"
fi

if has FOO_URL; then
  fail "FOO_URL leaked (arbitrary *_URL must be stripped)"
else
  ok "FOO_URL is stripped (generic *_URL deny pattern)"
fi

if has MY_WEBHOOK_URL; then
  fail "MY_WEBHOOK_URL leaked (matches both *_WEBHOOK* and *_URL)"
else
  ok "MY_WEBHOOK_URL is stripped (matches *_WEBHOOK* + *_URL deny patterns)"
fi

# *_TOKEN pattern (deny: credential-shaped)
if has SLACK_WEBHOOK_TOKEN; then
  fail "SLACK_WEBHOOK_TOKEN leaked (credential-shaped *_TOKEN)"
else
  ok "SLACK_WEBHOOK_TOKEN is stripped (*_TOKEN deny pattern)"
fi

if has GITHUB_TOKEN; then
  fail "GITHUB_TOKEN leaked into agent env"
else
  ok "GITHUB_TOKEN is stripped"
fi

echo "== ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, GAFFER_MAX_TURNS must SURVIVE =="
if has ANTHROPIC_BASE_URL; then
  ok "ANTHROPIC_BASE_URL is preserved (explicit allow overrides *_URL deny)"
else
  fail "ANTHROPIC_BASE_URL was stripped (would break claude base URL override)"
fi

if has ANTHROPIC_API_KEY; then
  ok "ANTHROPIC_API_KEY is preserved (explicit allow overrides *_KEY deny)"
else
  fail "ANTHROPIC_API_KEY was stripped (would break claude auth)"
fi

if has GAFFER_MAX_TURNS; then
  ok "GAFFER_MAX_TURNS is preserved (GAFFER_* prefix allow)"
else
  fail "GAFFER_MAX_TURNS was stripped (would break max-turns cap)"
fi

echo "== Values are passed verbatim (no quoting damage) =="
ACTUAL_KEY="$(
  env -i \
    PATH="/usr/bin:/bin" \
    HOME="$HOME" \
    SHELL="/bin/bash" \
    RUNNER_DIR="$RUNNER_DIR" \
    ANTHROPIC_API_KEY="sk-ant has=spaces" \
    /bin/bash -c '
      source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
      gaffer_agent_env
      for kv in "${GAFFER_AGENT_ENV[@]}"; do
        [ "${kv%%=*}" = "ANTHROPIC_API_KEY" ] && printf "%s" "${kv#*=}"
      done
    '
)"
if [ "$ACTUAL_KEY" = "sk-ant has=spaces" ]; then
  ok "ANTHROPIC_API_KEY value with spaces and '=' is preserved verbatim"
else
  fail "ANTHROPIC_API_KEY value mangled: got '$ACTUAL_KEY'"
fi

# ---------------------------------------------------------------------------
echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS — $PASS checks passed (/bin/bash path)"
  exit 0
else
  echo "FAILED — ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]})) failed"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
