#!/usr/bin/env bash
# =====================================================================
# PACKAGE H1: `gaffer preflight` (runner/preflight.sh) and `gaffer sandbox-status` say
# when agents run without OS isolation, since a person's tester verdict is then guarded
# by the safety hook only (a waiver recorded then reads "recorded without OS isolation").
#   A. the opt-out (GAFFER_STRICT_REQUIRE=0) and no provider: preflight warns, and
#      sandbox-status reports wrapped=false;
#   B. the opt-out, a provider available and STRICT_MODE=1 (the launch wraps): no
#      warning, wrapped=true;
#   C. the opt-out, a provider available but STRICT_MODE=0 (the launch does not wrap):
#      the warning, wrapped=false;
#   D. the sandbox required and missing: preflight fails the sandbox line instead, and
#      prints no human-verdicts line (no agent launches at all).
# The provider is a stub `sandbox-exec` on PATH (SANDBOX_PROVIDER=sandbox-exec). No model.
# Run: bash runner/test/preflight-human-verdicts.test.sh   (bash 3.2 safe)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
# shellcheck source=lib/isolate.sh
. "$HERE/lib/isolate.sh"
gaffer_test_isolate; trap 'gaffer_test_rm_work "$GAFFER_TEST_ISO"' EXIT
WORK="$GAFFER_TEST_ISO"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
mkdir -p "$WORK/bin" "$WORK/home" "$GAFFER_DATA"
printf '#!/bin/sh\nexit 0\n' > "$WORK/bin/sandbox-exec"; chmod +x "$WORK/bin/sandbox-exec"
LINE='human verdicts: agents run without OS isolation'
CLEAN=(env -u STRICT_MODE -u GAFFER_STRICT_REQUIRE -u SANDBOX_PROVIDER -u GAFFER_MODE -u DRY_RUN
  -u GAFFER_PRINCIPAL_TOKEN HOME="$WORK/home" GAFFER_REGISTRY_PROBE=0 NO_COLOR=1)
# A bound for each call that works where there is no `timeout` (macOS): perl's alarm.
if command -v perl >/dev/null 2>&1; then BOUND=(perl -e 'alarm shift; exec @ARGV' 120); elif command -v timeout >/dev/null 2>&1; then BOUND=(timeout 120); else BOUND=(); fi
pf() { "${CLEAN[@]}" "$@" ${BOUND[@]+"${BOUND[@]}"} bash "$RUNNER_DIR/preflight.sh" 2>&1; }
wrapped() {
  "${CLEAN[@]}" "$@" ${BOUND[@]+"${BOUND[@]}"} bash "$RUNNER_DIR/gaffer" sandbox-status 2>/dev/null \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const l=d.trim().split("\n").filter(x=>x.startsWith("{")).pop();process.stdout.write(String(JSON.parse(l).wrapped))}catch{process.stdout.write("?")}})'
}

echo "== A: opted out, no provider =="
OUT="$(pf GAFFER_STRICT_REQUIRE=0 SANDBOX_PROVIDER=none)"
grep -qF "$LINE" <<<"$OUT" && ok "preflight warns that human verdicts are guarded by the safety hook only" || fail "no warning: $(grep -i sandbox <<<"$OUT" | tr '\n' '|')"
[ "$(wrapped GAFFER_STRICT_REQUIRE=0 SANDBOX_PROVIDER=none)" = false ] && ok "sandbox-status: wrapped=false" || fail "sandbox-status wrapped: $(wrapped GAFFER_STRICT_REQUIRE=0 SANDBOX_PROVIDER=none)"

echo "== B: opted out, provider available, STRICT_MODE=1 =="
OUT="$(pf PATH="$WORK/bin:$PATH" GAFFER_STRICT_REQUIRE=0 STRICT_MODE=1 SANDBOX_PROVIDER=sandbox-exec)"
grep -qF "$LINE" <<<"$OUT" && fail "warned although the launch wraps: $(grep -F "$LINE" <<<"$OUT")" || ok "no warning when the launch is wrapped"
[ "$(wrapped PATH="$WORK/bin:$PATH" GAFFER_STRICT_REQUIRE=0 STRICT_MODE=1 SANDBOX_PROVIDER=sandbox-exec)" = true ] && ok "sandbox-status: wrapped=true" || fail "sandbox-status wrapped is not true"

echo "== C: opted out, provider available, STRICT_MODE=0 =="
OUT="$(pf PATH="$WORK/bin:$PATH" GAFFER_STRICT_REQUIRE=0 STRICT_MODE=0 SANDBOX_PROVIDER=sandbox-exec)"
grep -qF "$LINE" <<<"$OUT" && ok "preflight warns: the provider exists but the launch does not wrap" || fail "no warning with STRICT_MODE=0"
[ "$(wrapped PATH="$WORK/bin:$PATH" GAFFER_STRICT_REQUIRE=0 STRICT_MODE=0 SANDBOX_PROVIDER=sandbox-exec)" = false ] && ok "sandbox-status: wrapped=false" || fail "sandbox-status wrapped is not false"

echo "== D: required and missing =="
OUT="$(pf GAFFER_STRICT_REQUIRE=1 SANDBOX_PROVIDER=none)"
grep -qF "$LINE" <<<"$OUT" && fail "a human-verdicts line although no agent launches: $(grep -F "$LINE" <<<"$OUT")" || ok "no human-verdicts line when the sandbox is required"
grep -q 'OS sandbox: .*missing' <<<"$OUT" && ok "the sandbox line fails instead" || fail "no failing sandbox line: $(grep -i sandbox <<<"$OUT" | tr '\n' '|')"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "preflight-human-verdicts: all $PASS checks passed"
  exit 0
fi
echo "preflight-human-verdicts: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
