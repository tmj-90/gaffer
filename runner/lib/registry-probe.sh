#!/usr/bin/env bash
# =====================================================================
# lib/registry-probe.sh — EXECUTION preflight: can the AGENT reach the package
# registry? Sourced by factory.config.sh; used by preflight.sh (report) and by the
# bootstrap path in tick.sh (gate, before a model call is spent).
#
# Why it exists (seen live, exp3): preflight passed 17/17 — tool presence, builds,
# config, MCP handshakes — and the first delivery tick then spun for the whole
# 30-minute GAFFER_TICK_TIMEOUT because the bootstrap agent's `npm install` could
# not verify the TLS-intercepting proxy's certificate. npm retries a certificate
# failure three times with backoff PER PACKAGE (a single `npm view` takes ~70 s to
# fail), so a scaffold install of dozens of packages burns the tick, the ticket is
# parked as a generic "timeout", and nothing says WHY. The runner never noticed
# because IT inherited the trust store; the agent's allowlisted env did not.
#
# The probe therefore runs `npm ping` INSIDE the agent's env — `env -i` with the
# same GAFFER_AGENT_ENV allowlist tick.sh uses (PATH, HOME → ~/.npmrc, npm_config_*,
# proxy route, trust store) — with retries off and a bound, so it answers in seconds
# and fails for exactly the reasons the delivery would.
#
# Discipline (runner/CLAUDE.md): additive + fail-soft on the factory's side. npm
# missing, the knob off, or the helper absent → "skipped" (rc 2), never a refusal.
# =====================================================================

# gaffer_registry_probe [timeout_secs]
#   → 0 reachable · 1 unreachable (GAFFER_REGISTRY_PROBE_CODE = npm error code, e.g.
#     SELF_SIGNED_CERT_IN_CHAIN / ENOTFOUND / ECONNREFUSED / E407 / timeout / rc=N;
#     GAFFER_REGISTRY_PROBE_DETAIL = the first `npm error` line) · 2 skipped
#     (GAFFER_REGISTRY_PROBE=0, npm not installed, or gaffer_agent_env unavailable).
gaffer_registry_probe() {
  local secs="${1:-${GAFFER_REGISTRY_PROBE_TIMEOUT:-45}}"
  GAFFER_REGISTRY_PROBE_CODE=""; GAFFER_REGISTRY_PROBE_DETAIL=""
  [ "${GAFFER_REGISTRY_PROBE:-1}" = "1" ] || { GAFFER_REGISTRY_PROBE_CODE="skipped"; return 2; }
  command -v npm >/dev/null 2>&1 || { GAFFER_REGISTRY_PROBE_CODE="no-npm"; return 2; }
  declare -F gaffer_agent_env >/dev/null 2>&1 || { GAFFER_REGISTRY_PROBE_CODE="no-agent-env"; return 2; }
  gaffer_agent_env
  local out rc=0
  # The agent's exact env, plus: no retries (one attempt answers the question), a
  # short per-request timeout, and the chatter off. These only SHORTEN the probe —
  # the registry, proxy route, cafile and ~/.npmrc are whatever the agent gets.

  if declare -F gaffer_timeout >/dev/null 2>&1; then
    out="$(gaffer_timeout "$secs" env -i ${GAFFER_AGENT_ENV[@]+"${GAFFER_AGENT_ENV[@]}"} \
      npm_config_fetch_retries=0 npm_config_fetch_timeout=20000 \
      npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false \
      npm_config_loglevel=error npm ping 2>&1 </dev/null)" || rc=$?
  else
    out="$(env -i ${GAFFER_AGENT_ENV[@]+"${GAFFER_AGENT_ENV[@]}"} \
      npm_config_fetch_retries=0 npm_config_fetch_timeout=20000 \
      npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false \
      npm_config_loglevel=error npm ping 2>&1 </dev/null)" || rc=$?
  fi
  [ "$rc" -eq 0 ] && return 0
  # shellcheck disable=SC2034  # read by preflight.sh / tick.sh after the call
  GAFFER_REGISTRY_PROBE_DETAIL="$(printf '%s\n' "$out" | grep -m1 -E '^npm (ERR!|error) ' | cut -c1-300)"
  if [ "$rc" -eq 124 ]; then
    GAFFER_REGISTRY_PROBE_CODE="timeout"
  else
    GAFFER_REGISTRY_PROBE_CODE="$(printf '%s\n' "$out" | sed -n 's/^npm \(ERR! \|error \)code \([A-Za-z0-9_]*\).*/\2/p' | head -1)"
    [ -n "$GAFFER_REGISTRY_PROBE_CODE" ] || GAFFER_REGISTRY_PROBE_CODE="$(printf '%s\n' "$out" | grep -o -m1 -E 'SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT|CERT_[A-Z_]+|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|E40[0-9]|E5[0-9][0-9]' || true)"
    [ -n "$GAFFER_REGISTRY_PROBE_CODE" ] || GAFFER_REGISTRY_PROBE_CODE="rc=$rc"
  fi
  return 1
}

# gaffer_registry_probe_hint <code> → one line an operator can act on.
gaffer_registry_probe_hint() {
  case "${1:-}" in
    SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT|CERT_*)
      printf '%s' "the agent env does not trust the proxy's CA: export NODE_EXTRA_CA_CERTS=<bundle> (passed through to agents) and run \`npm config set cafile <bundle>\`; never disable TLS verification" ;;
    ENOTFOUND|EAI_AGAIN)
      printf '%s' "the registry host does not resolve from the agent env: offline, or the proxy route is missing (export HTTPS_PROXY / NO_PROXY)" ;;
    ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|timeout)
      printf '%s' "the registry (or proxy) did not answer within the bound: check HTTPS_PROXY / NO_PROXY and that this network allows the registry (npm_config_registry)" ;;
    E407)
      printf '%s' "the proxy requires authentication: put the credentials in HTTPS_PROXY" ;;
    E401|E403)
      printf '%s' "the registry refused the request (auth / allowlist): check npm_config_registry and its token" ;;
    *)
      printf '%s' "run \`npm ping\` from a shell with the agent's env (runner/preflight.sh prints this probe); GAFFER_REGISTRY_PROBE=0 skips it for an offline machine with a warm cache" ;;
  esac
}

# REGISTRY PROBE: 1 = before a greenfield bootstrap spawns its agent (and in
# runner/preflight.sh) run `npm ping` inside the agent's allowlisted env, bounded by
# GAFFER_REGISTRY_PROBE_TIMEOUT seconds; an unreachable registry parks the bootstrap
# to blocked at once with the npm error code and a fix hint, spending no model call.
# 0 = skip (offline with a warm npm cache, or a registry that rejects ping).
: "${GAFFER_REGISTRY_PROBE:=1}"
# Seconds the registry probe may take before it counts as unreachable ("timeout").
: "${GAFFER_REGISTRY_PROBE_TIMEOUT:=45}"
