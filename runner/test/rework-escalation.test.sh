#!/usr/bin/env bash
# =====================================================================
# REWORK LOOP — escalation ladder + double-bound (runner/tick.sh + factory.config.sh)
# ---------------------------------------------------------------------
# The runner's delivery rework loop is VISIBLE, ESCALATING, WELL-FED and BOUNDED:
#   • ESCALATION (gaffer_build_escalation): attempt 1 = routed model + base prompt;
#     attempt 2..(max-1) = RETHINK (re-plan, same model); attempt max = STRONGER
#     model (GAFFER_REWORK_STRONG_MODEL) + the FULL failure history.
#   • DOUBLE-BOUND (gaffer_ticket_rework_spend + the per-ticket budget): the loop
#     stops at whichever hits FIRST — the attempt cap OR the per-ticket cost ceiling.
#
# These two functions are EXTRACTED FROM THE REAL SOURCE and eval'd here (never a
# copy), so a drift in tick.sh/factory.config.sh is caught. Zero external deps.
# Run: bash runner/test/rework-escalation.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
TICK="$RUNNER_DIR/tick.sh"
CFG="$RUNNER_DIR/factory.config.sh"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

# Extract a bash function body from a source file by name + closing-brace indent.
#   extract_fn <file> <name> <close-brace-line>   (close-brace-line e.g. "  }" or "}")
extract_fn() {
  awk -v name="$2" -v endln="$3" '
    $0 ~ ("^[[:space:]]*" name "\\(\\) \\{") { grab=1 }
    grab { print }
    grab && $0 == endln { exit }
  ' "$1"
}

echo "== PART A: gaffer_build_escalation — the escalation ladder =="
# Stubs the real function depends on.
log() { :; }
gaffer_quarantine() { printf '%s' "$2"; }   # real sig: <tag> <value> [mode] → echo value
ROUTE_IMPL_FLAG="--model sonnet"
GAFFER_REWORK_STRONG_MODEL="opus"
_MAX_DELIVERY_ATTEMPTS=3
_REWORK_HISTORY=$'── attempt 1 — definition-of-done ──\nAssertionError: expected 3 to be 4\n'
_REWORK_BLOCK=""
_ATTEMPT_IMPL_FLAG=""

FN_SRC="$(extract_fn "$TICK" "gaffer_build_escalation" "  }")"
[ -n "$FN_SRC" ] && ok "A extracted gaffer_build_escalation from tick.sh (real source)" \
  || fail "A could not extract gaffer_build_escalation from tick.sh"
eval "$FN_SRC"

# Attempt 1 — routed model, NO rework block (base prompt).
gaffer_build_escalation 1
[ -z "$_REWORK_BLOCK" ] && ok "A1 attempt 1 → empty rework block (base prompt)" \
  || fail "A1 attempt 1 should have no rework block (got: $_REWORK_BLOCK)"
[ "$_ATTEMPT_IMPL_FLAG" = "$ROUTE_IMPL_FLAG" ] && ok "A1 attempt 1 → routed model (no escalation)" \
  || fail "A1 attempt 1 model should be the routed model (got: $_ATTEMPT_IMPL_FLAG)"

# Attempt 2 — RETHINK, same model, carries the real failure.
gaffer_build_escalation 2
printf '%s' "$_REWORK_BLOCK" | grep -q 'RETHINK' \
  && ok "A2 attempt 2 → RETHINK posture (re-plan the approach)" \
  || fail "A2 attempt 2 should be a RETHINK ($_REWORK_BLOCK)"
[ "$_ATTEMPT_IMPL_FLAG" = "$ROUTE_IMPL_FLAG" ] \
  && ok "A2 attempt 2 → same routed model (model escalates only on the final attempt)" \
  || fail "A2 attempt 2 model should stay the routed model (got: $_ATTEMPT_IMPL_FLAG)"
printf '%s' "$_REWORK_BLOCK" | grep -q 'expected 3 to be 4' \
  && ok "A2 the real failure is fed into the rework block (well-fed)" \
  || fail "A2 the rework block should carry the real failure ($_REWORK_BLOCK)"

# Attempt 3 (== max) — STRONGER model + full history.
gaffer_build_escalation 3
printf '%s' "$_REWORK_BLOCK" | grep -q 'FINAL' \
  && ok "A3 attempt 3 → FINAL posture (last shot before a human)" \
  || fail "A3 attempt 3 should be the FINAL attempt ($_REWORK_BLOCK)"
[ "$_ATTEMPT_IMPL_FLAG" = "--model opus" ] \
  && ok "A3 attempt 3 → escalates to the STRONGER model (opus)" \
  || fail "A3 attempt 3 should escalate to opus (got: $_ATTEMPT_IMPL_FLAG)"

# With the escalation model unset, the final attempt keeps the routed model (no crash).
GAFFER_REWORK_STRONG_MODEL="" gaffer_build_escalation 3 2>/dev/null || true
GAFFER_REWORK_STRONG_MODEL=""
gaffer_build_escalation 3
[ "$_ATTEMPT_IMPL_FLAG" = "$ROUTE_IMPL_FLAG" ] \
  && ok "A4 no strong model set → final attempt keeps the routed model (no escalation, no crash)" \
  || fail "A4 with no strong model the final attempt should keep the routed model (got: $_ATTEMPT_IMPL_FLAG)"
GAFFER_REWORK_STRONG_MODEL="opus"

echo "== PART B: gaffer_ticket_rework_spend — the cost side of the double-bound =="
SPEND_SRC="$(extract_fn "$CFG" "gaffer_ticket_rework_spend" "}")"
[ -n "$SPEND_SRC" ] && ok "B extracted gaffer_ticket_rework_spend from factory.config.sh (real source)" \
  || fail "B could not extract gaffer_ticket_rework_spend"
eval "$SPEND_SRC"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/rework-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
LEDGER="$WORK/usage-ledger.jsonl"
# Two measured delivery calls for ticket 88 (0.10 + 0.25), one for a different
# ticket, one unmeasured (unknown → contributes 0). Only 88's measured spend counts.
{
  printf '%s\n' '{"kind":"delivery","ticket":88,"measured":true,"total_cost_usd":0.10}'
  printf '%s\n' '{"kind":"delivery","ticket":88,"measured":true,"total_cost_usd":0.25}'
  printf '%s\n' '{"kind":"delivery","ticket":99,"measured":true,"total_cost_usd":5.00}'
  printf '%s\n' '{"kind":"delivery","ticket":88,"measured":false,"total_cost_usd":"unknown"}'
  printf '%s\n' '{"kind":"clarify","ticket":88,"measured":true,"total_cost_usd":9.00}'
} > "$LEDGER"

SPENT="$(GAFFER_USAGE_LEDGER="$LEDGER" gaffer_ticket_rework_spend 88)"
awk "BEGIN{exit !(($SPENT+0) > 0.349 && ($SPENT+0) < 0.351)}" \
  && ok "B1 sums ONLY ticket 88's measured DELIVERY spend (0.35, ignoring other tickets/kinds/unknowns)" \
  || fail "B1 expected ~0.35 for ticket 88, got $SPENT"

# The per-ticket ceiling decision (the exact awk tick.sh uses): 0.35 >= 0.30 → trip.
GAFFER_REWORK_BUDGET_USD="0.30"
if awk "BEGIN{exit !(${SPENT:-0}+0 >= ${GAFFER_REWORK_BUDGET_USD}+0)}"; then
  ok "B2 spend 0.35 ≥ ceiling 0.30 → the cost bound trips (park to blocked even with attempts left)"
else
  fail "B2 the cost bound should trip at 0.35 ≥ 0.30"
fi
# Below the ceiling → keep reworking.
GAFFER_REWORK_BUDGET_USD="1.00"
if awk "BEGIN{exit !(${SPENT:-0}+0 >= ${GAFFER_REWORK_BUDGET_USD}+0)}"; then
  fail "B3 the cost bound should NOT trip at 0.35 < 1.00"
else
  ok "B3 spend 0.35 < ceiling 1.00 → the cost bound does not trip (attempts still bound it)"
fi

echo "== PART C: the double-bound is wired into _recover_or_park =="
grep -q 'GAFFER_REWORK_BUDGET_USD' "$TICK" \
  && ok "C tick.sh reads the per-ticket rework budget (GAFFER_REWORK_BUDGET_USD)" \
  || fail "C tick.sh does not read GAFFER_REWORK_BUDGET_USD"
grep -q 'gaffer_ticket_rework_spend "\$NUM"' "$TICK" \
  && ok "C _recover_or_park checks the per-ticket cumulative spend" \
  || fail "C _recover_or_park does not check per-ticket spend"
grep -q '_cost_exhausted' "$TICK" \
  && ok "C a hit cost ceiling parks (even with attempts remaining)" \
  || fail "C tick.sh missing the cost-ceiling park branch"
# GAFFER_MAX_DELIVERY_ATTEMPTS default is raised 2 → 3.
grep -q 'GAFFER_MAX_DELIVERY_ATTEMPTS:-3' "$TICK" \
  && ok "C the attempt cap default is raised to 3 (room for the ladder)" \
  || fail "C tick.sh default GAFFER_MAX_DELIVERY_ATTEMPTS should be 3"
grep -qE 'GAFFER_MAX_DELIVERY_ATTEMPTS:=3' "$CFG" \
  && ok "C factory.config.sh documents/defaults the attempt cap to 3" \
  || fail "C factory.config.sh default GAFFER_MAX_DELIVERY_ATTEMPTS should be 3"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
