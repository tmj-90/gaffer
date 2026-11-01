#!/usr/bin/env bash
# =====================================================================
# A delivery launch the budget admission refuses is NOT an attempt (review of
# exploratory finding fresh-user/F-09).
# ---------------------------------------------------------------------
# worker_deliver asks lib/budget-admission.mjs right before every paid launch and,
# refused, returns 77 with no agent spawned. tick.sh read that as an agent that
# "exited non-zero with no commits": a no-commit failure, and at the limit a park to
# blocked, for a ticket nobody worked on. Since every paid launch now needs a dollar
# cap, a hand-run live tick with no cap hit it at once (the suite hid it: run.sh
# exports GAFFER_ALLOW_UNCAPPED=1). Driven through the REAL tick.sh, stub agent:
#   B1. no dollar cap: TICK_RESULT=no_work, no agent ran, the ticket is still ready,
#       attempt_count 0, the no-commit counter untouched, no branch left
#   B2. a daily cap already spent: the same (whether the tick's own cap gate or the
#       launch admission is the one that refuses)
# Run: bash runner/test/budget-refused-delivery.test.sh
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

STUB_TICK_NAME=budget-refused-delivery
# shellcheck source=lib/stub-tick.sh
source "$HERE/lib/stub-tick.sh"
sqlv() { node -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1], { readOnly: true }); const r = db.prepare(process.argv[2]).get(Number(process.argv[3])); process.stdout.write(String(r ? Object.values(r)[0] : ""));' "$DISPATCH_DB" "$1" "$2" 2>/dev/null; }
deliveries() { grep -lx delivery "$CALLS"/*/kind 2>/dev/null | wc -l | tr -d ' '; }
# With ONE allowed attempt and ONE allowed no-commit failure, a counted failure parks at once.
export GAFFER_MAX_DELIVERY_ATTEMPTS=1 GAFFER_MAX_NOCOMMIT_FAILURES=1
unset GAFFER_ALLOW_UNCAPPED GAFFER_DAILY_BUDGET_USD GAFFER_BUDGET_USD

check() {  # check <label> <ticket> <tick result>
  local L="$1" T="$2" R="$3"
  [ "$R" = "TICK_RESULT=no_work" ] && ok "$L: the tick reports no_work (nothing spent)" || fail "$L: $R"
  [ "$(deliveries)" = 0 ] && ok "$L: no agent ran" || fail "$L: $(deliveries) delivery call(s)"
  [ "$(st "$T")" = ready ] && ok "$L: #$T is still ready (not parked)" || fail "$L: #$T is $(st "$T")"
  [ "$(sqlv 'select attempt_count from tickets where number=?' "$T")" = 0 ] && ok "$L: attempt_count is 0" \
    || fail "$L: attempt_count=$(sqlv 'select attempt_count from tickets where number=?' "$T")"
  [ ! -e "$GAFFER_DATA/.nocommit-failures/$T" ] && ok "$L: the no-commit counter was not touched" || fail "$L: nocommit=$(cat "$GAFFER_DATA/.nocommit-failures/$T")"
  [ -z "$(branch_of "$T")" ] && ok "$L: no branch left behind" || fail "$L: branch $(branch_of "$T") left"
  [ "${4:-}" = launch ] || return 0
  grep -q "BUDGET: #$T — the paid delivery launch was refused" "$GAFFER_DATA/factory.log" && ok "$L: the log says why" || fail "$L: no BUDGET line in factory.log"
}

echo "== B1. no dollar cap: the refused launch is not an attempt =="
T="$(new_ready "Add helper uncapped" "add a helper")"
check B1 "$T" "$(run_tick)" launch
wg ticket cancel "$T" >/dev/null 2>&1 || true

echo "== B2. a daily cap already spent: the same =="
rm -f "$GAFFER_DATA/.failed-tickets"
T="$(new_ready "Add helper capped" "add a helper")"
printf '{"ts":"%s","kind":"delivery","total_cost_usd":9}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$GAFFER_DATA/usage-ledger.jsonl"
export GAFFER_DAILY_BUDGET_USD=1
check B2 "$T" "$(run_tick)"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
