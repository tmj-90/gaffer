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
#   G  PR mode (lib/land.sh), green: the record names the revision that LANDED (the local
#      default after the fast-forward, tree-equal to the candidate), not the scratch merge;
#   H  PR mode (bin/merge-ticket.mjs): the remote default moved before GitHub merged, so
#      what landed is not the candidate the replay passed on — no record.
#   I  external review #7, the reviewer's steps: the registered command is FILE-SCOPED
#      (`node --test test/label.test.mjs`) and never runs the tester's
#      test/acceptance.test.mjs. The replay used to run that command, pass, land the broken
#      combination and record the unrun file as passed. Now the tester's file runs BY PATH
#      (node:test) on the candidate: it fails there, the landing is held (tester_replay_red,
#      the file named), main is untouched and nothing is recorded; a passing tester file in
#      the same repo runs by path, lands and is recorded.
#   J  a registered command gaffer has no file-scoped invocation for (`sh scripts/test.sh`,
#      which runs one file): the tester's file shows no evidence it ran, so the merge lane
#      and Merge now hold it (tester_replay_unverified, naming the file), nothing lands, no
#      record, and `gaffer status` names the file that did not run.
#   K  FORGED PROOF (the reviewer's follow-up): the delivery's module, imported by the
#      tester's file, exits before the file's tests register and prints / writes "passed"
#      evidence for it (runner lines, reporter-shaped events, appended to the replay's proof
#      files). The by-path run exits 0, but no signed event proves the file: the merge lane
#      holds it (tester_replay_unverified, naming the file), main is untouched, no record.
# Run: bash runner/test/land-tester-replay.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
[ -f "$ROOT/packages/dispatch/dist/cli/index.js" ] || { echo "SKIP: dispatch CLI not built"; exit 0; }
[ -f "$ROOT/packages/crew/dist/runtime/context/renderPromptCli.js" ] || { echo "SKIP: crew not built"; exit 0; }
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/land-replay.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
[ "${KEEP:-0}" = 1 ] || trap 'gaffer_test_rm_work "$WORK"' EXIT
mkdir -p "$WORK/data" "$WORK/bin"
R="$WORK/repo"; mkdir -p "$R/src" "$R/test"
gitc() { git -c user.email=t@t -c user.name=t "$@"; }
( cd "$R" && git init -q -b main
  printf '{ "name": "r", "version": "0.1.0", "private": true, "type": "module", "scripts": { "test": "node --test", "lint": "node -e 0" } }\n' > package.json
  printf 'export function profile() {\n  return { name: "Ada", displayName: "Ada" };\n}\n' > src/profile.js
  printf 'import { profile } from "./profile.js";\nexport function label() {\n  return profile().name;\n}\n' > src/label.js
  # The registered smoke suite: green at every step of this test.
  printf 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { profile } from "../src/profile.js";\nimport { label } from "../src/label.js";\ntest("smoke", () => { assert.equal(profile().name, "Ada"); assert.equal(typeof label, "function"); });\n' > test/smoke.test.js
  gitc add -A && gitc commit -qm init )
git init -q --bare "$WORK/origin.git"; git -C "$R" remote add origin "$WORK/origin.git"; git -C "$R" push -q origin main 2>/dev/null

cat > "$WORK/bin/claude" <<'STUB'
#!/usr/bin/env bash
prompt=""; prev=""; for a in "$@"; do [ "$prev" = "-p" ] && prompt="$a"; prev="$a"; done
if [ -e .git ]; then
  case "$prompt" in
    *"[read-displayName]"*) sed -i.bak 's/profile().name;/profile().displayName;/' src/label.js ;;
    *"[note-"*) n="$(printf '%s' "$prompt" | sed -n 's/.*\[note-\([0-9a-z]*\)\].*/\1/p' | head -1)"; mkdir -p docs; printf 'note %s\n' "$n" > "docs/note-$n.md" ;;
    *"[forge-proof]"*) cp "$(dirname "$0")/forger.js" src/label.js ;;
  esac
  rm -f src/*.bak
  git -c user.email=s@s -c user.name=s add -A >/dev/null; git -c user.email=s@s -c user.name=s commit -qm "feat: delivery" >/dev/null 2>&1 || true
  printf '{"type":"result","subtype":"success","is_error":false,"result":"done.\\n\\nSmallest-change note: one line.","total_cost_usd":0.01,"num_turns":1}\n'; exit 0
fi
printf '{"type":"result","subtype":"success","is_error":false,"result":"ok"}\n'
STUB
chmod +x "$WORK/bin/claude"
export GAFFER_DATA="$WORK/data" CLAUDE_BIN="$WORK/bin/claude" CLAUDE_FLAGS="" \
       GAFFER_MAX_TURNS=3 GAFFER_TICK_TIMEOUT=60 GAFFER_CARD_MODEL=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
       REVIEW_MODE=human DRY_RUN=0 GAFFER_MAINTENANCE=0 GAFFER_STRICT_REQUIRE=0 GAFFER_SECURITY_REVIEW=0 GAFFER_TESTING=1 \
       MAX_OPEN_AGENT_BRANCHES_PER_REPO=12 MAX_OPEN_AGENT_PRS_PER_REPO=12 MAX_IN_REVIEW_PER_REPO=12 GAFFER_DIGEST_DISABLE=1 GAFFER_AUTO_PUSH=0
unset GAFFER_DOD_TYPECHECK_CMD GAFFER_TESTER_REPLAY
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
wg repo add -n repo --path "$R" --branch main --stack node --test "npm test" --lint "npm run lint" >/dev/null 2>&1
# The tick must not run the live tester on an in_testing ticket: this test plays the tester.
run_tick() { ( cd "$RUNNER_DIR" && bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT=' ; }
st() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status'; }
approve_heads() { wg ticket diff "$1" --heads 2>/dev/null | sed 's/^/--commit /' | tr '\n' ' '; }
new_ticket() { local n; n="$(wg ticket create -t "$1" -d "$2" --risk low 2>/dev/null | jget 'd.ticket.number')"; wg ac add "$n" -t "tests pass" >/dev/null 2>&1; wg ticket repo-access set "$n" repo --access write --relation confirmed >/dev/null 2>&1; [ "${3:-testable}" = testable ] && wg ticket set-testable "$n" >/dev/null 2>&1; wg ticket ready "$n" >/dev/null 2>&1; printf '%s' "$n"; }
branch_of() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.branch_name || ""'; }
LABEL_TEST='import test from "node:test";
import assert from "node:assert/strict";
import { label } from "../src/label.js";
test("the label reads Ada", () => { assert.equal(label(), "Ada"); });'
NAME_TEST='import test from "node:test";
import assert from "node:assert/strict";
import { profile } from "../src/profile.js";
test("the profile is named Ada", () => { assert.equal(profile().name, "Ada"); });'
# Play the independent tester as bin/tester-run.mjs does: its tests (and its installed
# wiring) committed on gaffer-tests/ticket-<n> off the tested commit, and a PASS bound to
# that commit and to the commit holding its tests, or "none" (dispatch's tester pass path:
# the row a ticket.tester_passed event names).
tester_pass() {
  local n="$1" body="${2:-}" head wt tc=none
  head="$(git -C "$R" rev-parse "refs/heads/$(branch_of "$n")")"
  if [ -n "$body" ]; then
    wt="$WORK/tester-$n"; git -C "$R" worktree add -q --detach "$wt" "$head" >/dev/null 2>&1
    mkdir -p "$wt/test" "$wt/.claude"
    printf '%s\n' "$body" > "$wt/test/bb-label.test.js"
    printf '{}\n' > "$wt/.claude/settings.json"; printf 'brief\n' > "$wt/CLAUDE.factory.md"
    gitc -C "$wt" checkout -q -B "gaffer-tests/ticket-$n"; gitc -C "$wt" add -A; gitc -C "$wt" commit -qm "black-box tests for #$n"
    tc="$(git -C "$wt" rev-parse HEAD)"
    git -C "$R" worktree remove --force "$wt" >/dev/null 2>&1
  fi
  wg ticket tester-pass "$n" --summary "black-box tests pass [tested commit ${head:0:12}]" --tested-commit "$head" --replay passed --tests-commit "$tc" --as agent >/dev/null 2>&1
}
approve() {
  # shellcheck disable=SC2046  # one --commit <repo>=<sha> word pair per head
  wg review approve "$1" $(approve_heads "$1") --reviewer human1 >/dev/null 2>&1
}
tree_of() { git -C "$R" rev-parse "$1^{tree}"; }
main_tests() { local wt="$WORK/main-check"; git -C "$R" worktree add -q --detach "$wt" "${1:-main}" >/dev/null 2>&1; ( cd "$wt" && npm test >/dev/null 2>&1 ); local rc=$?; git -C "$R" worktree remove --force "$wt" >/dev/null 2>&1; return $rc; }
hold_of() { wg ticket show "$1" | jget '((d.events || []).filter(e => e.event_type === "ticket.blocked").map(e => e.payload_json || "").pop()) || ""' 2>/dev/null; }
replay_ev() { wg ticket show "$1" | jget '(d.evidence || []).filter(e => (e.summary || "").startsWith("TESTER REPLAY FAILED")).map(e => e.summary).join("\n")' 2>/dev/null; }
LOGF="$GAFFER_DATA/factory.log"

echo "== setup: eleven deliveries, each green on its own =="
T1="$(new_ticket "Label by display name [read-displayName]" "label() reads profile().displayName")"
T2="$(new_ticket "Label by display name again [read-displayName]" "label() reads profile().displayName")"
T3="$(new_ticket "Label by display name, PR [read-displayName]" "label() reads profile().displayName")"
T4="$(new_ticket "Label by display name, PR now [read-displayName]" "label() reads profile().displayName")"
T5="$(new_ticket "Note five [note-5]" "a note")"
T6="$(new_ticket "Note six [note-6]" "a note")"
T7="$(new_ticket "Note seven [note-7]" "a note" plain)"
T8="$(new_ticket "Note eight [note-8]" "a note")"
T9="$(new_ticket "Label by display name, tampered [read-displayName]" "label() reads profile().displayName")"
T10="$(new_ticket "Note ten [note-10]" "a note")"
T11="$(new_ticket "Note eleven [note-11]" "a note")"
ALL_T="$T1 $T2 $T3 $T4 $T5 $T6 $T7 $T8 $T9 $T10 $T11"
for _ in $ALL_T; do AUTO_MERGE=0 run_tick >/dev/null; done
all_review=1; for n in $ALL_T; do [ "$(st "$n")" = in_review ] || all_review=0; done
[ "$all_review" = 1 ] && ok "all eleven delivered through their DoD gates (in_review)" || fail "statuses: $(for n in $ALL_T; do printf '#%s=%s ' "$n" "$(st "$n")"; done)"
for n in "$T1" "$T5" "$T6"; do approve "$n"; done
approve "$T7"
[ "$(st "$T1")" = in_testing ] && [ "$(st "$T7")" = ready_for_merge ] && ok "a testable approval goes to the tester (in_testing); an ordinary one to ready_for_merge" || fail "after approve: T1=$(st "$T1") T7=$(st "$T7")"
tester_pass "$T1" "$LABEL_TEST"; tester_pass "$T5"; tester_pass "$T6" "$NAME_TEST"
[ "$(st "$T1")" = ready_for_merge ] && [ "$(st "$T5")" = ready_for_merge ] && [ "$(st "$T6")" = ready_for_merge ] && ok "the tester's bound PASS → ready_for_merge" || fail "after tester: T1=$(st "$T1") T5=$(st "$T5") T6=$(st "$T6")"
main_tests "$(branch_of "$T1")" && ok "the delivery branch passes the smoke suite" || fail "fixture: T1 branch red"
( wt="$WORK/tc"; git -C "$R" worktree add -q --detach "$wt" "gaffer-tests/ticket-$T1" >/dev/null 2>&1; cd "$wt" && npm test >/dev/null 2>&1 ); rc=$?; git -C "$R" worktree remove --force "$WORK/tc" >/dev/null 2>&1
[ "$rc" -eq 0 ] && ok "the tester's assertion passes on the delivery branch (tested commit)" || fail "fixture: the tester's assertion fails on the tested commit"

echo "== main moves: displayName removed — a clean merge, the smoke suite stays green =="
sed -i.bak 's/, displayName: "Ada"//' "$R/src/profile.js" && rm -f "$R/src/profile.js.bak"
gitc -C "$R" commit -qam "refactor: drop the unused displayName"; git -C "$R" push -q origin main 2>/dev/null
main_tests && ok "main still passes the smoke suite" || fail "fixture: main red"

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
# TESTER REPLAY RECORD: which tester assertions passed on which landed revision.
replay_rec() { wg ticket show "$1" | jget '((d.evidence || []).filter(e => e.recorded_by_actor_type === "system" && (e.uri || "").startsWith("gaffer-tester-replayed:")).map(e => e.uri.slice(23) + " " + JSON.stringify(JSON.parse(e.payload_json || "{}").files || [])).join("\n"))' 2>/dev/null; }
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
merge_now() { ( cd "$RUNNER_DIR" && DISPATCH_DB="$DISPATCH_DB" GAFFER_DATA="$GAFFER_DATA" node bin/merge-ticket.mjs --ticket "$1" ) >"$WORK/mn.out" 2>"$WORK/mn.err"; }
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

echo "== G: PR mode (lib/land.sh), green — the record names what LANDED, not the scratch merge =="
approve "$T10"; tester_pass "$T10" "$NAME_TEST"
git -C "$R" push -q origin "$(branch_of "$T10")" 2>/dev/null   # the PR's head branch, on the remote
MAIN_G="$(git -C "$R" rev-parse main)"
(
  # shellcheck source=../lib/land.sh
  source "$RUNNER_DIR/lib/land.sh"
  log() { printf '%s\n' "$*" >> "$LOGF"; }
  # GitHub merges the PR (its own merge commit on the remote default), then the local
  # default is fast-forwarded — what gaffer_pr_merge does.
  gaffer_pr_merge() {
    local c="$WORK/gh-clone-g"; rm -rf "$c"; git clone -q -b main "$WORK/origin.git" "$c" 2>/dev/null
    gitc -C "$c" merge -q --no-ff -m "Merge pull request #10" "$4" && git -C "$c" push -q origin HEAD:main 2>/dev/null || return 1
    git -C "$1" fetch -q origin "$3" 2>/dev/null && git -C "$1" merge -q --ff-only FETCH_HEAD >/dev/null 2>&1 || return 3
    return 0
  }
  SHOW="$(wg ticket show "$T10" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const d=JSON.parse(s);d.ticket.pr_url="https://github.com/o/r/pull/10";process.stdout.write(JSON.stringify(d))})')"
  _gaffer_land_one "$T10" "$R" "$(branch_of "$T10")" main "$SHOW" MERGE "" 0
  echo "rc=$?" > "$WORK/g.rc"
) >/dev/null 2>&1
grep -q '^rc=0$' "$WORK/g.rc" 2>/dev/null && ok "G: the PR-mode landing ran (rc 0)" || fail "G: $(cat "$WORK/g.rc" 2>/dev/null) $(grep "#$T10" "$LOGF" | tail -3 | tr '\n' '|' | cut -c1-400)"
LANDED_G="$(git -C "$R" rev-parse main)"
[ "$LANDED_G" != "$MAIN_G" ] && [ "$LANDED_G" = "$(git -C "$WORK/origin.git" rev-parse main)" ] && ok "G: the PR merge landed upstream and main was fast-forwarded" || fail "G: main=$LANDED_G origin=$(git -C "$WORK/origin.git" rev-parse main)"
R10="$(replay_rec "$T10")"
[ "${R10%% *}" = "$LANDED_G" ] && ok "G: the replay record names the landed revision (main ${LANDED_G:0:12})" || fail "G: record '$R10' vs main $LANDED_G"
case "$R10" in *'["test/bb-label.test.js"]'*) ok "G: …and the tester file that passed on the candidate with that tree" ;; *) fail "G: record files: $R10" ;; esac

echo "== H: PR mode (bin/merge-ticket.mjs) — the remote moved before GitHub merged: no record =="
approve "$T11"; tester_pass "$T11" "$NAME_TEST"
git -C "$R" push -q origin "$(branch_of "$T11")" 2>/dev/null
node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);d.prepare("UPDATE tickets SET pr_url=? WHERE number=?").run("https://github.com/o/r/pull/11",Number(process.argv[2]));d.close()' "$DISPATCH_DB" "$T11" 2>/dev/null
cat > "$WORK/bin/gh-h" <<GH
#!/usr/bin/env bash
# Someone else's change reaches the remote default first; then GitHub squash-merges the PR.
pin=""; prev=""; for a in "\$@"; do [ "\$prev" = "--match-head-commit" ] && pin="\$a"; prev="\$a"; done
case "\$*" in *"pr merge"*) ;; *) exit 0 ;; esac
c="$WORK/gh-clone-h"; rm -rf "\$c"; git clone -q -b main "$WORK/origin.git" "\$c" 2>/dev/null
mkdir -p "\$c/docs"; printf 'other\n' > "\$c/docs/other.md"
git -C "\$c" add -A; git -C "\$c" -c user.email=o@o -c user.name=o commit -qm "someone else"
git -C "\$c" -c user.email=o@o -c user.name=o merge -q --squash "\$pin" >/dev/null 2>&1
git -C "\$c" -c user.email=o@o -c user.name=o commit -qm "squash #11" >/dev/null 2>&1
git -C "\$c" push -q origin HEAD:main 2>/dev/null
GH
chmod +x "$WORK/bin/gh-h"
( cd "$RUNNER_DIR" && GAFFER_GH_BIN="$WORK/bin/gh-h" DISPATCH_DB="$DISPATCH_DB" GAFFER_DATA="$GAFFER_DATA" node bin/merge-ticket.mjs --ticket "$T11" ) >"$WORK/h.out" 2>"$WORK/h.err"; rc=$?
[ "$rc" -eq 0 ] && git -C "$R" cat-file -e main:docs/other.md 2>/dev/null && git -C "$R" cat-file -e main:docs/note-11.md 2>/dev/null && ok "H: the PR landed upstream on a moved default and main was fast-forwarded" || fail "H: rc=$rc $(tail -c 400 "$WORK/h.out")"
[ -z "$(replay_rec "$T11")" ] && ok "H: no replay record — what landed is not the candidate the replay passed on" || fail "H: #$T11 recorded a replay on a revision it never ran on: $(replay_rec "$T11") (main $(git -C "$R" rev-parse main))"
grep -q "NO tester replay record" "$WORK/h.err" 2>/dev/null && ok "H: …and says so" || fail "H: no log line for the missing record"

echo "== I: a FILE-SCOPED registered command (the reviewer's steps) =="
# repo2: the registered command runs ONE file (test/label.test.mjs), which stays green.
R2="$WORK/repo2"; mkdir -p "$R2/src" "$R2/test"
( cd "$R2" && git init -q -b main
  printf '{ "name": "r2", "version": "0.1.0", "private": true, "type": "module" }\n' > package.json
  printf 'export function profile() {\n  return { name: "Ada", displayName: "Ada" };\n}\n' > src/profile.js
  printf 'import { profile } from "./profile.js";\nexport function label() {\n  return profile().name;\n}\n' > src/label.js
  printf 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { label } from "../src/label.js";\ntest("label is a function", () => { assert.equal(typeof label, "function"); });\n' > test/label.test.mjs
  gitc add -A && gitc commit -qm init )
wg repo add -n repo2 --path "$R2" --branch main --stack node --test "node --test test/label.test.mjs" >/dev/null 2>&1
# repo3: a registered command gaffer knows no file-scoped invocation for.
R3="$WORK/repo3"; mkdir -p "$R3/src" "$R3/test" "$R3/scripts"
( cd "$R3" && git init -q -b main
  printf '{ "name": "r3", "version": "0.1.0", "private": true, "type": "module" }\n' > package.json
  printf 'export function profile() {\n  return { name: "Ada" };\n}\n' > src/profile.js
  printf 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { profile } from "../src/profile.js";\ntest("profile", () => { assert.equal(profile().name, "Ada"); });\n' > test/label.test.mjs
  printf 'node --test test/label.test.mjs\n' > scripts/test.sh
  gitc add -A && gitc commit -qm init )
wg repo add -n repo3 --path "$R3" --branch main --stack node --test "sh scripts/test.sh" >/dev/null 2>&1
new_ticket_in() { local rp="$1" n; n="$(wg ticket create -t "$2" -d "$3" --risk low 2>/dev/null | jget 'd.ticket.number')"; wg ac add "$n" -t "tests pass" >/dev/null 2>&1; wg ticket repo-access set "$n" "$rp" --access write --relation confirmed >/dev/null 2>&1; wg ticket set-testable "$n" >/dev/null 2>&1; wg ticket ready "$n" >/dev/null 2>&1; printf '%s' "$n"; }
# The tester, as bin/tester-run.mjs: test/acceptance.test.mjs on gaffer-tests/ticket-<n>.
tester_pass_in() {
  local repo="$1" n="$2" body="$3" head wt tc
  head="$(git -C "$repo" rev-parse "refs/heads/$(branch_of "$n")")"
  wt="$WORK/tester-in-$n"; git -C "$repo" worktree add -q --detach "$wt" "$head" >/dev/null 2>&1
  mkdir -p "$wt/test"; printf '%s\n' "$body" > "$wt/test/acceptance.test.mjs"
  gitc -C "$wt" checkout -q -B "gaffer-tests/ticket-$n"; gitc -C "$wt" add -A; gitc -C "$wt" commit -qm "black-box tests for #$n"
  tc="$(git -C "$wt" rev-parse HEAD)"; git -C "$repo" worktree remove --force "$wt" >/dev/null 2>&1
  wg ticket tester-pass "$n" --summary "black-box tests pass [tested commit ${head:0:12}]" --tested-commit "$head" --replay passed --tests-commit "$tc" --as agent >/dev/null 2>&1
}
ACC_LABEL='import test from "node:test";
import assert from "node:assert/strict";
import { label } from "../src/label.js";
test("the label is Ada", () => { assert.equal(label(), "Ada"); });'
ACC_NAME='import test from "node:test";
import assert from "node:assert/strict";
import { profile } from "../src/profile.js";
test("the profile is named Ada", () => { assert.equal(profile().name, "Ada"); });'
T12="$(new_ticket_in repo2 "Label by display name, file-scoped [read-displayName]" "label() reads profile().displayName")"
T13="$(new_ticket_in repo2 "Note thirteen [note-13]" "a note")"
T14="$(new_ticket_in repo3 "Note fourteen [note-14]" "a note")"
T15="$(new_ticket_in repo3 "Note fifteen [note-15]" "a note")"
for _ in 1 2 3 4; do AUTO_MERGE=0 run_tick >/dev/null; done
for n in "$T12" "$T13" "$T14" "$T15"; do approve "$n"; done
[ "$(st "$T12")" = in_testing ] && [ "$(st "$T14")" = in_testing ] && ok "I: the file-scoped repos' deliveries passed their gates and went to the tester" || fail "I: statuses T12=$(st "$T12") T13=$(st "$T13") T14=$(st "$T14") T15=$(st "$T15")"
tester_pass_in "$R2" "$T12" "$ACC_LABEL"; tester_pass_in "$R2" "$T13" "$ACC_NAME"
tester_pass_in "$R3" "$T14" "$ACC_NAME"
# main moves in repo2: displayName removed; the registered (file-scoped) suite stays green.
sed -i.bak 's/, displayName: "Ada"//' "$R2/src/profile.js" && rm -f "$R2/src/profile.js.bak"
gitc -C "$R2" commit -qam "refactor: drop the unused displayName"
MAIN_J="$(git -C "$R3" rev-parse main)"
rf_I="$WORK/i-check"; git -C "$R2" worktree add -q --detach "$rf_I" main >/dev/null 2>&1
gitc -C "$rf_I" merge -q --no-edit "$(git -C "$R2" rev-parse "refs/heads/$(branch_of "$T12")")" >/dev/null 2>&1
( cd "$rf_I" && node --test test/label.test.mjs >/dev/null 2>&1 ) && ok "I: the registered file-scoped command passes on the merge candidate" || fail "I: fixture: the registered command is red on the candidate"
git -C "$rf_I" checkout -q "gaffer-tests/ticket-$T12" -- test/acceptance.test.mjs
( cd "$rf_I" && node --test test/acceptance.test.mjs >/dev/null 2>&1 ) && fail "I: fixture: the tester's file passes on the candidate" || ok "I: the tester's test/acceptance.test.mjs FAILS on the candidate (undefined !== 'Ada')"
git -C "$R2" worktree remove --force "$rf_I" >/dev/null 2>&1
B12="$(git -C "$R2" rev-parse "refs/heads/$(branch_of "$T12")")"
rm -f "$GAFFER_DATA/.merge-held-tickets"
GAFFER_MODE=autonomous AUTO_MERGE=1 run_tick >/dev/null
if git -C "$R2" merge-base --is-ancestor "$B12" main; then fail "I: main contains #$T12 — the broken combination landed"; else ok "I: main does not contain #$T12 — the broken combination did not land"; fi
grep -q 'profile().name;' <<<"$(git -C "$R2" show main:src/label.js 2>/dev/null)" && ok "I: main's label still reads name" || fail "I: main's label changed"
H12="$(hold_of "$T12")"
[ "$(st "$T12")" = blocked ] && case "$H12" in *tester_replay_red*) case "$H12" in *test/acceptance.test.mjs*) true ;; *) false ;; esac ;; *) false ;; esac \
  && ok "I: #$T12 held (tester_replay_red) naming test/acceptance.test.mjs" || fail "I: #$T12 status=$(st "$T12") hold=${H12:0:300}"
grep -q "MERGE: #$T12 TESTER REPLAY — running the tester's 1 test file(s) (test/acceptance.test.mjs) on the merge candidate .* (node-test, by path)" "$LOGF" && ok "I: the tester's file ran BY PATH (node:test), not through the file-scoped command" || fail "I: no by-path replay line for #$T12"
[ -z "$(replay_rec "$T12")" ] && ok "I: no replay record names the file (it failed where it ran)" || fail "I: #$T12 recorded a replay: $(replay_rec "$T12")"
[ "$(st "$T13")" = "done" ] && ok "I: the file-scoped happy path: the tester's passing file runs by path and #$T13 lands" || fail "I: #$T13 status=$(st "$T13") $(grep "#$T13" "$LOGF" | tail -2 | tr '\n' '|' | cut -c1-300)"
R13="$(replay_rec "$T13")"
[ "${R13%% *}" = "$(git -C "$R2" rev-parse main)" ] && case "$R13" in *'["test/acceptance.test.mjs"]'*) true ;; *) false ;; esac \
  && ok "I: …recorded on the landed revision with the file that ran: $R13" || fail "I: #$T13 record '$R13' main=$(git -C "$R2" rev-parse main)"

echo "== J: no file-scoped invocation known — a tester file with no proof it ran holds =="
[ "$(git -C "$R3" rev-parse main)" = "$MAIN_J" ] && ok "J: repo3's main untouched by the merge lane" || fail "J: repo3 main moved: $(git -C "$R3" log --oneline -2 main | tr '\n' '|')"
H14="$(hold_of "$T14")"
[ "$(st "$T14")" = blocked ] && case "$H14" in *tester_replay_unverified*) case "$H14" in *test/acceptance.test.mjs*) true ;; *) false ;; esac ;; *) false ;; esac \
  && ok "J: the merge lane held #$T14 (tester_replay_unverified) naming test/acceptance.test.mjs" || fail "J: #$T14 status=$(st "$T14") hold=${H14:0:300} $(grep "#$T14" "$LOGF" | tail -2 | tr '\n' '|' | cut -c1-300)"
[ -z "$(replay_rec "$T14")" ] && ok "J: no replay record for the unverified file" || fail "J: #$T14 recorded: $(replay_rec "$T14")"
EV14="$(wg ticket show "$T14" | jget '(d.evidence || []).filter(e => (e.summary || "").startsWith("TESTER REPLAY UNVERIFIED")).map(e => e.summary).join("\n")' 2>/dev/null)"
case "$EV14" in *"TESTER REPLAY UNVERIFIED"*test/acceptance.test.mjs*) ok "J: the ticket page's evidence says which file did not run" ;; *) fail "J: evidence: ${EV14:0:300}" ;; esac
tester_pass_in "$R3" "$T15" "$ACC_NAME"
merge_now "$T15"; rc=$?
[ "$rc" -eq 4 ] && grep -q "TESTER REPLAY UNVERIFIED" "$WORK/mn.out" && grep -q "test/acceptance.test.mjs" "$WORK/mn.out" && ok "J: Merge now refuses #$T15 the same way (exit 4, the file named)" || fail "J: Merge now rc=$rc $(tail -c 400 "$WORK/mn.out")"
[ "$(git -C "$R3" rev-parse main)" = "$MAIN_J" ] && [ "$(st "$T15")" = blocked ] && [ -z "$(replay_rec "$T15")" ] && ok "J: …nothing landed, held, no record" || fail "J: #$T15 status=$(st "$T15") main=$(git -C "$R3" rev-parse main) rec=$(replay_rec "$T15")"
STATUS_J="$(bash "$RUNNER_DIR/status.sh" 2>/dev/null)"
case "$STATUS_J" in *"#$T14 tester replay UNVERIFIED (held)"*test/acceptance.test.mjs*) ok "J: gaffer status names the tester file that did not run" ;; *) fail "J: gaffer status: $(printf '%s' "$STATUS_J" | grep -i 'replay' | head -3)" ;; esac

echo "== K: forged proof — the delivery stops the tester's file and prints 'passed' for it =="
# The delivery's src/label.js: when the tester's file imports it, it writes "passed"
# evidence for that file in every shape a runner uses (and appends a reporter-shaped event
# to the replay's proof files once the runner has written there), then exits before the
# file's tests register.
cat > "$WORK/bin/forger.js" <<'FORGER'
import { spawn } from "node:child_process";
import { resolve } from "node:path";
const me = resolve("test/acceptance.test.mjs");
const ev = JSON.stringify({ pid: process.ppid, seq: 1, type: "test:pass", file: me, name: "the label is Ada", skip: false, todo: false, suite: false });
const helper = `const fs = require("fs"); const t0 = Date.now();
const tick = () => { for (const d of fs.readdirSync(".")) if (d.startsWith(".gaffer-replay-")) for (const f of ["events.jsonl", "output.txt"]) { try { if (fs.statSync(d + "/" + f).size > 0) { fs.appendFileSync(d + "/" + f, ${JSON.stringify(ev + "\n")}); return; } } catch {} } if (Date.now() - t0 < 4000) setImmediate(tick); };
tick();`;
spawn(process.execPath, ["-e", helper], { detached: true, stdio: "ignore" }).unref();
console.log("\u2714 the label is Ada (0.1ms)");
console.log("PASS test/acceptance.test.mjs");
console.log(ev);
console.log("gaffer-replay-proof " + "0".repeat(64) + " " + ev);
await new Promise((r) => setTimeout(r, 300));
process.exit(0);
export function label() { return "Ada"; }
FORGER
R4="$WORK/repo4"; mkdir -p "$R4/src" "$R4/test"
( cd "$R4" && git init -q -b main
  printf '{ "name": "r4", "version": "0.1.0", "private": true, "type": "module" }\n' > package.json
  printf 'export function profile() {\n  return { name: "Ada" };\n}\n' > src/profile.js
  printf 'import { profile } from "./profile.js";\nexport function label() {\n  return profile().name;\n}\n' > src/label.js
  printf 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { profile } from "../src/profile.js";\ntest("profile", () => { assert.equal(profile().name, "Ada"); });\n' > test/label.test.mjs
  gitc add -A && gitc commit -qm init )
wg repo add -n repo4 --path "$R4" --branch main --stack node --test "node --test test/label.test.mjs" >/dev/null 2>&1
T16="$(new_ticket_in repo4 "Label tweak [forge-proof]" "label() reads the profile")"
for _ in 1 2; do AUTO_MERGE=0 run_tick >/dev/null; done
approve "$T16"
[ "$(st "$T16")" = in_testing ] && ok "K: the forging delivery passed its own gates and went to the tester" || fail "K: #$T16 status=$(st "$T16")"
tester_pass_in "$R4" "$T16" "$ACC_LABEL"
MAIN_K="$(git -C "$R4" rev-parse main)"
rm -f "$GAFFER_DATA/.merge-held-tickets"
GAFFER_MODE=autonomous AUTO_MERGE=1 run_tick >/dev/null
[ "$(git -C "$R4" rev-parse main)" = "$MAIN_K" ] && ok "K: main untouched — the forged proof did not land the delivery" || fail "K: repo4 main moved: $(git -C "$R4" log --oneline -2 main | tr '\n' '|')"
H16="$(hold_of "$T16")"
[ "$(st "$T16")" = blocked ] && case "$H16" in *tester_replay_unverified*) case "$H16" in *test/acceptance.test.mjs*) true ;; *) false ;; esac ;; *) false ;; esac \
  && ok "K: #$T16 held (tester_replay_unverified) naming test/acceptance.test.mjs" || fail "K: #$T16 status=$(st "$T16") hold=${H16:0:400} $(grep "#$T16" "$LOGF" | tail -3 | tr '\n' '|' | cut -c1-400)"
[ -z "$(replay_rec "$T16")" ] && ok "K: no replay record for the forged file" || fail "K: #$T16 recorded: $(replay_rec "$T16")"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "land-tester-replay: ALL $PASS checks passed"; exit 0; fi
echo "land-tester-replay: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1
