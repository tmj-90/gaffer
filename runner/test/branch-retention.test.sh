#!/usr/bin/env bash
# =====================================================================
# BRANCH RETENTION — a branch this tick did not create is never deleted.
# ---------------------------------------------------------------------
# Driven through the REAL tick.sh with a stub agent (lib/stub-tick.sh):
#   F. pre-spawn budget gate on a REWORKED ticket → parked blocked, reviewed commits kept
#   G. SIGTERM while a rework agent works → ticket back to ready, reviewed branch kept
#      (and the crash-trap release reason says it was a signal)
#   H. multi-repo: repo A reuses its reviewed branch, repo B cannot be worktree'd → the
#      setup rollback keeps A's branch
#   I. a DoD payload that cannot be parsed on a FRESH delivery → branch kept (the log
#      says PRESERVED and the EXIT trap no longer deletes it)
# Run: bash runner/test/branch-retention.test.sh
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

STUB_TICK_NAME=branch-retention
# shellcheck source=lib/stub-tick.sh
source "$HERE/lib/stub-tick.sh"

echo "== F. pre-spawn budget gate on a REWORKED ticket keeps the reviewed branch =="
F="$(reworked_ticket "Budget rework")"; BF="$(branch_of "$F")"
[ "$(st "$F")" = "ready" ] && [ "$(commits_on "$BF")" -ge 1 ] && ok "F: #$F reworked (ready) with $(commits_on "$BF") reviewed commit(s) on $BF" || fail "F: fixture: status=$(st "$F") commits=$(commits_on "$BF")"
OUTF="$(GAFFER_REWORK_BUDGET_USD=0.01 run_tick)"
[ "$(st "$F")" = "blocked" ] && ok "F: the budget gate parked #$F to blocked" || fail "F: status=$(st "$F") ($OUTF)"
[ "$(commits_on "$BF")" != "BRANCH-GONE" ] && [ "$(commits_on "$BF")" -ge 1 ] && ok "F: reviewed branch $BF SURVIVED the park ($(commits_on "$BF") commit(s))" || fail "F: reviewed branch $BF is $(commits_on "$BF") after the budget park"
grep -q "branch $BF KEPT in repo" "$GAFFER_DATA/factory.log" && ok "F: runner logged that the pre-existing branch was kept" || fail "F: no 'KEPT' log line"

echo "== G. SIGTERM during a rework keeps the reviewed branch =="
G="$(reworked_ticket "Kill rework")"; BG="$(branch_of "$G")"; NG="$(commits_on "$BG")"
echo hang > "$MODE"
( cd "$RUNNER_DIR" && exec perl -e 'setpgrp(0, 0); exec @ARGV' bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" >"$WORK/kill.out" ) &
TP=$!
wait_hanging && ok "G: the rework agent is running" || fail "G: the stub agent never started"
kill -TERM -- "-$TP"; wait "$TP"; GRC=$?
rm -f "$CALLS"/*/hanging
[ "$GRC" = 143 ] && ok "G: tick exited 143 on TERM" || fail "G: tick exit $GRC"
[ "$(st "$G")" = "ready" ] && ok "G: #$G released back to ready" || fail "G: status=$(st "$G")"
[ "$(commits_on "$BG")" = "$NG" ] && ok "G: reviewed branch $BG survived the kill ($NG commit(s))" || fail "G: $BG is $(commits_on "$BG") (had $NG)"
grep -q "released claim on #$G → ready (runner killed mid-delivery (signal)" "$GAFFER_DATA/factory.log" && ok "G: the crash-trap release says it was a signal" || fail "G: release reason: $(grep "#$G → ready" "$GAFFER_DATA/factory.log" | tail -1 | cut -c1-200)"
retire "$G"; echo deliver > "$MODE"

echo "== H. multi-repo setup rollback keeps repo A's reviewed branch =="
RB="$WORK/repo-b"; mkrepo "$RB"
wg repo add -n repob --path "$RB" --branch main --stack node --test "npm test" --lint "npm run lint" >/dev/null 2>&1
H="$(wg ticket create -t "Two repo rework" -d "deliver a helper" --risk low 2>/dev/null | jget 'd.ticket.number')"
wg ac add "$H" -t "helper added" >/dev/null 2>&1
wg ticket repo-access set "$H" repo --access write --relation confirmed >/dev/null 2>&1
wg ticket repo-access set "$H" repob --access write --relation confirmed >/dev/null 2>&1
ticket_slug() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' | tr -s '-' | sed -E 's/^-+//; s/-+$//' | cut -d- -f1-6 | cut -c1-50 | sed -E 's/-+$//'; }  # mirrors tick.sh gaffer_ticket_slug
BH="gaffer/ticket-$H-$(ticket_slug "Two repo rework")"
git -C "$R" branch "$BH" main >/dev/null 2>&1
git -C "$R" worktree add -q "$WORK/wt-h" "$BH" >/dev/null 2>&1
printf 'export const reviewed = 1;\n' > "$WORK/wt-h/src/reviewed.js"
git -C "$WORK/wt-h" -c user.email=t@t -c user.name=t add -A >/dev/null 2>&1
git -C "$WORK/wt-h" -c user.email=t@t -c user.name=t commit -qm "deliver #$H: reviewed work" >/dev/null 2>&1
git -C "$R" worktree remove --force "$WORK/wt-h" >/dev/null 2>&1
wg ticket ready "$H" >/dev/null 2>&1
mv "$RB/.git" "$RB/.git-off"   # repo B is no longer a git repo on disk → WT_FAILED
run_tick >/dev/null
mv "$RB/.git-off" "$RB/.git"
grep -q "a write repo could not be worktree'd" "$GAFFER_DATA/factory.log" && ok "H: repo B could not be worktree'd (rollback ran)" || fail "H: the WT_FAILED rollback did not run"
[ "$(commits_on "$BH")" = 1 ] && ok "H: repo A's reviewed branch $BH survived the multi-repo rollback" || fail "H: $BH is $(commits_on "$BH") after the rollback"
retire "$H"

echo "== I. an unparseable DoD payload on a FRESH delivery keeps the branch =="
mkdir -p "$WORK/shim"
REAL_NODE="$(command -v node)"
cat > "$WORK/shim/node" <<SHIM
#!/usr/bin/env bash
case " \$* " in *"json-tool.mjs dod-cmd-map"*) cat >/dev/null; exit 3 ;; esac
exec "$REAL_NODE" "\$@"
SHIM
chmod +x "$WORK/shim/node"
echo deliver > "$MODE"
I="$(new_ready "Dod parse fail" "deliver a helper")"
( PATH="$WORK/shim:$PATH" run_tick >/dev/null )
BI="$(branch_of "$I")"
grep -q "delivery FAILED for #$I — DoD gate commands unresolvable; parked, removed worktree, branch .* PRESERVED" "$GAFFER_DATA/factory.log" && ok "I: the DoD config-fail path ran (logs PRESERVED)" || fail "I: the DoD parse-fail path did not run"
[ -n "$BI" ] && [ "$(commits_on "$BI")" -ge 1 ] && ok "I: the branch the log calls PRESERVED really is ($BI, $(commits_on "$BI") commit(s))" || fail "I: branch for #$I is gone after the DoD parse-fail park"

retire "$I"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
