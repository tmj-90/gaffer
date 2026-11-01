#!/usr/bin/env bash
# =====================================================================
# lib/claude-auth.sh — is `claude` able to AUTHENTICATE, not just installed?
# Sourced by factory.config.sh; used by preflight.sh and the live-run gate (loop.sh,
# `gaffer run`, bin/poll-once.sh: gaffer_claude_auth_gate).
#
# Why it exists: preflight checked only `claude --version`, so an unauthenticated or
# expired claude reported "→ ready"; the first onboard then logged a vague "no usable
# JSON" and the first live tick failed every agent call. `--version` succeeds without
# credentials, so presence says nothing about auth.
#
# Two levels:
#   • gaffer_claude_auth_probe  — FREE: is a credential VISIBLE? (the env vars the CLI
#     reads, or its credentials file). macOS keeps the login in the Keychain, which a
#     shell cannot inspect, so there it reports "unknown" rather than a false alarm.
#   • gaffer_claude_live_probe  — opt-in (GAFFER_PREFLIGHT_LIVE=1), ONE tiny paid call:
#     `claude -p ok --max-turns 1 --output-format json`; fails on a non-zero exit or
#     claude's JSON reporting is_error (auth / limit errors often exit 0).
# Discipline (runner/CLAUDE.md): report-only, never mutates, never reads a credential's
# contents — only whether one exists.
# =====================================================================

# gaffer_claude_auth_probe
#   → 0 a credential is visible (GAFFER_CLAUDE_AUTH_SOURCE says which)
#   · 1 none visible · 2 unknown (macOS Keychain, a gateway, no HOME: not inspectable).
# Looks at: the env vars the CLI reads, its credentials file, a Console key in its
# global config (~/.claude.json), and an apiKeyHelper or auth `env` entry in the
# user's or the managed settings.json. Only the presence of a key name is checked.
gaffer_claude_auth_probe() {
  GAFFER_CLAUDE_AUTH_SOURCE=""
  local k
  for k in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY; do
    if [ -n "${!k:-}" ]; then GAFFER_CLAUDE_AUTH_SOURCE="\$$k"; return 0; fi
  done
  # No HOME (a bare service unit) and no CLAUDE_CONFIG_DIR: nowhere to look, so unknown.
  [ -z "${CLAUDE_CONFIG_DIR:-}" ] && [ -z "${HOME:-}" ] && return 2
  local cdir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  local cred="$cdir/.credentials.json"
  if [ -s "$cred" ]; then GAFFER_CLAUDE_AUTH_SOURCE="$cred"; return 0; fi
  # The CLI's global config keeps a Console login's key as primaryApiKey.
  local gcfg="${HOME:-}/.claude.json"; [ -n "${CLAUDE_CONFIG_DIR:-}" ] && gcfg="$CLAUDE_CONFIG_DIR/.claude.json"
  if [ -s "$gcfg" ] && grep -q '"primaryApiKey"' "$gcfg" 2>/dev/null; then GAFFER_CLAUDE_AUTH_SOURCE="$gcfg (primaryApiKey)"; return 0; fi
  # The user's and the managed settings can supply a login: an apiKeyHelper that
  # produces the key, or an `env` block that sets a key, a cloud provider or a gateway.
  local cset
  for cset in "$cdir/settings.json" /etc/claude-code/managed-settings.json "/Library/Application Support/ClaudeCode/managed-settings.json"; do
    [ -s "$cset" ] || continue
    if grep -qE '"(apiKeyHelper|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY|ANTHROPIC_BASE_URL)"' "$cset" 2>/dev/null; then
      GAFFER_CLAUDE_AUTH_SOURCE="$cset"; return 0
    fi
  done
  [ "$(uname -s 2>/dev/null)" = "Darwin" ] && return 2
  # A gateway (ANTHROPIC_BASE_URL) may authenticate on its own: not inspectable.
  [ -n "${ANTHROPIC_BASE_URL:-}" ] && return 2
  return 1
}

# gaffer_claude_auth_gate — the LIVE-RUN gate (loop.sh, `gaffer run`, bin/poll-once.sh)
# before any ticket is claimed (exploratory findings fresh-user/F-04, F-06): a logged-out
# claude used to claim a good ticket, fail with "Invalid API key · Please run /login",
# count a no-commit failure and, three runs later, park the ticket.
#   → 0 go · 1 refuse (no credential visible; gaffer_claude_auth_hint says what to do).
# FREE (gaffer_claude_auth_probe, no model call) and CACHED for the run: a pass exports
# GAFFER_CLAUDE_AUTH_CHECKED=ok, so its workers and later checks do not probe again.
# Never refuses on doubt: a dry run, another worker provider, a custom CLAUDE_BIN (a
# wrapper may bring its own login), the docker sandbox (the container has its own),
# "unknown" (the macOS Keychain, an ANTHROPIC_BASE_URL gateway, no HOME) and
# GAFFER_CLAUDE_AUTH_PROBE=0 all go ahead. A credential
# that is present but rejected is caught when the call fails (tick.sh auth_error).
gaffer_claude_auth_gate() {
  [ "${DRY_RUN:-0}" = "1" ] && return 0
  [ "${GAFFER_CLAUDE_AUTH_PROBE:-1}" = "0" ] && return 0
  [ "${GAFFER_CLAUDE_AUTH_CHECKED:-}" = "ok" ] && return 0
  case "${GAFFER_WORKER_PROVIDER:-claude-code}" in claude-code|claude|"") ;; *) return 0 ;; esac
  [ "${CLAUDE_BIN:-claude}" = "claude" ] || return 0
  # The docker sandbox runs the agent in a container with ITS credential (forwarded
  # env or GAFFER_SANDBOX_CLAUDE_CREDENTIALS, which sandbox-docker.sh checks), not the
  # host's login, so the host having none says nothing.
  if [ "${SANDBOX_PROVIDER:-}" = "docker" ] && declare -F _worker_sandbox_wanted >/dev/null 2>&1 && _worker_sandbox_wanted; then
    return 0
  fi
  local _rc=0
  gaffer_claude_auth_probe || _rc=$?
  [ "$_rc" = 1 ] && return 1
  export GAFFER_CLAUDE_AUTH_CHECKED=ok
  return 0
}
gaffer_claude_auth_hint() {
  printf '%s' 'claude is not logged in: run `claude /login` (or set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in your environment; GAFFER_CLAUDE_AUTH_PROBE=0 skips this check)'
}

# gaffer_claude_live_probe [timeout_secs]
#   → 0 claude answered · 1 it failed (GAFFER_CLAUDE_LIVE_ERROR = its first error line)
#   · 2 skipped (claude not on PATH).
gaffer_claude_live_probe() {
  local secs="${1:-$GAFFER_PREFLIGHT_LIVE_TIMEOUT}" bin="${CLAUDE_BIN:-claude}" out rc scratch
  GAFFER_CLAUDE_LIVE_ERROR=""
  command -v "$bin" >/dev/null 2>&1 || return 2
  # The probe only asks whether claude can answer at all. It gets NO tools, no MCP
  # servers and no slash commands, and runs from an empty scratch directory, never from
  # the caller's cwd (under loop.sh that is the runner checkout). A stub that treated
  # the probe as a delivery once committed into the checkout from there.
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/gaffer-live-probe.XXXXXX")" || return 1
  printf '{"mcpServers":{}}' >"$scratch/mcp.json"
  if command -v timeout >/dev/null 2>&1; then
    out="$(cd "$scratch" && GAFFER_WRITE_ROOTS="$scratch" timeout "$secs" "$bin" -p ok --max-turns 1 --output-format json \
      --tools "" --mcp-config "$scratch/mcp.json" --strict-mcp-config --disable-slash-commands 2>&1)"; rc=$?
  else
    out="$(cd "$scratch" && GAFFER_WRITE_ROOTS="$scratch" "$bin" -p ok --max-turns 1 --output-format json \
      --tools "" --mcp-config "$scratch/mcp.json" --strict-mcp-config --disable-slash-commands 2>&1)"; rc=$?
  fi
  rm -rf "$scratch"
  if [ "$rc" -eq 0 ] && ! grep -Eq '"is_error"[[:space:]]*:[[:space:]]*true' <<<"$out"; then return 0; fi
  # The error line: claude's JSON .result when it parses, else the first output line.
  GAFFER_CLAUDE_LIVE_ERROR="$(printf '%s' "$out" | node -e '
    let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
      let line = "";
      try { const j = JSON.parse(d); line = String(j.result ?? ""); } catch {}
      if (!line) line = d.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
      process.stdout.write(line.slice(0, 200));
    });' 2>/dev/null)"
  [ -n "$GAFFER_CLAUDE_LIVE_ERROR" ] || GAFFER_CLAUDE_LIVE_ERROR="exit $rc"
  [ "$rc" -eq 124 ] && GAFFER_CLAUDE_LIVE_ERROR="timed out after ${secs}s"
  return 1
}

# LIVE-RUN AUTH GATE: 0 = skip the free credential check before a live run
# (gaffer_claude_auth_gate); 1 (default) = refuse a live run when no credential is visible.
: "${GAFFER_CLAUDE_AUTH_PROBE:=1}"
# LIVE CLAUDE PROBE: 1 = runner/preflight.sh also makes ONE tiny paid `claude -p` call
# to prove the login works (catches an expired token the free credential check cannot);
# 0 = only the free check (is a credential visible at all).
: "${GAFFER_PREFLIGHT_LIVE:=0}"
# Seconds the live probe may take before it counts as a failure.
: "${GAFFER_PREFLIGHT_LIVE_TIMEOUT:=60}"
