#!/usr/bin/env bash
# =====================================================================
# PYTHON3 GUARDS — a test SKIPs on a missing python3 only if it actually uses python3.
# ---------------------------------------------------------------------
# The runner no longer needs python3, and a `command -v python3 || { SKIP; exit 0; }`
# guard on a test that never calls it turns a python-less machine's run green while
# running nothing (six delivery-safety suites did exactly that). For every runner test
# carrying the guard, assert python3 is invoked somewhere other than the guard itself
# and comments.
# Run: bash runner/test/python3-guard.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

n=0
for t in "$HERE"/*.test.sh; do
  grep -q 'command -v python3' "$t" || continue
  n=$((n + 1))
  uses="$(grep -v 'command -v python3' "$t" | grep -v '^[[:space:]]*#' | grep -c 'python3' || true)"
  if [ "${uses:-0}" -gt 0 ]; then
    ok "$(basename "$t"): guards python3 and uses it ($uses line(s))"
  else
    fail "$(basename "$t"): SKIPs without python3 but never calls it — drop the guard"
  fi
done
[ "$n" -gt 0 ] || ok "no runner test guards on python3"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
