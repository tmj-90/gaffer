#!/usr/bin/env bash
# =====================================================================
# PRE-SPAWN BUDGET GATE (C3) — gaffer_budget_exhausted, extracted from tick.sh.
# ---------------------------------------------------------------------
# The rework loop already bounds cost AFTER an attempt runs. This gate bounds it
# BEFORE the spawn, so a ticket that already reached its ceiling in a prior run does
# not burn one more agent turn. Proves the REAL function (extracted verbatim):
#   • no ceiling configured anywhere → never gates;
#   • the factory-wide GAFFER_REWORK_BUDGET_USD trips at cumulative spend >= ceiling;
#   • the per-ticket delivery_budget_usd WINS over the factory default;
#   • the message globals (GAFFER_BUDGET_SPENT/CEIL) expose the resolved figures.
# Zero deps beyond python3. Run: bash test/prespawn-budget-gate.test.sh  (bash 3.2 safe)
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
TICK="$RUNNER_DIR/tick.sh"
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required"; exit 0; }
[ -f "$TICK" ] || { echo "SKIP: tick.sh not found"; exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

# Extract the REAL gaffer_budget_exhausted from tick.sh and source it.
FN="$(mktemp "${TMPDIR:-/tmp}/budget-fn.XXXXXX")"
trap 'rm -f "$FN"' EXIT
awk '/^gaffer_budget_exhausted\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$TICK" > "$FN"
grep -q 'gaffer_budget_exhausted()' "$FN" \
  && ok "extracted the real gaffer_budget_exhausted from tick.sh" \
  || { echo "FAIL: could not extract gaffer_budget_exhausted from tick.sh"; exit 1; }
# The function closes over the numeric-safe awk comparison helpers (_num_pos/_num_ge);
# extract the REAL ones from tick.sh too so this still exercises production code.
grep -E '^_num_(pos|ge|le)\(\)' "$TICK" >> "$FN"
grep -q '^_num_pos()' "$FN" \
  && ok "extracted the real _num_ helpers from tick.sh" \
  || { echo "FAIL: could not extract the _num_ helpers from tick.sh"; exit 1; }
# shellcheck disable=SC1090
source "$FN"

# The deps the function closes over (mirrors tick.sh's runtime).
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }
SPEND=0
gaffer_ticket_rework_spend() { echo "$SPEND"; }
GAFFER_BUDGET_SPENT=""; GAFFER_BUDGET_CEIL=""
# Run the gate IN THE CURRENT SHELL (never $(...) — a subshell would drop the message
# globals the function sets). V=EXHAUSTED when it trips, OK otherwise.
V=""
gate() { GAFFER_BUDGET_SPENT=""; GAFFER_BUDGET_CEIL=""; if gaffer_budget_exhausted 1; then V=EXHAUSTED; else V=OK; fi; }

# 1. no ceiling anywhere → the gate must NEVER trip (spend is irrelevant).
SHOW='{"ticket":{}}'; GAFFER_REWORK_BUDGET_USD=""; SPEND="5.00"; gate
[ "$V" = "OK" ] && ok "no ceiling configured → gate never trips" || fail "gated with no ceiling set"

# 2. factory-wide ceiling, spend UNDER it → OK.
GAFFER_REWORK_BUDGET_USD="2.00"; SPEND="1.50"; gate
[ "$V" = "OK" ] && ok "factory ceiling \$2.00, spent \$1.50 → OK (spawn allowed)" || fail "tripped while under the ceiling"

# 3. factory-wide ceiling, spend AT/OVER it → EXHAUSTED (pre-spawn park).
SPEND="2.00"; gate
[ "$V" = "EXHAUSTED" ] && ok "factory ceiling \$2.00, spent \$2.00 → EXHAUSTED (park before spawn)" || fail "did not trip at the ceiling"

# 4. the per-ticket delivery_budget_usd WINS over the factory default.
SHOW='{"ticket":{"delivery_budget_usd":0.50}}'; GAFFER_REWORK_BUDGET_USD="10.00"; SPEND="0.75"; gate
[ "$V" = "EXHAUSTED" ] && ok "per-ticket budget \$0.50 wins over \$10.00 default (spent \$0.75 → EXHAUSTED)" || fail "per-ticket budget not honoured over the default"
[ "$GAFFER_BUDGET_CEIL" = "0.5" ] && ok "GAFFER_BUDGET_CEIL exposes the resolved per-ticket ceiling (\$0.5)" || fail "ceil global wrong (got '$GAFFER_BUDGET_CEIL')"
[ "$GAFFER_BUDGET_SPENT" = "0.75" ] && ok "GAFFER_BUDGET_SPENT exposes the cumulative spend (\$0.75)" || fail "spent global wrong (got '$GAFFER_BUDGET_SPENT')"

# 5. per-ticket budget, spend under it → OK (even though it's the tighter ceiling).
SPEND="0.25"; gate
[ "$V" = "OK" ] && ok "per-ticket \$0.50, spent \$0.25 → OK (spawn allowed)" || fail "tripped under the per-ticket budget"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "prespawn-budget-gate: ALL $PASS checks passed"
  exit 0
fi
echo "prespawn-budget-gate: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
