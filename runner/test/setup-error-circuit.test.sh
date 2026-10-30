#!/usr/bin/env bash
# =====================================================================
# SETUP-ERROR CIRCUIT — a systemic setup fault stops the run, it does not churn.
# ---------------------------------------------------------------------
# A fail-closed setup check (here: the MCP template is unreadable, so the MCP render
# refuses) used to `exit 1` as a plain error: the crash trap released the claim as
# "runner killed mid-delivery" (nothing was killed), the next tick re-claimed the same
# ticket, and one broken install burned MAX_TICKS_PER_DAY on claim/teardown churn.
# Driven through the REAL loop.sh + tick.sh (lib/stub-tick.sh):
#   C1. loop.sh with MAX_TICKS=4 and two ready tickets → ONE claim, TICK_RESULT
#       setup_error, the run stops (exit 3), the day count is unchanged (no agent ran),
#       the release reason names MCP-RENDER (not "runner killed"), the cause is in
#       $GAFFER_DATA/.setup-error, and no agent was spawned
#   C2. a RESUMED delivery that hits the setup error goes back to `paused`
#   C3. lib/daemon.sh backs off exponentially on loop exit 3 and resets on recovery
# Run: bash runner/test/setup-error-circuit.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
command -v perl >/dev/null 2>&1 || { echo "SKIP: perl required (timeout primitive)"; exit 0; }
for f in packages/dispatch/dist/cli/index.js packages/memory/dist/bin/memory.js packages/crew/dist/cli/index.js; do
  [ -f "$ROOT/$f" ] || { echo "SKIP: $f not built (run pnpm -r build)"; exit 0; }
done

STUB_TICK_NAME=setup-error-circuit
# shellcheck source=lib/stub-tick.sh
source "$HERE/lib/stub-tick.sh"

echo "== C1. a systemic setup error under loop.sh: one claim, the run stops =="
echo deliver > "$MODE"
C1="$(new_ready "Setup error one" "deliver a helper")"
C1B="$(new_ready "Setup error two" "deliver a helper")"
DAY0="$(gaffer_day_count)"
OUT="$( cd "$RUNNER_DIR" && MCP_CONFIG="$WORK/nonexistent/.mcp.json" MAX_TICKS=4 EMPTY_POLL_LIMIT=2 TICK_SLEEP=0 bash ./loop.sh 2>/dev/null )"; LRC=$?
CLAIMS="$(grep -c "claimed #[0-9]* for delivery" "$GAFFER_DATA/factory.log")"
[ "$CLAIMS" = 1 ] && ok "C1: exactly one claim in the whole run (was one per tick)" || fail "C1: $CLAIMS claims: $(printf '%s\n' "$OUT" | grep '^tick ' | tr '\n' '|')"
printf '%s\n' "$OUT" | grep -q '^tick 1/4 → setup_error$' && ok "C1: the tick reports setup_error" || fail "C1: tick lines: $(printf '%s\n' "$OUT" | grep '^tick ' | tr '\n' '|')"
! printf '%s\n' "$OUT" | grep -q '^tick 2/4' && ok "C1: no second tick ran" || fail "C1: the run kept ticking"
printf '%s\n' "$OUT" | grep -q 'setup error — MCP-RENDER' && ok "C1: loop.sh names the cause" || fail "C1: no setup-error line in the loop output"
[ "$LRC" = 3 ] && ok "C1: loop.sh exits 3 (setup error)" || fail "C1: loop.sh exit $LRC"
[ "$(gaffer_day_count)" = "$DAY0" ] && ok "C1: the day count is unchanged (no agent ran)" || fail "C1: day count $DAY0 → $(gaffer_day_count)"
grep -q "→ ready (setup error: MCP-RENDER" "$GAFFER_DATA/factory.log" && ok "C1: the claim was released with the real reason" || fail "C1: release reason: $(grep '→ ready' "$GAFFER_DATA/factory.log" | tail -1 | cut -c1-200)"
! grep -q "runner killed" "$GAFFER_DATA/factory.log" && ok "C1: no fake 'runner killed' reason" || fail "C1: log still blames a kill"
cut -f2 "$GAFFER_DATA/.setup-error" 2>/dev/null | grep -qx MCP-RENDER && ok "C1: \$GAFFER_DATA/.setup-error records the cause" || fail "C1: marker: $(cat "$GAFFER_DATA/.setup-error" 2>/dev/null)"
[ -z "$(last_delivery)" ] && ok "C1: no agent was spawned" || fail "C1: an agent ran"
[ "$(st "$C1")" = ready ] && [ "$(st "$C1B")" = ready ] && ok "C1: both tickets are back in ready" || fail "C1: statuses $(st "$C1") / $(st "$C1B")"
retire "$C1"; retire "$C1B"

echo "== C2. a resumed delivery that hits the setup error goes back to paused =="
rm -f "$GAFFER_DATA/.failed-tickets"
echo edit-nocommit-cap > "$MODE"
C2="$(new_ready "Resume setup error" "deliver a helper")"
run_tick >/dev/null
[ "$(st "$C2")" = paused ] && ok "C2: #$C2 paused at the cap" || fail "C2: status=$(st "$C2")"
wg ticket continue "$C2" >/dev/null 2>&1; rm -f "$GAFFER_DATA/.failed-tickets"
OUT2="$(MCP_CONFIG="$WORK/nonexistent/.mcp.json" run_tick)"
[ "$OUT2" = "TICK_RESULT=setup_error" ] && ok "C2: the resumed tick reports setup_error" || fail "C2: result '$OUT2'"
[ "$(st "$C2")" = paused ] && ok "C2: the resume is back to paused (not stranded in_progress)" || fail "C2: status=$(st "$C2")"

echo "== C3. the daemon backs off on setup errors and resets once a pass gets through =="
STUBLOOP="$WORK/stub-loop.sh"; COUNTER="$WORK/loop-passes"
cat > "$STUBLOOP" <<STUBL
#!/usr/bin/env bash
n=\$(( \$(cat "$COUNTER" 2>/dev/null || echo 0) + 1 )); echo "\$n" > "$COUNTER"
[ "\$n" -le 3 ] && exit 3
exit 0
STUBL
# shellcheck source=../lib/daemon.sh
source "$RUNNER_DIR/lib/daemon.sh"
DOUT="$( (GAFFER_LOOP_SH="$STUBLOOP" GAFFER_DAEMON_MAX_CYCLES=5 GAFFER_DAEMON_SETUP_BACKOFF_MAX=3 MAX_TICKS_PER_DAY=0 gaffer_run_daemon 1) 2>&1 )"
WAITS="$(printf '%s\n' "$DOUT" | sed -n 's/.*next pass in \([0-9]*\)s$/\1/p' | tr '\n' ' ')"
[ "$WAITS" = "1 2 3 " ] && ok "C3: waits double per consecutive setup-error pass and stop at the ceiling (1s 2s 3s)" || fail "C3: back-off waits '$WAITS' :: $(printf '%s\n' "$DOUT" | tr '\n' '|' | cut -c1-300)"
[ "$(cat "$COUNTER")" = 5 ] && ok "C3: a pass that gets through resets the back-off (5 passes ran)" || fail "C3: passes=$(cat "$COUNTER")"
printf '%s\n' "$DOUT" | grep -q 'setup error (.*MCP-RENDER' && ok "C3: the daemon names the setup error" || fail "C3: daemon output lacks the cause"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
