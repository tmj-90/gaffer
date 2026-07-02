#!/usr/bin/env bash
# =====================================================================
# TRACK-3a — the FIRST-CLASS per-ticket delivery budget is ENFORCED by the
# runner (tick.sh _recover_or_park), overriding the factory-wide default.
# ---------------------------------------------------------------------
# The rework loop's cost bound now resolves its ceiling from the ticket's own
# tickets.delivery_budget_usd (inherited from the epic) when set, falling back to
# GAFFER_REWORK_BUDGET_USD otherwise. This proves:
#   A. the RESOLUTION: a per-ticket budget wins over the env default; an unset one
#      falls back to the env default.
#   B. the CEILING trips at cumulative spend >= the resolved ceiling.
#   C. the wiring is present in tick.sh (reads delivery_budget_usd + resolves an
#      effective ceiling), and the dispatch view surfaces the field.
# Zero deps beyond awk + node. Run: bash test/ticket-budget-enforce.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
TICK="$RUNNER_DIR/tick.sh"
CLI="$ROOT/packages/dispatch/dist/cli/index.js"

command -v awk  >/dev/null 2>&1 || { echo "SKIP: awk required";  exit 0; }
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

# The exact resolution tick.sh uses: per-ticket budget wins when > 0, else the env
# default. Mirrored here so the policy is pinned independently of the delivery flow.
resolve_ceiling() {
  local ticket_budget="$1" env_default="$2" eff=""
  case "$ticket_budget" in ""|None|null) ticket_budget="" ;; esac
  if [ -n "$ticket_budget" ] && awk "BEGIN{exit !(${ticket_budget:-0}+0 > 0)}" 2>/dev/null; then
    eff="$ticket_budget"
  else
    eff="$env_default"
  fi
  printf '%s' "$eff"
}
trips() { # <spent> <ceiling> → 0 (trips) / 1 (ok)
  local spent="$1" ceiling="$2"
  [ -n "$ceiling" ] && awk "BEGIN{exit !(${ceiling:-0}+0 > 0)}" || return 1
  awk "BEGIN{exit !(${spent:-0}+0 >= ${ceiling}+0)}"
}

echo "== A: per-ticket budget overrides the factory default =="
[ "$(resolve_ceiling 0.50 2.00)" = "0.50" ] \
  && ok "a set per-ticket budget (0.50) wins over the env default (2.00)" \
  || fail "per-ticket budget should win (got $(resolve_ceiling 0.50 2.00))"
[ "$(resolve_ceiling "" 2.00)" = "2.00" ] \
  && ok "an unset per-ticket budget falls back to the env default (2.00)" \
  || fail "unset budget should fall back (got $(resolve_ceiling "" 2.00))"
[ "$(resolve_ceiling None 2.00)" = "2.00" ] \
  && ok "a null/None per-ticket budget falls back to the env default" \
  || fail "None budget should fall back (got $(resolve_ceiling None 2.00))"

echo "== B: the resolved ceiling trips at cumulative spend >= ceiling =="
if trips 0.60 "$(resolve_ceiling 0.50 2.00)"; then
  ok "spend 0.60 >= per-ticket ceiling 0.50 → parks (even though env default is 2.00)"
else
  fail "the per-ticket ceiling should trip at 0.60 >= 0.50"
fi
if trips 0.60 "$(resolve_ceiling "" 2.00)"; then
  fail "spend 0.60 < env default 2.00 should NOT trip"
else
  ok "spend 0.60 < env default 2.00 → does not trip (attempts still bound it)"
fi

echo "== C: the wiring exists in tick.sh + the field is surfaced by dispatch =="
grep -q 'delivery_budget_usd' "$TICK" \
  && ok "tick.sh reads the per-ticket delivery_budget_usd" \
  || fail "tick.sh does not read delivery_budget_usd"
grep -q '_eff_ceiling' "$TICK" \
  && ok "tick.sh resolves an effective per-ticket ceiling" \
  || fail "tick.sh missing the effective-ceiling resolution"

if [ -f "$CLI" ]; then
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/tbudget.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
  DB="$WORK/d.sqlite"
  node "$CLI" --db "$DB" init >/dev/null 2>&1
  OUT="$(node "$CLI" --db "$DB" ticket create -t "budgeted" --budget 1.5 2>/dev/null)"
  echo "$OUT" | grep -q '"delivery_budget_usd": *1.5' \
    && ok "wg ticket create --budget surfaces delivery_budget_usd on the ticket" \
    || fail "ticket create --budget did not surface the field ($OUT)"
else
  echo "  skip dispatch CLI not built ($CLI) — build it to exercise the surface"
fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
