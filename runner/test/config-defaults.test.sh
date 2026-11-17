#!/usr/bin/env bash
# =====================================================================
# The fourteen settings at their defaults derive exactly what the config derived
# before them.
# ---------------------------------------------------------------------
# runner/test/fixtures/config-defaults/*.txt were written by lib/config-dump.sh on the
# code BEFORE the settings change (every variable the config set, its value, whether it
# was exported, and every function it defined), with no settings, for each GAFFER_MODE,
# and each again under the environment's sandbox opt-out. This checks, with a clean
# environment and the real config, that today's config prints the same line for every
# name a fixture holds (a new name may appear; none may change, lose its export or go):
#   1. with nothing set (none.txt, optout.txt) and for each mode (mode-*.txt);
#   2. with each of the fourteen settings at its default, from settings.json and from
#      the environment;
#   3. with every setting at its default at once, from settings.json.
# The settings allowlist variables (_GAFFER_SETTINGS_KEYS) are the one by-design change.
# Run: bash runner/test/config-defaults.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIX="$HERE/fixtures/config-defaults"
DUMP="$HERE/lib/config-dump.sh"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(gaffer_test_tmpdir config-defaults)" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN

# same <fixture> <label> [VAR=value ...]: every fixture line is in today's dump.
same() {
  local fx="$1" label="$2"; shift 2
  bash "$DUMP" "$@" > "$WORK/now.txt" 2>&1
  # The setting under test is the input, not a derived value: its own line (a
  # settings.json value is exported, as it always was) is left out.
  grep -v -E "^V (_GAFFER_SETTINGS_KEYS${IGNORE:+|$IGNORE}) " "$FIX/$fx" > "$WORK/want.txt"
  # A fixture line missing from today's dump (a value that changed, an export that
  # was dropped, a variable or function that went).
  LC_ALL=C comm -23 "$WORK/want.txt" "$WORK/now.txt" > "$WORK/missing.txt"
  if [ -s "$WORK/missing.txt" ]; then
    fail "$label: differs from $fx: $(head -5 "$WORK/missing.txt" | tr '\n' ';') now: $(grep -F -f <(cut -d' ' -f1,2 "$WORK/missing.txt" | sed 's/$/ /' | head -5) "$WORK/now.txt" | head -5 | tr '\n' ';')"
  else
    ok "$label: every value of $fx ($(wc -l < "$WORK/want.txt" | tr -d ' ') lines)"
  fi
}

echo "== 1: nothing set, and each mode =="
same none.txt "no settings"
same optout.txt "no settings, sandbox opt-out in the environment" GAFFER_STRICT_REQUIRE=0
for m in supervised lite graduated autonomous strict; do
  same "mode-$m.txt" "GAFFER_MODE=$m" GAFFER_MODE="$m"
  same "mode-$m-optout.txt" "GAFFER_MODE=$m, opt-out" GAFFER_MODE="$m" GAFFER_STRICT_REQUIRE=0
done

# The defaults, read from the spec in 01-settings.sh (GAFFER_DATA moves the data dir
# and cannot come from settings.json, so it is checked by the other tests).
DEFAULTS="GAFFER_MODE=supervised GAFFER_MODELS=standard GAFFER_EFFORT=standard GAFFER_CONCURRENCY=1
GAFFER_SANDBOX=auto GAFFER_GATES=standard GAFFER_LANDING=local GAFFER_TESTING=auto GAFFER_IDLE=auto
DISPATCH_API_PORT=8787"

echo "== 2: each setting at its default, from the environment =="
for kv in $DEFAULTS GAFFER_DAILY_BUDGET_USD= GAFFER_BUDGET_USD= GAFFER_NOTIFY=; do
  IGNORE="${kv%%=*}" same none.txt "$kv in the environment" "$kv"
done

echo "== 2b/3: each setting at its default, from settings.json; then all at once =="
# config-dump.sh makes its own GAFFER_DATA; a settings.json needs a data dir we own.
# The dump replaces the data path it is given, so the fixture's <DATA> still matches.
dump_with_file() {  # dump_with_file <label> <json>
  local d="$WORK/data-$RANDOM"; mkdir -p "$d"; printf '%s\n' "$2" > "$d/settings.json"
  same none.txt "$1" GAFFER_DATA="$d" _GD_DATA="$d"
}
ALL=""; NAMES=""
for kv in $DEFAULTS GAFFER_DAILY_BUDGET_USD= GAFFER_BUDGET_USD= GAFFER_NOTIFY=; do
  j="\"${kv%%=*}\":\"${kv#*=}\""
  IGNORE="${kv%%=*}" dump_with_file "settings.json {$j}" "{$j}"
  ALL="$ALL${ALL:+,}$j"; NAMES="$NAMES${NAMES:+|}${kv%%=*}"
done
IGNORE="$NAMES" dump_with_file "settings.json with all thirteen at their defaults" "{$ALL}"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "config-defaults: ALL $PASS checks passed"
  exit 0
fi
echo "config-defaults: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
