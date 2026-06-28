#!/usr/bin/env bash
# =====================================================================
# R-10: gaffer_timeout must FAIL CLOSED when no timeout primitive exists.
# ---------------------------------------------------------------------
# Before R-10, gaffer_timeout fell through to running the command UNBOUNDED
# when neither perl nor timeout/gtimeout was present — a denial-of-wallet hole
# (a runaway `claude -p` could burn unbounded wall-clock + tokens). Now:
#   1. With NO primitive available, gaffer_timeout does NOT run the command and
#      returns 127 (a setup fault).
#   2. gaffer_timeout_preflight returns 127 when no primitive is available, 0
#      otherwise — the up-front gate loop.sh / tick.sh use to abort the run.
#   3. The normal path is unaffected: with perl present, a fast command still
#      runs and relays its exit status.
#
# Absent primitives are simulated by emptying PATH (so `command -v perl` etc.
# all fail) inside a subshell — bash builtins still work, so the function body
# still executes; only the external primitives are unreachable.
# Zero deps. Run: bash test/timeout-fail-closed.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/timeout-failclosed.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
export GAFFER_DATA="$WORK/.gaffer"
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh"

# A sentinel the wrapped command would create IF it ran. Its absence proves the
# command was refused, not merely that the exit code happened to be 127.
SENTINEL="$WORK/ran"

echo "== fail closed: no timeout primitive available =="
# Run in a subshell with an empty PATH so command -v perl/timeout/gtimeout all
# miss. gaffer_timeout is already defined in this shell, so it stays callable.
( PATH=""; gaffer_timeout 5 touch "$SENTINEL" ); rc=$?
[ "$rc" = "127" ] && ok "gaffer_timeout returns 127 with no primitive" \
  || fail "expected exit 127 with no primitive (got $rc)"
[ ! -e "$SENTINEL" ] && ok "wrapped command did NOT run (no sentinel)" \
  || fail "wrapped command ran despite no timeout primitive — NOT fail-closed"

echo "== preflight gate =="
( PATH=""; gaffer_timeout_preflight ); rc=$?
[ "$rc" = "127" ] && ok "preflight returns 127 when no primitive is available" \
  || fail "preflight should return 127 with no primitive (got $rc)"
gaffer_timeout_preflight; rc=$?
[ "$rc" = "0" ] && ok "preflight returns 0 when a primitive (perl) is available" \
  || fail "preflight should return 0 with perl on PATH (got $rc)"

echo "== normal path unaffected (perl present) =="
gaffer_timeout 5 true && ok "fast command still passes through (exit 0)" \
  || fail "fast command should still exit 0 with perl present"
gaffer_timeout 5 bash -c 'exit 7'; rc=$?
[ "$rc" = "7" ] && ok "still relays the command's exit status" \
  || fail "should relay exit status 7 (got $rc)"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
