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
# code that read them could post as the factory. GAFFER_NOTIFY (the setting) holds the
# webhook and Slack URLs with their tokens and matches none of the patterns, so it is named.
gaffer_env_name_is_endpoint() {
  case "$1" in
    GAFFER_NOTIFY|GAFFER_NOTIFY_*|*_WEBHOOK*|*_SLACK*|*_URL) return 0 ;;
  esac
  return 1
}

# True (rc 0) for a name a gate run never gets, whoever names it (the operator's pass-through
# knob included): every credential and endpoint above, the model provider's whole
# namespace, the operator's REST and dispatch settings, the agent CLI's configuration, the
# factory's own knobs and internals.
#
# Also refused: every name that injects code into, or redirects, what the gate starts
# (the loaders' preload and option variables, the shells' startup files, git's command,
# config and directory overrides, the interpreters' startup and option variables), the
# names the gate's own list fixes (PATH, HOME, TMPDIR) and an agent socket that signs as
# the operator (SSH_AUTH_SOCK, GPG_AGENT_INFO). Matched in any letter case: a lower-case
# github_token is the same credential.
gaffer_env_name_never_for_gates() {
  local up
  up="$(printf '%s' "$1" | tr 'abcdefghijklmnopqrstuvwxyz' 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')"
  gaffer_env_name_is_credential "$up" && return 0
  gaffer_env_name_is_endpoint "$up" && return 0
  case "$up" in
    ANTHROPIC_*|CLAUDE_*|DISPATCH_*|MEMORY_*|GAFFER_*|_*|AWS_*|GOOGLE_*|AZURE_*|NPM_CONFIG_*) return 0 ;;
    PATH|HOME|TMPDIR|TMP|TEMP|SHELL|IFS|ENV|BASH_ENV|BASHOPTS|SHELLOPTS|PS4|PROMPT_COMMAND|CDPATH|ZDOTDIR) return 0 ;;
    LD_*|DYLD_*|NODE_OPTIONS|NODE_PATH|NODE_REPL_EXTERNAL_MODULE|GIT_*|SSH_AUTH_SOCK|SSH_ASKPASS|GPG_AGENT_INFO|GNUPGHOME) return 0 ;;
    PYTHONSTARTUP|PYTHONPATH|PYTHONHOME|PYTHONUSERBASE|PERL5OPT|PERL5LIB|PERLLIB|RUBYOPT|RUBYLIB|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS) return 0 ;;
    *_PROXY|*_AUTH|*_CREDENTIALS|*_PAT|*_APIKEY|*_COOKIE|*_SESSION) return 0 ;;
  esac
  return 1
}
