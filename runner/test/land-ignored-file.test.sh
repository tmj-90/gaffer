#!/usr/bin/env bash
# =====================================================================
# External review #9, finding 5: landing never overwrites a file the operator ignores.
# ---------------------------------------------------------------------
# An approved branch began tracking `settings.local`, which the operator ignores in
# their checkout and keeps a private copy of; landing silently replaced that copy (git's
# merge/checkout default overwrites ignored files). Both checkout-updating landing paths
# now refuse: the dashboard/`gaffer merge` path (bin/merge-ticket.mjs) and the shell path
# (lib/land.sh via the merge lane), each with --no-overwrite-ignore and a check by name
# first, and the ticket is HELD for a human naming the file. Driven through the REAL
# tick.sh, dispatch and merge-ticket.mjs with a stub agent (lib/stub-tick.sh):
#   I1. merge-ticket.mjs: refused, operator copy kept, main unmoved, ticket blocked
#       (ignored_file_in_the_way) with settings.local in the reason
#   I2. the merge lane (lib/land.sh): the same
# Run: bash runner/test/land-ignored-file.test.sh
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

STUB_TICK_NAME=land-ignored-file
# shellcheck source=lib/stub-tick.sh
source "$HERE/lib/stub-tick.sh"

# The operator ignores settings.local locally and keeps their own copy in the checkout.
printf 'settings.local\n' >> "$R/.git/info/exclude"
printf 'OPERATOR COPY\n' > "$R/settings.local"

heads() { wg ticket diff "$1" --heads 2>/dev/null | sed 's/^/--commit /' | tr '\n' ' '; }
hold_reason() {
  node -e '
const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1], { readOnly: true });
const r = db.prepare("SELECT json_extract(e.payload_json, ?) AS reason, json_extract(e.payload_json, ?) AS code FROM work_events e JOIN tickets t ON t.id = e.entity_id WHERE t.number = ? AND e.event_type = ? ORDER BY e.rowid DESC LIMIT 1").get("$.reason", "$.reason_code", Number(process.argv[2]), "ticket.blocked");
process.stdout.write(r ? `${r.code}\t${r.reason}` : "");' "$DISPATCH_DB" "$1" 2>/dev/null
}
deliver_approved() {
  local t; t="$(new_ready "$1" "track the local settings")"
  echo track-ignored > "$MODE"; run_tick >/dev/null
  wg review approve "$t" $(heads "$t") --reviewer human1 >/dev/null 2>&1
  printf '%s' "$t"
}
check_refused() {  # <label> <ticket>
  local L="$1" T="$2" HR
  [ "$(cat "$R/settings.local")" = "OPERATOR COPY" ] && ok "$L: the operator's ignored copy is preserved" || fail "$L: settings.local now reads '$(cat "$R/settings.local")'"
  [ "$(git -C "$R" rev-parse main)" = "$MAIN0" ] && ok "$L: main did not move" || fail "$L: main moved"
  [ "$(st "$T")" = "blocked" ] && ok "$L: #$T is held for a human (blocked)" || fail "$L: #$T is $(st "$T")"
  HR="$(hold_reason "$T")"
  case "$HR" in ignored_file_in_the_way*settings.local*) ok "$L: the hold names the file (ignored_file_in_the_way)" ;; *) fail "$L: hold reason '$HR'" ;; esac
}

echo "== I1. bin/merge-ticket.mjs (Merge now / gaffer merge) =="
T1="$(deliver_approved "Track settings A")"
[ "$(st "$T1")" = "ready_for_merge" ] && ok "I1: #$T1 approved (ready_for_merge)" || fail "I1: #$T1 is $(st "$T1") after approve"
MAIN0="$(git -C "$R" rev-parse main)"
node "$RUNNER_DIR/bin/merge-ticket.mjs" --ticket "$T1" >"$WORK/m1.json" 2>"$WORK/m1.err"; RC=$?
[ "$RC" != 0 ] && ok "I1: merge-ticket refused (exit $RC)" || fail "I1: merge-ticket exited 0: $(tail -3 "$WORK/m1.err")"
check_refused I1 "$T1"
grep -q "settings.local" "$WORK/m1.err" && ok "I1: the refusal names the file" || fail "I1: refusal: $(tail -3 "$WORK/m1.err" | tr '\n' '|')"
retire "$T1"

echo "== I2. the merge lane (lib/land.sh) =="
T2="$(deliver_approved "Track settings B")"
[ "$(st "$T2")" = "ready_for_merge" ] && ok "I2: #$T2 approved (ready_for_merge)" || fail "I2: #$T2 is $(st "$T2") after approve"
MAIN0="$(git -C "$R" rev-parse main)"
echo deliver > "$MODE"; AUTO_MERGE=1 run_tick >/dev/null
check_refused I2 "$T2"
grep -q "#$T2 HELD for a human — landing would overwrite a file you ignore locally.*settings.local" "$GAFFER_DATA/factory.log" \
  && ok "I2: the lane logs the hold naming the file" || fail "I2: no hold line in the factory log: $(grep "#$T2" "$GAFFER_DATA/factory.log" | tail -3 | tr '\n' '|')"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS: $PASS checks"; exit 0; fi
echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"; exit 1
