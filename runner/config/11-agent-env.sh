# shellcheck shell=bash
# runner/config/11-agent-env.sh: the agent child-env scrub: gaffer_agent_env and the worker provider's env
# pass-through helpers.
# Sourced by runner/factory.config.sh only, in its fixed order, never directly or on
# its own: it reads what the parts before it set. Lines moved verbatim from
# factory.config.sh. The last line tells factory.config.sh this part loaded whole.

# --- Agent child-env scrub (C1/M2/M3) ----------------------------------------
# The live `claude -p` launches (delivery, bootstrap, agent-review, clarify) run
# in a subshell that, by default, INHERITS the full parent environment. That env
# carries ambient credentials the runner needs but the AGENT does not —
# GITHUB_TOKEN, AWS_* keys, DISPATCH_API_TOKEN, anything matching
# *_TOKEN / *_SECRET / *_KEY / *_PASSWORD, AND the runner's own outbound-endpoint
# vars (GAFFER_NOTIFY_*, *_WEBHOOK*, *_SLACK*, *_URL). A prompt-injected agent
# that can read its own environment could exfiltrate credentials OR post to a
# notify webhook it found in GAFFER_NOTIFY_WEBHOOK_URL.
# The agentChildEnv() function in bin/product-owner-run.mjs now also drops these
# outbound-endpoint classes (keeping ANTHROPIC_BASE_URL as the sole *_URL
# exception, for API routing), RESTORING true parity between the two code paths.
# This function is an ALLOWLIST rather than a denylist: we start from nothing
# (`env -i`) and hand the agent ONLY what `claude -p`, its MCP tools, and the
# per-call boundary vars need. Nothing else can leak by accident, including
# credentials we haven't thought of yet.
#
# Usage:
#   gaffer_agent_env                       # populates the GAFFER_AGENT_ENV array
#   ( cd "$dir" && env -i "${GAFFER_AGENT_ENV[@]}" VAR=val … \
#       gaffer_timeout … "$CLAUDE_BIN" -p … )
#
# What we KEEP (and why):
#   - PATH, HOME, SHELL, USER, LOGNAME, TMPDIR — a working shell so `claude`
#     resolves its binary, reads ~/.claude credentials, and child tools run.
#     (PWD is intentionally NOT carried: the caller cd's first and env -i runs in
#     that cwd; passing the parent's PWD would hand the agent a stale directory.)
#   - LANG / LC_* / TERM / TZ — locale + terminal sanity.
#   - ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL,
#     ANTHROPIC_MODEL, CLAUDE_CODE_* and other CLAUDE_*  — claude -p AUTH and
#     config. NOTE: ANTHROPIC_API_KEY is deliberately the ONE *_KEY we keep, and
#     CLAUDE_CODE_OAUTH_TOKEN (the `claude setup-token` subscription credential) the
#     ONE *_TOKEN; the keep-despite-deny list names both explicitly so the generic
#     *_KEY / *_TOKEN strip can't take them.
#   - AWS_REGION / AWS_DEFAULT_REGION — needed for Bedrock-backed claude; these
#     are NON-secret (the AWS_*_KEY / AWS_SESSION_TOKEN credentials are NOT kept).
#   - MCP_CONFIG, DISPATCH_DB, MEMORY_DB, DISPATCH_MCP_BIN, MEMORY_MCP_BIN — the
#     agent's MCP servers + their DB paths (its only data-plane reach).
#   - GAFFER_* knobs the agent or its hooks read (models, caps, write/read roots,
#     skill/quarantine wiring). EXCEPTION: GAFFER_NOTIFY_* vars (notification
#     webhooks / Slack endpoints) are blocked by the deny case above even though
#     they match this prefix — the agent must not read its own exfiltration channel.
#     The per-call boundary vars are layered on top by the caller AFTER this array,
#     so they always win.
#   - npm_config_* — the scoped/locked bootstrap install knobs.
#   - NODE_EXTRA_CA_CERTS / SSL_CERT_FILE / SSL_CERT_DIR / CURL_CA_BUNDLE /
#     REQUESTS_CA_BUNDLE / GIT_SSL_CAINFO and HTTPS_PROXY / HTTP_PROXY / NO_PROXY /
#     ALL_PROXY (+ lowercase) — the trust store and proxy route the agent's installs
#     and fetches need behind a corporate / TLS-intercepting proxy. Not credentials.
# Everything NOT named here is dropped — in particular GITHUB_TOKEN, AWS access
# keys/secrets/session tokens, DISPATCH_API_TOKEN, any *_TOKEN / *_SECRET /
# *_KEY (besides ANTHROPIC_API_KEY) / *_PASSWORD, and the outbound-endpoint class
# (GAFFER_NOTIFY_*, *_WEBHOOK*, *_SLACK*, *_URL — except ANTHROPIC_BASE_URL).
# ── Worker-provider-indirected agent-env allowlist (Spec 3 / Phase 3) ─────────
# The credential-stripping allowlist splits into a provider-AGNOSTIC base (the
# working shell, locale, the MCP data-plane wiring, the GAFFER_*/npm_config_*
# knobs — every worker needs these) and a provider-SPECIFIC AUTH/config surface
# (which model-provider secrets + config the worker CLI reads). These three
# functions ARE the seam: claude-code's contribution is BYTE-IDENTICAL to the set
# this allowlist always carried (its union with the agnostic base == the historical
# list), so the scrub is unchanged. The `command` provider's auth surface is whatever
# the operator names in GAFFER_WORKER_COMMAND_ENV (never claude-code's, never the
# runner-only secrets). Each echoes whitespace-separated tokens (empty for unknown
# providers — harmless, since an unknown provider fails closed in worker_deliver
# before the scrub is even built).
#
# The names GAFFER_WORKER_COMMAND_ENV lets through to a command worker: valid env
# names, minus the runner-only secrets (lib/worker.mjs commandEnvPassNames).
gaffer_command_env_pass_names() {
  local n
  for n in $(printf '%s' "${GAFFER_WORKER_COMMAND_ENV:-}" | tr ',' ' '); do
    case "$n" in
      *[!A-Za-z0-9_]* | [0-9]*) continue ;;
      DISPATCH_API_TOKEN | GAFFER_CLAIM_TOKEN | GAFFER_PRINCIPAL_TOKEN | GITHUB_TOKEN | GH_TOKEN | GAFFER_NOTIFY_* | *_WEBHOOK* | *_SLACK*) continue ;;
    esac
    printf '%s\n' "$n"
  done
}
# keep-exact: exact env-var names the provider's worker needs.
gaffer_provider_env_keep_exact() {
  case "${GAFFER_WORKER_PROVIDER:-claude-code}" in
    claude-code)
      printf '%s\n' \
        ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL ANTHROPIC_MODEL \
        AWS_REGION AWS_DEFAULT_REGION
      ;;
    command) gaffer_command_env_pass_names ;;
  esac
}
# keep-prefix: env-var prefixes whose whole namespace the provider's worker reads.
#   CLAUDE_*  → claude -p config/auth (CLAUDE_BIN, CLAUDE_CODE_*, CLAUDE_FLAGS…).
gaffer_provider_env_keep_prefix() {
  case "${GAFFER_WORKER_PROVIDER:-claude-code}" in
    claude-code) printf '%s\n' CLAUDE_ ;;
  esac
}
# keep-despite-deny: provider auth names that must survive the credential-shaped
# deny patterns below (they LOOK like secrets because they ARE the worker's auth).
#   claude-code → the ANTHROPIC auth trio (…_API_KEY / …_AUTH_TOKEN / …_BASE_URL)
#                 PLUS CLAUDE_CODE_OAUTH_TOKEN — the subscription token from
#                 `claude setup-token`, the documented headless-Max path. B25(b): it
#                 matched the `*_TOKEN` deny rule and was not in this list, so the
#                 scrub dropped it and a Max-plan agent (host or docker sandbox)
#                 could not authenticate. It is the ONE `*_TOKEN` kept; every other
#                 token (GITHUB_TOKEN, AWS_SESSION_TOKEN, DISPATCH_API_TOKEN…) is
#                 still denied.
gaffer_provider_env_keep_despite_deny() {
  case "${GAFFER_WORKER_PROVIDER:-claude-code}" in
    claude-code) printf '%s\n' ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL CLAUDE_CODE_OAUTH_TOKEN ;;
    # command: the operator NAMED these for the worker's own auth, so they survive
    # the credential-shaped deny like the ANTHROPIC auth trio does for claude-code.
    command) gaffer_command_env_pass_names ;;
  esac
}

# The CA bundle Node should trust, derived for a machine behind a TLS-intercepting
# proxy whose operator exported the bundle for curl / git / python but not for Node.
# npm, like every Node program, reads NODE_EXTRA_CA_CERTS (it EXTENDS Node's roots,
# never replaces them), so an agent's `npm install` then trusts the proxy without a
# separate `npm config set cafile`. Echoes nothing when NODE_EXTRA_CA_CERTS is already
# set (the operator's value always wins) or no exported bundle is a readable file.
#   gaffer_node_ca_fallback → a path, or nothing
gaffer_node_ca_fallback() {
  [ -n "${NODE_EXTRA_CA_CERTS:-}" ] && return 0
  local _ca
  for _ca in "${SSL_CERT_FILE:-}" "${CURL_CA_BUNDLE:-}" "${REQUESTS_CA_BUNDLE:-}" "${GIT_SSL_CAINFO:-}"; do
    [ -n "$_ca" ] && [ -f "$_ca" ] && [ -r "$_ca" ] && { printf '%s\n' "$_ca"; return 0; }
  done
  return 0
}

GAFFER_AGENT_ENV=()
gaffer_agent_env() {
  GAFFER_AGENT_ENV=()
  # Provider-AGNOSTIC base: the working shell, locale, MCP data-plane wiring, and
  # the write/read-root boundary vars. Every worker provider needs these.
  local keep_exact=(
    PATH HOME SHELL USER LOGNAME TMPDIR TMP TEMP
    LANG LC_ALL LC_CTYPE LC_MESSAGES LC_NUMERIC TERM TZ COLUMNS LINES
    MCP_CONFIG DISPATCH_DB MEMORY_DB DISPATCH_MCP_BIN MEMORY_MCP_BIN MEMORY_AUDIT_LOG
    GAFFER_WRITE_ROOTS GAFFER_READ_ROOTS
    # Trust store + proxy routing. These name the machine's network PATH, not a
    # credential: behind a TLS-intercepting corporate proxy the agent's `npm install`,
    # `git fetch`, curl and node tooling all fail (SELF_SIGNED_CERT_IN_CHAIN) without
    # them, while the runner itself — which does inherit them — works fine. Seen live:
    # a greenfield bootstrap spun on npm TLS retries for the whole 30-min tick timeout.
    # (NODE_TLS_REJECT_UNAUTHORIZED is deliberately NOT here — that disables TLS.)
    NODE_EXTRA_CA_CERTS SSL_CERT_FILE SSL_CERT_DIR CURL_CA_BUNDLE REQUESTS_CA_BUNDLE
    GIT_SSL_CAINFO
    HTTPS_PROXY HTTP_PROXY NO_PROXY ALL_PROXY https_proxy http_proxy no_proxy all_proxy
  )
  # Provider-agnostic prefixes:
  #   GAFFER_*  → factory knobs (models, caps, skill/quarantine wiring, boundary).
  #   npm_config_* → the scoped, lifecycle-disabled bootstrap install knobs.
  local keep_prefix=( GAFFER_ npm_config_ )
  # Layer the ACTIVE provider's auth/config surface on top (claude-code == the
  # historical ANTHROPIC_*/CLAUDE_*/AWS-region set, so the union is byte-identical).
  local extra
  while IFS= read -r extra; do [ -n "$extra" ] && keep_exact+=( "$extra" ); done < <(gaffer_provider_env_keep_exact)
  while IFS= read -r extra; do [ -n "$extra" ] && keep_prefix+=( "$extra" ); done < <(gaffer_provider_env_keep_prefix)
  local keep_despite_deny=()
  while IFS= read -r extra; do [ -n "$extra" ] && keep_despite_deny+=( "$extra" ); done < <(gaffer_provider_env_keep_despite_deny)
  local name val
  # compgen -e enumerates EXPORTED (i.e. environment) variable names, one per
  # line. Names can never contain a newline or '=', so line-reading is safe; the
  # VALUE is read separately via indirect expansion and preserved verbatim.
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    # Drop the credential-shaped AND outbound-endpoint vars even if a keep-prefix
    # would re-admit them. A prompt-injected agent must not be able to read the
    # runner's own exfiltration channels (notify webhooks, Slack URL, dashboard URL).
    # EXCEPTION: the ACTIVE provider's own auth names (keep_despite_deny, e.g.
    # claude-code's ANTHROPIC auth trio) survive — they look like secrets because
    # they ARE the worker's auth. This membership test is the provider-indirected
    # form of the former hard-coded `ANTHROPIC_*) : ;;` exception.
    local keep_forced=0 kd
    # `${arr[@]+"${arr[@]}"}` — NOT a bare `"${arr[@]}"`: under `set -u`, bash 3.2 (macOS CI)
    # treats an EMPTY array expansion as an unbound variable and aborts. This list is empty for
    # every provider except claude-code, so the bare form crashes gaffer_agent_env there.
    for kd in ${keep_despite_deny[@]+"${keep_despite_deny[@]}"}; do [ "$name" = "$kd" ] && { keep_forced=1; break; }; done
    if [ "$keep_forced" -eq 0 ]; then
      # The credential deny pattern's named entries are deliberately redundant with the
      # *_TOKEN / *_KEY globs: they document the exact secrets this list exists for and
      # survive a future glob edit.
      # shellcheck disable=SC2221,SC2222
      case "$name" in
        # Credential-shaped vars — never reach the agent:
        # GAFFER_PRINCIPAL_TOKEN is a PERSON's credential (package H1): with it the CLI
        # records a human verdict, so no agent may ever hold it.
        *_TOKEN|*_SECRET|*_KEY|*_PASSWORD|*_PASSWD|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|GITHUB_TOKEN|GH_TOKEN|DISPATCH_API_TOKEN|GAFFER_PRINCIPAL_TOKEN)
          continue ;;
        # Outbound endpoint / notify config — runner-only; the agent must not read
        # its own potential exfiltration channel:
        GAFFER_NOTIFY_*|*_WEBHOOK*|*_SLACK*|*_URL)
          continue ;;
      esac
    fi
    local matched=0
    local k
    for k in "${keep_exact[@]}"; do [ "$name" = "$k" ] && { matched=1; break; }; done
    if [ "$matched" -eq 0 ]; then
      local p
      for p in "${keep_prefix[@]}"; do case "$name" in "$p"*) matched=1; break;; esac; done
    fi
    [ "$matched" -eq 1 ] || continue
    # Read the value via indirect expansion; preserve it verbatim.
    val="${!name}"
    GAFFER_AGENT_ENV+=( "$name=$val" )
  done < <(compgen -e)
  # npx / `npm exec` auto-download guard: npm assumes --yes when stdin is not a TTY
  # (every headless agent), so `npx <package that is not installed>` silently fetched
  # and RAN registry code. npm_config_yes=false makes npm refuse instead; locally
  # installed bins (`npx vitest`, `npx tsc`) still run. An operator who exports
  # npm_config_yes themselves keeps their value (it rides the npm_config_ prefix).
  [ -n "${npm_config_yes+x}" ] || GAFFER_AGENT_ENV+=( "npm_config_yes=false" )
  # Node trusts the proxy's CA the operator exported for other tools (see above).
  local _node_ca; _node_ca="$(gaffer_node_ca_fallback)"
  [ -n "$_node_ca" ] && GAFFER_AGENT_ENV+=( "NODE_EXTRA_CA_CERTS=$_node_ca" )
  return 0
}

_GAFFER_CONFIG_PART=11-agent-env
