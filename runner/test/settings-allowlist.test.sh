#!/usr/bin/env bash
# =====================================================================
# settings.json is an ALLOWLIST: the runner takes from it only the fourteen settings
# (sandbox audit F1a; package 61).
# ---------------------------------------------------------------------
# settings.json lives in $GAFFER_DATA. The loader (runner/config/01-settings.sh) used to
# export every key but a short deny-list, so a file written by agent code made the next
# runner process, outside the sandbox and holding the factory key, run with
# NODE_OPTIONS / BASH_ENV / DYLD_INSERT_LIBRARIES, a different CLAUDE_BIN, the idle
# lane on the host or the gates out of the sandbox. This pins, with a clean environment
# and the real config:
#   1. none of those keys (nor an unknown one) is applied, and each is named on stderr;
#   2. a setting (GAFFER_CONCURRENCY, a budget) still applies and is exported, and a real
#      environment value still wins over the file; an old dashboard key that would widen
#      autonomy (DISPATCH_ALLOW_AGENT_APPROVE=1 under supervised) is NOT applied;
#   3. the allowlist is exactly the fourteen.
# The old dashboard keys and their migration are pinned by settings-fourteen.test.sh.
# Zero deps beyond node. Run: bash runner/test/settings-allowlist.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
CFG="$RUNNER_DIR/factory.config.sh"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(gaffer_test_tmpdir settings-allowlist)" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
mkdir -p "$WORK/home" "$WORK/data"

# cfg [VAR=value ...] -- <snippet>: the snippet in a clean env after sourcing the real
# config (its stderr goes to $WORK/err).
cfg() {
  local -a vars=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do vars+=("$1"); shift; done
  shift
  env -i PATH="$PATH" HOME="$WORK/home" GAFFER_DATA="$WORK/data" ERRF="$WORK/err" ${vars[@]+"${vars[@]}"} \
    bash --norc --noprofile -c 'source "$0" 2>"$ERRF"; eval "$1"' "$CFG" "$1"
}

HOSTILE="NODE_OPTIONS BASH_ENV ENV DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH LD_PRELOAD LD_LIBRARY_PATH CLAUDE_FLAGS CLAUDE_BIN
GAFFER_IDLE_HOST_EXEC GAFFER_DOD_SANDBOX GAFFER_ALLOW_NO_DOD GAFFER_DOD GIT_CONFIG_GLOBAL GIT_SSH_COMMAND
SOME_UNKNOWN_KEY"
{
  printf '{'
  for k in $HOSTILE; do printf '"%s":"/tmp/x-%s",' "$k" "$k"; done
  printf '"PATH":"/tmp/evil-bin","GAFFER_ALLOW_UNCAPPED":"1","GAFFER_STRICT_REQUIRE":"0",'
  printf '"MAX_TICKS":"9","DISPATCH_ALLOW_AGENT_APPROVE":"1","GAFFER_BUDGET_USD":"3"}\n'
} > "$WORK/data/settings.json"

echo "== 1: keys the dashboard cannot write are ignored and named =="
# shellcheck disable=SC2016  # expanded inside the configured shell
OUT="$(cfg -- 'for k in '"$(printf '%s ' $HOSTILE)"' GAFFER_ALLOW_UNCAPPED; do printf "%s=%s\n" "$k" "${!k-<unset>}"; done; printf "PATH=%s\n" "$PATH"; printf "STRICT=%s\n" "${GAFFER_STRICT_REQUIRE-}"')"
# A key the config defaults (CLAUDE_BIN, GAFFER_DOD_SANDBOX...) keeps its default; the
# file's value (/tmp/x-<key>) is never what the runner holds.
for k in $HOSTILE; do
  case "$OUT" in
    *"$k=/tmp/x-$k"*) fail "$k applied from settings.json: $(printf '%s\n' "$OUT" | grep "^$k=")" ;;
    *) ok "$k from settings.json is not applied ($(printf '%s\n' "$OUT" | grep "^$k=" | cut -c1-60))" ;;
  esac
done
case "$OUT" in *"GAFFER_ALLOW_UNCAPPED=1"*) fail "GAFFER_ALLOW_UNCAPPED=1 taken from settings.json" ;; *) ok "GAFFER_ALLOW_UNCAPPED from settings.json is not applied" ;; esac
case "$OUT" in *"PATH=/tmp/evil-bin"*) fail "PATH taken from settings.json" ;; *) ok "PATH from settings.json is not applied" ;; esac
case "$OUT" in *"STRICT=0"*) fail "GAFFER_STRICT_REQUIRE=0 taken from settings.json" ;; *) ok "GAFFER_STRICT_REQUIRE=0 from settings.json is not applied" ;; esac
for k in $HOSTILE PATH; do
  [ "$(grep -c "gaffer: ignoring $k from settings.json: not a dashboard setting; only the environment can set it" "$WORK/err")" = 1 ] \
    && ok "$k: one stderr line names it" || fail "$k: no single ignoring line: $(cat "$WORK/err")"
done
grep -q 'GAFFER_ALLOW_UNCAPPED' "$WORK/err" && fail "an environment-only key is talked about (it is skipped silently, as before)" \
  || ok "an environment-only key is skipped without a line (as before)"

echo "== 2: a setting still applies; the environment still wins; an old autonomy key does not =="
{
  printf '{"GAFFER_CONCURRENCY":"3","DISPATCH_ALLOW_AGENT_APPROVE":"1","GAFFER_BUDGET_USD":"3"}\n'
} > "$WORK/data/settings.json"
V="$(cfg -- 'printf "%s|%s|%s" "$GAFFER_CONCURRENCY" "$DISPATCH_ALLOW_AGENT_APPROVE" "$GAFFER_BUDGET_USD"')"
[ "$V" = "3|0|3" ] && ok "GAFFER_CONCURRENCY and GAFFER_BUDGET_USD apply from the file; the old DISPATCH_ALLOW_AGENT_APPROVE=1 does not (supervised derives 0)" \
  || fail "settings not applied as expected: $V"
grep -q 'settings.json key DISPATCH_ALLOW_AGENT_APPROVE is no longer a setting; ignored: GAFFER_MODE decides it' "$WORK/err" \
  && ok "the old key is named once, with the setting that decides it now" || fail "no migration line: $(cat "$WORK/err")"
V="$(cfg GAFFER_CONCURRENCY=4 -- 'printf "%s" "$GAFFER_CONCURRENCY"')"
[ "$V" = 4 ] && ok "a real environment value wins over the file" || fail "env did not win: $V"
V="$(cfg -- 'env | grep -c "^GAFFER_CONCURRENCY=3$"')"
[ "$V" = 1 ] && ok "a setting from the file is exported to children" || fail "GAFFER_CONCURRENCY not exported: $V"

echo "== 3: the allowlist is the fourteen settings =="
V="$(cfg -- 'printf "%s" "$_GAFFER_SETTINGS_KEYS" | tr -s " " "\n" | grep -c .')"
[ "$V" = 14 ] && ok "fourteen names" || fail "the allowlist holds $V names"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "settings-allowlist: ALL $PASS checks passed"
  exit 0
fi
echo "settings-allowlist: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
