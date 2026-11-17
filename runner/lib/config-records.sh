# shellcheck shell=bash
# runner/lib/config-records.sh: what the config just derived, as records, one per line
# (tab separated; values have no tabs or newlines):
#   S <setting> <origin: environment|settings.json|default> <value>
#   D <derived name> <origin: environment|settings.json|derived> <set: 1|0> <value>
#   M <old key> <old value> <setting> <derived value> <decision>
#   X <derived name>   (run on its own only: the derived values the config exports)
# Two readers, one source: `gaffer config show` pipes them into bin/config-show.mjs (which
# hides every secret), and the dashboard runs this file on its own (below) to learn the
# values the runner will use, so it never keeps a second copy of the derivation tables.
#
# Sourced: defines gaffer_config_records (the config must already be sourced).
# Run as `bash runner/lib/config-records.sh`: sources factory.config.sh in a fresh shell
# with the caller's environment, then prints the records. Read-only: nothing is written
# or started. The values are RAW (a webhook URL is printed as it is), so only the
# dashboard process reads this output; a person's view goes through config-show.mjs.

gaffer_config_records() {
  local _n _o _s _k _d _cfg_kept=" "
  _cfg_clean() { local v="${1//$'\t'/ }"; printf '%s' "${v//$'\n'/ }"; }
  # The old settings.json keys that still apply (stricter), from the migration log.
  while IFS=$'\t' read -r _k _ _ _ _d; do
    [ "$_d" = kept ] && _cfg_kept="$_cfg_kept$_k "
  done <<<"$_GAFFER_MIGRATION_LOG"
  for _n in $_GAFFER_SETTINGS_KEYS; do
    case "$_GAFFER_OPERATOR_ENV" in
      *" $_n "*) _o=environment ;;
      *) case "$_GAFFER_FROM_FILE" in *" $_n "*) _o=settings.json ;; *) _o=default ;; esac ;;
    esac
    printf 'S\t%s\t%s\t%s\n' "$_n" "$_o" "$(_cfg_clean "${!_n-}")"
  done
  while IFS= read -r _n; do
    [ -n "$_n" ] || continue
    case "$_GAFFER_OPERATOR_ENV" in
      *" $_n "*) _o=environment ;;
      *) case "$_cfg_kept" in *" $_n "*) _o=settings.json ;; *) _o=derived ;; esac ;;
    esac
    _s=0; [ -n "${!_n+x}" ] && _s=1
    printf 'D\t%s\t%s\t%s\t%s\n' "$_n" "$_o" "$_s" "$(_cfg_clean "${!_n-}")"
  done < <(node -e 'for (const s of require(process.argv[1]).settings) for (const d of s.derives) console.log(d.name)' "$RUNNER_DIR/config/settings-schema.json")
  [ -z "$_GAFFER_MIGRATION_LOG" ] || printf '%s' "$_GAFFER_MIGRATION_LOG" | sed 's/^/M\t/'
  unset -f _cfg_clean
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -u
  _gcr_here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  # shellcheck source=../factory.config.sh
  source "$_gcr_here/factory.config.sh"
  gaffer_config_records
  # For the dashboard only (`gaffer config show` never runs this block): which derived
  # values this config EXPORTS, i.e. what a helper a runner starts would find in its
  # environment. The dashboard hands only those (and the old keys its own readers need)
  # to the helpers it starts; a value the config keeps to itself (DRY_RUN, whose
  # default a launcher such as poll-once.sh decides before sourcing) is never pushed.
  _gcr_exported=" $(compgen -e | tr '\n' ' ') "
  while IFS= read -r _gcr_n; do
    case "$_gcr_exported" in *" $_gcr_n "*) printf 'X\t%s\n' "$_gcr_n" ;; esac
  done < <(node -e 'for (const s of require(process.argv[1]).settings) for (const d of s.derives) console.log(d.name)' "$RUNNER_DIR/config/settings-schema.json")
fi
