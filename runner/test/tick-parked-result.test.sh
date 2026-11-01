#!/usr/bin/env bash
# =====================================================================
# A clean park reads as a park, not an error (exploratory finding cli-runner/F-20).
# ---------------------------------------------------------------------
# A delivery whose Definition-of-Done failed on its last allowed attempt was parked
# (blocked, branch kept, the reason recorded) exactly as designed, yet the tick
# reported TICK_RESULT=error and the run printed "tick 1/1 → error". Driven through
# the REAL tick.sh / loop.sh with a stub agent (lib/stub-tick.sh):
#   K1. a DoD failure at GAFFER_MAX_DELIVERY_ATTEMPTS=1 parks the ticket (blocked)
#   K2. the tick reports TICK_RESULT=parked: loop.sh prints "tick 1/1 → parked #N —
#       held for a human" (the park is named by the result, not only by a
#       "delivery PARKED" log line)
# Run: bash runner/test/tick-parked-result.test.sh
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
STUB_TICK_NAME=tick-parked
# shellcheck source=lib/stub-tick.sh
source "$HERE/lib/stub-tick.sh"
has() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }
printf '#!/usr/bin/env bash\nprintf "{}\\n"\n' > "$WORK/noop.sh"; chmod +x "$WORK/noop.sh"

echo "== K1. a DoD failure on the last attempt parks, and the run says parked =="
echo break-test > "$MODE"
T1="$(new_ready "Break helper" "change helper a")"
OUT="$( ( cd "$RUNNER_DIR" && GAFFER_MAX_DELIVERY_ATTEMPTS=1 MAX_TICKS=1 TICK_SLEEP=0 EMPTY_POLL_LIMIT=1 GAFFER_ALLOW_UNCAPPED=1 \
  LOOP_STATS_CMD="$WORK/noop.sh" LOOP_HQ_CMD="$WORK/noop.sh" LOOP_NOTIFY_EMIT_CMD="$WORK/noop.sh" bash ./loop.sh 2>&1 ) )"
[ "$(st "$T1")" = blocked ] && ok "K1: #$T1 was parked (blocked)" || fail "K1: #$T1 is $(st "$T1")"
has "$OUT" "tick 1/1 → parked #$T1 — held for a human" && ok "K2: loop.sh prints 'tick 1/1 → parked #$T1 — held for a human'" || fail "K2: $(printf '%s' "$OUT" | grep '^tick')"
retire "$T1"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
