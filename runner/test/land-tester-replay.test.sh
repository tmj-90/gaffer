#!/usr/bin/env bash
# =====================================================================
# TESTER REPLAY ON THE LANDING CANDIDATE — every landing path runs the independent
# tester's saved assertions on the exact merge it is about to land.
# ---------------------------------------------------------------------
# External review #4: the tester's assertions described the build it TESTED. After the
# default branch moved, the merge candidate passed the repository's own suite (the merge
# gate) yet failed the tester's saved assertion — the file lived only on
# gaffer-tests/ticket-<n> — and the ticket landed anyway. Now, once the repo's own gates
# pass on the merge, the gate checks the tester's test files (only those it added or
# changed; never its .claude/ wiring) out into the scratch merge and runs the repo's test
# command there too; a failure holds the landing like a red gate.
#
# Real dispatch + tick.sh + lib/land.sh + bin/merge-ticket.mjs, a stub claude, a fixture
# repo whose suite stays GREEN throughout (only the tester's assertion catches the break):
#   A  the MERGE LANE holds the ticket (blocked, tester_replay_red, the file named, the
#      failing output as evidence); main untouched (head and tree);
#   (B-D, Merge now and both PR-mode landings: land-tester-replay-merge-now.test.sh)
#   E  a bound tester PASS with no tests on record lands (nothing extra runs); a passing
#      replay lands; a ticket outside the testing lane lands with nothing replayed.
#   R  the landing RECORDS which tester assertions passed on which landed revision
#      (gaffer-tester-replayed:<sha>, system): the gated merge on main and the files that
#      ran there; nothing for a held replay or a ticket outside the testing lane.
#   F  the replay runs the tests the PASS BOUND (tester-run's tests commit), not the branch:
#      a tests branch rewritten after the PASS (an always-passing assertion swapped in) is
#      ignored and the bound, failing assertion still holds the landing;
#   (G-K, what the record and the proof name — the landed revision on PR landings and
#   only tester files proven to have run: land-tester-replay-proof.test.sh)
# Run: bash runner/test/land-tester-replay.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
# shellcheck source=lib/land-replay-world.sh
source "$HERE/lib/land-replay-world.sh"

echo "== setup: five deliveries, each green on its own =="
NT=($(new_tickets \
  "Label by display name [read-displayName]${TAB}label() reads profile().displayName" \
  "Note five [note-5]${TAB}a note" \
  "Note six [note-6]${TAB}a note" \
  "Note seven [note-7]${TAB}a note${TAB}plain" \
  "Label by display name, tampered [read-displayName]${TAB}label() reads profile().displayName"))
T1="${NT[0]:-}" T5="${NT[1]:-}" T6="${NT[2]:-}" T7="${NT[3]:-}" T9="${NT[4]:-}"
ALL_T="$T1 $T5 $T6 $T7 $T9"
for _ in $ALL_T; do AUTO_MERGE=0 run_tick >/dev/null; done
# TESTER FIRST: a testable delivery goes to the tester before review; an ordinary one
# (T7) waits in review.
all_lane=1; for n in $ALL_T; do want=in_testing; [ "$n" = "$T7" ] && want=in_review; [ "$(st "$n")" = "$want" ] || all_lane=0; done
[ "$all_lane" = 1 ] && ok "all five delivered through their DoD gates (testable ones sent to the tester, the plain one in review)" || fail "statuses: $(for n in $ALL_T; do printf '#%s=%s ' "$n" "$(st "$n")"; done)"
approve "$T7"
[ "$(st "$T7")" = ready_for_merge ] && ok "an ordinary approval goes to ready_for_merge" || fail "after approve: T7=$(st "$T7")"
tester_pass "$T1" "$LABEL_TEST"; tester_pass "$T5"; tester_pass "$T6" "$NAME_TEST"
[ "$(st "$T1")" = in_review ] && [ "$(st "$T5")" = in_review ] && [ "$(st "$T6")" = in_review ] && ok "the tester's bound PASS → back in review" || fail "after tester: T1=$(st "$T1") T5=$(st "$T5") T6=$(st "$T6")"
for n in "$T1" "$T5" "$T6"; do approve "$n"; done
[ "$(st "$T1")" = ready_for_merge ] && [ "$(st "$T5")" = ready_for_merge ] && [ "$(st "$T6")" = ready_for_merge ] && ok "a person approves each tested commit → ready_for_merge" || fail "after approve: T1=$(st "$T1") T5=$(st "$T5") T6=$(st "$T6")"
main_tests "$(branch_of "$T1")" && ok "the delivery branch passes the smoke suite" || fail "fixture: T1 branch red"
( wt="$WORK/tc"; git -C "$R" worktree add -q --detach "$wt" "gaffer-tests/ticket-$T1" >/dev/null 2>&1; cd "$wt" && npm test >/dev/null 2>&1 ); rc=$?; git -C "$R" worktree remove --force "$WORK/tc" >/dev/null 2>&1
[ "$rc" -eq 0 ] && ok "the tester's assertion passes on the delivery branch (tested commit)" || fail "fixture: the tester's assertion fails on the tested commit"

echo "== main moves: displayName removed — a clean merge, the smoke suite stays green =="
move_main

echo "== A: the merge lane replays the tester's assertion on the candidate and holds =="
GAFFER_MODE=autonomous AUTO_MERGE=1 run_tick >/dev/null
[ "$(st "$T1")" = "blocked" ] && ok "A: #$T1 held for a human (blocked), not done" || fail "A: #$T1 status=$(st "$T1") $(grep "#$T1" "$LOGF" | tail -3 | tr '\n' '|' | cut -c1-500)"
B1="$(git -C "$R" rev-parse "refs/heads/$(branch_of "$T1")")"
if git -C "$R" merge-base --is-ancestor "$B1" main; then fail "A: main contains #$T1 — the broken combination landed"; else ok "A: main does not contain #$T1"; fi
grep -q 'profile().name;' <<<"$(git -C "$R" show main:src/label.js 2>/dev/null)" && ok "A: main's label still reads name" || fail "A: main's label changed"
H1="$(hold_of "$T1")"
case "$H1" in *tester_replay_red*) case "$H1" in *test/bb-label.test.js*) ok "A: the hold is tester_replay_red and names the tester's file" ;; *) fail "A: the hold does not name the file: ${H1:0:400}" ;; esac ;; *) fail "A: hold payload: ${H1:0:400}" ;; esac
case "$H1" in *settings.json*|*CLAUDE.factory.md*) fail "A: the tester's wiring was replayed as a test" ;; *) ok "A: only the tester's test file is replayed (its .claude/ wiring is not)" ;; esac
EV1="$(replay_ev "$T1")"
case "$EV1" in *"TESTER REPLAY FAILED"*"DoD: FAIL"*) ok "A: the failing replay output is attached as evidence" ;; *) fail "A: no replay evidence: ${EV1:0:300}" ;; esac
grep -q "MERGE: #$T1 TESTER REPLAY — running the tester's 1 test file(s) (test/bb-label.test.js)" "$LOGF" && ok "A: the lane logged the replay on the merge candidate" || fail "A: no replay log line"
grep -q "MERGE: #$T1 MERGE GATE PASS" "$LOGF" && ok "A: the repo's own gates PASSED on the candidate (only the tester's assertion catches it)" || fail "A: the merge gate did not pass first"

echo "== E: what else the lane landed in that tick =="
[ "$(st "$T5")" = "done" ] && ok "E: a bound PASS with no tests on record lands (nothing extra runs)" || fail "E: #$T5 status=$(st "$T5")"
grep -q "MERGE: #$T5 TESTER REPLAY — no tester test files to replay" "$LOGF" && ok "E: …logged as nothing to replay" || fail "E: no no-tests line for #$T5"
[ "$(st "$T6")" = "done" ] && ok "E: a tester assertion that passes on the candidate lands" || fail "E: #$T6 status=$(st "$T6")"
grep -q "MERGE: #$T6 TESTER REPLAY PASS" "$LOGF" && ok "E: …after the replay passed" || fail "E: no replay PASS line for #$T6"
[ "$(st "$T7")" = "done" ] && grep -q "MERGE: #$T7 TESTER REPLAY — nothing to replay" "$LOGF" && ok "E: a ticket outside the testing lane lands, nothing replayed" || fail "E: #$T7 status=$(st "$T7")"
git -C "$R" show "main:test/bb-label.test.js" >/dev/null 2>&1 && fail "E: a tester's file landed on main" || ok "E: the tester's files ran on the candidate but never landed"
main_tests && ok "E: main is green" || fail "E: main red"
R5="$(replay_rec "$T5")"; R6="$(replay_rec "$T6")"
P6="$(wg ticket show "$T6" | jget '((d.landing && d.landing.repos) || [])[0].sha')"
S6="${R6%% *}"
[ -n "$S6" ] && [ "$(git -C "$R" rev-parse "$S6^2" 2>/dev/null)" = "$P6" ] && git -C "$R" merge-base --is-ancestor "$S6" main \
  && ok "E: #$T6's replay record names the landed revision (the gated merge of its tested commit, on main)" || fail "E: #$T6 record: '$R6' (pin $P6)"
case "$R6" in *'["test/bb-label.test.js"]'*) ok "E: …and the tester test file that passed there" ;; *) fail "E: #$T6 record files: $R6" ;; esac
case "$R5" in *' []') ok "E: a bound PASS with no tests on record still records its landed revision (no files)" ;; *) fail "E: #$T5 record: '$R5'" ;; esac
[ -z "$(replay_rec "$T7")" ] && ok "E: a ticket outside the testing lane has no replay record" || fail "E: #$T7 has a replay record"
[ -z "$(replay_rec "$T1")" ] && ok "A: a held replay records nothing" || fail "A: #$T1 has a replay record"
MAIN1="$(git -C "$R" rev-parse main)"; TREE1="$(tree_of main)"
git -C "$R" push -q origin main 2>/dev/null

echo "== F: a tests branch rewritten after the PASS cannot stand in for the bound assertion =="
tester_pass "$T9" "$LABEL_TEST"; approve "$T9"
BOUND9="$(git -C "$R" rev-parse "gaffer-tests/ticket-$T9")"
# Another process with the repository (any agent's worktree shares its refs) swaps in an
# assertion that always passes, on a commit that descends from the tested commit.
( wt="$WORK/tamper"; git -C "$R" worktree add -q --detach "$wt" "$(git -C "$R" rev-parse "refs/heads/$(branch_of "$T9")")" >/dev/null 2>&1
  mkdir -p "$wt/test"; printf 'import test from "node:test";\ntest("vacuous", () => {});\n' > "$wt/test/bb-label.test.js"
  gitc -C "$wt" add -A; gitc -C "$wt" commit -qm "tests"; git -C "$R" branch -f "gaffer-tests/ticket-$T9" "$(git -C "$wt" rev-parse HEAD)"
  git -C "$R" worktree remove --force "$wt" >/dev/null 2>&1 )
[ "$(git -C "$R" rev-parse "gaffer-tests/ticket-$T9")" != "$BOUND9" ] && ok "F: the tests branch now holds a vacuous assertion" || fail "F: fixture: the tests branch was not rewritten"
MAIN_F="$(git -C "$R" rev-parse main)"
GAFFER_MODE=autonomous AUTO_MERGE=1 run_tick >/dev/null
[ "$(st "$T9")" = "blocked" ] && case "$(hold_of "$T9")" in *tester_replay_red*) true ;; *) false ;; esac && ok "F: the bound (failing) assertion still ran on the candidate: held, tester_replay_red" || fail "F: #$T9 status=$(st "$T9") $(grep "#$T9" "$LOGF" | tail -3 | tr '\n' '|' | cut -c1-500)"
[ "$(git -C "$R" rev-parse main)" = "$MAIN_F" ] && ok "F: main untouched" || fail "F: main moved (the vacuous replay let it land)"
[ -z "$(replay_rec "$T9")" ] && ok "F: no replay record" || fail "F: #$T9 has a replay record: $(replay_rec "$T9")"
git -C "$R" push -q origin main 2>/dev/null

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "land-tester-replay: ALL $PASS checks passed"; exit 0; fi
echo "land-tester-replay: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1

