#!/usr/bin/env bash
# =====================================================================
# Two overlapping runs never share their per-run lists (the s6-decisions race).
# ---------------------------------------------------------------------
# The "failed delivery this run" list (and the other per-run lists: reviewed,
# clarified, merge-held, tested, backpressure, the warned-once markers) used to be
# ONE file under $GAFFER_DATA for every run, and poll-once.sh / loop.sh started a run
# by deleting it. A dashboard Poll that started while the previous Poll was still
# parking an empty delivery cleared the file; the still-running first run then added
# the ticket (which an answered decision had already moved back to ready), and the
# second Poll skipped it: "all ready tickets failed delivery this run", no
# redelivery until the next Poll minutes later.
#
# Driven through the REAL poll-once.sh and tick.sh with a stub agent held at a
# barrier (lib/stub-tick.sh, mode hold-empty), so the interleaving is the same on any
# scheduler:
#   P1  Poll 1 claims #T; its agent is held. #T's decision is raised and answered
#       (the ticket goes back to ready, as in s6). Poll 2 starts; its tick only begins
#       once Poll 1 has finished (the wrapper waits), so Poll 1's skip entry is written
#       before Poll 2 picks. Released: Poll 1 parks the empty delivery.
#   P2  Poll 2 delivers #T (it is not skipped by Poll 1's list) and says it waited
#       for the Poll that was still running.
#   P3  every run's lists live in its own run-state dir, removed when the run ends; a
#       Poll neither clears nor writes the shared path a hand-run tick uses, and it
#       sweeps a leftover run-state dir whose owner is gone.
#   P4  a Poll that cannot get the poll lock in time refuses with a "— not polling."
#       line and reserves no day slot.
#   P5  a loop.sh pass keeps its lists in its own dir too: it leaves a running Poll's
#       lists alone and removes only its own dir.
# Run: bash runner/test/poll-overlap-run-state.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
command -v perl >/dev/null 2>&1 || { echo "SKIP: perl required (timeout primitive)"; exit 0; }
for f in packages/dispatch/dist/cli/index.js packages/memory/dist/bin/memory.js packages/crew/dist/cli/index.js; do
  [ -f "$ROOT/$f" ] || { echo "SKIP: $f not built (run pnpm -r build)"; exit 0; }
done
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX ANTHROPIC_BASE_URL GAFFER_CLAUDE_AUTH_PROBE GAFFER_CLAUDE_AUTH_CHECKED
unset GAFFER_RUN_STATE_DIR

STUB_TICK_NAME=poll-overlap
# shellcheck source=lib/stub-tick.sh
source "$HERE/lib/stub-tick.sh"
has() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }
export GAFFER_DAILY_BUDGET_USD=5 MAX_TICKS_PER_DAY=50
# wait_for <seconds> <command...>: poll until the command succeeds (no GNU timeout).
wait_for() { local _n=$(( $1 * 5 )) _i=0; shift; while [ "$_i" -lt "$_n" ]; do "$@" && return 0; sleep 0.2; _i=$((_i + 1)); done; return 1; }
holding() { ls "$CALLS"/*/holding >/dev/null 2>&1; }
deliveries() { grep -lx delivery "$CALLS"/*/kind 2>/dev/null | wc -l | tr -d ' '; }
poll() { ( cd "$RUNNER_DIR" && exec bash ./bin/poll-once.sh ); }

# Poll 2's tick starts only once Poll 1 has exited, so Poll 1's late skip entry is
# always written before Poll 2 reads its list (the ordering s6 hit under load).
cat > "$WORK/tick-after-p1.sh" <<'SH'
touch "$P2_MARK"
while kill -0 "$P1_PID" 2>/dev/null; do sleep 0.1; done
exec bash "$REAL_TICK"
SH

echo "== P1. Poll 2 starts while Poll 1 is still parking an empty delivery =="
T="$(new_ready "Ask a question" "deliver a helper")"
echo hold-empty > "$MODE"
poll > "$WORK/p1.out" 2>&1 &
P1=$!
wait_for 120 holding && ok "P1: Poll 1's agent is held at the barrier" || fail "P1: Poll 1's agent never started: $(tail -5 "$WORK/p1.out" | tr '\n' '|')"
# The agent's question is raised and answered while it is still running (s6: the
# decision is answered, the ticket goes back to ready before the empty park ends).
# request_decision blocks the agent's OWN claim (the token the runner put in its MCP config).
TOK="$(node -e 'const f=(o)=>{if(o&&typeof o==="object"){for(const[k,v]of Object.entries(o)){if(k==="GAFFER_CLAIM_TOKEN")return v;const r=f(v);if(r)return r}}return ""};process.stdout.write(String(f(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")))))' "$(dirname "$(ls "$CALLS"/*/holding | head -1)")/mcp.json" 2>/dev/null)"
wg block "$T" --token "$TOK" --reason "Which way?" >/dev/null 2>&1
DEC="$(wg decision --ticket "$T" --title "Which way?" --question "Which way?" 2>/dev/null | jget 'd.decision ? d.decision.id : d.id' 2>/dev/null)"
wg decisions resolve "$DEC" --answer "the left way" >/dev/null 2>&1
[ "$(st "$T")" = ready ] || wg unblock "$T" >/dev/null 2>&1
[ "$(st "$T")" = ready ] && ok "P1: #$T is back to ready while Poll 1 still runs" || fail "P1: #$T is $(st "$T") (decision '$DEC')"
echo deliver > "$MODE"
P2_MARK="$WORK/p2-ticking" P1_PID="$P1" REAL_TICK="$RUNNER_DIR/tick.sh" GAFFER_POLL_TICK_SH="$WORK/tick-after-p1.sh" \
  poll > "$WORK/p2.out" 2>&1 &
P2=$!
p2_started() { [ -e "$WORK/p2-ticking" ] || grep -q 'waiting for the poll already running' "$WORK/p2.out" 2>/dev/null; }
wait_for 60 p2_started || fail "P1: Poll 2 never started: $(tr '\n' '|' < "$WORK/p2.out")"
touch "$CALLS/release"
wait "$P1"; wait "$P2"
has "$(cat "$WORK/p1.out")" "TICK_RESULT=" && ok "P1: Poll 1 finished ($(sed -n 's/^TICK_RESULT=//p' "$WORK/p1.out" | tail -1))" || fail "P1: Poll 1: $(tail -5 "$WORK/p1.out" | tr '\n' '|')"
grep -q "EMPTY delivery for #$T" "$GAFFER_DATA/factory.log" && ok "P1: Poll 1 parked the empty delivery" || fail "P1: no EMPTY delivery line for #$T"

echo "== P2. Poll 2 delivers the answered ticket =="
P2OUT="$(cat "$WORK/p2.out")"
has "$P2OUT" "failed delivery this run" && fail "P2: Poll 2 skipped #$T on Poll 1's list: $(grep 'failed delivery' "$WORK/p2.out")" \
  || ok "P2: Poll 2 did not skip #$T on Poll 1's list"
[ "$(deliveries)" = 2 ] && ok "P2: Poll 2 ran a second delivery of #$T" || fail "P2: $(deliveries) delivery call(s); Poll 2: $(sed -n 's/^TICK_RESULT=//p' "$WORK/p2.out")"
[ "$(st "$T")" = in_review ] && ok "P2: #$T is in review after Poll 2" || fail "P2: #$T is $(st "$T")"
grep -Eq '^gaffer poll: waiting for the poll already running' "$WORK/p2.out" \
  && ok "P2: Poll 2 said it waited for the Poll still running" || fail "P2: no waiting line: $(grep 'gaffer poll' "$WORK/p2.out" | tr '\n' '|')"

echo "== P3. each run's lists are its own =="
[ ! -e "$GAFFER_DATA/.failed-tickets" ] && ok "P3: no Poll wrote the shared skip path" || fail "P3: shared .failed-tickets: $(tr '\n' ' ' < "$GAFFER_DATA/.failed-tickets")"
_left="$(ls -A "$GAFFER_DATA/run-state" 2>/dev/null | tr '\n' ' ')"
[ -z "$_left" ] && ok "P3: both Polls removed their run-state dirs" || fail "P3: left behind: $_left"
# A hand-run tick's list and a dead run's leftover dir: the Poll keeps the first (not
# its run) and sweeps the second (its owner pid is gone).
printf '99\n' > "$GAFFER_DATA/.failed-tickets"
DEAD=999999; while kill -0 "$DEAD" 2>/dev/null; do DEAD=$((DEAD - 1)); done
mkdir -p "$GAFFER_DATA/run-state/loop-$DEAD-1"
printf 'printf "%%s\\n" "$GAFFER_RUN_STATE_DIR" > "%s/p3.dir"; ls -A "$GAFFER_RUN_STATE_DIR" > "%s/p3.ls"; echo TICK_RESULT=no_work\n' "$WORK" "$WORK" > "$WORK/tick-p3.sh"
GAFFER_POLL_TICK_SH="$WORK/tick-p3.sh" poll > "$WORK/p3.out" 2>&1
_dir="$(cat "$WORK/p3.dir" 2>/dev/null)"
case "$_dir" in "$GAFFER_DATA/run-state/"poll-*) ok "P3: the Poll's tick ran in its own run-state dir" ;; *) fail "P3: GAFFER_RUN_STATE_DIR='$_dir'" ;; esac
[ -e "$WORK/p3.ls" ] && [ ! -s "$WORK/p3.ls" ] && ok "P3: the Poll's lists start empty" || fail "P3: run-state dir held: $(tr '\n' ' ' < "$WORK/p3.ls" 2>/dev/null)"
[ "$(cat "$GAFFER_DATA/.failed-tickets")" = 99 ] && ok "P3: the Poll left the hand-run tick's list alone" || fail "P3: shared list now '$(cat "$GAFFER_DATA/.failed-tickets" 2>/dev/null)'"
[ ! -e "$GAFFER_DATA/run-state/loop-$DEAD-1" ] && ok "P3: a dead run's leftover dir was swept" || fail "P3: run-state/loop-$DEAD-1 kept"
[ -n "$_dir" ] && [ ! -e "$_dir" ] && ok "P3: the Poll removed its run-state dir at exit" || fail "P3: '$_dir' left"
rm -f "$GAFFER_DATA/.failed-tickets"

echo "== P4. a Poll that cannot get the poll lock refuses =="
sleep 30 & HOLDER=$!
mkdir -p "$GAFFER_DATA/.poll.lock.d"; printf '%s\n' "$HOLDER" > "$GAFFER_DATA/.poll.lock.d/pid"
_day_before="$(cat "$GAFFER_DATA/.daily-ticks" 2>/dev/null | tr '\n' ' ')"
out="$(GAFFER_POLL_WAIT_TIMEOUT=1 GAFFER_POLL_TICK_SH="$WORK/tick-p3.sh" poll 2>&1)"; rc=$?
kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null
grep -Eq '^gaffer poll: .*still running.*— not polling\.$' <<<"$out" && ok "P4: the refusal names the running Poll" || fail "P4: $(printf '%s' "$out" | tr '\n' '|')"
[ "$rc" = 0 ] && has "$out" "TICK_RESULT=no_work" && ok "P4: exit 0, TICK_RESULT=no_work" || fail "P4: rc=$rc"
[ "$(cat "$GAFFER_DATA/.daily-ticks" 2>/dev/null | tr '\n' ' ')" = "$_day_before" ] && ok "P4: no day slot reserved" || fail "P4: the day count moved"
[ -d "$GAFFER_DATA/.poll.lock.d" ] && [ "$(cat "$GAFFER_DATA/.poll.lock.d/pid")" = "$HOLDER" ] && ok "P4: the other Poll's lock was left alone" || fail "P4: lock changed"
rm -rf "$GAFFER_DATA/.poll.lock.d"
retire "$T"

echo "== P5. a loop pass neither clears nor shares a running Poll's lists =="
sleep 60 & LIVE=$!
mkdir -p "$GAFFER_DATA/run-state/poll-$LIVE-1"; printf '42\n' > "$GAFFER_DATA/run-state/poll-$LIVE-1/.failed-tickets"
printf '#!/usr/bin/env bash\nprintf "{}\\n"\n' > "$WORK/noop.sh"; chmod +x "$WORK/noop.sh"
out="$( ( cd "$RUNNER_DIR" && MAX_TICKS=1 TICK_SLEEP=0 EMPTY_POLL_LIMIT=1 \
  LOOP_STATS_CMD="$WORK/noop.sh" LOOP_HQ_CMD="$WORK/noop.sh" LOOP_NOTIFY_EMIT_CMD="$WORK/noop.sh" bash ./loop.sh 2>&1 ) )"; rc=$?
[ "$rc" = 0 ] && ok "P5: loop.sh ran (rc 0)" || fail "P5: loop.sh rc=$rc: $(printf '%s' "$out" | tail -5 | tr '\n' '|')"
[ "$(cat "$GAFFER_DATA/run-state/poll-$LIVE-1/.failed-tickets" 2>/dev/null)" = 42 ] && ok "P5: the running Poll's list is untouched" || fail "P5: the Poll's list is now '$(cat "$GAFFER_DATA/run-state/poll-$LIVE-1/.failed-tickets" 2>/dev/null)'"
_left="$(ls -A "$GAFFER_DATA/run-state" 2>/dev/null | tr '\n' ' ')"
[ "$_left" = "poll-$LIVE-1 " ] && ok "P5: the loop removed its own run-state dir and kept the live Poll's" || fail "P5: run-state holds: $_left"
[ ! -e "$GAFFER_DATA/.failed-tickets" ] && ok "P5: the loop wrote no shared skip path" || fail "P5: shared .failed-tickets written"
kill "$LIVE" 2>/dev/null; wait "$LIVE" 2>/dev/null

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
