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
#   B  the dashboard's Merge now (bin/merge-ticket.mjs) holds the same way (exit 4);
#   C  PR mode (lib/land.sh): the gate on the FETCHED remote default replays the tester's
#      tests; a red replay never asks GitHub to merge;
#   D  PR mode (bin/merge-ticket.mjs): the same, with a gh stub that would merge;
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

echo "== setup: nine deliveries, each green on its own =="
T1="$(new_ticket "Label by display name [read-displayName]" "label() reads profile().displayName")"
T2="$(new_ticket "Label by display name again [read-displayName]" "label() reads profile().displayName")"
T3="$(new_ticket "Label by display name, PR [read-displayName]" "label() reads profile().displayName")"
T4="$(new_ticket "Label by display name, PR now [read-displayName]" "label() reads profile().displayName")"
T5="$(new_ticket "Note five [note-5]" "a note")"
T6="$(new_ticket "Note six [note-6]" "a note")"
T7="$(new_ticket "Note seven [note-7]" "a note" plain)"
T8="$(new_ticket "Note eight [note-8]" "a note")"
T9="$(new_ticket "Label by display name, tampered [read-displayName]" "label() reads profile().displayName")"
ALL_T="$T1 $T2 $T3 $T4 $T5 $T6 $T7 $T8 $T9"
for _ in $ALL_T; do AUTO_MERGE=0 run_tick >/dev/null; done
all_review=1; for n in $ALL_T; do [ "$(st "$n")" = in_review ] || all_review=0; done
[ "$all_review" = 1 ] && ok "all nine delivered through their DoD gates (in_review)" || fail "statuses: $(for n in $ALL_T; do printf '#%s=%s ' "$n" "$(st "$n")"; done)"
for n in "$T1" "$T5" "$T6"; do approve "$n"; done
approve "$T7"
[ "$(st "$T1")" = in_testing ] && [ "$(st "$T7")" = ready_for_merge ] && ok "a testable approval goes to the tester (in_testing); an ordinary one to ready_for_merge" || fail "after approve: T1=$(st "$T1") T7=$(st "$T7")"
tester_pass "$T1" "$LABEL_TEST"; tester_pass "$T5"; tester_pass "$T6" "$NAME_TEST"
[ "$(st "$T1")" = ready_for_merge ] && [ "$(st "$T5")" = ready_for_merge ] && [ "$(st "$T6")" = ready_for_merge ] && ok "the tester's bound PASS → ready_for_merge" || fail "after tester: T1=$(st "$T1") T5=$(st "$T5") T6=$(st "$T6")"
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

echo "== B: Merge now (bin/merge-ticket.mjs) replays and holds the same way =="
approve "$T2"; tester_pass "$T2" "$LABEL_TEST"
merge_now "$T2"; rc=$?
[ "$rc" -eq 4 ] && ok "B: Merge now refuses #$T2 (exit 4)" || fail "B: rc=$rc $(tail -c 400 "$WORK/mn.out")"
grep -q "TESTER REPLAY FAILED" "$WORK/mn.out" && grep -q "test/bb-label.test.js" "$WORK/mn.out" && ok "B: …saying the tester's replay failed, naming the file" || fail "B: output: $(tail -c 400 "$WORK/mn.out")"
[ "$(git -C "$R" rev-parse main)" = "$MAIN1" ] && [ "$(tree_of main)" = "$TREE1" ] && ok "B: main untouched (head and tree)" || fail "B: main moved"
[ "$(st "$T2")" = "blocked" ] && case "$(hold_of "$T2")" in *tester_replay_red*) true ;; *) false ;; esac && ok "B: #$T2 held (blocked, tester_replay_red)" || fail "B: #$T2 status=$(st "$T2") hold=$(hold_of "$T2" | cut -c1-200)"
[ -z "$(replay_rec "$T2")" ] && ok "B: a held replay records nothing" || fail "B: #$T2 has a replay record"
approve "$T8"; tester_pass "$T8" "$NAME_TEST"
merge_now "$T8"; rc=$?
[ "$rc" -eq 0 ] && [ "$(st "$T8")" = "done" ] && ok "B: Merge now lands #$T8 once the tester's assertion passes on the candidate" || fail "B: #$T8 rc=$rc status=$(st "$T8") $(tail -c 300 "$WORK/mn.out")"
R8="$(replay_rec "$T8")"; S8="${R8%% *}"
[ -n "$S8" ] && [ "$S8" = "$(git -C "$R" rev-parse main)" ] && case "$R8" in *'["test/bb-label.test.js"]'*) true ;; *) false ;; esac \
  && ok "B: Merge now's replay record names the landed revision (main) and the tester's file" || fail "B: #$T8 record: '$R8' main=$(git -C "$R" rev-parse main)"
MAIN1="$(git -C "$R" rev-parse main)"; TREE1="$(tree_of main)"; git -C "$R" push -q origin main 2>/dev/null

echo "== C: PR mode (lib/land.sh) gates the fetched remote default and never asks GitHub =="
approve "$T3"; tester_pass "$T3" "$LABEL_TEST"
(
  # shellcheck source=../lib/land.sh
  source "$RUNNER_DIR/lib/land.sh"
  log() { printf '%s\n' "$*" >> "$LOGF"; }
  gaffer_pr_merge() { printf 'pr_merge %s\n' "$*" >> "$WORK/pr-calls"; return 0; }
  SHOW="$(wg ticket show "$T3" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const d=JSON.parse(s);d.ticket.pr_url="https://github.com/o/r/pull/3";process.stdout.write(JSON.stringify(d))})')"
  _gaffer_land_one "$T3" "$R" "$(branch_of "$T3")" main "$SHOW" MERGE "" 0
  echo "rc=$?" > "$WORK/c.rc"
) >/dev/null 2>&1
grep -q '^rc=4$' "$WORK/c.rc" 2>/dev/null && ok "C: PR-mode landing held (rc 4)" || fail "C: $(cat "$WORK/c.rc" 2>/dev/null)"
[ -s "$WORK/pr-calls" ] && fail "C: gh pr merge was asked to merge a red replay" || ok "C: the PR merge was never asked for"
grep -q "MERGE: #$T3 TESTER REPLAY — running the tester's 1 test file(s)" "$LOGF" && ok "C: the replay ran on the PR-mode candidate" || fail "C: no PR-mode replay line"
[ "$(git -C "$WORK/origin.git" rev-parse main)" = "$MAIN1" ] && [ "$(git -C "$R" rev-parse main)" = "$MAIN1" ] && ok "C: the remote and local default untouched" || fail "C: a default branch moved"
[ "$(st "$T3")" = "blocked" ] && ok "C: #$T3 held (blocked)" || fail "C: #$T3 status=$(st "$T3")"

echo "== D: PR mode (bin/merge-ticket.mjs) — the same, with a gh that would merge =="
approve "$T4"; tester_pass "$T4" "$LABEL_TEST"
node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);d.prepare("UPDATE tickets SET pr_url=? WHERE number=?").run("https://github.com/o/r/pull/4",Number(process.argv[2]));d.close()' "$DISPATCH_DB" "$T4" 2>/dev/null
cat > "$WORK/bin/gh" <<GH
#!/usr/bin/env bash
printf 'gh %s\n' "\$*" >> "$WORK/gh-calls"
exit 0
GH
chmod +x "$WORK/bin/gh"
( cd "$RUNNER_DIR" && GAFFER_GH_BIN="$WORK/bin/gh" DISPATCH_DB="$DISPATCH_DB" GAFFER_DATA="$GAFFER_DATA" node bin/merge-ticket.mjs --ticket "$T4" ) >"$WORK/d.out" 2>"$WORK/d.err"; rc=$?
[ "$rc" -eq 4 ] && grep -q "TESTER REPLAY FAILED" "$WORK/d.out" && ok "D: PR-mode Merge now refuses (exit 4, tester replay failed)" || fail "D: rc=$rc $(tail -c 400 "$WORK/d.out")"
grep -q "pr merge" "$WORK/gh-calls" 2>/dev/null && fail "D: gh pr merge ran on a red replay" || ok "D: gh pr merge never ran"
[ "$(git -C "$R" rev-parse main)" = "$MAIN1" ] && ok "D: main untouched" || fail "D: main moved"
[ "$(st "$T4")" = "blocked" ] && ok "D: #$T4 held (blocked)" || fail "D: #$T4 status=$(st "$T4")"

echo "== F: a tests branch rewritten after the PASS cannot stand in for the bound assertion =="
approve "$T9"; tester_pass "$T9" "$LABEL_TEST"
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

