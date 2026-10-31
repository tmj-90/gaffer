#!/usr/bin/env bash
# =====================================================================
# FLAKY-TEST RERUN — a red TESTS gate under a parallel pool is rerun ONCE at
# concurrency 1 before the attempt counts (runner/lib/dod.sh, tick.sh).
# ---------------------------------------------------------------------
#   U1 under a pool (GAFFER_CONCURRENCY>1) a tests gate red on run 1 and green on
#      run 2 is PASS, marked flaky-suspected, the note naming both runs, run 1's
#      output kept in a ---DOD-RERUN--- block; the rerun had the serial hints
#   U2 both runs red → FAIL, the note naming both exit codes, exactly one rerun
#   U3 no pool (GAFFER_CONCURRENCY=1) → no rerun, FAIL as before
#   U4 only the tests gate: a red lint or typecheck gate is never rerun
#   U5 GAFFER_DOD_FLAKY_RERUN=0 → no rerun
#   U6 the serial lock held by a live process → no rerun, run 1 stands (fail closed)
#   U7 the rerun waits for another worker's in-flight gate run; a dead marker is ignored
#   U8 the evidence summary carries `flaky: true` and both runs
#   U9 with gate integrity (a base commit): column 7 is the command's `source`, the
#      flaky mark is column 8, and the rerun runs the SAME base-pinned command (the
#      delivery's rewritten `scripts.test` never runs); the JSON carries both
#   E2E one real tick.sh delivery under GAFFER_CONCURRENCY=2 whose repo's tests fail
#      once: the ticket reaches in_review WITHOUT a rework attempt, the DoD evidence
#      says flaky suspected and a needs_human_review note is filed
# Run: bash runner/test/dod-flaky-rerun.test.sh   (bash 3.2 safe)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
DISPATCH_CLI="$ROOT/packages/dispatch/dist/cli/index.js"
MEMORY_CLI="$ROOT/packages/memory/dist/bin/memory.js"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/dod-flaky.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
SLEEPER=""
trap '[ -n "$SLEEPER" ] && kill "$SLEEPER" 2>/dev/null; gaffer_test_rm_work "$WORK"' EXIT

(
gaffer_timeout() { local s="$1"; shift; "$@"; return $?; }
# shellcheck source=../lib/dod.sh
source "$RUNNER_DIR/lib/dod.sh"
export GAFFER_DATA="$WORK/data"; mkdir -p "$GAFFER_DATA"
WT="$WORK/wt"; mkdir -p "$WT"
# A test command that fails on its first N runs, then passes; it logs each run's
# GAFFER_DOD_SERIAL so the serial hint can be checked.
flaky_cmd() { printf 'n=$(cat %s/count 2>/dev/null || echo 0); n=$((n+1)); echo $n > %s/count; echo "run $n serial=${GAFFER_DOD_SERIAL:-0}" >> %s/runs; echo "FAIL flaky.test > race"; [ $n -gt %s ]' "$WORK" "$WORK" "$WORK" "$1"; }
runs() { cat "$WORK/count" 2>/dev/null || echo 0; }
reset() { rm -f "$WORK/count" "$WORK/runs"; }
row() { printf 'repo\t%s\t1\t1\t1\t%s\t%s\t%s\n' "$WT" "$1" "${2:--}" "${3:--}"; }
gate_line() { grep "^GATE	$1	" "$2"; }

echo "== U1: red then green under a pool → PASS, flaky suspected =="
reset; RES="$WORK/u1"
row "$(flaky_cmd 1)" | GAFFER_CONCURRENCY=3 gaffer_run_dod_gates "$RES"; rc=$?
L="$(gate_line tests "$RES")"
[ "$rc" = 0 ] && ok "U1 the gate passes" || fail "U1 rc=$rc"
[ "$(runs)" = 2 ] && ok "U1 exactly one rerun" || fail "U1 runs=$(runs)"
case "$L" in *"	PASS	0	pass-on-retry (flaky suspected): run 1 exited 1 under a pool of 3; run 2 at concurrency 1 passed: "*"	flaky-suspected") ok "U1 PASS, both runs named, marked flaky-suspected" ;; *) fail "U1 line: $L" ;; esac
# Column 7 is gate integrity's `source` (empty without a base), column 8 the mark.
COLS="$(printf '%s\n' "$L" | awk -F'\t' '{print NF "|" $7 "|" $8}')"
[ "$COLS" = "8||flaky-suspected" ] && ok "U1 the mark is column 8, after an empty source column 7" || fail "U1 columns: $COLS"
grep -q '^---DOD-RERUN tests@repo (run 1, exit 1, pool of 3)---$' "$RES" && grep -q 'FAIL flaky.test > race' "$RES" \
  && ok "U1 run 1's output is kept in a DOD-RERUN block" || fail "U1 no DOD-RERUN block: $(cat "$RES")"
grep -q '^---DOD-OUTPUT ' "$RES" && fail "U1 a passing gate left a failure block" || ok "U1 no failure block (nothing for the rework feedback)"
grep -q '^run 2 serial=1$' "$WORK/runs" && grep -q '^run 1 serial=0$' "$WORK/runs" \
  && ok "U1 the rerun ran with GAFFER_DOD_SERIAL=1, run 1 without" || fail "U1 serial hint: $(cat "$WORK/runs")"
[ ! -d "$GAFFER_DATA/.dod-serial/rerun.lock" ] && ok "U1 the serial lock is released" || fail "U1 lock left behind"

echo "== U8: the evidence summary =="
EV="$(gaffer_dod_evidence_summary "$RES" PASS)"
node -e 'const j=JSON.parse(process.argv[1].split("\n")[1]);const g=j.gates.find(x=>x.gate==="tests");process.exit(g&&g.flaky===true&&g.status==="PASS"&&/run 1 exited 1/.test(g.note)?0:1)' "$EV" \
  && ok "U8 the JSON gate carries flaky:true and both runs" || fail "U8 json: $(printf '%s' "$EV" | sed -n 2p)"
case "$EV" in *"---DOD-RERUN tests@repo"*"FAIL flaky.test > race"*"---END-DOD-RERUN---"*) ok "U8 the transcript keeps run 1's output" ;; *) fail "U8 transcript: $EV" ;; esac
EV0="$(gaffer_dod_evidence_summary "$WORK/none" PASS)"
node -e 'const j=JSON.parse(process.argv[1].split("\n")[1]);process.exit(j.gates.length===0?0:1)' "$EV0" && ok "U8 an empty results file still parses" || fail "U8 empty"

echo "== U2: red twice → FAIL naming both runs =="
reset; RES="$WORK/u2"
row "$(flaky_cmd 9)" | GAFFER_CONCURRENCY=2 gaffer_run_dod_gates "$RES"; rc=$?
L="$(gate_line tests "$RES")"
[ "$rc" != 0 ] && ok "U2 the gate fails" || fail "U2 passed"
[ "$(runs)" = 2 ] && ok "U2 only one rerun" || fail "U2 runs=$(runs)"
case "$L" in *"	FAIL	1	exited 1: "*"(run 1 exited 1 under a pool of 2; run 2 at concurrency 1 also failed)") ok "U2 the note names both runs" ;; *) fail "U2 line: $L" ;; esac
grep -q '^---DOD-OUTPUT tests@repo---$' "$RES" && ok "U2 the failure block is there for the rework feedback" || fail "U2 no failure block"

echo "== U3: no pool → no rerun =="
reset; RES="$WORK/u3"
row "$(flaky_cmd 1)" | GAFFER_CONCURRENCY=1 gaffer_run_dod_gates "$RES"; rc=$?
[ "$rc" != 0 ] && [ "$(runs)" = 1 ] && ok "U3 concurrency 1: FAIL, never rerun" || fail "U3 rc=$rc runs=$(runs)"
reset
row "$(flaky_cmd 1)" | ( unset GAFFER_CONCURRENCY; gaffer_run_dod_gates "$RES" ); rc=$?
[ "$rc" != 0 ] && [ "$(runs)" = 1 ] && ok "U3 unset: FAIL, never rerun" || fail "U3 unset rc=$rc runs=$(runs)"

echo "== U4: only the tests gate =="
reset; RES="$WORK/u4"
row "true" "-" "$(flaky_cmd 1)" | GAFFER_CONCURRENCY=3 gaffer_run_dod_gates "$RES"; rc=$?
[ "$rc" != 0 ] && [ "$(runs)" = 1 ] && ok "U4 a red lint gate is not rerun" || fail "U4 lint rc=$rc runs=$(runs)"
reset
row "true" "$(flaky_cmd 1)" "-" | GAFFER_CONCURRENCY=3 gaffer_run_dod_gates "$RES"; rc=$?
[ "$rc" != 0 ] && [ "$(runs)" = 1 ] && ok "U4 a red typecheck gate is not rerun" || fail "U4 typecheck rc=$rc runs=$(runs)"

echo "== U5: the off switch =="
reset; RES="$WORK/u5"
row "$(flaky_cmd 1)" | GAFFER_CONCURRENCY=3 GAFFER_DOD_FLAKY_RERUN=0 gaffer_run_dod_gates "$RES"; rc=$?
[ "$rc" != 0 ] && [ "$(runs)" = 1 ] && ok "U5 GAFFER_DOD_FLAKY_RERUN=0 → no rerun" || fail "U5 rc=$rc runs=$(runs)"

echo "== U6: the serial lock is held → run 1 stands =="
reset; RES="$WORK/u6"
sleep 30 & SLEEPER=$!
mkdir -p "$GAFFER_DATA/.dod-serial/rerun.lock"; echo "$SLEEPER" > "$GAFFER_DATA/.dod-serial/rerun.lock/pid"
# The first gate run waits for a held lock before it starts; bound both waits.
row "$(flaky_cmd 1)" | GAFFER_CONCURRENCY=3 GAFFER_DOD_TIMEOUT=2 gaffer_run_dod_gates "$RES"; rc=$?
L="$(gate_line tests "$RES")"
[ "$rc" != 0 ] && [ "$(runs)" = 1 ] && ok "U6 no rerun without the lock: FAIL" || fail "U6 rc=$rc runs=$(runs)"
case "$L" in *"could not take the serial lock in time, so run 1 stands"*) ok "U6 the note says why" ;; *) fail "U6 line: $L" ;; esac
[ -d "$GAFFER_DATA/.dod-serial/rerun.lock" ] && ok "U6 another holder's lock is left alone" || fail "U6 removed a live holder's lock"
kill "$SLEEPER" 2>/dev/null; wait "$SLEEPER" 2>/dev/null; SLEEPER=""
reset
row "$(flaky_cmd 1)" | GAFFER_CONCURRENCY=3 gaffer_run_dod_gates "$RES"; rc=$?
[ "$rc" = 0 ] && [ "$(runs)" = 2 ] && ok "U6 a dead holder's lock is reaped and the rerun runs" || fail "U6 reap rc=$rc runs=$(runs)"

echo "== U7: the rerun waits for another worker's in-flight gate run =="
reset; RES="$WORK/u7"
mkdir -p "$GAFFER_DATA/.dod-serial/running"
( sleep 3; date +%s > "$WORK/other-done" ) & OTHER=$!
: > "$GAFFER_DATA/.dod-serial/running/$OTHER"
: > "$GAFFER_DATA/.dod-serial/running/999999"   # a dead worker's marker
CMD="date +%s >> $WORK/started; $(flaky_cmd 1)"
row "$CMD" | GAFFER_CONCURRENCY=3 GAFFER_DOD_RERUN_WAIT=20 gaffer_run_dod_gates "$RES"; rc=$?
wait "$OTHER" 2>/dev/null
R2="$(sed -n 2p "$WORK/started" 2>/dev/null)"; DONE="$(cat "$WORK/other-done" 2>/dev/null)"
[ "$rc" = 0 ] && [ -n "$R2" ] && [ -n "$DONE" ] && [ "$R2" -ge "$DONE" ] \
  && ok "U7 the rerun started after the other in-flight gate run finished" || fail "U7 rc=$rc rerun=$R2 other=$DONE"
[ ! -e "$GAFFER_DATA/.dod-serial/running/999999" ] && ok "U7 a dead worker's marker is cleared" || fail "U7 stale marker kept"

echo "== U9: gate integrity: source in column 7, the mark in 8, the rerun base-pinned =="
CREW_DIR="$ROOT/packages/crew"; export CREW_DIR
if [ -f "$CREW_DIR/dist/runtime/dod/gateIntegrityCli.js" ]; then
  reset; RES="$WORK/u9"; R9="$WORK/r9"; mkdir -p "$R9"
  # The base's `test` script fails on its first run, then passes; the delivery rewrites
  # it to always fail. Base-pinned, both runs execute the base body.
  printf '%s\n' "$(flaky_cmd 1)" > "$WORK/flaky.sh"
  git -C "$R9" init -q -b main
  printf '{"name":"r9","scripts":{"test":"sh %s"}}\n' "$WORK/flaky.sh" > "$R9/package.json"
  git -C "$R9" add -A && git -C "$R9" -c user.email=t@t -c user.name=t commit -qm base
  BASE9="$(git -C "$R9" rev-parse HEAD)"
  printf '{"name":"r9","scripts":{"test":"exit 1"}}\n' > "$R9/package.json"
  git -C "$R9" -c user.email=t@t -c user.name=t commit -qam "rewrite the test script"
  printf 'repo\t%s\t1\t0\t0\tnpm test\t-\t-\t%s\t0\n' "$R9" "$BASE9" | GAFFER_CONCURRENCY=3 gaffer_run_dod_gates "$RES"; rc=$?
  L="$(gate_line tests "$RES")"
  COLS="$(printf '%s\n' "$L" | awk -F'\t' '{print NF "|" $4 "|" $8}')"
  SRC="$(printf '%s\n' "$L" | awk -F'\t' '{print $7}')"
  [ "$rc" = 0 ] && [ "$(runs)" = 2 ] && ok "U9 the base-pinned script ran twice and passed on the rerun" || fail "U9 rc=$rc runs=$(runs): $(cat "$RES")"
  [ "$COLS" = "8|PASS|flaky-suspected" ] && ok "U9 the PASS row carries the mark in column 8" || fail "U9 columns: $COLS"
  case "$SRC" in base-pinned*) ok "U9 column 7 is the source (base-pinned)" ;; *) fail "U9 source: $SRC" ;; esac
  EV="$(gaffer_dod_evidence_summary "$RES" PASS)"
  node -e 'const j=JSON.parse(process.argv[1].split("\n")[1]);const g=j.gates.find(x=>x.gate==="tests");process.exit(g&&g.flaky===true&&/^base-pinned/.test(g.source||"")?0:1)' "$EV" \
    && ok "U9 the JSON gate carries source and flaky:true" || fail "U9 json: $(printf '%s' "$EV" | sed -n 2p)"
else
  fail "U9 crew dist not built (pnpm -r build)"
fi

echo "## UNIT $PASS ${#FAILURES[@]}"
for f in ${FAILURES[@]+"${FAILURES[@]}"}; do echo "## FAIL $f"; done
) > "$WORK/unit.out" 2>&1
grep -v '^## ' "$WORK/unit.out"
UP="$(sed -n 's/^## UNIT \([0-9]*\) .*/\1/p' "$WORK/unit.out")"; PASS=$((PASS + ${UP:-0}))
while IFS= read -r l; do FAILURES+=("${l#\#\# FAIL }"); done < <(grep '^## FAIL ' "$WORK/unit.out")
[ -n "$UP" ] || FAILURES+=("the unit section did not finish")

echo "== E2E: one real delivery tick under a pool of 2 =="
if [ -f "$DISPATCH_CLI" ] && command -v git >/dev/null 2>&1 && node --input-type=commonjs -e "require('node:sqlite')" 2>/dev/null; then
  REPO="$WORK/widget"; mkdir -p "$REPO/test"
  # The repo's tests fail once (a counter OUTSIDE the worktree), then pass.
  printf '#!/bin/sh\nn=$(cat %s/e2e-count 2>/dev/null || echo 0); n=$((n+1)); echo $n > %s/e2e-count\n[ $n -ge 2 ] || { echo "FAIL race.test > shared port"; exit 1; }\necho ok\n' "$WORK" "$WORK" > "$REPO/flaky-test.sh"
  chmod +x "$REPO/flaky-test.sh"
  printf '{"name":"widget","version":"1.0.0","private":true}\n' > "$REPO/package.json"
  git -C "$REPO" init -q -b main
  git -C "$REPO" -c user.email=t@e -c user.name=t -c commit.gpgsign=false add -A
  git -C "$REPO" -c user.email=t@e -c user.name=t -c commit.gpgsign=false commit -qm init
  export GAFFER_DATA="$WORK/e2e-data"; mkdir -p "$GAFFER_DATA"
  export DISPATCH_DB="$GAFFER_DATA/dispatch.sqlite" MEMORY_DB="$GAFFER_DATA/memory.sqlite"
  node "$DISPATCH_CLI" --db "$DISPATCH_DB" init >/dev/null
  [ -f "$MEMORY_CLI" ] && node "$MEMORY_CLI" init >/dev/null 2>&1
  node "$DISPATCH_CLI" --db "$DISPATCH_DB" repo add -n widget --path "$REPO" --branch main --stack node --test "sh ./flaky-test.sh" >/dev/null
  TID="$(node "$DISPATCH_CLI" --db "$DISPATCH_DB" ticket create -t "Add DELIVERED marker" -d "Add DELIVERED.txt." --risk low 2>/dev/null |
    node -e 'let r="";process.stdin.on("data",c=>r+=c);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(r).ticket.id)}catch{}})')"
  node -e '
const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.DISPATCH_DB);
const rid=db.prepare("select id from repositories where name=?").get("widget").id;
db.prepare("insert into ticket_repos(ticket_id,repo_id,role,access,relation,source) values(?,?,?,?,?,?)").run(process.argv[1],rid,"primary","write","confirmed","manual");
db.prepare("insert into acceptance_criteria(id,ticket_id,text,sort_order) values(?,?,?,0)").run("ac-1",process.argv[1],"DELIVERED.txt exists");
' "$TID"
  node "$DISPATCH_CLI" --db "$DISPATCH_DB" ticket ready "$TID" >/dev/null 2>&1
  mkdir -p "$WORK/bin"
  cat > "$WORK/bin/claude" <<'SH'
#!/bin/sh
printf 'delivered\n' > DELIVERED.txt
git add -A >/dev/null 2>&1; git -c user.email=f@a -c user.name=f -c commit.gpgsign=false commit -qm "deliver: add DELIVERED.txt" >/dev/null 2>&1
printf '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"Added DELIVERED.txt.\\n\\nSmallest-change note: one file.","stop_reason":"end_turn","total_cost_usd":0.01}\n'
SH
  chmod +x "$WORK/bin/claude"
  CLAUDE_BIN="$WORK/bin/claude" GAFFER_PLAN_MODEL=none GAFFER_IMPL_MODEL=none GAFFER_CONCURRENCY=2 \
    DRY_RUN=0 GAFFER_ALLOW_UNCAPPED=1 GAFFER_TICK_TIMEOUT=120 GAFFER_DOD_INSTALL=0 \
    bash "$RUNNER_DIR/tick.sh" > "$WORK/tick.log" 2>&1 || true
  q() { node -e 'const{DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.DISPATCH_DB);const r=db.prepare(process.argv[1]).all(process.argv[2]);process.stdout.write(JSON.stringify(r))' "$1" "$TID"; }
  ST="$(q 'select status from tickets where id=?')"
  case "$ST" in *'"in_review"'*) ok "E2E the ticket reached in_review" ;; *) fail "E2E status: $ST" ;; esac
  [ "$(cat "$WORK/e2e-count" 2>/dev/null)" = 2 ] && ok "E2E the repo's tests ran twice (one rerun)" || fail "E2E test runs: $(cat "$WORK/e2e-count" 2>/dev/null)"
  RW="$(q 'select count(*) n from rework_attempts where ticket_id=?')"
  case "$RW" in *'"n":0'*) ok "E2E no rework attempt was counted" ;; *) fail "E2E rework attempts: $RW" ;; esac
  DE="$(q "select summary from evidence where ticket_id=? and evidence_type='test_output' and summary like 'DoD: PASS%'")"
  node -e 'const rows=JSON.parse(process.argv[1]);const j=JSON.parse(rows[rows.length-1].summary.split("\n")[1]);const g=j.gates.find(x=>x.gate==="tests");process.exit(g&&g.flaky===true?0:1)' "$DE" \
    && ok "E2E the DoD evidence marks the tests gate flaky suspected" || fail "E2E DoD evidence: $DE"
  NH="$(q "select summary from evidence where ticket_id=? and evidence_type='manual_note' and summary like 'needs_human_review: flaky%'")"
  [ "$NH" != "[]" ] && ok "E2E a needs_human_review note flags it for the reviewer" || fail "E2E no flaky flag note"
  grep -q 'flaky suspected; flagging needs_human_review' "$WORK/tick.log" && ok "E2E the tick log says so" || fail "E2E log: $(grep 'DoD' "$WORK/tick.log" | tail -3)"
else
  echo "  SKIP E2E (dispatch CLI not built, or git / node:sqlite missing)"
fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "dod-flaky-rerun: all $PASS passed"; exit 0; fi
echo "dod-flaky-rerun: ${#FAILURES[@]} FAILED (of $((PASS + ${#FAILURES[@]})))"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
[ -f "$WORK/tick.log" ] && { echo "--- tick.log tail ---"; tail -25 "$WORK/tick.log"; }
exit 1
