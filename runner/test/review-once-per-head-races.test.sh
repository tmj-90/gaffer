#!/usr/bin/env bash
# =====================================================================
# ONE AGENT REVIEW PER DELIVERED COMMIT: THE RACES (REVIEW_MODE=agent).
# ---------------------------------------------------------------------
# Split off review-once-per-head.test.sh (1-4: tester first, one review per head across
# daemon passes, a rework reviewed once, a tester FAIL unpaid) and
# review-once-per-head-resubmit.test.sh (7) when the one file outgrew the 600 s per-test
# cap on a slow macOS runner. Same world (lib/review-once-world.sh): real dispatch, real
# tick.sh, the real bin/tester-run.mjs and a stub agent whose own invocation log is what
# is counted:
#   5. a ticket that leaves review between the review pick and the launch (a person
#      approves and merges it) is not reviewed, and no "reviewer modified the
#      candidate" note is written
#   5b. a head another lane reviewed between this lane's pick and its launch
#      (GAFFER_CONCURRENCY>1) is not reviewed again
#   6. a ticket merged by a person WHILE the reviewer runs is reported as having left
#      review, never as the reviewer's act (the branch it judged is not restored)
# Run: bash runner/test/review-once-per-head-races.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
for f in packages/dispatch/dist/cli/index.js packages/memory/dist/bin/memory.js packages/crew/dist/cli/index.js; do
  [ -f "$ROOT/$f" ] || { echo "SKIP: $f not built (run pnpm -r build)"; exit 0; }
done
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

# shellcheck source=lib/review-once-world.sh
. "$HERE/lib/review-once-world.sh"

echo "== 5. a ticket merged between the review pick and the launch is not reviewed =="
K="$(new_ticket "Merged before its review" "v stays 1")"
mkdir -p "$WORK/run-k" "$WORK/run-k2"
# Deliver and test it (the review pass of these ticks finds nothing new to review).
for i in 1 2 3; do
  r="$( ( cd "$RUNNER_DIR" && GAFFER_RUN_STATE_DIR="$WORK/run-k" PATH="$WORK/shim:$PATH" bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | sed -n 's/^TICK_RESULT=//p' | tail -1)"
  [ "$(st "$K")" = in_review ] && [ -n "$(branch_head "$K")" ] && [ "$(count tester "$(branch_head "$K")")" -ge 1 ] && break
done
HK="$(branch_head "$K")"
KN0="$(tamper_notes)"
if [ "$(st "$K")" = in_review ] && [ "$(count review "$HK")" = 0 ]; then
  ok "5: setup: #$K tested and waiting in_review for its review"
  printf '%s' "$K" > "$CTL/race-ticket"; : > "$CTL/race-armed"
  ( cd "$RUNNER_DIR" && GAFFER_RUN_STATE_DIR="$WORK/run-k2" PATH="$WORK/shim:$PATH" bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) >/dev/null
  [ -e "$CTL/race-fired" ] && ok "5: the person approved and merged #$K after the pick ($(st "$K"))" || fail "5: the race never fired (no review worktree was created)"
  [ "$(count review "$HK")" = 0 ] && ok "5: the reviewer was not launched for a ticket no longer in review" || fail "5: ${HK:0:12} was reviewed $(count review "$HK") times"
  [ "$(tamper_notes)" = "$KN0" ] && ok "5: no 'reviewer modified the candidate' line" || fail "5: a tamper line was written: $(grep 'reviewer modified' "$GAFFER_DATA/factory.log" | tail -1)"
  grep -q "reviewer modified the candidate" <<<"$(wg ticket show "$K" 2>/dev/null)" \
    && fail "5: a 'reviewer modified the candidate' note is on #$K" || ok "5: no 'reviewer modified the candidate' note on #$K"
  [ "$(ledger_rows review "$K")" = 0 ] && ok "5: no review call is booked in the usage ledger for #$K" || fail "5: $(ledger_rows review "$K") review row(s) booked for #$K"
  [ ! -e "$GAFFER_DATA/worktrees/review-wt-$K" ] && ! grep -q "review-wt-$K" <<<"$(git -C "$R" worktree list)" \
    && ok "5: no review worktree left behind" || fail "5: review-wt-$K left behind"
  [ ! -e "$GAFFER_DATA/.review-$K.lock.d" ] && ok "5: the review claim is released" || fail "5: the review claim of #$K is left"
else
  fail "5: setup: #$K is $(st "$K") with $(count review "$HK") reviews (calls: $(tr '\n' '|' < "$CALLS"))"
fi
rm -f "$CTL/race-armed" "$CTL/race-fired"

echo "== 5b. a head another lane reviewed between this lane's pick and its launch is not reviewed again =="
Q="$(new_ticket "Reviewed by another lane" "v stays 1")"
mkdir -p "$WORK/run-q" "$WORK/run-q2"
for i in 1 2 3; do
  ( cd "$RUNNER_DIR" && GAFFER_RUN_STATE_DIR="$WORK/run-q" PATH="$WORK/shim:$PATH" bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) >/dev/null
  [ "$(st "$Q")" = in_review ] && [ -n "$(branch_head "$Q")" ] && [ "$(count tester "$(branch_head "$Q")")" -ge 1 ] && break
done
HQ="$(branch_head "$Q")"
if [ "$(st "$Q")" = in_review ] && [ "$(count review "$HQ")" = 0 ]; then
  printf '%s' "$Q" > "$CTL/race-ticket"; echo verdict > "$CTL/race-mode"; : > "$CTL/race-armed"
  ( cd "$RUNNER_DIR" && GAFFER_RUN_STATE_DIR="$WORK/run-q2" PATH="$WORK/shim:$PATH" bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) >/dev/null
  [ -e "$CTL/race-fired" ] && ok "5b: another lane's verdict landed after the pick" || fail "5b: the race never fired"
  [ "$(count review "$HQ")" = 0 ] && ok "5b: this lane did not review the same head again" || fail "5b: ${HQ:0:12} reviewed $(count review "$HQ") times"
  grep -q "REVIEW: #$Q head ${HQ:0:12} was reviewed by another lane since the pick" "$GAFFER_DATA/factory.log" \
    && ok "5b: logged as reviewed by another lane" || fail "5b: no 'another lane' line"
  [ ! -e "$GAFFER_DATA/worktrees/review-wt-$Q" ] && [ ! -e "$GAFFER_DATA/.review-$Q.lock.d" ] && ok "5b: no worktree or claim left" || fail "5b: worktree or claim left"
else
  fail "5b: setup: #$Q is $(st "$Q") with $(count review "$HQ") reviews"
fi
rm -f "$CTL/race-armed" "$CTL/race-mode" "$CTL/race-fired"
wg ticket cancel "$Q" >/dev/null 2>&1 || wg wont-do "$Q" --reason done >/dev/null 2>&1 || true

echo "== 6. a ticket merged WHILE the reviewer runs left review; it is not the reviewer's act =="
J="$(new_ticket "Merged during its review" "v stays 1")"
JN0="$(tamper_notes)"
: > "$CTL/merge-during"
daemon_pass
HJ="$(git -C "$R" log --format=%H -1 --grep "merge #$J" main 2>/dev/null)"
[ -n "$HJ" ] && ok "6: the person merged #$J during its review ($(st "$J"))" || fail "6: #$J was not merged during a review (status $(st "$J"), merge-during left: $([ -e "$CTL/merge-during" ] && echo yes || echo no))"
[ "$(tamper_notes)" = "$JN0" ] && ok "6: no 'reviewer modified the candidate' line" || fail "6: $(grep 'reviewer modified' "$GAFFER_DATA/factory.log" | tail -1)"
grep -q "#$J.*left review during the review" "$GAFFER_DATA/factory.log" \
  && ok "6: the log says the ticket left review during the review" || fail "6: no 'left review' line: $(grep "agent review of #$J" "$GAFFER_DATA/factory.log" | tail -1)"
grep -q "reviewer modified the candidate" <<<"$(wg ticket show "$J" 2>/dev/null)" \
  && fail "6: a 'reviewer modified the candidate' note is on #$J" || ok "6: no 'reviewer modified the candidate' note on #$J"
git -C "$R" rev-parse --verify -q "refs/gaffer/review-tamper/$J" >/dev/null \
  && fail "6: the merge was kept as a reviewer tamper ref" || ok "6: nothing kept as a reviewer tamper ref"
[ "$(ledger_rows review "$J")" = 1 ] && ok "6: the review that ran is booked once in the usage ledger" || fail "6: $(ledger_rows review "$J") review rows for #$J"
[ ! -e "$GAFFER_DATA/worktrees/review-wt-$J" ] && ok "6: no review worktree left behind" || fail "6: review-wt-$J left behind"
# Nothing acted on the reviewer's verdict, so its lane verdict is held: the commit is not
# marked reviewed by a verdict nobody used.
_LVJ="$(wg ticket show "$J" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);const r=(v.events||[]).filter(e=>e.event_type==="ticket.lane_verdict").map(e=>JSON.parse(e.payload_json||"{}")).filter(p=>p.lane==="agent-review").pop()||{};process.stdout.write(String(r.verdict||""))})')"
[ "$_LVJ" = held ] && ok "6: the unused verdict is recorded as held" || fail "6: agent-review lane verdict on #$J is '$_LVJ'"


echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "review-once-per-head-races: ALL $PASS checks passed"; exit 0; fi
echo "review-once-per-head-races: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1
