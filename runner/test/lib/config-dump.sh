#!/usr/bin/env bash
# =====================================================================
# runner/test/lib/config-dump.sh: print every variable the real config sets, with its
# value and whether it is exported, in one stable, host-neutral text.
# ---------------------------------------------------------------------
# Written BEFORE the fourteen-settings change (61) to record what the config derived
# then; runner/test/fixtures/config-defaults/*.txt are its output on that code, and
# runner/test/config-defaults.test.sh checks that the code of today still prints the
# same for every name the fixture holds (a new name may appear; none may change or go).
#
#   bash runner/test/lib/config-dump.sh [--config <factory.config.sh>] [VAR=value ...]
#
# The config is sourced in a clean environment (env -i: PATH, a scratch HOME and
# GAFFER_DATA, then the VAR=value pairs given), so the operator's own shell never
# leaks in. Output, sorted (LC_ALL=C):
#   V <name> <x|-> <value>   one line per shell variable the source set (x = exported)
#   F <name>                 one line per function the source defined
# Values are escaped (\\, \n, \t) so a line is a line. Host details are replaced:
# the checkout root by <ROOT>, the scratch HOME by <HOME>, GAFFER_DATA by <DATA>, and
# SANDBOX_PROVIDER by <auto> when the config detected it from the tools on PATH (it
# depends on whether docker or sandbox-exec is installed). Bookkeeping that holds the
# environment itself (_GAFFER_DV_* records, _GAFFER_OPERATOR_ENV, _GAFFER_ENV_AT_SOURCE)
# and bash's own variables are left out.
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="$(cd "$HERE/../.." && pwd)/factory.config.sh"
if [ "${1:-}" = "--config" ]; then CFG="$2"; shift 2; fi
ROOT="$(cd "$(dirname "$CFG")/.." && pwd)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/gaffer-config-dump.XXXXXX")" || exit 70
trap 'rm -rf "$SCRATCH"' EXIT
mkdir -p "$SCRATCH/home" "$SCRATCH/data"
# The snippet runs in the configured shell. It lists variables before and after the
# source, so only what the config set is printed.
# shellcheck disable=SC2016  # expanded by the inner shell
SNIP='
_gd_before=" $(compgen -v | tr "\n" " ") "
_gd_fbefore=" $(compgen -A function | tr "\n" " ") "
_gd_sp_preset="${SANDBOX_PROVIDER+x}"
source "$_GD_CFG" >/dev/null 2>&1 || { echo "SOURCE-FAILED rc=$?"; exit 1; }
for _gd_n in $(compgen -v); do
  case "$_gd_n" in
    _gd_* | _GD_* | _GAFFER_DV_* | _GAFFER_OPERATOR_ENV | _GAFFER_ENV_AT_SOURCE) continue ;;
    BASH* | PIPESTATUS | FUNCNAME | LINENO | RANDOM | SRANDOM | SECONDS | EPOCH* | PPID | SHLVL | OLDPWD | PWD | _ | COLUMNS | LINES | OPTIND | OPTERR | HISTCMD | IFS | PS4 | GROUPS | DIRSTACK | COMP_WORDBREAKS | HOSTNAME | HOSTTYPE | MACHTYPE | OSTYPE | UID | EUID | SHELLOPTS | TERM) continue ;;
  esac
  case "$_gd_before" in *" $_gd_n "*) [ "$_gd_n" = GAFFER_DATA ] || [ "$_gd_n" = HOME ] || [ "$_gd_n" = PATH ] || continue ;; esac
  [ "$_gd_n" = PATH ] && continue
  [ "$_gd_n" = HOME ] && continue
  _gd_x=-; case " $(compgen -e | tr "\n" " ") " in *" $_gd_n "*) _gd_x=x ;; esac
  if declare -p "$_gd_n" 2>/dev/null | grep -q "^declare -[a-zA-Z]*a"; then
    eval "_gd_v=\"\${$_gd_n[*]-}\""
  else
    _gd_v="${!_gd_n-}"
  fi
  _gd_v="${_gd_v//\\/\\\\}"; _gd_v="${_gd_v//$'"'"'\n'"'"'/\\n}"; _gd_v="${_gd_v//$'"'"'\t'"'"'/\\t}"
  _gd_v="${_gd_v//$_GD_DATA/<DATA>}"; _gd_v="${_gd_v//$_GD_HOME/<HOME>}"; _gd_v="${_gd_v//$_GD_ROOT/<ROOT>}"
  if [ "$_gd_n" = SANDBOX_PROVIDER ] && [ -z "$_gd_sp_preset" ]; then _gd_v="<auto>"; fi
  printf "V %s %s %s\n" "$_gd_n" "$_gd_x" "$_gd_v"
done
for _gd_n in $(compgen -A function); do
  case "$_gd_fbefore" in *" $_gd_n "*) continue ;; esac
  printf "F %s\n" "$_gd_n"
done
'
env -i PATH="$PATH" HOME="$SCRATCH/home" GAFFER_DATA="$SCRATCH/data" \
  _GD_CFG="$CFG" _GD_DATA="$SCRATCH/data" _GD_HOME="$SCRATCH/home" _GD_ROOT="$ROOT" "$@" \
  bash --norc --noprofile -c "$SNIP" | LC_ALL=C sort
