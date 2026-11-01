# shellcheck shell=bash
# runner/lib/git-safe.sh — host bookkeeping git never runs repository code
# (external review #9, finding 2). See lib/git-safe.mjs for the full list and why.
#
#   gaffer_git_harden            export the static overrides (core.hooksPath=/dev/null,
#                                core.fsmonitor=false) through GIT_CONFIG_COUNT/KEY/VALUE
#   gaffer_git_harden <repo>...  also neutralise every code-running key (drivers, filters,
#                                helpers, pager, editor, …) that points into those repos
#
# The overrides travel in git's environment channel, so every git the runner (and any
# node helper it spawns: json-tool, merge-ticket.mjs, the crew/memory CLIs) runs on the
# host inherits them. The agent's own environment is rebuilt from an allowlist
# (lib/worker.sh `env -i`), so none of this reaches it. Sourced by factory.config.sh,
# which calls the static form once; tick.sh and land.sh call it again with the
# ticket's repositories. Idempotent: a second call rebuilds only Gaffer's entries, and
# GIT_CONFIG_* the operator set beforehand are kept in front.

gaffer_git_harden() {
  local out
  if [ "$#" -gt 0 ]; then
    if command -v node >/dev/null 2>&1 \
       && out="$(node "${RUNNER_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}/lib/git-safe.mjs" env "$@" 2>/dev/null)"; then
      eval "$out"
      return 0
    fi
  fi
  # Static form (also the fallback without node): rebuild Gaffer's two entries.
  local base="${GAFFER_GIT_SAFE_BASE:-${GIT_CONFIG_COUNT:-0}}" i
  case "$base" in '' | *[!0-9]*) base=0 ;; esac
  i="${GIT_CONFIG_COUNT:-0}"; case "$i" in '' | *[!0-9]*) i=0 ;; esac
  # A parent already hardened this environment for its repositories (a child that
  # re-sources factory.config.sh): keep those entries rather than dropping them.
  if [ "$#" -eq 0 ] && [ -n "${GAFFER_GIT_SAFE_REPOS:-}" ] && [ "$i" -ge $((base + 2)) ] \
     && [ "$(eval "printf '%s' \"\${GIT_CONFIG_KEY_$base:-}\"")" = "core.hooksPath" ]; then
    return 0
  fi
  while [ "$i" -gt "$base" ]; do i=$((i - 1)); unset "GIT_CONFIG_KEY_$i" "GIT_CONFIG_VALUE_$i"; done
  export "GIT_CONFIG_KEY_$base=core.hooksPath" "GIT_CONFIG_VALUE_$base=/dev/null"
  export "GIT_CONFIG_KEY_$((base + 1))=core.fsmonitor" "GIT_CONFIG_VALUE_$((base + 1))=false"
  export GIT_CONFIG_COUNT="$((base + 2))" GAFFER_GIT_SAFE_BASE="$base"
}
