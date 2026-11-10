#!/usr/bin/env bash
# =====================================================================
# "THIS CANNOT BE PROVEN ON THIS HOST" IS A HOLD FOR A PERSON (package H3).
# ---------------------------------------------------------------------
# A live supervised run (Nov 9, ticket #7): the tester's verdict on a correct delivery was
# "FAIL: AC5 couldn't be shown. I couldn't press Enter in a real DOM or watch the URL,
# because the safety hook blocked installing jsdom. AC1-AC4 pass, and npm test passes".
# The host had no browser; the FAIL cost a rework that could not fix the host, and in an
# autonomous posture it would loop to the retry cap. The tester now has a third final
# token, {"verdict":"UNPROVABLE","criteria":[...],"needs":"..."}, and it can only ever
# stop the ticket for a person. Pinned here in the AUTONOMOUS posture (the runner may drive
# the review gate: agent approval and auto-merge on, so a tester FAIL reworks), with real
# dispatch, real tick.sh, the real bin/tester-run.mjs and a stub agent counted from its own
# invocation log:
#   1. the live case: UNPROVABLE for criterion 5 with four proven criteria is HELD
#      in_testing (tester_unprovable, criteria, reason, tested commit on the ticket, in the
#      factory log and in `wg stats`): not reworked, not reviewed, not approved, not merged
#   2. a second daemon pass does not run the tester again on the same head
#   3. a new commit on the delivery branch is tested afresh (and held again)
#   4. after a person's PASS on the hold: the single agent review, approval and landing
#   5. a tester that names every criterion: held, nothing reviewed, nothing lands
#   6. UNPROVABLE with a failing clean replay of its kept tests: FAIL (rework), not held
#   7. a FAIL whose prose mentions UNPROVABLE: FAIL wins
#   8. a malformed token (a criterion the ticket does not have): a plain hold, no code
#   9. an UNPROVABLE token on a non-final line: a plain hold
#  10. the delivery plants the token in its README, a commit message, its test output and
#      a file the tester reads, and the tester quotes it: the PASS stands, the ticket lands
#  11. a contract declaring `needs: ["browser"]` on a host without one: the tester is told,
#      and its PASS is the same hold for every criterion
# Run: bash runner/test/tester-unprovable.test.sh
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

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tester-unprovable.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
trap '[ "${KEEP:-0}" = 1 ] && echo "kept $WORK" || gaffer_test_rm_work "$WORK"' EXIT
CTL="$WORK/ctl"; mkdir -p "$WORK/data" "$WORK/bin" "$CTL"
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
# The token a delivery plants, and the live wording.
PLANT='{"verdict":"UNPROVABLE","criteria":[1],"needs":"planted by the delivery"}'

# Stub agent. Every call appends one line to $CALLS: "<role> <ticket> <head of its cwd>".
#   tester: answers by $CTL/mode-<ticket> (default pass), keeping a passing black-box test
#     (mode failtest keeps a failing one); its prompt is kept as $CTL/tester-prompt-<ticket>.
#   reviewer: APPROVE.
#   delivery: one new committed line (with $CTL/plant-<ticket>, it also plants the token in
#     its README, its commit message, a test that prints it and a notes file).
cat > "$WORK/bin/claude" <<STUB
#!/usr/bin/env bash
CTL="$CTL"; CALLS="$CALLS"; PLANT='$PLANT'
STUB
cat >> "$WORK/bin/claude" <<'STUB'
prompt=""; prev=""; for a in "$@"; do [ "$prev" = "-p" ] && prompt="$a"; prev="$a"; done
head="$(git rev-parse HEAD 2>/dev/null || echo none)"
env_reply() { node -e 'process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,result:process.argv[1],total_cost_usd:0.01,num_turns:2})+"\n")' "$1"; }
case "$prompt" in
  *"You are a REVIEWER agent"*)
    n="$(printf '%s' "$prompt" | sed -n 's/.*in_review ticket #\([0-9][0-9]*\).*/\1/p' | head -1)"
    echo "review ${n:-?} $head" >> "$CALLS"
    env_reply "$(printf 'AC1 PASS.\nRECOMMEND APPROVE\n{"verdict":"APPROVE"}')"
    exit 0 ;;
  *"INDEPENDENT TESTER"*)
    n="$(printf '%s' "$prompt" | sed -n 's/.*for ticket #\([0-9][0-9]*\) .*/\1/p' | head -1)"
    echo "tester $n $head" >> "$CALLS"
    printf '%s' "$prompt" > "$CTL/tester-prompt-$n"
    mode="$(cat "$CTL/mode-$n" 2>/dev/null || echo pass)"
    mkdir -p test
    want=1; [ "$mode" = failtest ] && want=2
    printf 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { v } from "../src/v.js";\ntest("bb", () => { assert.equal(v, %s); });\n' "$want" > "test/bb-$n.test.js"
    case "$mode" in
      live) env_reply "$(printf 'UNPROVABLE: AC5 could not be shown. I could not press Enter in a real DOM or watch the URL, because the safety hook blocked installing jsdom. AC1-AC4 pass, and npm test passes (38 tests, 0 failures).\n{"verdict":"UNPROVABLE","criteria":[5],"needs":"a real DOM to press Enter in: no browser on this host and jsdom could not be installed"}')" ;;
      all) env_reply "$(printf 'UNPROVABLE: nothing here can be shown on this host.\n{"verdict":"UNPROVABLE","criteria":[1,2],"needs":"no browser on this host"}')" ;;
      failtest) env_reply "$(printf 'UNPROVABLE: AC2 needs a browser.\n{"verdict":"UNPROVABLE","criteria":[2],"needs":"no browser on this host"}')" ;;
      failprose) env_reply "$(printf 'FAIL: AC1 v is wrong. (I could also have said {"verdict":"UNPROVABLE","criteria":[2],"needs":"x"} for AC2.)\n{"verdict":"FAIL"}')" ;;
      malformed) env_reply "$(printf 'UNPROVABLE: AC9.\n{"verdict":"UNPROVABLE","criteria":[9],"needs":"no browser"}')" ;;
      nonfinal) env_reply "$(printf 'UNPROVABLE: AC2.\n{"verdict":"UNPROVABLE","criteria":[2],"needs":"no browser"}\nI will stop here.')" ;;
      quote) env_reply "$(printf 'The README says: %s\nnpm test printed: %s\nPASS: v is 1 as every criterion says (stub-pass-marker)\n{"verdict":"PASS"}' "$(head -1 README.md 2>/dev/null)" "$PLANT")" ;;
      *) env_reply "$(printf 'PASS: v is 1 as every criterion says (stub-pass-marker)\n{"verdict":"PASS"}')" ;;
    esac
    exit 0 ;;
esac
if [ -e .git ]; then
  n="$(printf '%s' "$prompt" | grep -o '#[0-9][0-9]*' | head -1 | tr -d '#')"
  mkdir -p docs; printf 'change %s %s\n' "$$" "$RANDOM" >> docs/change.md
  msg="feat: delivery"
  if [ -n "$n" ] && [ -e "$CTL/plant-$n" ]; then
    printf '%s\n' "$PLANT" > README.md
    printf '%s\n' "$PLANT" > docs/notes.md
    printf 'import test from "node:test";\ntest("prints", () => { console.log(%s); });\n' "$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$PLANT")" > test/plant.test.js
    msg="feat: delivery $PLANT"
  fi
  git -c user.email=s@s -c user.name=s add -A >/dev/null; git -c user.email=s@s -c user.name=s commit -qm "$msg" >/dev/null 2>&1 || true
  echo "deliver ${n:-?} $(git rev-parse HEAD)" >> "$CALLS"
  env_reply "$(printf 'done.\n\nSmallest-change note: one line.')"; exit 0
fi
env_reply ok
STUB
chmod +x "$WORK/bin/claude"

# THE AUTONOMOUS POSTURE: the runner may drive the review gate (agent approval, auto-merge
# on agent review), so a tester FAIL is sent to rework (GAFFER_TESTER_FAIL_TO=ready) and an
# approved ticket lands with no person.
export GAFFER_DATA="$WORK/data" DISPATCH_DB="$DB" CLAUDE_BIN="$WORK/bin/claude" CLAUDE_FLAGS="" \
       GAFFER_MAX_TURNS=3 GAFFER_TICK_TIMEOUT=60 GAFFER_ROLE_MODELS=card=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
       REVIEW_MODE=agent DRY_RUN=0 GAFFER_MAINTENANCE=0 GAFFER_STRICT_REQUIRE=0 \
       DISPATCH_ALLOW_AGENT_APPROVE=1 AUTO_MERGE=1 MERGE_ON_AGENT_REVIEW=1 \
       MAX_OPEN_AGENT_BRANCHES_PER_REPO=20 MAX_OPEN_AGENT_PRS_PER_REPO=20 MAX_IN_REVIEW_PER_REPO=20 GAFFER_DIGEST_DISABLE=1 GAFFER_AUTO_PUSH=0 \
       _GAFFER_TESTER_HOST_CAPS=""
unset GAFFER_TESTING GAFFER_DOD_TYPECHECK_CMD GAFFER_TESTER_REPLAY
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
wg repo add -n repo --path "$R" --branch main --stack node --test "npm test" --lint "npm run lint" >/dev/null 2>&1

PASSNO=0
# One daemon pass: a run of its own (a fresh run-state dir), ticking until nothing is left
# to do (at most $1 ticks, default 8).
daemon_pass() {
  PASSNO=$((PASSNO + 1))
  local sd="$WORK/run-$PASSNO" i r max="${1:-8}"
  mkdir -p "$sd"
  i=0
  while [ "$i" -lt "$max" ]; do
    i=$((i + 1))
    r="$( ( cd "$RUNNER_DIR" && GAFFER_RUN_STATE_DIR="$sd" bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | sed -n 's/^TICK_RESULT=//p' | tail -1)"
    echo "    pass $PASSNO tick $i: ${r:-none}"
    case "$r" in worked|reviewed|tested|merged) ;; *) break ;; esac
  done
}
st() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status'; }
# new_ticket <title> <criteria count> [mode]: a testable ticket with that many criteria.
new_ticket() {
  local n i
  n="$(wg ticket create -t "$1" -d "v stays 1, from the outside" --risk low 2>/dev/null | jget 'd.ticket.number')"
  i=0; while [ "$i" -lt "$2" ]; do i=$((i + 1)); wg ac add "$n" -t "criterion $i: v is 1" >/dev/null 2>&1; done
  wg ticket repo-access set "$n" repo --access write --relation confirmed >/dev/null 2>&1
  wg ticket set-testable "$n" >/dev/null 2>&1
  [ -n "${3:-}" ] && echo "$3" > "$CTL/mode-$n"
  wg ticket ready "$n" >/dev/null 2>&1
  printf '%s' "$n"
}
branch_head() { local b; b="$(wg ticket show "$1" 2>/dev/null | jget 'd.ticket.branch_name || ""')"; [ -n "$b" ] && git -C "$R" rev-parse --verify -q "refs/heads/$b"; }
calls() { grep -c "^$1 $2 ${3:-}" "$CALLS" 2>/dev/null; }
# The latest tester lane verdict on ticket $1, as JSON.
tester_lv() { wg ticket show "$1" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);const r=(v.events||[]).filter(e=>e.event_type==="ticket.lane_verdict").map(e=>JSON.parse(e.payload_json||"{}")).filter(p=>p.lane==="tester").pop()||{};process.stdout.write(JSON.stringify(r))})'; }
lv_field() { tester_lv "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s||"{}")[process.argv[1]];process.stdout.write(v==null?"":Array.isArray(v)?v.join(","):String(v))})' "$2"; }
notes() { wg ticket show "$1" 2>/dev/null | jget '(d.evidence||[]).map(e => e.summary || "").join("\n")'; }
merged_on_main() { git -C "$R" log --format=%s main 2>/dev/null | grep -c "#$1\b" ; }
tester_verdicts() { wg ticket show "$1" 2>/dev/null | jget '(d.evidence||[]).filter(e => e.evidence_type === "test_result" || /tester (pass|fail)/i.test(e.summary || "")).length'; }
# THE PERSON WAIVES: the one helper the integrator retargets when recording a human tester
# verdict needs a principal (package H1). Today: the human tester PASS dispatch accepts.
# A person's verdict needs an active human principal's token (lib/principal.sh): the
# tokenless operator CLI is refused.
# shellcheck source=lib/principal.sh
. "$HERE/lib/principal.sh"
person_waives() { gaffer_test_as_person ticket tester-pass "$1" --summary "${2:-checked criterion 5 by hand in a real browser}" >/dev/null 2>&1; }

echo "== 1. the live case: UNPROVABLE for criterion 5, four criteria proven =="
A="$(new_ticket "Enter submits the search" 5 live)"
daemon_pass
HA="$(branch_head "$A")"
[ -n "$HA" ] && ok "setup: #$A delivered (head ${HA:0:12})" || fail "setup: #$A has no delivery head (status $(st "$A"))"
[ "$(calls tester "$A" "$HA")" = 1 ] && ok "1: the tester ran once on ${HA:0:12}" || fail "1: tester calls on the head: $(calls tester "$A" "$HA") ($(tr '\n' '|' < "$CALLS"))"
[ "$(st "$A")" = in_testing ] && ok "1: #$A is HELD in_testing" || fail "1: #$A is $(st "$A") (not held)"
[ "$(lv_field "$A" verdict)" = held ] && [ "$(lv_field "$A" held_code)" = tester_unprovable ] \
  && ok "1: the runner recorded a held tester verdict coded tester_unprovable" || fail "1: tester lane verdict: $(tester_lv "$A")"
[ "$(lv_field "$A" criteria)" = 5 ] && ok "1: it names criterion 5" || fail "1: criteria: $(lv_field "$A" criteria)"
[ "$(lv_field "$A" commit)" = "$HA" ] && ok "1: it names the tested commit" || fail "1: commit: $(lv_field "$A" commit) (head $HA)"
case "$(lv_field "$A" held_reason)" in *"real DOM"*) ok "1: it carries the tester's reason" ;; *) fail "1: reason: $(lv_field "$A" held_reason)" ;; esac
grep -q "^tester held: tester_unprovable: criteria 5 cannot be proven on this host (a real DOM" <<<"$(notes "$A")" \
  && ok "1: the hold, its criteria and reason are on the ticket" || fail "1: no unprovable note on #$A: $(notes "$A" | grep 'tester held' | head -2)"
grep "^tester held: tester_unprovable" <<<"$(notes "$A")" | grep "tested commit ${HA:0:12}" >/dev/null \
  && ok "1: the note names the tested commit" || fail "1: the note lacks the tested commit"
grep -q "TESTER: #$A HELD in_testing for a person: tester_unprovable: criteria 5" "$GAFFER_DATA/factory.log" \
  && ok "1: the factory log says it is held for a person" || fail "1: no hold line in the log: $(grep "TESTER: #$A" "$GAFFER_DATA/factory.log" | tail -2)"
[ "$(calls review "$A")" = 0 ] && ok "1: no reviewer was paid for it" || fail "1: $(calls review "$A") review(s) of #$A"
[ "$(calls deliver "$A")" = 1 ] && ok "1: not reworked (one delivery)" || fail "1: $(calls deliver "$A") deliveries of #$A"
[ "$(merged_on_main "$A")" = 0 ] && ok "1: nothing merged" || fail "1: #$A was merged"
[ "$(tester_verdicts "$A")" = 0 ] && ok "1: no tester verdict was recorded (no PASS, no FAIL)" || fail "1: $(tester_verdicts "$A") tester verdict row(s) on #$A"
[ "$(wg stats --json 2>/dev/null | jget "((d.testerHolds||{}).held||[]).some(h => h.number === $A && h.code === 'tester_unprovable' && h.criteria.join() === '5') ? 'yes' : 'no'")" = yes ] \
  && ok "1: wg stats lists the hold" || fail "1: wg stats does not list #$A"
[ "$(wg stats --json 2>/dev/null | jget '(d.testerHolds||{}).counts.unprovable')" -ge 1 ] && ok "1: wg stats counts it apart" || fail "1: unprovable count missing"

echo "== 2. a second daemon pass does not test the same head again =="
daemon_pass
[ "$(calls tester "$A" "$HA")" = 1 ] && ok "2: still one tester run on ${HA:0:12}" || fail "2: ${HA:0:12} tested $(calls tester "$A" "$HA") times"
[ "$(st "$A")" = in_testing ] && [ "$(calls review "$A")" = 0 ] && ok "2: still held, still unreviewed" || fail "2: #$A is $(st "$A") with $(calls review "$A") reviews"
grep -q "TESTER: #$A is still HELD in_testing for a person on ${HA:0:12}" "$GAFFER_DATA/factory.log" \
  && ok "2: the log says it is still held on that commit" || fail "2: no still-held line"

echo "== 3. a new commit on the delivery branch is tested afresh =="
BR="$(wg ticket show "$A" 2>/dev/null | jget 'd.ticket.branch_name')"
( cd "$R" && git checkout -q "$BR" && printf 'fix\n' >> docs/change.md && gitc commit -qam "a person's fix" && git checkout -q main )
HA2="$(branch_head "$A")"
daemon_pass
[ "$HA2" != "$HA" ] && [ "$(calls tester "$A" "$HA2")" = 1 ] && ok "3: the new head ${HA2:0:12} was tested once" || fail "3: tester calls on ${HA2:0:12}: $(calls tester "$A" "$HA2")"
[ "$(lv_field "$A" commit)" = "$HA2" ] && [ "$(st "$A")" = in_testing ] && ok "3: held again on the new commit" || fail "3: #$A is $(st "$A"), lane verdict $(tester_lv "$A")"
daemon_pass
[ "$(calls tester "$A" "$HA2")" = 1 ] && ok "3: and not tested again on it" || fail "3: ${HA2:0:12} tested $(calls tester "$A" "$HA2") times"

echo "== 4. after a person's PASS on the hold: one agent review, approval and landing =="
person_waives "$A" && ok "4: a person recorded the tester PASS (a waiver)" || fail "4: the person's PASS was refused"
daemon_pass
[ "$(calls review "$A")" = 1 ] && ok "4: exactly one agent review" || fail "4: $(calls review "$A") reviews of #$A"
[ "$(st "$A")" = done ] && ok "4: approved and landed (done)" || fail "4: #$A is $(st "$A")"
[ "$(calls tester "$A")" = 2 ] && ok "4: the tester was not run again" || fail "4: $(calls tester "$A") tester runs on #$A"

echo "== 5. a tester that names every criterion: held, nothing reviewed, nothing lands =="
B="$(new_ticket "Everything needs a browser" 2 all)"
daemon_pass
[ "$(st "$B")" = in_testing ] && [ "$(lv_field "$B" held_code)" = tester_unprovable ] && [ "$(lv_field "$B" criteria)" = "1,2" ] \
  && ok "5: held for criteria 1,2" || fail "5: #$B is $(st "$B"), lane verdict $(tester_lv "$B")"
[ "$(calls review "$B")" = 0 ] && [ "$(merged_on_main "$B")" = 0 ] && ok "5: nothing reviewed, nothing landed" || fail "5: reviews $(calls review "$B"), merged $(merged_on_main "$B")"

echo "== 6. UNPROVABLE with a failing clean replay: FAIL wins =="
C="$(new_ticket "Its kept test fails" 2 failtest)"
daemon_pass 3
_cv="$(lv_field "$C" verdict)"; _cc="$(lv_field "$C" held_code)"
[ "$_cv" = fail ] && [ -z "$_cc" ] && ok "6: the outcome is a FAIL, not a hold" || fail "6: tester lane verdict on #$C: $(tester_lv "$C")"
[ "$(calls deliver "$C")" -ge 2 ] && ok "6: sent to rework (delivered again)" || fail "6: #$C was not reworked ($(calls deliver "$C") deliveries, $(st "$C"))"
[ "$(calls review "$C")" = 0 ] && ok "6: no review paid" || fail "6: $(calls review "$C") reviews"
wg ticket cancel "$C" >/dev/null 2>&1 || wg wont-do "$C" --reason done >/dev/null 2>&1 || true

echo "== 7. a FAIL whose prose mentions UNPROVABLE: FAIL wins =="
D="$(new_ticket "A failing criterion" 2 failprose)"
daemon_pass 3
[ "$(lv_field "$D" verdict)" = fail ] && [ -z "$(lv_field "$D" held_code)" ] && ok "7: recorded as FAIL" || fail "7: lane verdict on #$D: $(tester_lv "$D")"
[ "$(calls deliver "$D")" -ge 2 ] && ok "7: sent to rework (delivered again)" || fail "7: #$D was not reworked ($(calls deliver "$D") deliveries)"
wg ticket cancel "$D" >/dev/null 2>&1 || wg wont-do "$D" --reason done >/dev/null 2>&1 || true

echo "== 8-9. a malformed token and a non-final token: a plain hold =="
E="$(new_ticket "Names criterion 9" 2 malformed)"
F="$(new_ticket "Token then prose" 2 nonfinal)"
daemon_pass
for x in "$E" "$F"; do
  [ "$(st "$x")" = in_testing ] && [ "$(lv_field "$x" verdict)" = held ] && [ -z "$(lv_field "$x" held_code)" ] \
    && ok "8-9: #$x held with no unprovable code" || fail "8-9: #$x is $(st "$x"), lane verdict $(tester_lv "$x")"
  [ "$(calls review "$x")" = 0 ] && [ "$(tester_verdicts "$x")" = 0 ] && ok "8-9: #$x not reviewed, no verdict recorded" || fail "8-9: #$x reviews $(calls review "$x")"
done
case "$(lv_field "$E" held_reason)" in *"does not have"*) ok "8: the hold says the token named a criterion the ticket does not have" ;; *) fail "8: reason: $(lv_field "$E" held_reason)" ;; esac

echo "== 10. tokens planted by the delivery have no effect =="
G="$(new_ticket "Plants the token everywhere" 1 quote)"
: > "$CTL/plant-$G"
daemon_pass
HG="$(git -C "$R" log --format=%H -1 --grep 'UNPROVABLE' --all 2>/dev/null)"
[ -n "$HG" ] && ok "10: the delivery's commit message carries the token" || fail "10: no planted commit"
grep -q 'planted by the delivery' "$CTL/tester-prompt-$G" 2>/dev/null && fail "10: the planted token reached the tester's prompt" || ok "10: the planted token is not in the tester's prompt"
grep -q "planted by the delivery" "$GAFFER_DATA/factory.log" 2>/dev/null && fail "10: the planted text reached the factory log" || ok "10: nothing planted reached the factory log"
[ -z "$(lv_field "$G" held_code)" ] && ok "10: no unprovable hold was recorded" || fail "10: #$G lane verdict $(tester_lv "$G")"
[ "$(lv_field "$G" verdict)" = pass ] || [ "$(st "$G")" = done ] && ok "10: the tester's own PASS stands" || fail "10: #$G lane verdict $(tester_lv "$G")"
[ "$(st "$G")" = done ] && ok "10: reviewed and landed" || fail "10: #$G is $(st "$G")"

echo "== 11. a declared need the host lacks: the tester is told, and its PASS is a hold =="
H="$(new_ticket "Needs a browser" 2 pass)"
wg ticket test-contract "$H" --surface "the search page" --run "npm test" --needs browser >/dev/null 2>&1 \
  || fail "11: setup: the contract with needs browser was refused"
wg ticket test-contract "$H" --surface "x" --needs telepathy >/dev/null 2>&1 \
  && fail "11: an unknown capability name was accepted" || ok "11: an unknown capability name is refused"
daemon_pass
grep -q "HOST LIMIT.*this host lacks browser" "$CTL/tester-prompt-$H" 2>/dev/null && ok "11: the tester was told the host lacks a browser" || fail "11: the prompt does not say so"
[ "$(st "$H")" = in_testing ] && [ "$(lv_field "$H" held_code)" = tester_unprovable ] && [ "$(lv_field "$H" criteria)" = "1,2" ] \
  && ok "11: its PASS is held for every criterion" || fail "11: #$H is $(st "$H"), lane verdict $(tester_lv "$H")"
[ "$(calls review "$H")" = 0 ] && ok "11: not reviewed" || fail "11: $(calls review "$H") reviews"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "tester-unprovable: ALL $PASS checks passed"; exit 0; fi
echo "tester-unprovable: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1
