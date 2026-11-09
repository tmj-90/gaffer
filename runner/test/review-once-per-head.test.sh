#!/usr/bin/env bash
# =====================================================================
# ONE AGENT REVIEW PER DELIVERED COMMIT, AFTER THE TESTER (REVIEW_MODE=agent).
# ---------------------------------------------------------------------
# A live run (agent review, supervised, the tester lane on through a registered test
# command) paid for 22 agent reviews on 12 deliveries: each delivery was reviewed,
# then sent to the tester, then reviewed AGAIN on the next daemon pass, on the same
# commit (the tester changes no code; the "already reviewed" memory was a per-run
# skip file). One re-review raced a person's merge and was held as "reviewer
# modified the candidate". Pinned here, with real dispatch, real tick.sh, the real
# bin/tester-run.mjs and a stub agent whose own invocation log is what is counted:
#   1. a delivery goes to the tester BEFORE any reviewer runs; the tester's PASS
#      brings it back and the reviewer runs once, with the tester's PASS in its packet
#   2. a second daemon pass (a new run, an empty per-run skip file) does not review
#      the same head again
#   3. a rework (a new head) is tested and reviewed once more, exactly once
#   4. a tester FAIL sends the ticket to rework without a paid review
#   5. a ticket that leaves review between the review pick and the launch (a person
#      approves and merges it) is not reviewed, and no "reviewer modified the
#      candidate" note is written
#   5b. a head another lane reviewed between this lane's pick and its launch
#      (GAFFER_CONCURRENCY>1) is not reviewed again
#   6. a ticket merged by a person WHILE the reviewer runs is reported as having left
#      review, never as the reviewer's act (the branch it judged is not restored)
#   7. a rework that resubmits the commit the reviewer asked changes on is not reviewed
#      again and not stranded: with the approve gate earned (AFK) the runner sends it back
#      to rework on the recorded verdict; supervised, a note on the ticket says it waits
#      for a person
# Run: bash runner/test/review-once-per-head.test.sh
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

WORK="$(mktemp -d "${TMPDIR:-/tmp}/review-once.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
trap '[ "${KEEP:-0}" = 1 ] && echo "kept $WORK" || gaffer_test_rm_work "$WORK"' EXIT
CTL="$WORK/ctl"; mkdir -p "$WORK/data" "$WORK/bin" "$WORK/shim" "$CTL"
CALLS="$WORK/agent-calls.log"; : > "$CALLS"
R="$WORK/repo"; mkdir -p "$R/src" "$R/test"
gitc() { git -c user.email=t@t -c user.name=t "$@"; }
( cd "$R" && git init -q -b main
  printf '{ "name": "r", "version": "0.1.0", "private": true, "type": "module", "scripts": { "test": "node --test", "lint": "node -e 0" } }\n' > package.json
  printf 'export const v = 1;\n' > src/v.js
  printf 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { v } from "../src/v.js";\ntest("smoke", () => { assert.equal(v, 1); });\n' > test/smoke.test.js
  gitc add -A && gitc commit -qm init )
DCLI="$ROOT/packages/dispatch/dist/cli/index.js"
DB="$WORK/data/dispatch.sqlite"

# Stub agent. Every call appends one line to $CALLS: "<role> <head of its cwd>".
#   tester (the INDEPENDENT TESTER prompt): writes a passing black-box test and answers
#     the verdict in $CTL/tester-verdict (PASS | FAIL).
#   (the reviewer is told apart first: its packet quotes the tester's outcome)
#   reviewer (the REVIEWER agent prompt): keeps its prompt as $CTL/review-prompt-<head>;
#     answers APPROVE. With $CTL/merge-during present it first plays a person who
#     approves and merges the ticket while the review runs (the live race).
#   delivery (anything else in a checkout): one new committed line, so every delivery
#     and every rework is a new head.
cat > "$WORK/bin/claude" <<STUB
#!/usr/bin/env bash
CTL="$CTL"; CALLS="$CALLS"; DCLI="$DCLI"; DB="$DB"; R="$R"; NODE="$(command -v node)"
STUB
cat >> "$WORK/bin/claude" <<'STUB'
prompt=""; prev=""; for a in "$@"; do [ "$prev" = "-p" ] && prompt="$a"; prev="$a"; done
head="$(git rev-parse HEAD 2>/dev/null || echo none)"
case "$prompt" in
  *"You are a REVIEWER agent"*)
    echo "review $head" >> "$CALLS"
    printf '%s' "$prompt" > "$CTL/review-prompt-$head"
    if [ -e "$CTL/merge-during" ]; then
      rm -f "$CTL/merge-during"
      n="$(printf '%s' "$prompt" | sed -n 's/.*in_review ticket #\([0-9][0-9]*\).*/\1/p' | head -1)"
      b="$("$NODE" "$DCLI" --db "$DB" ticket show "$n" 2>/dev/null | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).ticket.branch_name||"")}catch{}})')"
      "$NODE" "$DCLI" --db "$DB" review approve "$n" --as human --reviewer person --commit "$head" >/dev/null 2>&1
      git -C "$R" -c user.email=p@p -c user.name=p merge -q --no-ff -m "merge #$n" "$b" >/dev/null 2>&1
      git -C "$R" branch -D "$b" >/dev/null 2>&1
    fi
    if [ "$(cat "$CTL/review-verdict" 2>/dev/null)" = CHANGES ]; then
      printf '{"type":"result","subtype":"success","is_error":false,"result":"AC1 not met.\\nRECOMMEND CHANGES: v must be documented\\n{\\"verdict\\":\\"CHANGES\\"}","total_cost_usd":0.01,"num_turns":2}\n'
      exit 0
    fi
    printf '{"type":"result","subtype":"success","is_error":false,"result":"AC1 PASS.\\nRECOMMEND APPROVE\\n{\\"verdict\\":\\"APPROVE\\"}","total_cost_usd":0.01,"num_turns":2}\n'
    exit 0 ;;
  *"INDEPENDENT TESTER"*)
    echo "tester $head" >> "$CALLS"
    mkdir -p test
    printf 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { v } from "../src/v.js";\ntest("bb", () => { assert.equal(v, 1); });\n' > test/bb.test.js
    case "$(cat "$CTL/tester-verdict" 2>/dev/null || echo PASS)" in
      FAIL) printf '{"type":"result","subtype":"success","is_error":false,"result":"FAIL: v is not what AC1 says (stub-fail-marker)\\n{\\"verdict\\":\\"FAIL\\"}","total_cost_usd":0.01,"num_turns":2}\n' ;;
      *) printf '{"type":"result","subtype":"success","is_error":false,"result":"PASS: v is 1 as AC1 says (stub-pass-marker)\\n{\\"verdict\\":\\"PASS\\"}","total_cost_usd":0.01,"num_turns":2}\n' ;;
    esac
    exit 0 ;;
esac
if [ -e .git ] && [ -e "$CTL/no-commit" ] && [ "$(git rev-list --count main..HEAD 2>/dev/null || echo 0)" -gt 0 ]; then
  # A rework that commits nothing new: the branch keeps the head it was sent back on.
  echo "deliver-nocommit $(git rev-parse HEAD)" >> "$CALLS"
  printf '{"type":"result","subtype":"success","is_error":false,"result":"done: nothing to change.\\n\\nSmallest-change note: none.","total_cost_usd":0.01,"num_turns":1}\n'; exit 0
fi
if [ -e .git ]; then
  mkdir -p docs; printf 'change %s %s\n' "$$" "$RANDOM" >> docs/change.md
  git -c user.email=s@s -c user.name=s add -A >/dev/null; git -c user.email=s@s -c user.name=s commit -qm "feat: delivery" >/dev/null 2>&1 || true
  echo "deliver $(git rev-parse HEAD)" >> "$CALLS"
  printf '{"type":"result","subtype":"success","is_error":false,"result":"done.\\n\\nSmallest-change note: one line.","total_cost_usd":0.01,"num_turns":1}\n'; exit 0
fi
printf '{"type":"result","subtype":"success","is_error":false,"result":"ok"}\n'
STUB
chmod +x "$WORK/bin/claude"

# A `git` shim first on PATH: armed by $CTL/race-armed, it plays a person who approves and
# merges the ticket in $CTL/race-ticket at the moment the review pass creates its review
# worktree (after the pick, before the launch), then runs the real git.
REALGIT="$(command -v git)"
cat > "$WORK/shim/git" <<SHIM
#!/usr/bin/env bash
CTL="$CTL"; DCLI="$DCLI"; DB="$DB"; R="$R"; REALGIT="$REALGIT"; NODE="$(command -v node)"
SHIM
cat >> "$WORK/shim/git" <<'SHIM'
if [ -e "$CTL/race-armed" ]; then
  case " $* " in
    *" worktree add "*review-wt-*)
      rm -f "$CTL/race-armed"
      n="$(cat "$CTL/race-ticket")"
      b="$("$NODE" "$DCLI" --db "$DB" ticket show "$n" 2>/dev/null | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).ticket.branch_name||"")}catch{}})')"
      h="$("$REALGIT" -C "$R" rev-parse "refs/heads/$b")"
      if [ "$(cat "$CTL/race-mode" 2>/dev/null)" = verdict ]; then
        # Another lane finished a review of this head after this lane's pick.
        "$NODE" "$DCLI" --db "$DB" ticket lane-verdict "$n" --lane agent-review --verdict changes --commit "$h" --as system >"$CTL/race-approve.out" 2>&1
        : > "$CTL/race-fired"; exec "$REALGIT" "$@"
      fi
      "$NODE" "$DCLI" --db "$DB" review approve "$n" --as human --reviewer person --commit "$h" >"$CTL/race-approve.out" 2>&1
      "$REALGIT" -C "$R" -c user.email=p@p -c user.name=p merge -q --no-ff -m "merge #$n" "$b" >/dev/null 2>&1
      : > "$CTL/race-fired" ;;
  esac
fi
exec "$REALGIT" "$@"
SHIM
chmod +x "$WORK/shim/git"

export GAFFER_DATA="$WORK/data" DISPATCH_DB="$DB" CLAUDE_BIN="$WORK/bin/claude" CLAUDE_FLAGS="" \
       GAFFER_MAX_TURNS=3 GAFFER_TICK_TIMEOUT=60 GAFFER_ROLE_MODELS=card=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
       REVIEW_MODE=agent DRY_RUN=0 GAFFER_MAINTENANCE=0 GAFFER_STRICT_REQUIRE=0 \
       MAX_OPEN_AGENT_BRANCHES_PER_REPO=12 MAX_OPEN_AGENT_PRS_PER_REPO=12 MAX_IN_REVIEW_PER_REPO=12 GAFFER_DIGEST_DISABLE=1 GAFFER_AUTO_PUSH=0
# The tester lane as the live run had it: the `auto` default with a registered test command.
unset GAFFER_TESTING GAFFER_DOD_TYPECHECK_CMD GAFFER_TESTER_REPLAY AUTO_MERGE MERGE_ON_AGENT_REVIEW DISPATCH_ALLOW_AGENT_APPROVE
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
wg repo add -n repo --path "$R" --branch main --stack node --test "npm test" --lint "npm run lint" >/dev/null 2>&1

# One daemon PASS: a run of its own (a fresh GAFFER_RUN_STATE_DIR, so the per-run skip
# files start empty, as each pass of the live daemon did), ticking until the factory
# has nothing left to do (at most 8 ticks).
PASSNO=0
daemon_pass() {
  PASSNO=$((PASSNO + 1))
  local sd="$WORK/run-$PASSNO" i r
  mkdir -p "$sd"
  for i in 1 2 3 4 5 6 7 8; do
    r="$( ( cd "$RUNNER_DIR" && GAFFER_RUN_STATE_DIR="$sd" PATH="$WORK/shim:$PATH" bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | sed -n 's/^TICK_RESULT=//p' | tail -1)"
    echo "    pass $PASSNO tick $i: ${r:-none}"
    case "$r" in worked|reviewed|tested) ;; *) break ;; esac
  done
}
st() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status'; }
new_ticket() { local n; n="$(wg ticket create -t "$1" -d "$2" --risk low 2>/dev/null | jget 'd.ticket.number')"; wg ac add "$n" -t "v is 1" >/dev/null 2>&1; wg ticket repo-access set "$n" repo --access write --relation confirmed >/dev/null 2>&1; wg ticket set-testable "$n" >/dev/null 2>&1; wg ticket ready "$n" >/dev/null 2>&1; printf '%s' "$n"; }
branch_head() { local b; b="$(wg ticket show "$1" 2>/dev/null | jget 'd.ticket.branch_name || ""')"; [ -n "$b" ] && git -C "$R" rev-parse --verify -q "refs/heads/$b"; }
count() { grep -c "^$1 $2\$" "$CALLS" 2>/dev/null; }
line_of() { grep -n "^$1 $2\$" "$CALLS" 2>/dev/null | head -1 | cut -d: -f1; }
ledger_rows() { node -e 'const fs=require("fs");let n=0;try{for(const l of fs.readFileSync(process.argv[1],"utf8").split("\n")){if(!l.trim())continue;try{const r=JSON.parse(l);if(r.kind===process.argv[2]&&Number(r.ticket)===Number(process.argv[3]))n++}catch{}}}catch{}process.stdout.write(String(n))' "$GAFFER_DATA/usage-ledger.jsonl" "$1" "$2"; }
tamper_notes() { { grep -c "reviewer modified the candidate" "$GAFFER_DATA/factory.log" 2>/dev/null || true; } | head -1; }

echo "== 1-2. one delivery, two daemon passes =="
echo PASS > "$CTL/tester-verdict"
N="$(new_ticket "Once per head" "v stays 1")"
daemon_pass
H1="$(branch_head "$N")"
[ -n "$H1" ] && ok "setup: #$N delivered (head ${H1:0:12})" || fail "setup: #$N has no delivery head (status $(st "$N"))"
[ "$(count tester "$H1")" -ge 1 ] && ok "1: the tester ran on ${H1:0:12}" || fail "1: the tester never ran on the head: $(tr '\n' '|' < "$CALLS")"
_t="$(line_of tester "$H1")"; _r="$(line_of review "$H1")"
[ -n "$_t" ] && [ -n "$_r" ] && [ "$_t" -lt "$_r" ] \
  && ok "1: the tester ran before the reviewer" || fail "1: order tester=${_t:-never} review=${_r:-never}: $(tr '\n' '|' < "$CALLS")"
[ "$(count review "$H1")" = 1 ] && ok "1: exactly one review in the first pass" || fail "1: $(count review "$H1") reviews of ${H1:0:12} in pass 1"
P="$CTL/review-prompt-$H1"
if [ -f "$P" ] && grep -q "TESTER OUTCOME" "$P" && grep -q "PASS on this exact commit" "$P" && grep -q "stub-pass-marker" "$P"; then
  ok "1: the review packet carries the tester's PASS for this head"
else
  fail "1: the review packet lacks the tester's PASS: $(grep -o 'TESTER OUTCOME[^.]*' "$P" 2>/dev/null | head -2 | tr '\n' '|')"
fi
grep -q "tests_commit\|tests are kept on\|gaffer-tests/ticket-$N" "$P" 2>/dev/null \
  && ok "1: the packet names where the tester's tests are kept" || fail "1: the packet does not name the tester's tests"
[ "$(st "$N")" = in_review ] && ok "1: #$N waits in_review for a person (advisory)" || fail "1: #$N is $(st "$N")"
daemon_pass
[ "$(count review "$H1")" = 1 ] && ok "2: a second daemon pass does not review the same head again" \
  || fail "2: ${H1:0:12} was reviewed $(count review "$H1") times over two passes"
[ "$(count tester "$H1")" = 1 ] && ok "2: nor tests it again" || fail "2: ${H1:0:12} tested $(count tester "$H1") times"

echo "== 3. a rework (a new head) is tested and reviewed once more =="
wg review reject "$N" --reason "a person wants another line" --to ready >/dev/null 2>&1
daemon_pass
H2="$(branch_head "$N")"
[ -n "$H2" ] && [ "$H2" != "$H1" ] && ok "3: the rework is a new head (${H2:0:12})" || fail "3: no new head (H1=${H1:0:12} H2=${H2:0:12}, status $(st "$N"))"
daemon_pass
_t="$(line_of tester "$H2")"; _r="$(line_of review "$H2")"
[ -n "$_t" ] && [ -n "$_r" ] && [ "$_t" -lt "$_r" ] \
  && ok "3: the new head is tested, then reviewed" || fail "3: order tester=${_t:-never} review=${_r:-never}"
[ "$(count review "$H2")" = 1 ] && ok "3: exactly one review of the new head over two passes" || fail "3: ${H2:0:12} reviewed $(count review "$H2") times"
[ "$(count review "$H1")" = 1 ] && ok "3: the old head is not reviewed again" || fail "3: ${H1:0:12} reviewed $(count review "$H1") times"

echo "== 4. a tester FAIL gets no review =="
echo FAIL > "$CTL/tester-verdict"
M="$(new_ticket "Fails its test" "v stays 1")"
daemon_pass
HM="$(git -C "$R" for-each-ref --format='%(objectname)' "refs/heads/$(wg ticket show "$M" 2>/dev/null | jget 'd.ticket.branch_name || ""')" 2>/dev/null)"
[ "$(count tester "$HM")" -ge 1 ] && ok "4: the tester ran on #$M" || fail "4: the tester did not run on #$M: $(tr '\n' '|' < "$CALLS")"
case "$(st "$M")" in refining|ready) ok "4: the FAIL sent #$M to rework ($(st "$M"))" ;; *) fail "4: #$M is $(st "$M")" ;; esac
[ "$(count review "$HM")" = 0 ] && ok "4: no reviewer was paid for the failing head" || fail "4: ${HM:0:12} reviewed $(count review "$HM") times"
wg review reject "$M" --reason park --to cancelled >/dev/null 2>&1 || wg ticket cancel "$M" >/dev/null 2>&1 || true
echo PASS > "$CTL/tester-verdict"

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

echo "== 7. a rework that resubmits the same commit after CHANGES is not reviewed again, nor stranded =="
echo CHANGES > "$CTL/review-verdict"
# 7a. AFK: the approve gate is earned (the env floor), so a CHANGES verdict reworks.
# The stub's first delivery commits; with $CTL/no-commit every rework after it commits nothing.
export DISPATCH_ALLOW_AGENT_APPROVE=1
: > "$CTL/no-commit"
A="$(new_ticket "Changes then the same commit (AFK)" "v stays 1")"
daemon_pass
HA="$(branch_head "$A")"
[ -n "$HA" ] && [ "$(count review "$HA")" = 1 ] && ok "7a: #$A delivered, tested and reviewed once (CHANGES) at ${HA:0:12}" \
  || fail "7a: setup: #$A head ${HA:-none}, $(count review "$HA") reviews, status $(st "$A")"
grep -q "AFK: #$A → CHANGES; re-queued to ready" "$GAFFER_DATA/factory.log" && ok "7a: the CHANGES verdict sent #$A to rework" || fail "7a: no AFK rework line for #$A"
grep -q "^deliver $HA\$" "$CALLS" && ok "7a: the head is the first delivery's commit (${HA:0:12}); the rework added none" || fail "7a: ${HA:0:12} is not the first delivery's commit"
grep -q "^deliver-nocommit $HA\$" "$CALLS" && ok "7a: the rework ran and committed nothing" || fail "7a: no no-commit rework recorded: $(tail -4 "$CALLS" | tr '\n' '|')"
[ "$(count review "$HA")" = 1 ] && ok "7a: the same commit is not reviewed a second time" || fail "7a: ${HA:0:12} reviewed $(count review "$HA") times"
grep -q "AFK: #$A came back into review on ${HA:0:12} with no new commit after the reviewer's CHANGES" "$GAFFER_DATA/factory.log" \
  && ok "7a: the runner sent it back to rework on the recorded verdict" || fail "7a: no re-queue on the recorded verdict: $(grep "#$A" "$GAFFER_DATA/factory.log" | tail -3 | tr '\n' '|')"
case "$(st "$A")" in in_review) fail "7a: #$A sits in_review with nobody told" ;; *) ok "7a: #$A is not left in review ($(st "$A"))" ;; esac
# A rework that keeps resubmitting the same commit is parked by the retry cap (dispatch's
# reject cap, 3 by default), still with that one review.
daemon_pass
case "$(st "$A")" in blocked|refining) ok "7a: the retry cap parked #$A ($(st "$A")) after the same commit came back again" ;; *) fail "7a: #$A is $(st "$A") after another resubmit of the same commit" ;; esac
[ "$(count review "$HA")" = 1 ] && ok "7a: still one review of ${HA:0:12}" || fail "7a: ${HA:0:12} reviewed $(count review "$HA") times"
unset DISPATCH_ALLOW_AGENT_APPROVE
rm -f "$CTL/no-commit"
wg ticket cancel "$A" >/dev/null 2>&1 || wg wont-do "$A" --reason done >/dev/null 2>&1 || true
# 7b. Supervised: the CHANGES verdict is advisory; a person sends it back; the rework
# resubmits the same commit; a note says the commit waits for a person.
: > "$CTL/no-commit"
B="$(new_ticket "Changes then the same commit (supervised)" "v stays 1")"
daemon_pass
HB="$(branch_head "$B")"
[ -n "$HB" ] && [ "$(count review "$HB")" = 1 ] && [ "$(st "$B")" = in_review ] && ok "7b: #$B reviewed once (advisory CHANGES), in review for a person" \
  || fail "7b: setup: #$B head ${HB:-none}, $(count review "$HB") reviews, status $(st "$B")"
wg review reject "$B" --reason "do what the reviewer said" --to ready >/dev/null 2>&1
daemon_pass
daemon_pass
[ "$(branch_head "$B")" = "$HB" ] && [ "$(st "$B")" = in_review ] && ok "7b: the rework resubmitted the same commit; #$B in review" || fail "7b: head $(branch_head "$B") status $(st "$B")"
[ "$(count review "$HB")" = 1 ] && ok "7b: the same commit is not reviewed a second time" || fail "7b: ${HB:0:12} reviewed $(count review "$HB") times"
_NB="$(wg ticket show "$B" 2>/dev/null | grep -o "agent review: back in review on $HB" | wc -l | tr -d ' ')"
[ "$_NB" -ge 1 ] && ok "7b: the ticket says the commit waits for a person" || fail "7b: no back-in-review note on #$B"
wg ticket show "$B" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);const n=(v.evidence||[]).filter(e=>/^agent review: back in review on /.test(e.summary||"")).length;process.exit(n===1?0:1)})' \
  && ok "7b: said once over two passes" || fail "7b: the note was written more than once"
rm -f "$CTL/no-commit" "$CTL/review-verdict"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "review-once-per-head: ALL $PASS checks passed"; exit 0; fi
echo "review-once-per-head: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1
