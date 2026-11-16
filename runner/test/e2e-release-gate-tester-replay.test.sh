#!/usr/bin/env bash
# =====================================================================
# RELEASE GATE 3 — an epic is accepted only when the independent tester's assertions
# passed on the revision that LANDED.
# ---------------------------------------------------------------------
# Operator promise: "accepted" means the tester's assertions hold on what reached main —
# not on the build the tester happened to test.
#
# The counterexample (external review 4, the reviewer's fixture): the decisive assertion
# lives only in the independent tester's own test file (gaffer-tests/ticket-<n>), and the
# repository's registered smoke suite stays GREEN at every step — otherwise the existing
# merge gate catches the break and this test proves the wrong thing.
#   1  a profile exposes both `name` and `displayName`; the acceptance delivery changes the
#      label to read `displayName`; the tester adds an assertion that the label returns
#      "Ada" — it passes on the delivery branch;
#   2  main advances with a commit removing `displayName`; git merges it cleanly; the smoke
#      suite still passes, but the tester's saved assertion now gets undefined;
#   3  the landing must run that assertion on the EXACT merge candidate, fail, leave main
#      untouched (head and tree), hold the ticket and keep the epic out of `wg stats`'
#      accepted count — the old runner landed the combination and counted the epic;
#   (TESTER FIRST: each acceptance delivery goes to the tester before review; its PASS
#   returns it to review and the person approves the tested commit.)
#   4  a repair commit on the delivery branch (re-delivered, re-tested, re-approved with --commit,
#      re-tested) lands; the assertion passes on the landed candidate, the replay record
#      names that landed sha, and the epic counts as accepted exactly once.
#   (5, the same steps behind a FILE-SCOPED registered command:
#   e2e-release-gate-tester-replay-scoped.test.sh, on its own copy of the world)
# Real dispatch + tick.sh (merge lane, live tester lane bin/tester-run.mjs --live), a stub
# claude, a fixture repo.
# Run: bash runner/test/e2e-release-gate-tester-replay.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
# shellcheck source=lib/release-gate-tester-replay-world.sh
source "$HERE/lib/release-gate-tester-replay-world.sh"

echo "== 1: an epic; the acceptance delivery reads displayName; the tester's assertion passes =="
printf '%s\n' '{"epic":{"name":"Profile label","description":"label() shows the profile name","brief":"The label shows the display name: label() returns Ada"},"tickets":[{"title":"Document the profile","description":"docs/profile.md","acceptanceCriteria":["a doc exists"],"dependsOn":[],"repo":"repo","access":"write"}]}' > "$WORK/plan.json"
suite_on main && ok "the starting main passes the registered smoke suite" || fail "fixture: the starting main is red"
EPIC="$(wg epic create "$WORK/plan.json" 2>/dev/null)"
IMPL="$(printf '%s' "$EPIC" | jget 'd.ticket_numbers[0]')"; ACC="$(printf '%s' "$EPIC" | jget 'String(d.acceptance_ticket_number)')"
[ -n "$IMPL" ] && [ -n "$ACC" ] && [ "$IMPL" != "$ACC" ] && ok "epic created: implementation #$IMPL + acceptance #$ACC" || fail "epic create: $EPIC"
wg ticket repo-access set "$IMPL" repo --access write --relation confirmed >/dev/null 2>&1
wg ticket repo-access set "$ACC" repo --access write --relation confirmed >/dev/null 2>&1
wg ticket ready "$IMPL" >/dev/null 2>&1; wg ticket ready "$ACC" >/dev/null 2>&1
AUTO_MERGE=0 run_tick >/dev/null
approve "$IMPL"
GAFFER_MODE=autonomous AUTO_MERGE=1 run_tick >/dev/null
[ "$(st "$IMPL")" = "done" ] && ok "#$IMPL delivered, approved and landed" || fail "#$IMPL status=$(st "$IMPL")"
[ "$(st "$ACC")" = in_testing ] || AUTO_MERGE=0 run_tick >/dev/null
[ "$(st "$ACC")" = in_testing ] && ok "acceptance #$ACC delivered through its gates and sent to the tester before review" || fail "acceptance status=$(st "$ACC") $(grep "#$ACC" "$LOGF" | tail -3 | tr '\n' '|' | cut -c1-400)"
BR="$(branch_of "$ACC")"
grep -q 'profile().displayName;' <<<"$(git -C "$R" show "refs/heads/$BR:src/label.js" 2>/dev/null)" && ok "the delivery changes the label to read displayName" || fail "fixture: the delivery's label: $(git -C "$R" show "refs/heads/$BR:src/label.js" 2>/dev/null | tr '\n' ' ')"
suite_on "refs/heads/$BR" && ok "the delivery branch passes the registered smoke suite" || fail "fixture: the delivery branch is red"
approve "$ACC"
[ "$(st "$ACC")" = in_testing ] && ok "an approval before the tester's PASS is refused (still in_testing)" || fail "acceptance after an early approve: $(st "$ACC")"
AUTO_MERGE=0 run_tick >/dev/null
[ "$(st "$ACC")" = in_review ] && ok "the independent tester's PASS → back in review" || fail "acceptance after the tester: $(st "$ACC") $(grep -i 'tester' "$LOGF" | tail -3 | tr '\n' '|' | cut -c1-400)"
approve "$ACC"
[ "$(st "$ACC")" = ready_for_merge ] && ok "a person approves the tested commit → ready_for_merge" || fail "acceptance after approve: $(st "$ACC")"
TESTED1="$(git -C "$R" rev-parse "refs/heads/$BR")"
git -C "$R" show "gaffer-tests/ticket-$ACC:test/bb-label.test.js" >/dev/null 2>&1 && ok "the tester's assertion is saved on gaffer-tests/ticket-$ACC" || fail "no tester test on gaffer-tests/ticket-$ACC"
git -C "$R" show "refs/heads/$BR:test/bb-label.test.js" >/dev/null 2>&1 && fail "fixture: the tester's assertion is on the delivery branch" || ok "…and only there (never on the delivery branch)"
with_tester_on "$BR" && ok "the tester's assertion passes on the delivery branch" || fail "fixture: the tester's assertion fails on the delivery branch"
[ "$(bound_tests "$ACC")" = "$(git -C "$R" rev-parse "gaffer-tests/ticket-$ACC")" ] && ok "the tester's PASS is bound to the commit holding its tests" || fail "PASS tests_commit '$(bound_tests "$ACC")' vs gaffer-tests/ticket-$ACC"
[ "$(accepted)" = "0" ] && ok "wg stats before any landing: accepted 0" || fail "wg stats accepted=$(accepted) before the landing"

echo "== 2: main moves — displayName removed, a clean merge, the smoke suite still green =="
sed -i.bak 's/, displayName: "Ada"//' "$R/src/profile.js" && rm -f "$R/src/profile.js.bak"
gitc -C "$R" commit -qam "refactor: drop the unused displayName"
MAIN0="$(git -C "$R" rev-parse main)"; TREE0="$(tree_of main)"
suite_on main && ok "main passes the registered smoke suite" || fail "fixture: main is red"
CAND="$WORK/cand"; git -C "$R" worktree add -q --detach "$CAND" main >/dev/null 2>&1
if gitc -C "$CAND" merge -q --no-edit "$TESTED1" >/dev/null 2>&1; then ok "git merges the delivery onto the moved main cleanly"; else fail "fixture: the merge conflicts"; fi
( cd "$CAND" && npm test >/dev/null 2>&1 ) && ok "the merge candidate passes the repository's own suite (the merge gate alone would land it)" || fail "fixture: the repo suite catches the break (wrong proof)"
git -C "$CAND" checkout -q "gaffer-tests/ticket-$ACC" -- test/bb-label.test.js
( cd "$CAND" && npm test >/dev/null 2>&1 ) && fail "fixture: the tester's assertion passes on the merge candidate" || ok "the tester's saved assertion FAILS on the merge candidate"
git -C "$R" worktree remove --force "$CAND" >/dev/null 2>&1

echo "== 3: the landing replays the assertion on the exact candidate — held, main untouched, not accepted =="
GAFFER_MODE=autonomous AUTO_MERGE=1 run_tick >/dev/null
[ "$(git -C "$R" rev-parse main)" = "$MAIN0" ] && ok "main's head is untouched" || fail "main moved: the broken combination landed ($(git -C "$R" log --oneline -3 main | tr '\n' '|'))"
[ "$(tree_of main)" = "$TREE0" ] && ok "main's tree is untouched" || fail "main's tree changed"
grep -q 'profile().name;' <<<"$(git -C "$R" show main:src/label.js 2>/dev/null)" && ok "main's label still reads name (the delivery did not land)" || fail "main's label: $(git -C "$R" show main:src/label.js | tr '\n' ' ')"
[ "$(st "$ACC")" = "blocked" ] && ok "acceptance #$ACC held for a human (blocked), not done" || fail "acceptance status=$(st "$ACC")"
HOLD="$(node -e '
  const { Dispatch } = await import(process.argv[1]);
  const d = Dispatch.open(process.argv[2]);
  const i = d.humanQueue().items.find((x) => x.ticket && x.ticket.number === Number(process.argv[3]));
  process.stdout.write(i ? `${i.reasonCode}|${i.reason}` : "none");' --input-type=module "$ROOT/packages/dispatch/dist/core.js" "$DISPATCH_DB" "$ACC" 2>/dev/null || echo none)"
case "$HOLD" in "tester_replay_red|"*"test/bb-label.test.js"*) ok "the human queue names the hold (tester_replay_red) and the tester's file" ;; *) fail "human queue item: ${HOLD:0:300}" ;; esac
EV="$(wg ticket show "$ACC" | jget '(d.evidence || []).filter(e => (e.summary || "").startsWith("TESTER REPLAY FAILED")).map(e => e.summary).join("\n")' 2>/dev/null)"
case "$EV" in *"TESTER REPLAY FAILED"*"DoD: FAIL"*) ok "the failing replay output is attached as evidence" ;; *) fail "no tester-replay evidence: ${EV:0:300}" ;; esac
grep -q "MERGE: #$ACC MERGE GATE PASS" "$LOGF" && ok "the repository's own gates passed on the candidate first" || fail "no merge-gate pass line for #$ACC"
[ "$(accepted)" = "0" ] && ok "wg stats: the epic is NOT counted as accepted" || fail "wg stats accepted=$(accepted) (the epic counted on a build whose assertion fails on main)"
[ -z "$(replay_rec "$ACC")" ] && ok "no tester-replay record for a held landing" || fail "a held landing recorded a replay: $(replay_rec "$ACC")"
suite_on main && ok "main is still green" || fail "main is red"

echo "== 4: repair on the delivery branch, re-approve with --commit, re-test, land — accepted once =="
wg ticket move "$ACC" ready >/dev/null 2>&1
AUTO_MERGE=0 run_tick >/dev/null
[ "$(st "$ACC")" = in_testing ] && ok "the repair was re-delivered on the branch and sent to the tester" || fail "after the repair delivery: $(st "$ACC") $(grep "#$ACC" "$LOGF" | tail -3 | tr '\n' '|' | cut -c1-400)"
REPAIRED="$(git -C "$R" rev-parse "refs/heads/$BR")"
[ "$REPAIRED" != "$TESTED1" ] && git -C "$R" merge-base --is-ancestor "$TESTED1" "$REPAIRED" && ok "the repair is a new commit on the same delivery branch" || fail "the delivery branch did not gain a repair commit"
suite_on "$REPAIRED" && ok "the repaired branch passes the registered smoke suite" || fail "fixture: the repaired branch is red"
[ "$(accepted)" = "0" ] && ok "wg stats while the repair is in flight: accepted 0" || fail "wg stats accepted=$(accepted) before the repair landed"
AUTO_MERGE=0 run_tick >/dev/null
[ "$(st "$ACC")" = in_review ] && ok "the tester re-tested the repair: PASS (back in review)" || fail "after re-test: $(st "$ACC")"
approve "$ACC"
[ "$(st "$ACC")" = ready_for_merge ] && ok "re-approved with --commit $(printf '%s' "$REPAIRED" | cut -c1-12) (the tested commit) → ready_for_merge" || fail "re-approve: $(st "$ACC")"
# A new run: loop.sh clears the per-run list of tickets the merge lane held this run.
rm -f "$GAFFER_DATA/.merge-held-tickets"
GAFFER_MODE=autonomous AUTO_MERGE=1 run_tick >/dev/null
[ "$(st "$ACC")" = "done" ] && ok "the repaired candidate landed (done)" || fail "acceptance status=$(st "$ACC") $(grep "#$ACC" "$LOGF" | tail -3 | tr '\n' '|' | cut -c1-500)"
git -C "$R" merge-base --is-ancestor "$REPAIRED" main && ok "main contains the repair" || fail "main lacks the repair"
grep -q "MERGE: #$ACC TESTER REPLAY PASS" "$LOGF" && ok "the tester's assertion ran and passed on the landed candidate" || fail "no replay PASS line"
LANDED="$(git -C "$R" rev-parse main)"
REC="$(replay_rec "$ACC")"
[ "${REC%% *}" = "$LANDED" ] && ok "the replay record names the landed sha (${LANDED:0:12})" || fail "replay record '$REC' vs main $LANDED"
case "$REC" in *'["test/bb-label.test.js"]'*) ok "…and the tester assertion that passed there" ;; *) fail "record files: $REC" ;; esac
git -C "$R" show main:test/bb-label.test.js >/dev/null 2>&1 && fail "the tester's file landed on main" || ok "the tester's file ran on the candidate but did not land"
suite_on main && ok "the landed main passes the registered smoke suite" || fail "the landed main is red"
with_tester_on main && ok "main passes the tester's assertion" || fail "main fails the tester's assertion"
[ "$(accepted)" = "1" ] && ok "wg stats: the epic is accepted" || fail "wg stats accepted=$(accepted) result=$(epic_field result)"
[ "$(epic_field replayed_commit)" = "$LANDED" ] && ok "wg stats names the same landed revision as the record" || fail "stats replayed_commit=$(epic_field replayed_commit)"
STATUS_OUT="$(bash "$RUNNER_DIR/status.sh" 2>/dev/null)"
case "$STATUS_OUT" in *"tester assertions passed on the landed revision ${LANDED:0:12}: test/bb-label.test.js"*) ok "gaffer status reads the same record" ;; *) fail "gaffer status: $(printf '%s' "$STATUS_OUT" | grep -i 'acceptance #' | head -2)" ;; esac
AUTO_MERGE=0 run_tick >/dev/null; GAFFER_MODE=autonomous AUTO_MERGE=1 run_tick >/dev/null
[ "$(accepted)" = "1" ] && [ "$(wg stats --json | jget 'String(d.acceptance.epics.length)')" = "1" ] && ok "counted exactly once (still 1 accepted, one epic row, after more ticks)" || fail "accepted=$(accepted) after more ticks"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "e2e-release-gate-tester-replay: ALL $PASS checks passed"; exit 0; fi
echo "e2e-release-gate-tester-replay: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1
