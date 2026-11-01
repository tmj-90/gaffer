#!/usr/bin/env bash
# =====================================================================
# An auth failure DURING a delivery is not an attempt (exploratory finding
# fresh-user/F-06; the pre-run gate is auth-gate.test.sh).
# ---------------------------------------------------------------------
# A credential that is visible but rejected fails the delivery call with "Invalid API
# key · Please run /login". That used to count a no-commit failure and, a few runs
# later, park a good ticket. Driven through the REAL tick.sh / loop.sh with a stub agent
# (lib/stub-tick.sh) printing that error envelope:
#   G4. TICK_RESULT=auth_error, the ticket goes back to ready, attempt_count and the
#       no-commit counter untouched, at a one-failure limit (a counted failure would park)
#   G5. loop.sh stops the run on that result (exit 3) with the /login hint; after this
#       second failure the ticket is still ready with nothing counted
#   G6. the dashboard's Poll for work says so on its refusal line ("gaffer poll:
#       aborting — claude could not authenticate …"), so the run is not a quiet success
# Run: bash runner/test/auth-gate-delivery.test.sh
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
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX ANTHROPIC_BASE_URL GAFFER_CLAUDE_AUTH_PROBE GAFFER_CLAUDE_AUTH_CHECKED

STUB_TICK_NAME=auth-gate-delivery
# shellcheck source=lib/stub-tick.sh
source "$HERE/lib/stub-tick.sh"
has() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }
sqlv() { node -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1], { readOnly: true }); const r = db.prepare(process.argv[2]).get(Number(process.argv[3])); process.stdout.write(String(r ? Object.values(r)[0] : ""));' "$DISPATCH_DB" "$1" "$2" 2>/dev/null; }
printf '#!/usr/bin/env bash\nprintf "{}\\n"\n' > "$WORK/noop.sh"; chmod +x "$WORK/noop.sh"

echo "== G4. an auth failure during a delivery is not an attempt =="
echo auth-error > "$MODE"
T="$(new_ready "Add helper auth" "add a helper")"
# With ONE allowed attempt and ONE allowed no-commit failure, a counted failure would
# park the ticket at once; this auth failure (and G5's, a second run) must leave it ready.
export GAFFER_MAX_DELIVERY_ATTEMPTS=1 GAFFER_MAX_NOCOMMIT_FAILURES=1
R1="$(run_tick)"
[ "$R1" = "TICK_RESULT=auth_error" ] && ok "G4: the tick reports auth_error" || fail "G4: $R1"
[ "$(st "$T")" = ready ] && ok "G4: at a one-failure limit #$T is still ready (not parked)" || fail "G4: #$T is $(st "$T")"
[ "$(sqlv 'select attempt_count from tickets where number=?' "$T")" = 0 ] && ok "G4: attempt_count is 0" || fail "G4: attempt_count=$(sqlv 'select attempt_count from tickets where number=?' "$T")"
[ ! -e "$GAFFER_DATA/.nocommit-failures/$T" ] && ok "G4: the no-commit counter was not touched" || fail "G4: nocommit=$(cat "$GAFFER_DATA/.nocommit-failures/$T")"
grep -q 'claude is not logged in' "$GAFFER_DATA/factory.log" && ok "G4: the log names the cause" || fail "G4: no auth line in factory.log"
[ -z "$(branch_of "$T")" ] && ok "G4: no empty branch left behind" || fail "G4: branch $(branch_of "$T") left"

echo "== G5. loop.sh stops the run on an auth failure =="
rm -f "$GAFFER_DATA/.failed-tickets"
out="$( ( cd "$RUNNER_DIR" && GAFFER_ALLOW_UNCAPPED=1 MAX_TICKS=3 TICK_SLEEP=0 EMPTY_POLL_LIMIT=3 \
  LOOP_STATS_CMD="$WORK/noop.sh" LOOP_HQ_CMD="$WORK/noop.sh" LOOP_NOTIFY_EMIT_CMD="$WORK/noop.sh" bash ./loop.sh 2>&1 ) )"; rc=$?
[ "$rc" = 3 ] && ok "G5: loop.sh exits 3" || fail "G5: rc=$rc"
has "$out" "done after 1 tick(s)" && ok "G5: the run stopped after the first auth failure" || fail "G5: $(printf '%s' "$out" | grep -E '^tick|done after' | tr '\n' ' ')"
has "$out" 'claude /login' && ok "G5: the run says to log in" || fail "G5: $out"
[ "$(st "$T")" = ready ] && [ "$(sqlv 'select attempt_count from tickets where number=?' "$T")" = 0 ] && [ ! -e "$GAFFER_DATA/.nocommit-failures/$T" ] \
  && ok "G5: after a second auth failure #$T is still ready, no attempt or no-commit failure counted" || fail "G5: #$T is $(st "$T")"
echo "== G6. the dashboard's Poll says the call could not authenticate =="
out="$( ( cd "$RUNNER_DIR" && GAFFER_ALLOW_UNCAPPED=1 bash ./bin/poll-once.sh 2>&1 ) )"
has "$out" "TICK_RESULT=auth_error" && ok "G6: the poll's tick reports auth_error" || fail "G6: $(printf '%s' "$out" | grep TICK_RESULT)"
grep -qE '^gaffer poll: aborting\b.*claude could not authenticate' <<<"$out" \
  && ok "G6: the refusal line the dashboard toasts names the cause" || fail "G6: no 'gaffer poll: aborting' line: $(printf '%s' "$out" | grep 'gaffer poll' | tr '\n' ' ')"
[ "$(st "$T")" = ready ] && [ "$(sqlv 'select attempt_count from tickets where number=?' "$T")" = 0 ] \
  && ok "G6: #$T is still ready with no attempt counted" || fail "G6: #$T is $(st "$T")"
retire "$T"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
