#!/usr/bin/env bash
# =====================================================================
# scripts/ui-regression/run-suites.sh -j N, without a browser or a server: what it
# refuses before it builds any world, and that CI still runs one world at a time.
# (The parallel run itself needs Chromium: `bash scripts/ui-regression/run-suites.sh
# -j 2 s14-map s11-health` is the proof, recorded in the commit that added -j.)
#   J1  -j takes a whole number of worlds, 1 or more: -j 0, -j x and a bare -j exit 2
#       and say so, before suite-plan.mjs or setup.sh runs
#   J2  --serve builds one world, so --serve with -j 2 is refused
#   J3  an unknown suite is still refused the same way with -j 2 (exit 2)
#   J4  CI's ui-scenarios step runs run-suites.sh with no -j (one world at a time)
#   J5  the playwright-core pin (pw-install.sh, shared by setup.sh and -j) is the
#       version CI installs Chromium for
# Run: bash runner/test/ui-suites-jobs.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
RS="$ROOT/scripts/ui-regression/run-suites.sh"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
# Point any world it might build somewhere harmless (none should be built here).
export UI_REGRESS_OUT="${TMPDIR:-/tmp}/ui-suites-jobs-never.$$" UI_REGRESS_PORT=1

echo "== J1: -j takes a number of worlds =="
for arg in "-j 0" "-j x" "-j" "-j0"; do
  # shellcheck disable=SC2086  # the flag and its value are two words on purpose
  out="$(bash "$RS" $arg s14-map 2>&1)"; rc=$?
  if [ "$rc" -eq 2 ] && [[ "$out" == *"-j takes a number of worlds"* ]]; then ok "J1 '$arg' exits 2 and names the rule"
  else fail "J1 '$arg': rc=$rc out=$(printf '%s' "$out" | head -2)"; fi
done
[ ! -e "$UI_REGRESS_OUT" ] && ok "J1 no world was built" || fail "J1 a refused run built $UI_REGRESS_OUT"

echo "== J2: --serve is one world =="
out="$(bash "$RS" --serve -j 2 s14-map 2>&1)"; rc=$?
[ "$rc" -eq 2 ] && [[ "$out" == *"--serve builds one world"* ]] && ok "J2 --serve -j 2 is refused (exit 2)" || fail "J2 rc=$rc out=$(printf '%s' "$out" | head -2)"

echo "== J3: an unknown suite =="
out="$(bash "$RS" -j 2 no-such-suite 2>&1)"; rc=$?
[ "$rc" -eq 2 ] && [[ "$out" == *"unknown suite"* ]] && ok "J3 -j 2 no-such-suite exits 2 naming it" || fail "J3 rc=$rc out=$(printf '%s' "$out" | head -2)"
[ ! -e "$UI_REGRESS_OUT" ] && ok "J3 no world was built" || fail "J3 built $UI_REGRESS_OUT"

echo "== J4: CI runs one world at a time =="
step="$(sed -n '/- name: Scenario suites/,/- name:/p' "$ROOT/.github/workflows/ci.yml" | grep -E 'run-suites\.sh')"
if [ -n "$step" ] && [[ "$step" != *"-j"* ]]; then ok "J4 ci.yml runs '$(printf '%s' "$step" | sed 's/^ *//')'"
else fail "J4 ci.yml's scenario step: '$step'"; fi

echo "== J5: the playwright-core pin =="
pin="$(sed -n -E 's/.*playwright-core@([0-9.]+).*/\1/p' "$ROOT/scripts/ui-regression/pw-install.sh" | head -1)"
ci="$(sed -n -E 's/.*npx --yes playwright@([0-9.]+) install.*/\1/p' "$ROOT/.github/workflows/ci.yml" | sort -u | tr '\n' ' ')"
[ -n "$pin" ] && [ "$ci" = "$pin " ] && ok "J5 pw-install.sh pins $pin, the version every ci.yml Chromium install uses" \
  || fail "J5 pw-install.sh pins '$pin', ci.yml installs '$ci'"

[ -e "$UI_REGRESS_OUT" ] && gaffer_test_rm_work "$UI_REGRESS_OUT"
echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "ui-suites-jobs: ALL $PASS checks passed"; exit 0; fi
echo "ui-suites-jobs: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
