#!/usr/bin/env bash
# =====================================================================
# RELEASE GATE 3, behind a FILE-SCOPED registered command (the second part of
# e2e-release-gate-tester-replay.test.sh; the same world,
# lib/release-gate-tester-replay-world.sh). An epic is accepted only when the independent
# tester's assertions passed on the revision that LANDED:
#   5  external review #7, the same steps in a repo whose registered test command is
#      FILE-SCOPED (`node --test test/label.test.mjs`): the tester's
#      test/acceptance.test.mjs was never executed by it, the landing recorded it as
#      passed and the epic counted as accepted while the assertion failed on what landed.
#      Now the replay runs the tester's file BY PATH on the candidate: the landing is held
#      (tester_replay_red, the file named), no record, the epic is not counted; after the
#      repair the file runs and passes on the landed candidate, is recorded, and the
#      second epic counts.
# Run: bash runner/test/e2e-release-gate-tester-replay-scoped.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
RG3_NAME=rg-tester-replay-scoped
# shellcheck source=lib/release-gate-tester-replay-world.sh
source "$HERE/lib/release-gate-tester-replay-world.sh"

# What wg stats counts as accepted before this epic (no epic in this world yet: 0).
ACC_BEFORE="$(accepted)"
[ "$ACC_BEFORE" = 0 ] && ok "setup: wg stats counts no accepted epic yet" || fail "setup: wg stats accepted='$ACC_BEFORE' before any epic"
echo "== 5: a FILE-SCOPED registered command (external review #7) — the tester's file must run =="
R2="$WORK/repo2"; mkdir -p "$R2/src" "$R2/test"
( cd "$R2" && git init -q -b main
  printf '{ "name": "r2", "version": "0.1.0", "private": true, "type": "module" }\n' > package.json
  printf 'export function profile() {\n  return { name: "Ada", displayName: "Ada" };\n}\n' > src/profile.js
  printf 'import { profile } from "./profile.js";\nexport function label() {\n  return profile().name;\n}\n' > src/label.js
  # The registered command runs this one file, which stays green at every step.
  printf 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { label } from "../src/label.js";\ntest("label is a function", () => { assert.equal(typeof label, "function"); });\n' > test/label.test.mjs
  gitc add -A && gitc commit -qm init )
wg repo add -n repo2 --path "$R2" --branch main --stack node --test "node --test test/label.test.mjs" >/dev/null 2>&1
printf '%s\n' '{"epic":{"name":"Profile label, file-scoped","description":"label() shows the profile name","brief":"The label shows the display name: label() returns Ada"},"tickets":[{"title":"Document the profile in repo2","description":"docs/profile.md","acceptanceCriteria":["a doc exists"],"dependsOn":[],"repo":"repo2","access":"write"}]}' > "$WORK/plan2.json"
EPIC2="$(wg epic create "$WORK/plan2.json" 2>/dev/null)"
IMPL2="$(printf '%s' "$EPIC2" | jget 'd.ticket_numbers[0]')"; ACC2="$(printf '%s' "$EPIC2" | jget 'String(d.acceptance_ticket_number)')"
[ -n "$IMPL2" ] && [ -n "$ACC2" ] && ok "5: a second epic in repo2: implementation #$IMPL2 + acceptance #$ACC2" || fail "5: epic create: $EPIC2"
wg ticket repo-access set "$IMPL2" repo2 --access write --relation confirmed >/dev/null 2>&1
wg ticket repo-access set "$ACC2" repo2 --access write --relation confirmed >/dev/null 2>&1
wg ticket ready "$IMPL2" >/dev/null 2>&1; wg ticket ready "$ACC2" >/dev/null 2>&1
AUTO_MERGE=0 run_tick >/dev/null
approve "$IMPL2"
rm -f "$GAFFER_DATA/.merge-held-tickets"
GAFFER_MODE=autonomous AUTO_MERGE=1 run_tick >/dev/null
[ "$(st "$IMPL2")" = "done" ] && ok "5: #$IMPL2 landed" || fail "5: #$IMPL2 status=$(st "$IMPL2")"
[ "$(st "$ACC2")" = in_testing ] || AUTO_MERGE=0 run_tick >/dev/null
BR2="$(branch_of "$ACC2")"
grep -q 'profile().displayName;' <<<"$(git -C "$R2" show "refs/heads/$BR2:src/label.js" 2>/dev/null)" && ok "5: the acceptance delivery reads displayName" || fail "5: acceptance #$ACC2 status=$(st "$ACC2") label: $(git -C "$R2" show "refs/heads/$BR2:src/label.js" 2>/dev/null | tr '\n' ' ')"
AUTO_MERGE=0 run_tick >/dev/null
approve "$ACC2"
[ "$(st "$ACC2")" = ready_for_merge ] && ok "5: the tester's PASS, then the approval of the tested commit → ready_for_merge" || fail "5: acceptance after the tester: $(st "$ACC2")"
git -C "$R2" show "gaffer-tests/ticket-$ACC2:test/acceptance.test.mjs" >/dev/null 2>&1 && ok "5: the tester saved test/acceptance.test.mjs" || fail "5: no test/acceptance.test.mjs on gaffer-tests/ticket-$ACC2"
sed -i.bak 's/, displayName: "Ada"//' "$R2/src/profile.js" && rm -f "$R2/src/profile.js.bak"
gitc -C "$R2" commit -qam "refactor: drop the unused displayName"
MAIN2="$(git -C "$R2" rev-parse main)"; TREE2="$(git -C "$R2" rev-parse 'main^{tree}')"
C2="$WORK/cand2"; git -C "$R2" worktree add -q --detach "$C2" main >/dev/null 2>&1
gitc -C "$C2" merge -q --no-edit "$(git -C "$R2" rev-parse "refs/heads/$BR2")" >/dev/null 2>&1
( cd "$C2" && node --test test/label.test.mjs >/dev/null 2>&1 ) && ok "5: the registered file-scoped command passes on the merge candidate" || fail "5: fixture: the registered command is red on the candidate"
git -C "$C2" checkout -q "gaffer-tests/ticket-$ACC2" -- test/acceptance.test.mjs
( cd "$C2" && node --test test/acceptance.test.mjs >/dev/null 2>&1 ) && fail "5: fixture: the tester's file passes on the candidate" || ok "5: running test/acceptance.test.mjs on the candidate fails (undefined !== 'Ada')"
git -C "$R2" worktree remove --force "$C2" >/dev/null 2>&1
rm -f "$GAFFER_DATA/.merge-held-tickets"
GAFFER_MODE=autonomous AUTO_MERGE=1 run_tick >/dev/null
[ "$(git -C "$R2" rev-parse main)" = "$MAIN2" ] && [ "$(git -C "$R2" rev-parse 'main^{tree}')" = "$TREE2" ] && ok "5: repo2's main untouched (head and tree)" || fail "5: the broken combination landed: $(git -C "$R2" log --oneline -2 main | tr '\n' '|')"
HOLD2="$(node -e '
  const { Dispatch } = await import(process.argv[1]);
  const d = Dispatch.open(process.argv[2]);
  const i = d.humanQueue().items.find((x) => x.ticket && x.ticket.number === Number(process.argv[3]));
  process.stdout.write(i ? `${i.reasonCode}|${i.reason}` : "none");' --input-type=module "$ROOT/packages/dispatch/dist/core.js" "$DISPATCH_DB" "$ACC2" 2>/dev/null || echo none)"
case "$HOLD2" in "tester_replay_red|"*"test/acceptance.test.mjs"*) ok "5: held for a human (tester_replay_red) naming test/acceptance.test.mjs" ;; *) fail "5: acceptance #$ACC2 status=$(st "$ACC2") queue item: ${HOLD2:0:300}" ;; esac
grep -q "MERGE: #$ACC2 TESTER REPLAY — running the tester's 1 test file(s) (test/acceptance.test.mjs) on the merge candidate .* (node-test, by path)" "$LOGF" && ok "5: the tester's file ran by path, not through the file-scoped command" || fail "5: no by-path replay line for #$ACC2"
[ -z "$(replay_rec "$ACC2")" ] && ok "5: no replay record names the file" || fail "5: a replay was recorded: $(replay_rec "$ACC2")"
[ "$(accepted)" = "$ACC_BEFORE" ] && ok "5: wg stats: the epic is NOT counted as accepted (still $ACC_BEFORE)" || fail "5: wg stats accepted=$(accepted) (was $ACC_BEFORE): the epic counted on a file that never ran on what landed"
wg ticket move "$ACC2" ready >/dev/null 2>&1
AUTO_MERGE=0 run_tick >/dev/null
REP2="$(git -C "$R2" rev-parse "refs/heads/$BR2")"
AUTO_MERGE=0 run_tick >/dev/null
approve "$ACC2"
rm -f "$GAFFER_DATA/.merge-held-tickets"
GAFFER_MODE=autonomous AUTO_MERGE=1 run_tick >/dev/null
[ "$(st "$ACC2")" = "done" ] && git -C "$R2" merge-base --is-ancestor "$REP2" main && ok "5: the repaired candidate landed (done)" || fail "5: acceptance #$ACC2 status=$(st "$ACC2") $(grep "#$ACC2" "$LOGF" | tail -3 | tr '\n' '|' | cut -c1-500)"
REC2="$(replay_rec "$ACC2")"
[ "${REC2%% *}" = "$(git -C "$R2" rev-parse main)" ] && case "$REC2" in *'["test/acceptance.test.mjs"]'*) true ;; *) false ;; esac \
  && ok "5: the record names the landed sha and test/acceptance.test.mjs, which ran and passed there" || fail "5: record '$REC2' vs main $(git -C "$R2" rev-parse main)"
# TEST IDENTITIES (external review 10): the registered command is file-scoped, so the
# tester lane's clean replay also ran the tester's file appended to it and bound the
# tests that passed there; the record proves every one.
EVID2="$(wg ticket show "$ACC2" | jget '((d.evidence || []).filter(e => e.recorded_by_actor_type === "system" && (e.uri || "").startsWith("gaffer-tester-replayed:")).map(e => { const p = JSON.parse(e.payload_json || "{}"); return p.evidence + " " + (p.tests || []).length; }).join(""))' 2>/dev/null)"
case "$EVID2" in "identities "[1-9]*) ok "5: the record proves the test identities the PASS bound ($EVID2)" ;; *) fail "5: record evidence '$EVID2'" ;; esac
[ "$(accepted)" = "$((ACC_BEFORE + 1))" ] && ok "5: wg stats: the epic is accepted ($((ACC_BEFORE + 1)))" || fail "5: wg stats accepted=$(accepted) (was $ACC_BEFORE)"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "e2e-release-gate-tester-replay-scoped: ALL $PASS checks passed"; exit 0; fi
echo "e2e-release-gate-tester-replay-scoped: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1
