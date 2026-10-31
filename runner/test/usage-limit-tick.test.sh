#!/usr/bin/env bash
# =====================================================================
# USAGE-WINDOW-AWARE SCHEDULER — end to end on the LIVE path (loop.sh → tick.sh).
# ---------------------------------------------------------------------
# A fake `claude` (no model, no tokens) against a real git repo and the real
# dispatch DB. Its first delivery call commits some work and then comes back
# refused by the usage window — the exact envelope Claude Code prints
# ("You've hit your session limit · resets <time> (UTC)", is_error:true). Proves:
#   A. GATE: while a pause is in force, a tick claims nothing and spawns nothing
#      (TICK_RESULT=no_work, the ticket stays ready, claude is never called).
#   B. REFUSAL: the tick reports usage_paused; the claim is RELEASED to ready
#      WITHOUT bumping attempt_count (and without the cross-run no-commit counter,
#      the rework trail or the per-run skip list); a ticket.usage_limited event
#      records the reason and paused_until; $GAFFER_DATA/usage-pause.json holds the
#      parsed reset + 1 min; the work committed before the refusal is kept on the
#      branch; the ledger row is labelled usage_limit.
#   C. RESUME: loop.sh started during a (short, test-written) pause sleeps until it
#      ends — no claude call meanwhile — then delivers the same ticket on the SAME
#      branch (the pre-refusal commit is kept) to in_review, attempt_count still 0.
#   D. NOT A REFUSAL: a SUCCESS envelope (is_error:false) whose result is the agent's
#      own reply 'Claude AI usage limit reached|<epoch>' is NOT a usage limit. The
#      agent controls that text, so honouring it would let it release its ticket
#      with no attempt counted forever. It takes the ordinary failure path: no
#      usage_paused, no pause file, no ticket.usage_limited event, and the
#      no-commit / attempt accounting moves so a human eventually sees the ticket.
#   E. LOCK HELD: with $GAFFER_DATA/.usage-pause.lock held elsewhere and a short
#      GAFFER_LOCK_TIMEOUT, a delivery that commits and returns a SUCCESS envelope
#      still reaches in_review (no usage_paused, no ticket.usage_limited event, not
#      skip-listed): classification runs without the lock.
#   F. 2.1.316 WORDING: the native-binary CLI prints "You've hit your 5-hour limit
#      · resets <Mon D, Ham> (UTC) · progress saved". That is a usage pause too
#      (usage_paused, attempt_count 0, no no-commit counter, a ticket.usage_limited
#      event) and the trailing " · progress saved" does not cost the real reset:
#      paused_until is the printed reset + 1 min, not the short default.
# Requires a built workspace + git. SKIPs otherwise.
# Run: bash runner/test/usage-limit-tick.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
DISPATCH_CLI="$ROOT/packages/dispatch/dist/cli/index.js"

PASS=0; FAILS=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILS+=("$1"); printf '  FAIL %s\n' "$1"; }
has()  { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }

command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
node --input-type=commonjs -e "require('node:sqlite')" 2>/dev/null || { echo "SKIP: node:sqlite requires Node >= 22.5"; exit 0; }
[ -f "$DISPATCH_CLI" ] || { echo "SKIP: dispatch not built ($DISPATCH_CLI) — run pnpm -r build"; exit 0; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/usage-limit-tick.XXXXXX")"; WORK="$(cd "$WORK" && pwd -P)"
trap 'pkill -f "$WORK" 2>/dev/null; rm -rf "$WORK"' EXIT

# --- fixture repo + factory state --------------------------------------------
REPO="$WORK/widget"; mkdir -p "$REPO/test"
printf '{"name":"widget","version":"1.0.0","private":true,"scripts":{"test":"node --test"}}\n' >"$REPO/package.json"
printf 'const t=require("node:test");const a=require("node:assert");t.test("baseline",()=>{a.equal(1+1,2);});\n' >"$REPO/test/base.test.js"
git -C "$REPO" init -q -b main
git -C "$REPO" -c user.email=t@e -c user.name=t -c commit.gpgsign=false add -A
git -C "$REPO" -c user.email=t@e -c user.name=t -c commit.gpgsign=false commit -qm init
export GAFFER_DATA="$WORK/data"; mkdir -p "$GAFFER_DATA"
export DISPATCH_DB="$GAFFER_DATA/dispatch.sqlite" MEMORY_DB="$GAFFER_DATA/memory.sqlite"
unset GAFFER_USAGE_PAUSE_FILE GAFFER_USAGE_PAUSE_DEFAULT_MIN
wg() { node "$DISPATCH_CLI" --db "$DISPATCH_DB" "$@"; }
sql() { node -e 'const{DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.DISPATCH_DB);const r=db.prepare(process.argv[1]).get(...process.argv.slice(2));process.stdout.write(r?String(Object.values(r)[0]??""):"")' "$@" 2>/dev/null; }
wg init >/dev/null
wg repo add -n widget --path "$REPO" --branch main --stack node --test "node --test" >/dev/null
NUM="$(wg ticket create -t "Add DELIVERED marker" -d "Add a DELIVERED.txt file at the repo root." --risk low 2>/dev/null | node "$RUNNER_DIR/lib/json-tool.mjs" expr 'd.ticket.number')"
TID="$(sql 'select id from tickets where number=?' "$NUM")"
RID="$(sql 'select id from repositories where name=?' widget)"
node -e '
const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync(process.env.DISPATCH_DB);
db.prepare("insert into ticket_repos(ticket_id,repo_id,role,access,relation,source) values(?,?,?,?,?,?)").run(process.argv[1],process.argv[2],"primary","write","confirmed","manual");
db.prepare("insert into acceptance_criteria(id,ticket_id,text,sort_order) values(?,?,?,0)").run("ac-1",process.argv[1],"DELIVERED.txt exists at the repo root");
' "$TID" "$RID"
wg ticket ready "$NUM" >/dev/null 2>&1
[ "$(sql 'select status from tickets where number=?' "$NUM")" = "ready" ] || { fail "fixture ticket #$NUM did not reach ready"; exit 1; }
status_of() { sql 'select status from tickets where number=?' "$NUM"; }
attempts_of() { sql 'select attempt_count from tickets where number=?' "$NUM"; }

# --- the fake claude: call 1 commits WIP then is REFUSED; call 2 delivers ------
CALLS="$WORK/claude-calls"; : > "$CALLS"
FAKE="$WORK/bin"; mkdir -p "$FAKE"
cat >"$FAKE/claude" <<SH
#!/bin/sh
date +%s >> "$CALLS"
n=\$(wc -l < "$CALLS" | tr -d ' ')
gc() { git -c user.email=fake@agent -c user.name="fake agent" -c commit.gpgsign=false "\$@" >/dev/null 2>&1; }
if [ "\$n" = 1 ]; then
  printf 'half-way\n' > WIP.txt; gc add -A; gc commit -qm "wip: started before the refusal"
  printf '%s\n' '{"type":"result","subtype":"success","is_error":true,"num_turns":3,"result":"You'"'"'ve hit your session limit · resets 11:59pm (UTC)","stop_reason":"stop_sequence","total_cost_usd":0.002}'
  exit 1
fi
printf 'delivered\n' > DELIVERED.txt; gc add -A; gc commit -qm "deliver: add DELIVERED.txt"
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"num_turns":2,"result":"Added DELIVERED.txt.","stop_reason":"end_turn","total_cost_usd":0.01}'
SH
chmod +x "$FAKE/claude"
export CLAUDE_BIN="$FAKE/claude" GAFFER_PLAN_MODEL=none GAFFER_IMPL_MODEL=none
export DRY_RUN=0 GAFFER_TICK_TIMEOUT=120 TICK_SLEEP=0 EMPTY_POLL_LIMIT=1 GAFFER_USAGE_PAUSE_POLL_SECS=1
MJS="$RUNNER_DIR/lib/usage-pause.mjs"
write_pause() { node -e 'const ms=Date.now()+Number(process.argv[2])*1000;require("fs").writeFileSync(process.argv[1],JSON.stringify({paused_until:new Date(ms).toISOString(),until_ms:ms,kind:"usage_limit",basis:"reset",message:"test pause",ticket:null,lane:"delivery",recorded_at:new Date().toISOString()}))' "$GAFFER_DATA/usage-pause.json" "$1"; }
pf() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=j[process.argv[2]];process.stdout.write(v==null?"":String(v))' "$GAFFER_DATA/usage-pause.json" "$1" 2>/dev/null; }

echo "== A: a tick during a pause claims nothing and spawns nothing =="
write_pause 3600
out="$(bash "$RUNNER_DIR/tick.sh" 2>&1)"
has "$out" "TICK_RESULT=no_work" && ok "tick → no_work while paused" || fail "tick result while paused: $(printf '%s' "$out" | tail -3)"
[ "$(status_of)" = "ready" ] && ok "the ticket stays ready (no claim)" || fail "ticket is '$(status_of)'"
[ ! -s "$CALLS" ] && ok "claude was never called during the pause" || fail "claude called $(wc -l < "$CALLS") time(s) during the pause"
grep -q "USAGE: paused until .* UTC: usage limit — not starting new paid work" "$GAFFER_DATA/factory.log" 2>/dev/null \
  && ok "the factory log names the pause" || fail "no USAGE gate line in factory.log"
node "$MJS" clear

echo "== B: a refused delivery releases the claim without counting an attempt =="
MAX_TICKS=1 bash "$RUNNER_DIR/loop.sh" >"$WORK/loop1.log" 2>&1
has "$(cat "$WORK/loop1.log")" "tick 1/1 → usage_paused" && ok "loop reported tick → usage_paused" || fail "loop1: $(grep 'tick 1' "$WORK/loop1.log")"
[ "$(wc -l < "$CALLS" | tr -d ' ')" = "1" ] && ok "one delivery call was made" || fail "claude calls: $(wc -l < "$CALLS")"
[ "$(status_of)" = "ready" ] && ok "the claim was released: #$NUM is back to ready" || fail "ticket is '$(status_of)' (want ready)"
[ "$(attempts_of)" = "0" ] && ok "attempt_count was NOT bumped (0)" || fail "attempt_count=$(attempts_of)"
[ "$(sql 'select count(*) from ticket_claims where ticket_id=? and status=?' "$TID" active)" = "0" ] && ok "no active claim left" || fail "an active claim remains"
[ ! -e "$GAFFER_DATA/.nocommit-failures/$NUM" ] && ok "the cross-run no-commit counter was not touched" || fail "nocommit counter = $(cat "$GAFFER_DATA/.nocommit-failures/$NUM")"
[ "$(sql 'select count(*) from rework_attempts where ticket_id=?' "$TID")" = "0" ] && ok "no rework attempt was recorded" || fail "rework_attempts rows exist"
grep -qx "$NUM" "$GAFFER_DATA/.failed-tickets" 2>/dev/null && fail "the ticket was skip-listed for the run" || ok "not skip-listed (it is retried once the window resets)"
EV_UNTIL="$(sql "select json_extract(payload_json,'\$.paused_until') from work_events where entity_id=? and event_type='ticket.usage_limited'" "$TID")"
EV_REASON="$(sql "select json_extract(payload_json,'\$.reason') from work_events where entity_id=? and event_type='ticket.usage_limited'" "$TID")"
[ -n "$EV_UNTIL" ] && ok "a ticket.usage_limited event records paused_until ($EV_UNTIL)" || fail "no ticket.usage_limited event (or no paused_until)"
has "$EV_REASON" "You've hit your session limit" && has "$EV_REASON" "not counted as an attempt" \
  && ok "the event's reason quotes the CLI and says no attempt was counted" || fail "event reason: $EV_REASON"
[ "$(sql "select json_extract(payload_json,'\$.reason_code') from work_events where entity_id=? and event_type='ticket.usage_limited'" "$TID")" = "usage_limit" ] \
  && ok "reason_code usage_limit" || fail "reason_code missing"
[ -s "$GAFFER_DATA/usage-pause.json" ] && ok "\$GAFFER_DATA/usage-pause.json was written" || fail "no usage-pause.json"
[ "$(pf paused_until)" = "$EV_UNTIL" ] && ok "the pause file and the event agree on paused_until" || fail "pause '$(pf paused_until)' vs event '$EV_UNTIL'"
WANT="$(node --input-type=module -e "
import { parseResetClock } from '$RUNNER_DIR/lib/worker.mjs';
const now = Date.parse(process.argv[1]); const r = parseResetClock('x · resets 11:59pm (UTC)', now);
process.stdout.write(new Date(Math.max(now + 600000, r + 60000)).toISOString());" "$(pf recorded_at)")"
[ "$(pf paused_until)" = "$WANT" ] && [ "$(pf basis)" = "reset" ] && [ "$(pf kind)" = "usage_limit" ] && [ "$(pf ticket)" = "$NUM" ] \
  && ok "paused_until = the printed reset (11:59pm UTC) + 1 min, basis reset, ticket #$NUM" || fail "pause file: until=$(pf paused_until) want=$WANT basis=$(pf basis) ticket=$(pf ticket)"
BR="$(git -C "$REPO" branch --list 'gaffer/ticket-*' | head -1 | tr -d ' *')"
[ -n "$BR" ] && git -C "$REPO" cat-file -e "$BR:WIP.txt" 2>/dev/null \
  && ok "the work committed before the refusal is kept on $BR" || fail "the pre-refusal commit is gone (branch '$BR')"
LROW="$(tail -1 "$GAFFER_DATA/usage-ledger.jsonl" 2>/dev/null)"
has "$LROW" '"usage_limit":"usage_limit"' && has "$LROW" '"ticket":'"$NUM" \
  && ok "the ledger row is labelled usage_limit (spend still booked conservatively)" || fail "ledger row: $LROW"
grep -q "USAGE: #$NUM refused by the model's usage window" "$GAFFER_DATA/factory.log" && ok "the factory log explains the release" || fail "no USAGE release line"

echo "== C: loop.sh sleeps out the pause, then delivers the same ticket =="
write_pause 3
t0="$(date +%s)"
MAX_TICKS=1 bash "$RUNNER_DIR/loop.sh" >"$WORK/loop2.log" 2>&1
el=$(( $(date +%s) - t0 ))
L2="$(cat "$WORK/loop2.log")"
has "$L2" "gaffer factory: paused until " && has "$L2" ": usage limit — sleeping until then" \
  && ok "loop.sh printed 'paused until <time>: usage limit — sleeping until then'" || fail "loop2 lacks the pause line: $(head -5 "$WORK/loop2.log")"
has "$L2" "usage pause over — admitting work again" && ok "loop.sh resumed once the pause ended" || fail "no resume line"
SECOND="$(sed -n 2p "$CALLS")"
[ -n "$SECOND" ] && [ "$(( SECOND - t0 ))" -ge 2 ] && ok "the next claude call came only after the pause (+$(( SECOND - t0 ))s; loop took ${el}s)" || fail "second call at '${SECOND:-none}' (t0=$t0)"
[ "$(status_of)" = "in_review" ] && ok "the same ticket was delivered → in_review" || fail "ticket is '$(status_of)' after the resume: $(tail -20 "$WORK/loop2.log")"
[ "$(attempts_of)" = "0" ] && ok "attempt_count is still 0 after the delivery" || fail "attempt_count=$(attempts_of)"
git -C "$REPO" cat-file -e "$BR:WIP.txt" 2>/dev/null && git -C "$REPO" cat-file -e "$BR:DELIVERED.txt" 2>/dev/null \
  && ok "the delivery built on the kept branch (pre-refusal commit + the delivery)" || fail "branch $BR lacks WIP.txt or DELIVERED.txt"
grep -q "reused worktree .* prior commit(s) kept" "$GAFFER_DATA/factory.log" && ok "the tick reused the kept branch" || fail "no 'reused worktree' line"

echo "== D: an agent reply carrying the legacy limit string takes the normal failure path =="
node "$MJS" clear
NUM2="$(wg ticket create -t "Add SECOND marker" -d "Add a SECOND.txt file at the repo root." --risk low 2>/dev/null | node "$RUNNER_DIR/lib/json-tool.mjs" expr 'd.ticket.number')"
TID2="$(sql 'select id from tickets where number=?' "$NUM2")"
node -e '
const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync(process.env.DISPATCH_DB);
db.prepare("insert into ticket_repos(ticket_id,repo_id,role,access,relation,source) values(?,?,?,?,?,?)").run(process.argv[1],process.argv[2],"primary","write","confirmed","manual");
db.prepare("insert into acceptance_criteria(id,ticket_id,text,sort_order) values(?,?,?,0)").run("ac-2",process.argv[1],"SECOND.txt exists at the repo root");
' "$TID2" "$RID"
wg ticket ready "$NUM2" >/dev/null 2>&1
[ "$(sql 'select status from tickets where number=?' "$NUM2")" = "ready" ] || fail "fixture ticket #$NUM2 did not reach ready"
CALLS2="$WORK/claude-calls-2"; : > "$CALLS2"
cat >"$FAKE/claude-liar" <<SH
#!/bin/sh
date +%s >> "$CALLS2"
e=\$(( \$(date +%s) - 5 ))
printf '{"type":"result","subtype":"success","is_error":false,"num_turns":9,"result":"Claude AI usage limit reached|%s","stop_reason":"end_turn","total_cost_usd":0.5}\n' "\$e"
SH
chmod +x "$FAKE/claude-liar"
CLAUDE_BIN="$FAKE/claude-liar" MAX_TICKS=1 bash "$RUNNER_DIR/loop.sh" >"$WORK/loop3.log" 2>&1
L3="$(cat "$WORK/loop3.log")"
[ "$(wc -l < "$CALLS2" | tr -d ' ')" = "1" ] && ok "one delivery call was made" || fail "liar calls: $(wc -l < "$CALLS2")"
has "$L3" "usage_paused" && fail "the tick reported usage_paused for an agent's own reply" || ok "the tick did NOT report usage_paused"
[ ! -e "$GAFFER_DATA/usage-pause.json" ] && ok "no usage-pause.json was written (the factory is not halted)" || fail "a pause was recorded: $(cat "$GAFFER_DATA/usage-pause.json")"
[ "$(sql "select count(*) from work_events where entity_id=? and event_type='ticket.usage_limited'" "$TID2")" = "0" ] \
  && ok "no ticket.usage_limited event" || fail "a ticket.usage_limited event was recorded for #$NUM2"
NC2="$(cat "$GAFFER_DATA/.nocommit-failures/$NUM2" 2>/dev/null)"
ST2="$(sql 'select status from tickets where number=?' "$NUM2")"
AT2="$(sql 'select attempt_count from tickets where number=?' "$NUM2")"
has "$L3" "tick 1/1 → error" && ok "loop reported tick → error (the ordinary failure path)" || fail "loop3: $(grep 'tick 1' "$WORK/loop3.log")"
[ "$ST2" = "refining" ] && ok "#$NUM2 was parked to refining for a human (as for any no-commit reply)" \
  || fail "#$NUM2 is '$ST2' (want refining): attempt_count=${AT2:-0} nocommit=${NC2:-none}"

echo "== E: a held usage-pause lock cannot turn a real delivery into a 'refusal' =="
# The classifier runs WITHOUT the lock; only a confirmed refusal goes on to the locked
# record step. With the lock held by someone else (and a short GAFFER_LOCK_TIMEOUT), a
# delivery that committed work and returned a normal SUCCESS envelope used to read as
# rc 2 ("refusal, pause not written"): released to ready, a ticket.usage_limited event
# with paused_until null, skip-listed. It must reach review like any delivery.
node "$MJS" clear
NUM3="$(wg ticket create -t "Add OUT marker" -d "Add an OUT.txt file at the repo root." --risk low 2>/dev/null | node "$RUNNER_DIR/lib/json-tool.mjs" expr 'd.ticket.number')"
TID3="$(sql 'select id from tickets where number=?' "$NUM3")"
node -e '
const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync(process.env.DISPATCH_DB);
db.prepare("insert into ticket_repos(ticket_id,repo_id,role,access,relation,source) values(?,?,?,?,?,?)").run(process.argv[1],process.argv[2],"primary","write","confirmed","manual");
db.prepare("insert into acceptance_criteria(id,ticket_id,text,sort_order) values(?,?,?,0)").run("ac-3",process.argv[1],"OUT.txt exists at the repo root");
' "$TID3" "$RID"
wg ticket ready "$NUM3" >/dev/null 2>&1
[ "$(sql 'select status from tickets where number=?' "$NUM3")" = "ready" ] || fail "fixture ticket #$NUM3 did not reach ready"
CALLS3="$WORK/claude-calls-3"; : > "$CALLS3"
cat >"$FAKE/claude-ok" <<SH
#!/bin/sh
date +%s >> "$CALLS3"
printf 'out\n' > OUT.txt
git -c user.email=fake@agent -c user.name="fake agent" -c commit.gpgsign=false add -A >/dev/null 2>&1
git -c user.email=fake@agent -c user.name="fake agent" -c commit.gpgsign=false commit -qm "deliver: add OUT.txt" >/dev/null 2>&1
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"num_turns":2,"result":"Added OUT.txt.","stop_reason":"end_turn","total_cost_usd":0.01}'
SH
chmod +x "$FAKE/claude-ok"
# Hold $GAFFER_DATA/.usage-pause.lock for both lock flavours: flock(1) where present
# (Linux/CI) and the mkdir spinlock with a LIVE holder pid (macOS, no flock).
UL_LOCK="$GAFFER_DATA/.usage-pause.lock"; READY="$WORK/lock-held"
(
  if command -v flock >/dev/null 2>&1; then exec 9>>"$UL_LOCK"; flock 9; fi
  : > "$READY"
  while :; do sleep 1; done
) &
HOLDER=$!
mkdir -p "$UL_LOCK.d"; echo "$HOLDER" > "$UL_LOCK.d/pid"
n=0; while [ ! -e "$READY" ] && [ "$n" -lt 50 ]; do sleep 0.1; n=$((n + 1)); done
[ -e "$READY" ] && ok "the usage-pause lock is held by another process" || fail "could not hold the usage-pause lock"
CLAUDE_BIN="$FAKE/claude-ok" GAFFER_LOCK_TIMEOUT=2 MAX_TICKS=1 bash "$RUNNER_DIR/loop.sh" >"$WORK/loop4.log" 2>&1
kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null; rm -rf "$UL_LOCK.d"
L4="$(cat "$WORK/loop4.log")"
[ "$(wc -l < "$CALLS3" | tr -d ' ')" = "1" ] && ok "one delivery call was made" || fail "ok-stub calls: $(wc -l < "$CALLS3")"
has "$L4" "usage_paused" && fail "a successful delivery was reported as usage_paused under a held lock" || ok "the tick did NOT report usage_paused"
ST3="$(sql 'select status from tickets where number=?' "$NUM3")"
[ "$ST3" = "in_review" ] && ok "#$NUM3 reached in_review" || fail "#$NUM3 is '$ST3' (want in_review): $(grep 'tick 1' "$WORK/loop4.log")"
[ "$(sql "select count(*) from work_events where entity_id=? and event_type='ticket.usage_limited'" "$TID3")" = "0" ] \
  && ok "no ticket.usage_limited event" || fail "a ticket.usage_limited event was recorded for #$NUM3"
grep -qx "$NUM3" "$GAFFER_DATA/.failed-tickets" 2>/dev/null && fail "#$NUM3 was skip-listed" || ok "#$NUM3 was not skip-listed"
[ ! -e "$GAFFER_DATA/usage-pause.json" ] && ok "no usage-pause.json was written" || fail "a pause was recorded: $(cat "$GAFFER_DATA/usage-pause.json")"

echo "== F: Claude Code 2.1.316 wording (5-hour limit + ' · progress saved') pauses with its real reset =="
node "$MJS" clear
NUM4="$(wg ticket create -t "Add FOURTH marker" -d "Add a FOURTH.txt file at the repo root." --risk low 2>/dev/null | node "$RUNNER_DIR/lib/json-tool.mjs" expr 'd.ticket.number')"
TID4="$(sql 'select id from tickets where number=?' "$NUM4")"
node -e '
const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync(process.env.DISPATCH_DB);
db.prepare("insert into ticket_repos(ticket_id,repo_id,role,access,relation,source) values(?,?,?,?,?,?)").run(process.argv[1],process.argv[2],"primary","write","confirmed","manual");
db.prepare("insert into acceptance_criteria(id,ticket_id,text,sort_order) values(?,?,?,0)").run("ac-4",process.argv[1],"FOURTH.txt exists at the repo root");
' "$TID4" "$RID"
wg ticket ready "$NUM4" >/dev/null 2>&1
[ "$(sql 'select status from tickets where number=?' "$NUM4")" = "ready" ] || fail "fixture ticket #$NUM4 did not reach ready"
# A reset 3 days out, printed the way the CLI does beyond 24h ("Nov 3, 9am", with
# the year only when it differs), in UTC.
RESET_MS="$(node -e 'const d=new Date(Date.now()+3*86400000);d.setUTCMinutes(0,0,0);process.stdout.write(String(d.getTime()))')"
RESET_TXT="$(node -e 'const d=new Date(Number(process.argv[1]));const o={month:"short",day:"numeric",hour:"numeric",hour12:true,timeZone:"UTC"};if(d.getUTCFullYear()!==new Date().getUTCFullYear())o.year="numeric";process.stdout.write(d.toLocaleString("en-US",o).replace(/[ \u202f]([AP]M)/i,(a,b)=>b.toLowerCase()))' "$RESET_MS")"
CALLS4="$WORK/claude-calls-4"; : > "$CALLS4"
cat >"$FAKE/claude-316" <<SH
#!/bin/sh
date +%s >> "$CALLS4"
printf '%s\n' '{"type":"result","subtype":"success","is_error":true,"num_turns":1,"result":"You'"'"'ve hit your 5-hour limit · resets $RESET_TXT (UTC) · progress saved","stop_reason":"stop_sequence","total_cost_usd":0}'
exit 1
SH
chmod +x "$FAKE/claude-316"
CLAUDE_BIN="$FAKE/claude-316" MAX_TICKS=1 bash "$RUNNER_DIR/loop.sh" >"$WORK/loop5.log" 2>&1
L5="$(cat "$WORK/loop5.log")"
[ "$(wc -l < "$CALLS4" | tr -d ' ')" = "1" ] && ok "one delivery call was made" || fail "316-stub calls: $(wc -l < "$CALLS4")"
has "$L5" "tick 1/1 → usage_paused" && ok "loop reported tick → usage_paused for the 5-hour wording" || fail "loop5: $(grep 'tick 1' "$WORK/loop5.log")"
[ "$(sql 'select status from tickets where number=?' "$NUM4")" = "ready" ] && ok "#$NUM4 is back to ready" || fail "#$NUM4 is '$(sql 'select status from tickets where number=?' "$NUM4")'"
[ "$(sql 'select attempt_count from tickets where number=?' "$NUM4")" = "0" ] && ok "attempt_count was NOT bumped" || fail "attempt_count=$(sql 'select attempt_count from tickets where number=?' "$NUM4")"
[ ! -e "$GAFFER_DATA/.nocommit-failures/$NUM4" ] && ok "the no-commit counter was not touched" || fail "nocommit counter = $(cat "$GAFFER_DATA/.nocommit-failures/$NUM4")"
[ "$(sql "select count(*) from work_events where entity_id=? and event_type='ticket.usage_limited'" "$TID4")" = "1" ] \
  && ok "a ticket.usage_limited event was recorded" || fail "no ticket.usage_limited event for #$NUM4"
WANT4="$(node -e 'process.stdout.write(new Date(Number(process.argv[1])+60000).toISOString())' "$RESET_MS")"
[ "$(pf paused_until)" = "$WANT4" ] && [ "$(pf basis)" = "reset" ] \
  && ok "paused_until = the printed reset ($RESET_TXT UTC) + 1 min despite ' · progress saved'" \
  || fail "pause file: until=$(pf paused_until) want=$WANT4 basis=$(pf basis)"

echo
if [ "${#FAILS[@]}" -eq 0 ]; then
  echo "usage-limit-tick: ALL $PASS checks passed"
  exit 0
fi
echo "usage-limit-tick: ${#FAILS[@]} FAILURE(S):"
for f in "${FAILS[@]}"; do echo "  - $f"; done
echo "--- loop1 ---"; tail -15 "$WORK/loop1.log" 2>/dev/null
echo "--- factory.log ---"; grep -E "USAGE|delivery|release" "$GAFFER_DATA/factory.log" 2>/dev/null | tail -20
exit 1
