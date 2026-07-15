#!/usr/bin/env bash
# Hermetic test for audit-gate.sh — no network. Stubs `pnpm` on PATH so it emits a
# canned `pnpm audit --json` payload, then asserts the gate's exit code for each
# class of output:
#   retired-endpoint error (npm 410)      → 0  SKIPPED (upstream outage, not a vuln)
#   un-accepted high advisory             → 1  FAIL (gate still has teeth)
#   un-accepted critical advisory         → 1  FAIL (critical is gating too)
#   transient bad-response (same code)    → 2  fail closed (NOT the 410 retirement)
#   other/unknown error envelope          → 2  fail closed
#   unexpected shape (no `advisories`)     → 2  fail closed
#   clean (no advisories)                  → 0  OK
#   low-severity only                      → 0  OK (not gated)
#   allowlisted high advisory              → 0  accepted (allowlist path exercised)
#
# Run: bash .github/scripts/audit-gate.test.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$HERE/audit-gate.sh"

command -v node >/dev/null 2>&1 || {
  echo "SKIP: node required"
  exit 0
}
[ -f "$GATE" ] || {
  echo "SKIP: audit-gate.sh not found"
  exit 0
}

PASS=0
FAILS=()
STUB="$(mktemp -d "${TMPDIR:-/tmp}/audit-gate-test.XXXXXX")"
trap 'rm -rf "$STUB"' EXIT

# Write a fake `pnpm` that prints $1 (the canned JSON) and swallows the args.
stub_pnpm() {
  printf '#!/usr/bin/env bash\ncat <<'"'"'JSON'"'"'\n%s\nJSON\n' "$1" >"$STUB/pnpm"
  chmod +x "$STUB/pnpm"
}

# Run the gate with the stub on PATH + an optional allowlist file. Echoes exit code.
run_gate() {
  local allowlist="${1:-}"
  if [ -n "$allowlist" ]; then
    PATH="$STUB:$PATH" GAFFER_TEST_ALLOWLIST="$allowlist" bash "$GATE" >/dev/null 2>&1
  else
    PATH="$STUB:$PATH" bash "$GATE" >/dev/null 2>&1
  fi
  echo $?
}

check() {
  local label="$1" want="$2" got="$3"
  if [ "$got" = "$want" ]; then
    PASS=$((PASS + 1))
    printf '  ok   %s (exit %s)\n' "$label" "$got"
  else
    FAILS+=("$label")
    printf '  FAIL %s (exit %s, want %s)\n' "$label" "$got" "$want"
  fi
}

RETIRED='{"error":{"code":"ERR_PNPM_AUDIT_BAD_RESPONSE","message":"The audit endpoint (at https://registry.npmjs.org/-/npm/v1/security/audits/quick) responded with 410: This endpoint is being retired. Use the bulk advisory endpoint instead."}}'
TRANSIENT='{"error":{"code":"ERR_PNPM_AUDIT_BAD_RESPONSE","message":"The audit endpoint responded with 503: Service Unavailable"}}'
HIGH='{"advisories":{"1":{"severity":"high","github_advisory_id":"GHSA-test-high","module_name":"evil"}}}'
CRITICAL='{"advisories":{"1":{"severity":"critical","github_advisory_id":"GHSA-test-crit","module_name":"boom"}}}'
OTHER_ERR='{"error":{"code":"ERR_SOMETHING_ELSE","message":"disk on fire"}}'
NO_ADVISORIES='{"metadata":{"vulnerabilities":{}}}'
CLEAN='{"advisories":{}}'
LOW_ONLY='{"advisories":{"1":{"severity":"low","github_advisory_id":"GHSA-test-low","module_name":"meh"}}}'

# An allowlist that accepts the HIGH advisory's id, to exercise the accepted path.
ALLOW="$STUB/allow.txt"
printf '# test allowlist\nGHSA-test-high  # accepted for the test\n' >"$ALLOW"

echo "== audit-gate.sh exit-code contract =="
stub_pnpm "$RETIRED"
check "retired 410 endpoint → SKIPPED" 0 "$(run_gate)"
stub_pnpm "$TRANSIENT"
check "transient bad-response (503, same code) → fail closed" 2 "$(run_gate)"
stub_pnpm "$HIGH"
check "un-accepted HIGH advisory → FAIL" 1 "$(run_gate)"
stub_pnpm "$CRITICAL"
check "un-accepted CRITICAL advisory → FAIL" 1 "$(run_gate)"
stub_pnpm "$OTHER_ERR"
check "unknown error envelope → fail closed" 2 "$(run_gate)"
stub_pnpm "$NO_ADVISORIES"
check "no advisories key → fail closed" 2 "$(run_gate)"
stub_pnpm "$CLEAN"
check "clean → OK" 0 "$(run_gate)"
stub_pnpm "$LOW_ONLY"
check "low-severity only → OK (not gated)" 0 "$(run_gate)"
# Allowlist path: the SAME HIGH advisory, but its id is accepted → gate passes.
stub_pnpm "$HIGH"
check "allowlisted HIGH advisory → accepted (OK)" 0 "$(run_gate "$ALLOW")"

echo
if [ "${#FAILS[@]}" -eq 0 ]; then
  echo "PASS — $PASS checks passed ($GATE)"
  exit 0
else
  echo "FAILED — ${#FAILS[@]} of $((PASS + ${#FAILS[@]}))"
  for f in "${FAILS[@]}"; do echo "  - $f"; done
  exit 1
fi
