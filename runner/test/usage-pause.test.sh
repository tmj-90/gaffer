#!/usr/bin/env bash
# =====================================================================
# USAGE-WINDOW PAUSE — lib/usage-pause.mjs + lib/usage-pause.sh, and the admission
# points that read it (daemon, pool worker, gaffer status).
# ---------------------------------------------------------------------
# Proves, hermetically (no agent, no model call):
#   1. paused_until rules: a printed reset + 1 min; no reset → the default
#      (GAFFER_USAGE_PAUSE_DEFAULT_MIN, 60); never below the 10-min floor (a low
#      setting is raised, an imminent reset is held to the floor); clamped to 8
#      days; junk → 60; a later pause is never shortened; an expired pause is gone;
#      a corrupt pause file is ACTIVE (fail closed) until mtime + the default.
#   2. the record CLI writes $GAFFER_DATA/usage-pause.json only for a refusal and
#      prints the TSV the tick reads; status/until/clear behave.
#   3. gaffer_usage_pause_wait sleeps until the pause ends (a 2 s pause, poll 1 s),
#      honours an early clear, and a stop predicate ends it at once.
#   4. the daemon (gaffer_run_daemon) starts NO pass while paused and prints
#      "paused until <time>: usage limit", then runs its pass once the pause ends.
#   5. a pool worker (worker.sh) admits nothing while paused: told to stop during
#      the pause it exits with 0 ticks run.
#   6. gaffer status prints "paused until <time>: usage limit".
# Run: bash test/usage-pause.test.sh   (bash 3.2 safe)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }

PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
has()  { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/usage-pause.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
trap 'gaffer_test_rm_work "$WORK"' EXIT
# shellcheck source=lib/isolate.sh
. "$HERE/lib/isolate.sh"; gaffer_test_isolate "$WORK"
MJS="$RUNNER_DIR/lib/usage-pause.mjs"
PF="$GAFFER_DATA/usage-pause.json"
unset GAFFER_USAGE_PAUSE_DEFAULT_MIN GAFFER_USAGE_PAUSE_FILE

# Write a pause that ends <secs> from now (the file format is the interface).
write_pause() {  # write_pause <secs> [kind]
  node -e '
    const ms = Date.now() + Number(process.argv[2]) * 1000;
    require("fs").writeFileSync(process.argv[1], JSON.stringify({
      paused_until: new Date(ms).toISOString(), until_ms: ms, kind: process.argv[3] || "usage_limit",
      basis: "reset", message: "You’ve hit your session limit", ticket: 7, lane: "delivery",
      recorded_at: new Date().toISOString() }));' "$PF" "$1" "${2:-usage_limit}"
}

echo "== 1: paused_until rules =="
RULES="$(node --input-type=module -e "
import { computePausedUntil, pauseDefaultMin, recordPause, readPause, PAUSE_FLOOR_MIN } from '$MJS';
const now = Date.UTC(2026, 9, 31, 12, 0); const min = (ms) => Math.round((ms - now) / 60000);
const out = {};
out.reset = min(computePausedUntil({ resetsAtMs: now + 90 * 60000 }, now, {}).untilMs);
out.resetBasis = computePausedUntil({ resetsAtMs: now + 90 * 60000 }, now, {}).basis;
out.dflt = min(computePausedUntil({ resetsAtMs: null }, now, {}).untilMs);
out.dfltBasis = computePausedUntil({ resetsAtMs: null }, now, {}).basis;
out.setting = min(computePausedUntil({}, now, { GAFFER_USAGE_PAUSE_DEFAULT_MIN: '240' }).untilMs);
out.low = min(computePausedUntil({}, now, { GAFFER_USAGE_PAUSE_DEFAULT_MIN: '1' }).untilMs);
out.zero = pauseDefaultMin({ GAFFER_USAGE_PAUSE_DEFAULT_MIN: '0' });
out.junk = pauseDefaultMin({ GAFFER_USAGE_PAUSE_DEFAULT_MIN: '-5' });
out.imminent = min(computePausedUntil({ resetsAtMs: now + 30000 }, now, {}).untilMs);
out.past = min(computePausedUntil({ resetsAtMs: now - 3600000 }, now, {}).untilMs);
out.far = min(computePausedUntil({ resetsAtMs: now + 30 * 86400000 }, now, {}).untilMs);
out.floor = PAUSE_FLOOR_MIN;
const env = { GAFFER_DATA: process.argv[1] };
const a = recordPause({ limit: { kind: 'usage_limit', resetsAtMs: now + 120 * 60000, message: 'a' }, ticket: 3 }, env, now);
const b = recordPause({ limit: { kind: 'rate_limit', resetsAtMs: null, message: 'b' }, ticket: 4 }, env, now);
out.keptLonger = b.until_ms === a.until_ms && b.ticket === 3;
const c = recordPause({ limit: { kind: 'rate_limit', resetsAtMs: now + 300 * 60000, message: 'c' }, ticket: 5 }, env, now);
out.extended = min(c.until_ms) === 301 && c.kind === 'rate_limit';
out.expired = readPause(env, now + 302 * 60000) === null;
console.log(JSON.stringify(out));
" "$WORK/rules")"
jf() { node -e 'const o=JSON.parse(process.argv[1]); process.stdout.write(String(o[process.argv[2]]))' "$RULES" "$1"; }
[ "$(jf reset)" = "91" ] && [ "$(jf resetBasis)" = "reset" ] && ok "a printed reset → that time + 1 min (basis reset)" || fail "reset rule: $RULES"
[ "$(jf dflt)" = "60" ] && [ "$(jf dfltBasis)" = "default" ] && ok "no reset → the 60-min default (basis default)" || fail "default rule: $RULES"
[ "$(jf setting)" = "240" ] && ok "GAFFER_USAGE_PAUSE_DEFAULT_MIN=240 → 240 min" || fail "setting rule: $RULES"
[ "$(jf low)" = "10" ] && [ "$(jf zero)" = "10" ] && ok "a setting below the floor (1, 0) is raised to 10 min — never configurable below it" || fail "floor rule: $RULES"
[ "$(jf junk)" = "60" ] && ok "a junk setting (-5) falls back to 60" || fail "junk rule: $RULES"
[ "$(jf imminent)" = "10" ] && [ "$(jf past)" = "10" ] && ok "a reset 30 s away (or already past) is held to the 10-min floor" || fail "imminent rule: $RULES"
[ "$(jf far)" = "11520" ] && ok "a reset 30 days out is clamped to 8 days" || fail "max clamp: $RULES"
[ "$(jf keptLonger)" = "true" ] && ok "a shorter second pause never shortens the one in force" || fail "never-shorten: $RULES"
[ "$(jf extended)" = "true" ] && ok "a longer second pause extends it" || fail "extend: $RULES"
[ "$(jf expired)" = "true" ] && ok "a pause whose time has passed reads as no pause" || fail "expiry: $RULES"

echo "== 1b: a corrupt pause file fails closed =="
printf 'not json {' > "$PF"
out="$(node "$MJS" status)"; rc=$?
[ "$rc" = 0 ] && has "$out" "paused until" && ok "an unreadable pause file reads as ACTIVE (status exit 0: '$out')" || fail "corrupt file did not fail closed (rc=$rc, '$out')"
node "$MJS" clear; [ ! -e "$PF" ] && ok "clear removes the pause file" || fail "clear left the file"
node "$MJS" status >/dev/null; [ "$?" = 1 ] && ok "no pause file → status exit 1 (not paused)" || fail "status without a file is not exit 1"

echo "== 2: the record CLI =="
printf '%s' '{"type":"result","subtype":"success","is_error":true,"result":"You'"'"'ve hit your session limit · resets 3pm (Europe/London)","num_turns":1}' > "$WORK/limit.json"
printf '%s' '{"type":"result","subtype":"success","is_error":false,"result":"delivered","num_turns":4}' > "$WORK/ok.json"
node "$MJS" record --json-file "$WORK/ok.json" --ticket 9 >/dev/null; rc=$?
[ "$rc" = 10 ] && [ ! -e "$PF" ] && ok "an ordinary result records nothing (exit 10, no file)" || fail "ordinary result wrote a pause (rc=$rc)"
line="$(node "$MJS" record --json-file "$WORK/limit.json" --ticket 9 --lane delivery)"; rc=$?
IFS=$'\t' read -r r_s r_iso r_kind r_basis r_msg <<<"$line"
{ [ "$rc" = 0 ] && [ -s "$PF" ] && [ "$r_kind" = "usage_limit" ] && [ "$r_basis" = "reset" ] \
  && [ "$r_s" -gt "$(date +%s)" ] && has "$r_msg" "session limit" && has "$r_iso" "T"; } \
  && ok "a refusal writes usage-pause.json and prints <until s> <ISO> <kind> <basis> <message>" || fail "record line '$line' (rc=$rc)"
[ "$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).ticket))' "$PF")" = "9" ] \
  && ok "the pause names the ticket that hit it" || fail "pause file has no ticket"
until_s="$(node "$MJS" until)"; [ "$until_s" = "$r_s" ] && ok "until prints the end in epoch seconds" || fail "until '$until_s' != '$r_s'"
node "$MJS" clear

echo "== 3: gaffer_usage_pause_record / _active / _wait (bash) =="
# shellcheck source=../lib/usage-pause.sh
source "$RUNNER_DIR/lib/usage-pause.sh"
gaffer_usage_pause_record "$WORK/ok.json" 9 delivery >/dev/null; [ "$?" = 1 ] && ok "record on an ordinary result → rc 1" || fail "record on ok.json not rc 1"
gaffer_usage_pause_record "$WORK/limit.json" 9 delivery >/dev/null; [ "$?" = 0 ] && ok "record on a refusal → rc 0" || fail "record on limit.json not rc 0"
GAFFER_USAGE_PAUSE_FILE="$WORK/no-such-dir/sub/x.json" gaffer_usage_pause_active >/dev/null && fail "a missing file read as active" || ok "_active is false when the file is absent"
# A parent that is a regular file: unwritable even as root.
: > "$WORK/not-a-dir"
GAFFER_USAGE_PAUSE_FILE="$WORK/not-a-dir/usage-pause.json" gaffer_usage_pause_record "$WORK/limit.json" 9 delivery >/dev/null; rc=$?
[ "$rc" = 2 ] && ok "a refusal whose pause cannot be written → rc 2 (the tick fails closed)" || fail "unwritable pause rc=$rc (want 2)"
node "$MJS" clear
# CLASSIFY BEFORE THE LOCK: a lock that cannot be taken, or a record step that
# crashes, must never turn an ordinary result into a "refusal" (it used to: rc 2, and
# the tick released a committed delivery to ready and skip-listed it).
gaffer_with_lock() { return 1; }   # the lock could not be taken (as on a timeout)
gaffer_usage_pause_record "$WORK/ok.json" 9 delivery >/dev/null; rc=$?
[ "$rc" = 1 ] && ok "lock unavailable + an ordinary result → rc 1 (ordinary path, not a refusal)" || fail "lock unavailable + ok.json rc=$rc (want 1)"
gaffer_usage_pause_record "$WORK/limit.json" 9 delivery >/dev/null; rc=$?
[ "$rc" = 2 ] && [ ! -e "$PF" ] && ok "lock unavailable + a confirmed refusal → rc 2 (fail closed), no pause" || fail "lock unavailable + limit.json rc=$rc (want 2)"
unset -f gaffer_with_lock
printf 'throw new Error("boom");\n' > "$WORK/crash.mjs"
GAFFER_USAGE_PAUSE_MJS="$WORK/crash.mjs" gaffer_usage_pause_record "$WORK/ok.json" 9 delivery >/dev/null; rc=$?
[ "$rc" = 1 ] && ok "a record step that crashes + an ordinary result → rc 1" || fail "crashing record + ok.json rc=$rc (want 1)"
GAFFER_USAGE_PAUSE_MJS="$WORK/crash.mjs" gaffer_usage_pause_record "$WORK/limit.json" 9 delivery >/dev/null; rc=$?
[ "$rc" = 2 ] && ok "a record step that crashes + a confirmed refusal → rc 2" || fail "crashing record + limit.json rc=$rc (want 2)"
GAFFER_USAGE_WORKER_MJS="$WORK/crash.mjs" gaffer_usage_pause_record "$WORK/limit.json" 9 delivery >/dev/null; rc=$?
[ "$rc" = 1 ] && [ ! -e "$PF" ] && ok "a classifier that crashes → rc 1 (the ordinary failure path; nothing recorded)" || fail "crashing classifier rc=$rc (want 1)"
printf '' > "$WORK/silent.mjs"
GAFFER_USAGE_WORKER_MJS="$WORK/silent.mjs" gaffer_usage_pause_record "$WORK/limit.json" 9 delivery >/dev/null; rc=$?
[ "$rc" = 1 ] && ok "a classifier that exits 0 with no detection JSON → rc 1 (not read as a refusal)" || fail "silent classifier rc=$rc (want 1)"
write_pause 2
line="$(gaffer_usage_pause_active)" && has "$line" "paused until" && has "$line" ": usage limit" \
  && ok "_active prints '$line'" || fail "_active did not report the pause ('$line')"
t0="$(date +%s)"
GAFFER_USAGE_PAUSE_POLL_SECS=1 gaffer_usage_pause_wait; wrc=$?
el=$(( $(date +%s) - t0 ))
[ "$wrc" = 0 ] && [ "$el" -ge 1 ] && [ "$el" -le 6 ] && ok "_wait slept until the 2 s pause ended (${el}s) and returned 0" || fail "_wait rc=$wrc after ${el}s"
write_pause 600
( sleep 2; node "$MJS" clear ) &
t0="$(date +%s)"
GAFFER_USAGE_PAUSE_POLL_SECS=1 gaffer_usage_pause_wait; wrc=$?
el=$(( $(date +%s) - t0 ))
[ "$wrc" = 0 ] && [ "$el" -le 6 ] && ok "a human's early clear ends a 10-min wait within the poll (${el}s)" || fail "early clear not honoured (rc=$wrc, ${el}s)"
wait 2>/dev/null
write_pause 600
_stop_now() { return 0; }
GAFFER_USAGE_PAUSE_POLL_SECS=1 gaffer_usage_pause_wait _stop_now; [ "$?" = 1 ] && ok "a stop predicate ends the wait at once (rc 1)" || fail "stop predicate ignored"
node "$MJS" clear

# GAFFER_DATA as factory.config.sh leaves it: a plain shell variable, NOT exported
# (`: "${GAFFER_DATA:=$GAFFER_HOME/.gaffer}"`). The helpers must hand it to node
# themselves; reading it from the environment only, a live run with the default data
# dir never wrote a pause (rc 2: refusal skip-listed, nothing paused) and never read one.
UNEXP="$WORK/unexported-data"; mkdir -p "$UNEXP"
(
  unset GAFFER_DATA; GAFFER_DATA="$UNEXP"   # assigned after unset: not exported
  gaffer_usage_pause_record "$WORK/limit.json" 9 delivery >/dev/null; echo "rec=$?"
  [ -s "$UNEXP/usage-pause.json" ] && echo "file=yes" || echo "file=no"
  gaffer_usage_pause_active >/dev/null; echo "active=$?"
  gaffer_usage_pause_until >/dev/null; echo "until=$?"
) > "$WORK/unexp.out" 2>&1
grep -qx 'rec=0' "$WORK/unexp.out" && grep -qx 'file=yes' "$WORK/unexp.out" \
  && ok "an UNEXPORTED GAFFER_DATA (the factory.config.sh default) still records the pause there" \
  || fail "unexported GAFFER_DATA: $(tr '\n' ' ' < "$WORK/unexp.out")"
grep -qx 'active=0' "$WORK/unexp.out" && grep -qx 'until=0' "$WORK/unexp.out" \
  && ok "an UNEXPORTED GAFFER_DATA: _active / _until read that pause" \
  || fail "unexported GAFFER_DATA read: $(tr '\n' ' ' < "$WORK/unexp.out")"
rm -rf "$UNEXP"

# A symlinked lib dir (a packaged install, a test's fake runner): the CLI must still
# run — it used to compare import.meta.url (resolved) with argv[1] (the link), exit 0
# with no output, and read as "paused" forever.
LINKED="$WORK/linked"; mkdir -p "$LINKED"; ln -s "$RUNNER_DIR/lib" "$LINKED/lib"
GAFFER_USAGE_PAUSE_MJS="$LINKED/lib/usage-pause.mjs" gaffer_usage_pause_active >/dev/null \
  && fail "a symlinked usage-pause.mjs reads as paused with no pause file" || ok "a symlinked usage-pause.mjs with no pause → not paused"
GAFFER_USAGE_PAUSE_MJS="$LINKED/lib/usage-pause.mjs" gaffer_usage_pause_record "$WORK/ok.json" 9 delivery >/dev/null; rc=$?
[ "$rc" = 1 ] && ok "a symlinked record on an ordinary result → rc 1 (not a refusal)" || fail "symlinked record rc=$rc"
GAFFER_USAGE_PAUSE_MJS="$LINKED/lib/usage-pause.mjs" GAFFER_USAGE_WORKER_MJS="$LINKED/lib/worker.mjs" gaffer_usage_pause_record "$WORK/limit.json" 9 delivery >/dev/null; rc=$?
[ "$rc" = 0 ] && [ -s "$PF" ] && ok "a symlinked classifier + record still pause on a refusal → rc 0" || fail "symlinked refusal rc=$rc (want 0)"
node "$MJS" clear
write_pause 30
GAFFER_USAGE_PAUSE_MJS="$LINKED/lib/usage-pause.mjs" gaffer_usage_pause_active >/dev/null \
  && ok "a symlinked usage-pause.mjs reads a real pause" || fail "symlinked status missed a pause"
node "$MJS" clear

echo "== 4: the daemon sleeps instead of starting a pass =="
# shellcheck source=../lib/daemon.sh
source "$RUNNER_DIR/lib/daemon.sh"
CNT="$WORK/passes"; echo 0 > "$CNT"; STAMP="$WORK/pass-at"
STUB="$WORK/loop.sh"
cat > "$STUB" <<STUBSH
#!/usr/bin/env bash
date +%s > "$STAMP"; n="\$(cat "$CNT")"; echo "\$((n + 1))" > "$CNT"
STUBSH
chmod +x "$STUB"
write_pause 2
t0="$(date +%s)"
dout="$(GAFFER_LOOP_SH="$STUB" GAFFER_DAEMON_MAX_CYCLES=2 GAFFER_USAGE_PAUSE_POLL_SECS=1 DRY_RUN=0 gaffer_run_daemon 0 2>&1)"
has "$dout" "gaffer daemon: paused until" && has "$dout" ": usage limit — sleeping until then" \
  && ok "the daemon printed 'paused until <time>: usage limit — sleeping until then'" || fail "daemon output: $dout"
[ "$(cat "$CNT")" = "1" ] && [ "$(( $(cat "$STAMP") - t0 ))" -ge 1 ] \
  && ok "no pass ran during the pause; the one pass ran after it ended" || fail "passes=$(cat "$CNT"), at +$(( $(cat "$STAMP" 2>/dev/null || echo "$t0") - t0 ))s"
echo 0 > "$CNT"; write_pause 600
( GAFFER_LOOP_SH="$STUB" GAFFER_DAEMON_MAX_CYCLES=0 GAFFER_USAGE_PAUSE_POLL_SECS=1 DRY_RUN=0 gaffer_run_daemon 0 >/dev/null 2>&1 ) &
DPID=$!
sleep 2; kill -TERM "$DPID" 2>/dev/null
for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$DPID" 2>/dev/null || break; sleep 0.5; done
if kill -0 "$DPID" 2>/dev/null; then kill -9 "$DPID" 2>/dev/null; fail "the daemon did not stop on SIGTERM during the pause"
else ok "SIGTERM during the pause stops the daemon promptly"; fi
[ "$(cat "$CNT")" = "0" ] && ok "a paused daemon told to stop ran no pass" || fail "ran $(cat "$CNT") pass(es)"
node "$MJS" clear

echo "== 5: a pool worker stops admitting while paused =="
write_pause 600
export GAFFER_POOL_STOP_FILE="$WORK/pool-stop"; rm -f "$GAFFER_POOL_STOP_FILE"
( DRY_RUN=0 WORKER_MAX_TICKS=3 GAFFER_USAGE_PAUSE_POLL_SECS=1 MAX_TICKS_PER_DAY=0 \
    bash "$RUNNER_DIR/worker.sh" 0 > "$WORK/worker.out" 2>&1 ) &
WPID=$!
sleep 3; : > "$GAFFER_POOL_STOP_FILE"
for _ in $(seq 1 20); do kill -0 "$WPID" 2>/dev/null || break; sleep 0.5; done
kill -0 "$WPID" 2>/dev/null && { kill -9 "$WPID"; fail "worker still running after the stop file"; }
has "$(cat "$WORK/worker.out")" "not admitting new work until then" \
  && ok "the worker said it is not admitting new work" || fail "worker output: $(tail -3 "$WORK/worker.out")"
read -r _w _r _c _i _n _e wticks < "$GAFFER_DATA/.workers/0.result" 2>/dev/null || wticks="?"
[ "$wticks" = "0" ] && ok "the paused worker ran 0 ticks (no claim, no spawn)" || fail "worker ran '$wticks' tick(s)"
unset GAFFER_POOL_STOP_FILE
node "$MJS" clear

echo "== 6: gaffer status shows the pause =="
mk() { printf '#!/usr/bin/env bash\nprintf "%%s\\n" %q\n' "$2" > "$1"; chmod +x "$1"; }
mk "$WORK/doc.sh" "Healthy."; mk "$WORK/stats.sh" '{"ticketsByStatus":{"ready":1}}'; mk "$WORK/empty.sh" "[]"
run_status() {
  WG_DOCTOR_CMD="$WORK/doc.sh" FG_DOCTOR_CMD="$WORK/doc.sh" LG_DOCTOR_CMD="$WORK/doc.sh" \
  STATS_CMD="$WORK/stats.sh" REPOS_CMD="$WORK/empty.sh" HUMAN_QUEUE_CMD="$WORK/empty.sh" \
  GAFFER_LOG="$WORK/factory.log" DASHBOARD_PROBE_URL="http://127.0.0.1:1/none" \
  bash "$RUNNER_DIR/status.sh" 2>&1 | sed 's/\x1b\[[0-9;]*m//g'
}
sout="$(run_status)"
has "$sout" "paused until" && fail "status shows a pause when there is none" || ok "no pause → no pause line"
write_pause 3600
sout="$(run_status)"
has "$sout" "paused until " && has "$sout" " UTC: usage limit" \
  && ok "status: '$(printf '%s\n' "$sout" | grep -m1 'paused until' | sed 's/^ *//' | cut -c1-60)…'" || fail "status lacks the pause line: $sout"
write_pause 3600 rate_limit
has "$(run_status)" ": rate limit" && ok "a rate-limit pause says 'rate limit'" || fail "rate_limit kind not shown"
node "$MJS" clear

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "usage-pause: ALL $PASS checks passed"
  exit 0
fi
echo "usage-pause: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
