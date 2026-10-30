#!/usr/bin/env bash
# =====================================================================
# lib/claude-auth.sh — is `claude` able to AUTHENTICATE, not just installed?
# Sourced by factory.config.sh; used by preflight.sh.
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
#   · 1 none visible · 2 unknown (macOS Keychain — not inspectable from a shell).
gaffer_claude_auth_probe() {
  GAFFER_CLAUDE_AUTH_SOURCE=""
  local k
  for k in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX; do
    if [ -n "${!k:-}" ]; then GAFFER_CLAUDE_AUTH_SOURCE="\$$k"; return 0; fi
  done
  local cred="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json"
  if [ -s "$cred" ]; then GAFFER_CLAUDE_AUTH_SOURCE="$cred"; return 0; fi
  [ "$(uname -s 2>/dev/null)" = "Darwin" ] && return 2
  return 1
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

# LIVE CLAUDE PROBE: 1 = runner/preflight.sh also makes ONE tiny paid `claude -p` call
# to prove the login works (catches an expired token the free credential check cannot);
# 0 = only the free check (is a credential visible at all).
: "${GAFFER_PREFLIGHT_LIVE:=0}"
# Seconds the live probe may take before it counts as a failure.
: "${GAFFER_PREFLIGHT_LIVE_TIMEOUT:=60}"
