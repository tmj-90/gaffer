# shellcheck shell=bash
# runner/config/01-settings.sh: settings precedence: the settings.json values (read by the prologue of
# factory.config.sh) applied as defaults, so a real env var always wins; the
# environment-only keys a settings.json can never set.
# Sourced by runner/factory.config.sh only, in its fixed order, never directly or on
# its own: it reads what the parts before it set. Lines moved verbatim from
# factory.config.sh. The last line tells factory.config.sh this part loaded whole.

# UI-editable settings. The dashboard Settings panel persists a flat {"KEY":"value"}
# map to $GAFFER_DATA/settings.json. Apply them as defaults HERE — before the config
# defaults below — so a real env var ALWAYS overrides the file (env wins).
# SECURITY: do NOT eval. eval re-parses the whole string, so BOTH a crafted key and a
# crafted value are command-injection vectors — the old `case "$_sk" in [A-Z_][A-Z0-9_]*`
# glob pinned only the first two chars ('*' swallows `}; cmd; :`), and a value with a `}`
# closes the `${...}` early and runs the trailing text. Instead: FULLY anchor the key to
# a shell identifier, then test-and-assign with indirect expansion (`${!_sk}`) + `printf
# -v`, neither of which re-parses $_sk or $_sv as a command.
# The file was read (strictly) at the top of this file, into $_gs_out; an unreadable
# one applied nothing and set _GAFFER_SETTINGS_UNREADABLE (see FAIL CLOSED above).
if [ -n "$_gs_out" ]; then
  while IFS=$'\t' read -r _sk _sv; do
    [[ "$_sk" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue   # whole-key anchor (^…$)
    # ENVIRONMENT-ONLY keys are never taken from the file. GAFFER_ALLOW_UNCAPPED lifts
    # the dollar-cap requirement (lib/budget.sh gaffer_spend_cap_ok); a hand-edited or
    # otherwise written settings.json must not be able to switch that off. Only the
    # operator's real environment can (SECURITY.md).
    # The worker provider knobs are environment-only too: settings.json lives in
    # $GAFFER_DATA, and a file that picks which program runs every agent turn (and which
    # secrets it gets) must not be one an agent's sandbox might reach. The same list is
    # packages/dispatch/src/api/settings.ts ENV_ONLY_KEYS.
    case "$_sk" in
      GAFFER_ALLOW_UNCAPPED | GAFFER_WORKER_PROVIDER | GAFFER_WORKER_COMMAND | GAFFER_WORKER_COMMAND_ENV | \
        GAFFER_WORKER_COMMAND_COST_USD | GAFFER_SANDBOX_WORKER_COMMAND) continue ;;
    esac
    # Under the command provider, a settings.json GAFFER_STRICT_REQUIRE=0 is NOT the
    # operator's out-of-band assertion (the opt-out from the sandbox requirement): only
    # the real environment can make it. Skipped, so the requirement stays on.
    if [ "$_sk" = GAFFER_STRICT_REQUIRE ] && [ "${GAFFER_WORKER_PROVIDER:-}" = command ]; then
      case "$(printf '%s' "$_sv" | tr '[:upper:]' '[:lower:]')" in
        0 | false | no | off)
          printf 'worker: ignoring GAFFER_STRICT_REQUIRE=%s from settings.json: under GAFFER_WORKER_PROVIDER=command only the environment can opt out of the OS sandbox\n' "$_sv" >&2
          continue ;;
      esac
    fi
    # assign-if-unset, no eval — and EXPORT: a dashboard setting must reach the
    # processes that read it (the dispatch CLI's notifier, the memory server, crew),
    # not only this shell. Unexported, notifications/auto-approve set in the UI
    # silently never fired.
    if [ -z "${!_sk:-}" ]; then printf -v "$_sk" '%s' "$_sv"; export "${_sk?}"; fi
  done <<<"$_gs_out"
  unset _sk _sv
fi
unset _gs_out

_GAFFER_CONFIG_PART=01-settings
