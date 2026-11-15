# shellcheck shell=bash
# runner/lib/env-scrub.sh: the ONE list of environment names that never cross into code
# the factory did not write. gaffer_agent_env (runner/config/11-agent-env.sh) uses it for
# the agent, gaffer_dod_gate_env (runner/lib/dod.sh) for every gate run. Sourced by both;
# defines functions only.

# True (rc 0) for a credential-shaped name. Named entries are deliberately redundant with
# the *_TOKEN / *_KEY globs: they document the exact secrets this list exists for and
# survive a future glob edit. GAFFER_PRINCIPAL_TOKEN is a PERSON's credential (package
# H1): with it the CLI records a human verdict.
gaffer_env_name_is_credential() {
  # shellcheck disable=SC2221,SC2222
  case "$1" in
    *_TOKEN|*_SECRET|*_KEY|*_PASSWORD|*_PASSWD|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|GITHUB_TOKEN|GH_TOKEN|DISPATCH_API_TOKEN|GAFFER_PRINCIPAL_TOKEN)
      return 0 ;;
  esac
  return 1
}

# True (rc 0) for the runner's own outbound endpoints (notify webhooks, Slack, *_URL):
# code that read them could post as the factory.
gaffer_env_name_is_endpoint() {
  case "$1" in
    GAFFER_NOTIFY_*|*_WEBHOOK*|*_SLACK*|*_URL) return 0 ;;
  esac
  return 1
}

# True (rc 0) for a name a gate run never gets, whoever names it (the operator's pass-through
# knob included): every credential and endpoint above, the model provider's whole
# namespace, the operator's REST and dispatch settings, the agent CLI's configuration, the
# factory's own knobs and internals.
gaffer_env_name_never_for_gates() {
  gaffer_env_name_is_credential "$1" && return 0
  gaffer_env_name_is_endpoint "$1" && return 0
  case "$1" in
    ANTHROPIC_*|CLAUDE_*|DISPATCH_*|MEMORY_*|GAFFER_*|_*|AWS_*|GOOGLE_*|AZURE_*|NPM_CONFIG_*|npm_config_*) return 0 ;;
  esac
  return 1
}
