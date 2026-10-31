#!/usr/bin/env bash
# =====================================================================
# LIFETIME BUDGET ADMISSION — GAFFER_BUDGET_USD is a HARD ceiling before the spend,
# not only after it.
# ---------------------------------------------------------------------
# GAFFER_BUDGET_REMAINING used to be read only AFTER a delivery call (the budget_cap
# pause), so at $0 headroom every new ready ticket still got one paid call before it
# paused: N ready tickets, N calls past the ceiling. Proves, with the REAL tick.sh
# and a stub `claude` (no model call):
#   1. gaffer_budget_headroom_ok: unset/0/garbage budget ⇒ OFF; headroom > 0 ⇒ ok;
#      headroom 0 ⇒ halt; a budget whose headroom could not be computed ⇒ halt;
#   2. at $0 headroom a tick with TWO ready tickets spawns NO agent, claims nothing,
#      and returns no_work with a BUDGET log line — twice;
#   3. raising GAFFER_BUDGET_USD lets the next tick deliver;
#   4. the dashboard's Poll (poll-once.sh) refuses with a "not polling." line (what
#      the UI's "Poll refused" toast shows) and the daemon idles with a notice.
# Run: bash test/lifetime-budget-gate.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; RUNNER_DIR="$(cd "$HERE/.." && pwd)"; ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
for d in node git awk perl; do command -v "$d" >/dev/null 2>&1 || { echo "SKIP: $d required"; exit 0; }; done
[ -f "$ROOT/packages/dispatch/dist/cli/index.js" ] || { echo "SKIP: dispatch not built"; exit 0; }
[ -f "$ROOT/packages/memory/dist/bin/memory.js" ] || { echo "SKIP: memory not built"; exit 0; }
STUB_TICK_NAME=lifetime-budget-gate
# shellcheck source=lib/stub-tick.sh
source "$HERE/lib/stub-tick.sh"

echo "== 1. gaffer_budget_headroom_ok =="
probe() { ( GAFFER_BUDGET_USD="$1" GAFFER_BUDGET_REMAINING="$2"; gaffer_budget_headroom_ok 2>/dev/null ) && echo ok || echo halt; }
[ "$(probe '' '')" = ok ] && ok "no budget → OFF" || fail "unset budget should be OFF"
[ "$(probe 0 '')" = ok ] && ok "budget 0 → OFF" || fail "budget 0 should be OFF"
[ "$(probe 'x;1' '')" = ok ] && ok "garbage budget → OFF (never executes)" || fail "garbage budget should be OFF"
[ "$(probe 5 2.5)" = ok ] && ok "headroom 2.50 → ok" || fail "headroom > 0 should be ok"
[ "$(probe 5 0.000000)" = halt ] && ok "headroom 0 → halt" || fail "headroom 0 should halt"
[ "$(probe 5 '')" = halt ] && ok "budget set but headroom unknown → halt (fail closed)" || fail "unknown headroom should halt"

echo "== 2. \$0 headroom: no agent is spawned for new ready tickets =="
printf '{"ts":"2020-01-01T00:00:00Z","ticket":99,"kind":"delivery","measured":true,"total_cost_usd":10}\n' > "$GAFFER_DATA/usage-ledger.jsonl"
export GAFFER_BUDGET_USD=5
T1="$(new_ready "first" "deliver a helper")"; T2="$(new_ready "second" "deliver a helper")"
echo deliver > "$MODE"
R1="$(run_tick)"; R2="$(run_tick)"
NCALLS="$(ls -1 "$CALLS" | wc -l | tr -d ' ')"
[ "$R1|$R2" = "TICK_RESULT=no_work|TICK_RESULT=no_work" ] && ok "both ticks return no_work" || fail "ticks: $R1 / $R2"
[ "$NCALLS" = 0 ] && ok "no agent call was made (was: one paid call per ready ticket)" || fail "$NCALLS agent call(s) made at \$0 headroom"
[ "$(st "$T1")|$(st "$T2")" = "ready|ready" ] && ok "both tickets stay ready (nothing claimed, nothing paused)" || fail "statuses: $(st "$T1") $(st "$T2")"
grep -q "BUDGET: lifetime budget exhausted (GAFFER_BUDGET_USD=\$5" "$GAFFER_DATA/tick.stderr.log" "$GAFFER_DATA"/*.log 2>/dev/null \
  && ok "the tick logs why" || fail "no BUDGET log line"

echo "== 4. Poll for work + the daemon refuse too =="
POUT="$(cd "$RUNNER_DIR" && bash bin/poll-once.sh 2>&1)"
grep -q "^gaffer poll: lifetime budget (GAFFER_BUDGET_USD=5, headroom \$0.000000) exhausted — not polling.$" <<<"$POUT" \
  && ok "poll-once refuses with a 'not polling.' line" || fail "poll-once: $POUT"
[ "$(ls -1 "$CALLS" | wc -l | tr -d ' ')" = 0 ] && ok "the refused poll spawned nothing" || fail "poll spawned an agent"
DERR="$( ( source "$RUNNER_DIR/lib/daemon.sh"; GAFFER_LOOP_SH=/bin/false GAFFER_DAEMON_CONFIG="$RUNNER_DIR/factory.config.sh" GAFFER_DAEMON_MAX_CYCLES=1 gaffer_run_daemon 0 ) 2>&1)"
grep -q "lifetime budget (GAFFER_BUDGET_USD=5) exhausted — idle" <<<"$DERR" && grep -q "stopped (0 pass" <<<"$DERR" \
  && ok "the daemon idles with a notice (no pass run)" || fail "daemon: $DERR"

echo "== 3. raising the budget lets work continue =="
export GAFFER_BUDGET_USD=50
R3="$(run_tick)"
[ "$R3" = "TICK_RESULT=worked" ] && ok "with headroom the next tick delivers" || fail "tick after raising the budget: $R3"
[ -n "$(last_delivery)" ] && ok "one delivery agent ran" || fail "no delivery after raising the budget"

echo; [ "${#FAILURES[@]}" -eq 0 ] && echo "lifetime-budget-gate: ALL $PASS checks passed" || { echo "lifetime-budget-gate: ${#FAILURES[@]} FAILURE(S)"; exit 1; }
