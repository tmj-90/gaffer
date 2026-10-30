#!/usr/bin/env bash
# =====================================================================
# TICK DEADLINE GUARD — an attempt the outer per-tick bound would kill is not started.
# ---------------------------------------------------------------------
# GAFFER_TICK_OUTER_TIMEOUT counts agent calls only, but each delivery attempt also
# runs the DoD install + gates + AC checks (and the merge lane runs before delivery).
# A live run had its final strong-model attempt killed by the outer bound mid-flight:
# spend wasted, no TICK_RESULT, and the branch this tick created deleted by the trap.
# Real tick.sh + stub agent (lib/stub-tick.sh), GAFFER_TICK_TIMEOUT=10, a DoD test
# that takes 10s and fails differently every run, under a 35s outer bound exactly as
# loop.sh wraps a tick:
#   D1. the tick ends on its own with a TICK_RESULT (not killed: rc 124/143)
#   D2. the next attempt is handed off: branch kept, ticket released to ready and
#       skipped for the run, the handoff logged with the time it needed
#   D3. GAFFER_TICK_DEADLINE_GUARD=0 restores the old behaviour (the bound kills it)
#   D4. attempt 1 is never refused for a short budget: with GAFFER_MAX_DELIVERY_ATTEMPTS=1
#       and less time left than one agent call, the agent still runs (its call clamped
#       to the time left) and delivers
# Run: bash runner/test/tick-deadline.test.sh
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

STUB_TICK_NAME=tick-deadline
# shellcheck source=lib/stub-tick.sh
source "$HERE/lib/stub-tick.sh"

# A repo whose test gate takes 10s and fails with a different line every run (so the
# not-converging check does not park first).
RS="$WORK/slow"; mkrepo "$RS"
wg repo add -n slow --path "$RS" --branch main --stack node --test 'sleep 10; echo "fail-$RANDOM"; exit 1' --lint "node -e 0" >/dev/null 2>&1
slow_ticket() { local n; n="$(wg ticket create -t "$1" -d "deliver a helper" --risk low 2>/dev/null | jget 'd.ticket.number')"; wg ac add "$n" -t "helper added" >/dev/null 2>&1; wg ticket repo-access set "$n" slow --access write --relation confirmed >/dev/null 2>&1; wg ticket ready "$n" >/dev/null 2>&1; printf '%s' "$n"; }
bounded_tick() {  # [NAME=value] — one tick under the 35s outer bound, like loop.sh; prints rc + result
  local out rc
  out="$( cd "$RUNNER_DIR" && export GAFFER_TICK_TIMEOUT=10 GAFFER_TICK_OUTER_TIMEOUT=35 GAFFER_TICK_DEADLINE_MARGIN=5 \
          GAFFER_REAP_GRACE=3 GAFFER_DOD_INSTALL=0 && { [ -z "${1:-}" ] || export "$1"; } \
          && gaffer_timeout 35 bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" )"; rc=$?
  printf 'rc=%s %s\n' "$rc" "$(printf '%s\n' "$out" | grep '^TICK_RESULT=' | tail -1)"
}
echo deliver > "$MODE"

echo "== D1/D2. the attempt that cannot finish is handed off, not killed =="
D="$(slow_ticket "Slow gate")"
R="$(bounded_tick)"
BD="$(branch_of "$D" "$RS")"
case "$R" in "rc=0 TICK_RESULT=error") ok "D1: the tick ended on its own ($R)" ;; *) fail "D1: tick outcome '$R' (killed by the outer bound?)" ;; esac
grep -q "DEADLINE: #$D attempt [0-9]/3 needs ~[0-9]*s" "$GAFFER_DATA/factory.log" && ok "D2: the handoff is logged with the time it needed" || fail "D2: no DEADLINE handoff in the log"
[ -n "$BD" ] && [ "$(commits_on "$BD" "$RS")" -ge 1 ] && ok "D2: branch $BD kept with its commits for the next tick" || fail "D2: branch for #$D is ${BD:-missing} ($(commits_on "${BD:-x}" "$RS"))"
[ "$(st "$D")" = ready ] && ok "D2: #$D released back to ready" || fail "D2: status=$(st "$D")"
grep -qx "$D" "$GAFFER_DATA/.failed-tickets" && ok "D2: #$D is skipped for the rest of the run" || fail "D2: #$D not in the skip file"
retire "$D"

echo "== D3. GAFFER_TICK_DEADLINE_GUARD=0 keeps the old behaviour (the outer bound kills the tick) =="
rm -f "$GAFFER_DATA/.failed-tickets"
D3="$(slow_ticket "Slow gate unguarded")"
R3="$(bounded_tick GAFFER_TICK_DEADLINE_GUARD=0)"
case "$R3" in "rc=124 "*) ok "D3: with the guard off the outer bound reaped the tick ($R3)" ;; *) fail "D3: expected the outer bound to fire, got '$R3'" ;; esac
grep -qx "$D3" "$GAFFER_DATA/.failed-tickets" && ok "D3: a ticket the outer bound killed is skipped for the rest of the run (no immediate re-claim)" || fail "D3: killed ticket #$D3 not in the skip file"

retire "$D3"

echo "== D4. attempt 1 runs (clamped) even when less than one agent call is left =="
rm -f "$GAFFER_DATA/.failed-tickets"
D4="$(new_ready "Short budget first attempt" "deliver a helper")"
R4="$( cd "$RUNNER_DIR" && export GAFFER_MAX_DELIVERY_ATTEMPTS=1 GAFFER_TICK_TIMEOUT=30 GAFFER_TICK_OUTER_TIMEOUT=32 \
        GAFFER_TICK_DEADLINE_MARGIN=5 GAFFER_REAP_GRACE=3 GAFFER_DOD_INSTALL=0 \
        && gaffer_timeout 90 bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" | grep '^TICK_RESULT=' | tail -1 )"
grep -q "DEADLINE: #$D4 attempt 1 has [0-9]*s .* clamped to [0-9]*s" "$GAFFER_DATA/factory.log" && ok "D4: attempt 1 started with its agent call clamped" || fail "D4: no clamp line for #$D4 in the log"
! grep -q "DEADLINE: #$D4 attempt 1/1 needs" "$GAFFER_DATA/factory.log" && ok "D4: attempt 1 was not handed off" || fail "D4: attempt 1 was refused"
[ "$R4" = "TICK_RESULT=worked" ] && [ "$(st "$D4")" = in_review ] && ok "D4: delivered ($R4, in_review)" || fail "D4: $R4 status=$(st "$D4")"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
