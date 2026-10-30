#!/usr/bin/env bash
# =====================================================================
# AN UNREADABLE settings.json REFUSES PAID WORK — the real tick.sh and Poll.
# ---------------------------------------------------------------------
# A settings.json that exists but does not parse (a hand edit, a truncated copy) used
# to apply nothing, so every cap it held fell to its default (MAX_TICKS_PER_DAY 50,
# the USD caps OFF). factory.config.sh now keeps the inherited values and sets
# _GAFFER_SETTINGS_UNREADABLE; settings-resource.test.sh covers the loop, the pool and
# the daemon. Proves, with the REAL tick.sh and a stub `claude` (no model call):
#   1. a tick under an unreadable settings.json spawns NO agent, claims nothing, and
#      returns setup_error with a SETUP log line naming the file;
#   2. the dashboard's Poll (poll-once.sh) refuses with a "not polling." line;
#   3. once the file parses again the next tick delivers.
# Run: bash test/settings-unreadable-gate.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; RUNNER_DIR="$(cd "$HERE/.." && pwd)"; ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
for d in node git awk perl; do command -v "$d" >/dev/null 2>&1 || { echo "SKIP: $d required"; exit 0; }; done
[ -f "$ROOT/packages/dispatch/dist/cli/index.js" ] || { echo "SKIP: dispatch not built"; exit 0; }
[ -f "$ROOT/packages/memory/dist/bin/memory.js" ] || { echo "SKIP: memory not built"; exit 0; }
STUB_TICK_NAME=settings-unreadable-gate
# shellcheck source=lib/stub-tick.sh
source "$HERE/lib/stub-tick.sh"

T1="$(new_ready "first" "deliver a helper")"
echo deliver > "$MODE"

echo "== 1. the real tick refuses under a malformed settings.json =="
printf '{"MAX_TICKS_PER_DAY":"2","GAFFER_DAILY_BUDGET_US' > "$GAFFER_DATA/settings.json"
R1="$(run_tick)"
NCALLS="$(ls -1 "$CALLS" | wc -l | tr -d ' ')"
[ "$R1" = "TICK_RESULT=setup_error" ] && ok "the tick returns setup_error" || fail "tick: $R1"
[ "$NCALLS" = 0 ] && ok "no agent call was made" || fail "$NCALLS agent call(s) made under an unreadable settings.json"
[ "$(st "$T1")" = ready ] && ok "the ticket stays ready (nothing claimed)" || fail "status: $(st "$T1")"
grep -q "SETUP: settings.json ($GAFFER_DATA/settings.json) exists but cannot be parsed" "$GAFFER_DATA/tick.stderr.log" "$GAFFER_DATA"/*.log 2>/dev/null \
  && ok "the tick logs why" || fail "no SETUP log line naming settings.json"
grep -q 'settings.json' "$GAFFER_DATA/.setup-error" 2>/dev/null && ok "the setup error is recorded for status / the daemon" || fail "no .setup-error"

echo "== 2. Poll for work refuses too =="
POUT="$(cd "$RUNNER_DIR" && bash bin/poll-once.sh 2>&1)"
grep -q "^gaffer poll: settings.json ($GAFFER_DATA/settings.json) cannot be read — not polling.$" <<<"$POUT" \
  && ok "poll-once refuses with a 'not polling.' line" || fail "poll-once: $POUT"
[ "$(ls -1 "$CALLS" | wc -l | tr -d ' ')" = 0 ] && ok "the refused poll spawned nothing" || fail "poll spawned an agent"

echo "== 3. a fixed settings.json lets work continue =="
printf '{"MAX_TICKS_PER_DAY":"5"}\n' > "$GAFFER_DATA/settings.json"
R2="$(run_tick)"
[ "$R2" = "TICK_RESULT=worked" ] && ok "once the file parses the next tick delivers" || fail "tick after the fix: $R2"
[ -n "$(last_delivery)" ] && ok "one delivery agent ran" || fail "no delivery after the fix"

echo; [ "${#FAILURES[@]}" -eq 0 ] && echo "settings-unreadable-gate: ALL $PASS checks passed" || { echo "settings-unreadable-gate: ${#FAILURES[@]} FAILURE(S)"; exit 1; }
