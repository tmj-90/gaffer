#!/usr/bin/env bash
# =====================================================================
# COST-AS-CONTROL — the usage-ledger → GAFFER_BUDGET_REMAINING → router
# downgrade + pause chain (Track 3a).
# ---------------------------------------------------------------------
# Cost is MEASURED in the usage-ledger; this proves it is now a CONTROL
# input, not just an observed number. Sourcing factory.config.sh with a
# real ledger + a configured GAFFER_BUDGET_USD:
#   1. GAFFER_BUDGET_REMAINING is the ledger total subtracted from the
#      budget (unmeasured "unknown" rows contribute 0 — never inferred).
#   2. GAFFER_BUDGET_LOW_THRESHOLD auto-derives to ~20% of the budget
#      when the operator leaves it unset (so the downgrade actually fires).
#   3. Near the ceiling the router DOWNGRADES one tier (sonnet → haiku)
#      and logs the trade-off — spend steers routing.
#   4. With headroom left, the router does NOT downgrade.
#   5. When spend >= budget, remaining is 0 and the pause-on-cap guard's
#      `<= 0` condition fires (in-flight work pauses).
#   6. An explicit GAFFER_BUDGET_LOW_THRESHOLD wins over the derived one.
# Zero deps beyond node + awk. Run: bash test/budget-remaining.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v awk  >/dev/null 2>&1 || { echo "SKIP: awk required";  exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/budget-remaining.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/data"

# Write a ledger with measured spend 4.5 (3.5 + 1.0) plus one UNMEASURED row that
# must contribute 0 (honesty: a partial run never reads as cheap).
write_ledger() {
  local total="$1"
  {
    printf '{"ts":"2026-07-01T00:00:00Z","ticket":1,"kind":"delivery","measured":true,"total_cost_usd":%s}\n' "$total"
    printf '{"ts":"2026-07-01T00:01:00Z","ticket":2,"kind":"delivery","measured":false,"total_cost_usd":"unknown"}\n'
  } > "$WORK/data/usage-ledger.jsonl"
}

# Source factory.config.sh in a clean env and echo the resolved control vars +
# a routing decision, so each assertion reads a fresh, side-effect-free source.
probe() {
  local budget="$1" threshold_override="${2:-}"
  env -i PATH="$PATH" HOME="$HOME" \
      GAFFER_DATA="$WORK/data" GAFFER_BUDGET_USD="$budget" \
      ${threshold_override:+GAFFER_BUDGET_LOW_THRESHOLD="$threshold_override"} \
      bash -c '
        source "'"$RUNNER_DIR"'/factory.config.sh" >/dev/null 2>&1
        printf "REMAINING=%s\n" "${GAFFER_BUDGET_REMAINING:-}"
        printf "THRESHOLD=%s\n" "${GAFFER_BUDGET_LOW_THRESHOLD:-}"
        printf "TIER=%s\n" "$(gaffer_route_model implement medium 3 "" 1 2>/dev/null)"
      '
}

echo "== 1-3: near the ceiling → remaining computed, threshold derived, downgrade fires =="
write_ledger 4.5
OUT="$(probe 5.00)"
REMAINING="$(printf '%s\n' "$OUT" | sed -n 's/^REMAINING=//p')"
THRESHOLD="$(printf '%s\n' "$OUT" | sed -n 's/^THRESHOLD=//p')"
TIER="$(printf '%s\n' "$OUT" | sed -n 's/^TIER=//p')"

awk "BEGIN{exit !((${REMAINING:-0}+0) > 0.4999 && (${REMAINING:-0}+0) < 0.5001)}" \
  && ok "GAFFER_BUDGET_REMAINING = budget 5.00 - measured 4.5 = 0.5 (unknown row = 0)" \
  || fail "remaining should be 0.5 (got '$REMAINING')"
awk "BEGIN{exit !((${THRESHOLD:-0}+0) > 0.9999 && (${THRESHOLD:-0}+0) < 1.0001)}" \
  && ok "GAFFER_BUDGET_LOW_THRESHOLD auto-derived to 20% of budget (1.0)" \
  || fail "threshold should derive to 1.0 (got '$THRESHOLD')"
[ "$TIER" = "haiku" ] \
  && ok "router DOWNGRADED sonnet → haiku near the ceiling (spend steers routing)" \
  || fail "expected a downgrade to haiku (got '$TIER')"

echo "== 4: plenty of headroom → no downgrade =="
write_ledger 0.10
OUT="$(probe 5.00)"
TIER="$(printf '%s\n' "$OUT" | sed -n 's/^TIER=//p')"
[ "$TIER" = "sonnet" ] \
  && ok "with headroom the router stays on the mid tier (sonnet)" \
  || fail "expected sonnet with headroom (got '$TIER')"

echo "== 5: spend >= budget → remaining 0 → pause-on-cap condition fires =="
write_ledger 6.00
OUT="$(probe 5.00)"
REMAINING="$(printf '%s\n' "$OUT" | sed -n 's/^REMAINING=//p')"
awk "BEGIN{exit !((${REMAINING:-1}+0) == 0)}" \
  && ok "remaining clamps to 0 when spend exceeds the budget" \
  || fail "remaining should clamp to 0 (got '$REMAINING')"
# The exact guard tick.sh uses to pause an in-flight delivery on a budget cap.
awk "BEGIN{exit !(${REMAINING:-1}+0 <= 0)}" \
  && ok "pause-on-cap guard (<= 0) fires when the budget is exhausted" \
  || fail "the <= 0 pause condition should fire at exhaustion"

echo "== 6: an explicit threshold overrides the derived one =="
write_ledger 4.5
OUT="$(probe 5.00 0.1)"     # remaining 0.5 > explicit 0.1 → no downgrade
THRESHOLD="$(printf '%s\n' "$OUT" | sed -n 's/^THRESHOLD=//p')"
TIER="$(printf '%s\n' "$OUT" | sed -n 's/^TIER=//p')"
[ "$THRESHOLD" = "0.1" ] \
  && ok "explicit GAFFER_BUDGET_LOW_THRESHOLD is honoured (not overwritten)" \
  || fail "explicit threshold should win (got '$THRESHOLD')"
[ "$TIER" = "sonnet" ] \
  && ok "remaining 0.5 above the explicit 0.1 threshold → no downgrade" \
  || fail "expected sonnet with a low explicit threshold (got '$TIER')"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
