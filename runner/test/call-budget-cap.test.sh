#!/usr/bin/env bash
# =====================================================================
# Opt-in HARD per-call dollar cap (GAFFER_MAX_CALL_USD → claude --max-budget-usd).
# ---------------------------------------------------------------------
# Before: nothing passed --max-budget-usd, and every spend guard acted only BETWEEN
# calls, so one 200-turn call could overshoot a ticket's ceiling by its whole cost.
# The knob is OPT-IN (owner decision pending on a default), so proves, with a fake
# `claude` that records its argv (no live model):
#   1. default (knob empty): no flag on the REAL worker_deliver nor on Worker.deliver
#      — behaviour unchanged;
#   2. knob set: the flag carries min(knob, factory headroom), and a site-supplied
#      flag (the delivery's, which also carries the ticket's remaining) is not doubled;
#      a ≤0 headroom adds no flag (the pre-spawn gates own that case);
#   3. tick.sh: the delivery passes the ticket's remaining ceiling, and a budget stop
#      (subtype error_max_budget_usd) is a budget_cap pause, never a turn cap-hit;
#   4. gaffer_ticket_budget_remaining (extracted from tick.sh) = ceiling − spend.
# Run: bash test/call-budget-cap.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/call-budget.XXXXXX")"; WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
export GAFFER_DATA="$WORK/.gaffer"; mkdir -p "$GAFFER_DATA"
export GAFFER_LOG="$WORK/factory.log"

FAKE="$WORK/fake-claude"
cat > "$FAKE" <<EOS
#!/usr/bin/env bash
printf '%s\n' "\$@" > "$WORK/claude.argv"
printf '%s\n' '{"result":"ok","total_cost_usd":0.01,"num_turns":1}'
EOS
chmod +x "$FAKE"
budget_arg() { awk 'p { print; exit } $0 == "--max-budget-usd" { p = 1 }' "$WORK/claude.argv" 2>/dev/null; }
count_flag() { grep -c '^--max-budget-usd$' "$WORK/claude.argv" 2>/dev/null || true; }

export CLAUDE_BIN="$FAKE"
unset GAFFER_MAX_CALL_USD GAFFER_BUDGET_USD
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
CWD="$WORK/cwd"; mkdir -p "$CWD"; MCP="$WORK/mcp.json"; printf '{"mcpServers":{}}' > "$MCP"
WORKER_CALL_ENV=( GAFFER_BUDGET_TEST=1 )

echo "== 1: default — the knob is off, nothing changes =="
[ -z "${GAFFER_MAX_CALL_USD:-}" ] && ok "GAFFER_MAX_CALL_USD defaults to empty (opt-in)" || fail "knob has a default ($GAFFER_MAX_CALL_USD)"
[ -z "$(gaffer_call_budget_usd 3)" ] && ok "gaffer_call_budget_usd is empty when the knob is off" || fail "budget emitted with the knob off"
worker_deliver "$CWD" "p" "" "$MCP" "$WORK/o1.json" "" >/dev/null 2>&1
[ "$(count_flag)" = "0" ] && ok "worker_deliver adds no --max-budget-usd by default" || fail "flag added by default"
MJS_DEFAULT="$(node --input-type=module -e "
import { withCallBudget } from '$RUNNER_DIR/lib/worker.mjs';
console.log(JSON.stringify(withCallBudget(['-p','x'], {GAFFER_BUDGET_REMAINING:'3'})));")"
[ "$MJS_DEFAULT" = '["-p","x"]' ] && ok "Worker.deliver argv unchanged by default (even with a budget headroom set)" || fail "mjs default changed argv: $MJS_DEFAULT"

echo "== 2: knob on — the call carries min(knob, headroom) =="
GAFFER_MAX_CALL_USD=5 worker_deliver "$CWD" "p" "" "$MCP" "$WORK/o2.json" "" >/dev/null 2>&1
[ "$(budget_arg)" = "5.0000" ] && ok "GAFFER_MAX_CALL_USD=5 → --max-budget-usd 5.0000" || fail "flag value '$(budget_arg)'"
GAFFER_MAX_CALL_USD=5 GAFFER_BUDGET_REMAINING=2 worker_deliver "$CWD" "p" "" "$MCP" "$WORK/o3.json" "" >/dev/null 2>&1
[ "$(budget_arg)" = "2.0000" ] && ok "clamped to the factory headroom (\$2)" || fail "headroom clamp '$(budget_arg)'"
GAFFER_MAX_CALL_USD=5 worker_deliver "$CWD" "p" "" "$MCP" "$WORK/o4.json" "" "" --max-budget-usd 1.5 >/dev/null 2>&1
[ "$(count_flag)" = "1" ] && [ "$(budget_arg)" = "1.5" ] && ok "a site-supplied cap is kept and not doubled" || fail "site cap doubled/lost ($(count_flag), $(budget_arg))"
GAFFER_MAX_CALL_USD=5 GAFFER_BUDGET_REMAINING=0 worker_deliver "$CWD" "p" "" "$MCP" "$WORK/o5.json" "" >/dev/null 2>&1
[ "$(count_flag)" = "0" ] && ok "\$0 headroom adds no flag (the pre-spawn gates own that case)" || fail "flag added at \$0 headroom"
[ "$(GAFFER_MAX_CALL_USD=5 gaffer_call_budget_usd 1.25)" = "1.2500" ] && ok "the ticket's remaining (\$1.25) wins when lowest" || fail "ticket clamp wrong"
MJS_ON="$(node --input-type=module -e "
import { withCallBudget } from '$RUNNER_DIR/lib/worker.mjs';
console.log(JSON.stringify(withCallBudget(['-p','x'], {GAFFER_MAX_CALL_USD:'5', GAFFER_BUDGET_REMAINING:'3'})));")"
[ "$MJS_ON" = '["-p","x","--max-budget-usd","3.0000"]' ] && ok "Worker.deliver seam appends the same cap (parity)" || fail "mjs cap: $MJS_ON"

echo "== 3: a budget stop is a budget_cap pause, never a turn cap-hit =="
printf '%s' '{"type":"result","subtype":"error_max_budget_usd","num_turns":3,"total_cost_usd":5.01}' > "$WORK/stop.json"
gaffer_is_budget_stop "$WORK/stop.json" && ok "gaffer_is_budget_stop recognises subtype error_max_budget_usd" || fail "budget stop not recognised"
gaffer_is_cap_hit "$WORK/stop.json" 0 && fail "a budget stop was classified as a turn cap-hit" || ok "a budget stop is NOT a turn cap-hit"
printf '%s' '{"type":"result","subtype":"error_max_turns","num_turns":200}' > "$WORK/turns.json"
gaffer_is_budget_stop "$WORK/turns.json" && fail "a turn cap read as a budget stop" || ok "a turn-cap stop is not a budget stop"
grep -q 'if gaffer_is_budget_stop "$USAGE_JSON"; then _BUDGET_HIT=1; fi' "$RUNNER_DIR/tick.sh" \
  && ok "tick.sh turns a budget stop into _BUDGET_HIT (pause reason budget_cap)" || fail "tick.sh does not wire the budget stop"
grep -q '_CALL_BUDGET="$(gaffer_call_budget_usd "$(gaffer_ticket_budget_remaining "$NUM")")"' "$RUNNER_DIR/tick.sh" \
  && ok "the delivery's cap carries the ticket's remaining ceiling" || fail "delivery does not pass the ticket's remaining"

echo "== 4: gaffer_ticket_budget_remaining (real, extracted from tick.sh) =="
FN="$WORK/fn.sh"
awk '/^gaffer_ticket_budget_remaining\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$RUNNER_DIR/tick.sh" > "$FN"
grep -E '^_num_(pos|ge|le)\(\)' "$RUNNER_DIR/tick.sh" >> "$FN"
# shellcheck disable=SC1090
source "$FN"
jget() { node "$RUNNER_DIR/lib/json-tool.mjs" expr "$1"; }
gaffer_ticket_rework_spend() { echo 3.5; }
SHOW='{"ticket":{"delivery_budget_usd":5}}'; GAFFER_REWORK_BUDGET_USD=""
[ "$(gaffer_ticket_budget_remaining 7)" = "1.500000" ] && ok "ticket budget \$5 − spent \$3.50 = \$1.50" || fail "remaining '$(gaffer_ticket_budget_remaining 7)'"
SHOW='{"ticket":{}}'
[ -z "$(gaffer_ticket_budget_remaining 7)" ] && ok "no ceiling configured → nothing (no clamp)" || fail "remaining without a ceiling"

echo "== 5: the spawns outside Worker.deliver carry the cap too =="
# spec-author spawns claude itself, and the inherit classifier's argv is spawned by
# greenfield.sh; both used to skip the cap. decompose (through the seam) is the control.
unset GAFFER_BUDGET_REMAINING
for helper in decompose spec-author; do
  rm -f "$WORK/claude.argv"
  GAFFER_DATA="$WORK/$helper" GAFFER_MAX_CALL_USD=3 \
    node "$RUNNER_DIR/bin/$helper.mjs" --brief x >/dev/null 2>&1 </dev/null
  [ "$(count_flag)" = "1" ] && [ "$(budget_arg)" = "3.0000" ] \
    && ok "$helper.mjs: GAFFER_MAX_CALL_USD=3 → --max-budget-usd 3.0000" \
    || fail "$helper.mjs argv lacks the cap ($(count_flag), '$(budget_arg)')"
  rm -f "$WORK/claude.argv"
  GAFFER_DATA="$WORK/$helper" node "$RUNNER_DIR/bin/$helper.mjs" --brief x >/dev/null 2>&1 </dev/null
  [ -f "$WORK/claude.argv" ] && [ "$(count_flag)" = "0" ] \
    && ok "$helper.mjs: no flag with the knob off" || fail "$helper.mjs default argv changed"
done
inherit_cap() { node --input-type=module -e "
import { buildClaudeArgv } from '$RUNNER_DIR/bin/inherit-repo.mjs';
const a = buildClaudeArgv({ prompt: 'P', model: 'haiku', flags: [] });
const i = a.indexOf('--max-budget-usd'); console.log(i < 0 ? 'none' : a[i + 1]);"; }
[ "$(GAFFER_MAX_CALL_USD=3 inherit_cap)" = "3.0000" ] \
  && ok "inherit classifier argv carries --max-budget-usd 3.0000" || fail "inherit argv lacks the cap"
[ "$(inherit_cap)" = "none" ] && ok "inherit classifier argv unchanged with the knob off" \
  || fail "inherit default argv changed"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
