#!/usr/bin/env bash
# =====================================================================
# `gaffer --help` and `gaffer wg` as a person meets them (exploratory findings
# fresh-user/F-22, cli-wg/F-09, F-14, F-23).
# ---------------------------------------------------------------------
#   1  `gaffer --help` lists `skills add`, `skills install --user|--project`;
#   2  `gaffer wg --help` and a wg usage error say `Usage: gaffer wg …`, not
#      `Usage: dispatch …`;
#   3  a wg usage error (unknown option, missing required option) exits 2, a
#      runtime refusal (NOT_FOUND) exits 1 with the one-line JSON error;
#   4  a mistyped GAFFER_DATA makes `gaffer wg ticket list` exit 2 with the setup
#      hint, and creates no dispatch.sqlite there.
# Run: bash runner/test/gaffer-wg-front-door.test.sh   (bash 3.2 safe)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
. "$(dirname "${BASH_SOURCE[0]}")/lib/skip.sh"
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
G="$RUNNER_DIR/gaffer"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
# macOS TMPDIR ends in "/": strip it, or $GAFFER_DATA carries a double slash the CLI
# prints normalised, and the path comparison below misses.
_T="${TMPDIR:-/tmp}"; _T="${_T%/}"
WORK="$(mktemp -d "$_T/gaffer-wg-front-door.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
export GAFFER_DATA="$WORK/data"; mkdir -p "$GAFFER_DATA"
unset DISPATCH_DB

echo "== 1: gaffer --help names every skills subcommand =="
H="$(bash "$G" --help 2>&1)"
case "$H" in *"gaffer skills add <path|git-url>"*) ok "lists skills add" ;; *) fail "no skills add in: $H" ;; esac
case "$H" in *"--user|--project"*) ok "lists install --user|--project" ;; *) fail "no --user|--project" ;; esac

[ -f "$ROOT/packages/dispatch/dist/cli/index.js" ] \
  || gaffer_skip "dispatch CLI not built (pnpm -C packages/dispatch build)"

echo "== 4: a mistyped GAFFER_DATA conjures no board =="
OUT="$(bash "$G" wg ticket list 2>&1)"; RC=$?
[ "$RC" -eq 2 ] && ok "wg on an uninitialised data dir exits 2" || fail "rc=$RC out=$OUT"
case "$OUT" in *"no database at $GAFFER_DATA/dispatch.sqlite"*"runner/gaffer setup"*) ok "says where and what to run" ;; *) fail "no setup hint: $OUT" ;; esac
[ ! -e "$GAFFER_DATA/dispatch.sqlite" ] && ok "created no dispatch.sqlite" || fail "a stray dispatch.sqlite was created"

bash "$G" wg init >/dev/null 2>&1 || fail "wg init failed"
[ -f "$GAFFER_DATA/dispatch.sqlite" ] && ok "wg init creates it" || fail "wg init created nothing"

echo "== 2: help and usage errors say gaffer wg =="
OUT="$(bash "$G" wg --help 2>&1)"
case "$OUT" in "Usage: gaffer wg [options] [command]"*) ok "wg --help: Usage: gaffer wg" ;; *) fail "wg --help: ${OUT:0:200}" ;; esac
case "$OUT" in *"Usage: dispatch"*) fail "still says Usage: dispatch" ;; *) ok "no 'Usage: dispatch'" ;; esac

echo "== 3: usage errors exit 2, refusals exit 1 =="
OUT="$(bash "$G" wg ticket list --nope 2>&1)"; RC=$?
[ "$RC" -eq 2 ] && ok "unknown option exits 2" || fail "unknown option rc=$RC"
case "$OUT" in *"unknown option '--nope'"*"Usage: gaffer wg ticket list"*) ok "names the option, gaffer wg usage" ;; *) fail "usage text: ${OUT:0:300}" ;; esac
OUT="$(bash "$G" wg ticket create 2>&1)"; RC=$?
[ "$RC" -eq 2 ] && ok "missing required option exits 2" || fail "missing -t rc=$RC"
OUT="$(bash "$G" wg ticket show 999 2>&1)"; RC=$?
[ "$RC" -eq 1 ] && ok "NOT_FOUND exits 1" || fail "NOT_FOUND rc=$RC"
case "$OUT" in '{"ok":false,"code":"NOT_FOUND"'*) ok "with the one-line JSON error" ;; *) fail "error line: $OUT" ;; esac

echo
if [ "${#FAILURES[@]}" -gt 0 ]; then
  printf 'FAILED %d (passed %d)\n' "${#FAILURES[@]}" "$PASS"
  exit 1
fi
echo "PASS $PASS"
