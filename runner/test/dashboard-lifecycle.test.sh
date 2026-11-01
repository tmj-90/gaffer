#!/usr/bin/env bash
# =====================================================================
# `gaffer dashboard` start / --restart / --stop say what really happened.
# ---------------------------------------------------------------------
# With the pid file missing, stale or garbage, or another server on the port, the
# launcher used to start a node that died on EADDRINUSE, record its dead pid, truncate
# dashboard.log, and print "✓ dashboard up" because the OLD server answered the probe
# (with the old token: --restart rotated nothing). Against the REAL built API server
# on scratch ports, proves:
#   A  a fresh start is up, its pid file names the live server, the token works;
#   B  --restart stops the old server, starts a new one and ROTATES the token;
#   C  --restart with a garbage / D  a dead pid file finds the old server by its port;
#   E  a plain start while a server of ours holds the port (pid file lost) refuses:
#      "already in use by pid N", exit 1, no pid file, dashboard.log untouched;
#   F  a non-dispatch listener is named and never stopped (start, --restart, --stop);
#   G  another factory's dashboard on the port is not stopped from here;
#   H  a server that exits on startup: exit 1, the reason, no dead pid, old log kept;
#   I  the token file deleted while it runs: a clear message + --restart, exit 1;
#   J  --stop stops it and removes the pid file; again → "not running", exit 0;
#   K  `gaffer status` reports the pid-file state truthfully;
#   L  a pid file naming a live process that only CARRIES the marker on its argv (a
#      recycled pid) is not trusted on Linux: not "already up", never stopped;
#   M  where the OS hides a process's environment (macOS-like, via _GAFFER_PROC_ROOT)
#      a server found only by its port is refused, not killed; one the pid file names
#      is still stopped; a non-numeric GAFFER_DASHBOARD_START_TIMEOUT falls back to 30.
# Ports: GAFFER_TEST_PORT_BASE (+0, +1), else random in 20000-39999.
# Run: bash runner/test/dashboard-lifecycle.test.sh   (bash 3.2 safe)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
API_BIN="$RUNNER_DIR/../packages/dispatch/dist/api/bin.js"
[ -f "$API_BIN" ] || { echo "SKIP: dispatch not built ($API_BIN)"; exit 0; }
command -v curl >/dev/null 2>&1 || { echo "SKIP: curl not on PATH"; exit 0; }
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required (a non-dispatch listener)"; exit 0; }
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
has()  { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/dashboard-lifecycle.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
DATA="$WORK/data"; OTHER="$WORK/other"
BASE="${GAFFER_TEST_PORT_BASE:-$(( 20000 + RANDOM % 20000 ))}"
PORT="$BASE"
unset DISPATCH_API_TOKEN NO_COLOR GAFFER_DATA _GAFFER_PROC_ROOT GAFFER_DASHBOARD_START_TIMEOUT
SPAWNED=()
cleanup() {
  local p
  for p in "$(cat "$DATA/dashboard.pid" 2>/dev/null)" "$(cat "$OTHER/dashboard.pid" 2>/dev/null)" ${SPAWNED[@]+"${SPAWNED[@]}"}; do
    case "$p" in ''|*[!0-9]*) continue ;; esac
    kill "$p" 2>/dev/null; sleep 0.2; kill -9 "$p" 2>/dev/null
  done
  gaffer_test_rm_work "$WORK"
}
trap cleanup EXIT

dash() { RC=0; OUT="$(env GAFFER_DATA="$DATA" DISPATCH_API_PORT="$PORT" bash "$RUNNER_DIR/gaffer" dashboard "$@" 2>&1)" || RC=$?; }
tok()  { cat "$DATA/dashboard-token" 2>/dev/null; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H "Authorization: Bearer $1" "http://127.0.0.1:$PORT/api/dashboard"; }
alive() { kill -0 "$1" 2>/dev/null; }
listener() { ( . "$RUNNER_DIR/lib/dashboard.sh"; gaffer_port_listener_pid "$PORT" ); }
gone_within() { local i=0; while alive "$1" && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done; ! alive "$1"; }
port_free_within() { local i=0; while [ -n "$(listener)" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done; [ -z "$(listener)" ]; }
# stop_started <pid> — a section stops the server it started on EVERY path (a skip
# too): `--stop` by the pid file, then a hard kill if it lingers, so the next section
# never finds it on the port ("✓ dashboard already up").
stop_started() {
  case "$1" in ''|*[!0-9]*) return 0 ;; esac
  alive "$1" || return 0
  echo "$1" > "$DATA/dashboard.pid"; dash --stop
  gone_within "$1" || kill -9 "$1" 2>/dev/null
}

echo "== A: a fresh start =="
dash
P1="$(cat "$DATA/dashboard.pid" 2>/dev/null)"; T1="$(tok)"
[ "$RC" -eq 0 ] && has "$OUT" "dashboard up" && ok "fresh start: exit 0, 'dashboard up'" || fail "fresh start rc=$RC: $OUT"
[ -n "$P1" ] && alive "$P1" && [ "$(listener)" = "$P1" ] && ok "the pid file names the live server holding the port ($P1)" || fail "pid file '$P1' vs listener '$(listener)'"
[ "$(code "$T1")" = 200 ] && ok "the printed token authenticates" || fail "token got $(code "$T1")"
has "$OUT" "?token=$T1" && ok "the login URL carries the token" || fail "no login URL: $OUT"

echo "== B: --restart stops the old server and rotates the token =="
dash --restart
P2="$(cat "$DATA/dashboard.pid" 2>/dev/null)"; T2="$(tok)"
[ "$RC" -eq 0 ] && has "$OUT" "dashboard up" && ok "--restart: exit 0, up" || fail "--restart rc=$RC: $OUT"
gone_within "$P1" && ok "the old server ($P1) is gone" || fail "the old server $P1 still runs"
[ -n "$P2" ] && [ "$P2" != "$P1" ] && alive "$P2" && [ "$(listener)" = "$P2" ] && ok "the new pid ($P2) holds the port" || fail "new pid '$P2' listener '$(listener)'"
[ -n "$T2" ] && [ "$T2" != "$T1" ] && ok "the token rotated" || fail "token not rotated"
[ "$(code "$T1")" = 401 ] && [ "$(code "$T2")" = 200 ] && ok "old token 401, new token 200" || fail "old $(code "$T1") new $(code "$T2")"
has "$OUT" "?token=$T2" && ok "the NEW token is printed" || fail "printed URL is not the new token: $OUT"

echo "== C: --restart with a garbage pid file finds the server by its port =="
echo "garbage" > "$DATA/dashboard.pid"
dash --restart
P3="$(cat "$DATA/dashboard.pid" 2>/dev/null)"; T3="$(tok)"
gone_within "$P2" && ok "the server the garbage pid file lost track of was stopped" || fail "old server $P2 still runs: $OUT"
[ "$RC" -eq 0 ] && [ -n "$P3" ] && alive "$P3" && [ "$(listener)" = "$P3" ] && ok "a new server is up and recorded ($P3)" || fail "rc=$RC pid '$P3' listener '$(listener)': $OUT"
[ "$T3" != "$T2" ] && [ "$(code "$T3")" = 200 ] && ok "token rotated (new one works)" || fail "token not rotated after a garbage pid file"
has "$OUT" "found by its port" && ok "it says how it found the old server" || fail "no 'found by its port': $OUT"

echo "== D: --restart with a dead pid in the file =="
sleep 0 & DEAD=$!; wait "$DEAD" 2>/dev/null
echo "$DEAD" > "$DATA/dashboard.pid"
dash --restart
P4="$(cat "$DATA/dashboard.pid" 2>/dev/null)"
gone_within "$P3" && [ "$RC" -eq 0 ] && [ -n "$P4" ] && alive "$P4" && [ "$(listener)" = "$P4" ] \
  && ok "stale pid: old stopped by port, new up ($P4)" || fail "stale pid restart rc=$RC p3 alive? new '$P4': $OUT"

echo "== E: the pid file lost while a server of ours holds the port =="
rm -f "$DATA/dashboard.pid"; cp "$DATA/dashboard.log" "$WORK/log.before"; T4="$(tok)"
dash
[ "$RC" -ne 0 ] && ok "a plain start refuses (exit $RC)" || fail "plain start on a held port exited 0: $OUT"
has "$OUT" "port $PORT is already in use by pid $P4" && ok "names the port and the pid holding it" || fail "message: $OUT"
has "$OUT" "dashboard up" && fail "said 'dashboard up' over another server" || ok "no false 'dashboard up'"
[ ! -e "$DATA/dashboard.pid" ] && ok "no pid file written" || fail "a pid file was written: $(cat "$DATA/dashboard.pid")"
cmp -s "$WORK/log.before" "$DATA/dashboard.log" && ok "dashboard.log untouched" || fail "dashboard.log changed"
alive "$P4" && [ "$(code "$T4")" = 200 ] && ok "the running server and its token are untouched" || fail "running server disturbed"
echo "$P4" > "$DATA/dashboard.pid"   # hand it back for the next sections

echo "== J: --stop =="
dash --stop
[ "$RC" -eq 0 ] && has "$OUT" "stopped the dashboard (pid $P4)" && ok "--stop: exit 0, names the pid" || fail "--stop rc=$RC: $OUT"
gone_within "$P4" && ok "the server is gone" || fail "server $P4 still runs after --stop"
[ ! -e "$DATA/dashboard.pid" ] && ok "the pid file is removed" || fail "pid file left behind"
dash --stop
[ "$RC" -eq 0 ] && has "$OUT" "not running" && ok "--stop again: 'not running', exit 0" || fail "second --stop rc=$RC: $OUT"

echo "== F: a non-dispatch listener on the port =="
( python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 & echo $! > "$WORK/py.pid" )
PY="$(cat "$WORK/py.pid")"; SPAWNED+=("$PY")
i=0; while [ "$(listener)" != "$PY" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
dash
[ "$RC" -ne 0 ] && has "$OUT" "port $PORT is already in use by pid $PY" && ok "start refused, the holder named" || fail "start over a foreign listener rc=$RC: $OUT"
[ ! -e "$DATA/dashboard.pid" ] && ok "no pid file" || fail "pid file written over a foreign listener"
dash --restart
[ "$RC" -ne 0 ] && alive "$PY" && ok "--restart refuses and leaves the foreign process alone" || fail "--restart rc=$RC py alive? $(alive "$PY" && echo yes || echo no): $OUT"
dash --stop
alive "$PY" && has "$OUT" "not a gaffer dashboard" && ok "--stop leaves it alone and says so" || fail "--stop vs foreign: $OUT"
kill "$PY" 2>/dev/null; gone_within "$PY" || kill -9 "$PY" 2>/dev/null

echo "== G: another factory's dashboard on the port =="
env GAFFER_DATA="$OTHER" DISPATCH_API_PORT="$PORT" bash "$RUNNER_DIR/gaffer" dashboard >/dev/null 2>&1
PO="$(cat "$OTHER/dashboard.pid" 2>/dev/null)"
dash --restart
if [ -n "$( . "$RUNNER_DIR/lib/dashboard.sh"; _gaffer_pid_data_dir "$PO")" ]; then
  [ "$RC" -ne 0 ] && alive "$PO" && has "$OUT" "another factory" && ok "the other factory's server is not stopped from here" || fail "other factory: rc=$RC alive? $(alive "$PO" && echo y || echo n): $OUT"
else
  echo "  note: this OS does not show another process's GAFFER_DATA; the port rule alone applies"
fi
env GAFFER_DATA="$OTHER" DISPATCH_API_PORT="$PORT" bash "$RUNNER_DIR/gaffer" dashboard --stop >/dev/null 2>&1
gone_within "$PO" || kill -9 "$PO" 2>/dev/null

echo "== L: a pid file naming a process that only carries the marker on its argv =="
rm -f "$DATA/dashboard.pid"
( exec -a "node /elsewhere/dist/api/bin.js --port $PORT" sleep 300 ) & FAKE=$!; SPAWNED+=("$FAKE")
if [ -r "/proc/$FAKE/environ" ]; then
  echo "$FAKE" > "$DATA/dashboard.pid"
  dash
  PL="$(cat "$DATA/dashboard.pid" 2>/dev/null)"
  [ "$RC" -eq 0 ] && ! has "$OUT" "already up" && [ "$PL" != "$FAKE" ] && alive "$PL" && ok "not 'already up': a real server started ($PL)" || fail "fake pid trusted: rc=$RC: $OUT"
  echo "$FAKE" > "$DATA/dashboard.pid"
  dash --stop
  alive "$FAKE" && ok "--stop never signals the marker-carrying stranger" || fail "--stop killed pid $FAKE: $OUT"
  gone_within "$PL" && ok "--stop stopped the real server, found by its port" || fail "real server $PL still runs: $OUT"
  echo "$FAKE" > "$DATA/dashboard.pid"
  dash --restart
  alive "$FAKE" && [ "$RC" -eq 0 ] && ok "--restart leaves it alone too" || fail "--restart rc=$RC fake alive? $(alive "$FAKE" && echo y || echo n): $OUT"
  dash --stop
else
  echo "  note: no /proc/<pid>/environ here; section M covers the hidden-environment rule"
fi
kill "$FAKE" 2>/dev/null

echo "== M: an OS that does not show a process's environment =="
rm -f "$DATA/dashboard.pid"
dash; PM="$(cat "$DATA/dashboard.pid" 2>/dev/null)"
hid() { RC=0; OUT="$(env _GAFFER_PROC_ROOT="$WORK/no-proc" GAFFER_DATA="$DATA" DISPATCH_API_PORT="$PORT" bash "$RUNNER_DIR/gaffer" dashboard "$@" 2>&1)" || RC=$?; }
if [ "$(uname -s)" != Darwin ] && [ -n "$PM" ]; then
  hid --stop
  [ "$RC" -eq 0 ] && gone_within "$PM" && ok "the server its pid file names is still stopped" || fail "pid-file stop under a hidden env: rc=$RC: $OUT"
  dash; PM="$(cat "$DATA/dashboard.pid" 2>/dev/null)"; rm -f "$DATA/dashboard.pid"
  hid --restart
  [ "$RC" -ne 0 ] && alive "$PM" && has "$OUT" "does not show" && ok "--restart refuses a port-only match it cannot attribute" || fail "--restart killed or misreported: rc=$RC alive? $(alive "$PM" && echo y || echo n): $OUT"
  hid --stop
  [ "$RC" -ne 0 ] && alive "$PM" && ok "--stop refuses it too (exit $RC)" || fail "--stop under a hidden env: rc=$RC: $OUT"
  hid
  [ "$RC" -ne 0 ] && alive "$PM" && has "$OUT" "kill $PM" && ok "a plain start names it and says how to stop it" || fail "plain start: rc=$RC: $OUT"
  stop_started "$PM"
else
  echo "  note: skipped (real macOS, or no server)"
  stop_started "$PM"
fi
# The timeout=abc start needs the port free: it must start a server, not find one.
port_free_within && ok "the port is free before the timeout=abc start" || fail "port $PORT still held by pid $(listener) before the timeout=abc start"
RC=0; OUT="$(env GAFFER_DASHBOARD_START_TIMEOUT=abc GAFFER_DATA="$DATA" DISPATCH_API_PORT="$PORT" bash "$RUNNER_DIR/gaffer" dashboard 2>&1)" || RC=$?
[ "$RC" -eq 0 ] && has "$OUT" "not a whole number" && has "$OUT" "dashboard up" && ok "a non-numeric start timeout falls back to 30 (said)" || fail "timeout=abc: rc=$RC: $OUT"
has "$OUT" "unbound variable" && fail "raw bash error: $OUT"
dash --stop

echo "== H: a server that exits on startup =="
dash
dash --stop
printf 'the previous server log\n' > "$DATA/dashboard.log"
mkdir -p "$WORK/notadb"
RC=0; OUT="$(env GAFFER_DATA="$DATA" DISPATCH_API_PORT="$PORT" DISPATCH_DB="$WORK/notadb" bash "$RUNNER_DIR/gaffer" dashboard 2>&1)" || RC=$?
[ "$RC" -ne 0 ] && has "$OUT" "dashboard failed to start" && ok "exit $RC with 'dashboard failed to start'" || fail "dead server: rc=$RC: $OUT"
has "$OUT" "dashboard up" && fail "said 'dashboard up' for a dead server" || ok "no false 'dashboard up'"
[ ! -e "$DATA/dashboard.pid" ] && ok "no dead pid written" || fail "dead pid written: $(cat "$DATA/dashboard.pid")"
[ "$(cat "$DATA/dashboard.log")" = "the previous server log" ] && ok "the previous dashboard.log is kept" || fail "dashboard.log replaced by a failed start"
[ -s "$DATA/dashboard-failed.log" ] && has "$OUT" "dashboard-failed.log" && ok "the failed server's output is kept and cited" || fail "no dashboard-failed.log cited: $OUT"

echo "== I: the token file deleted while the dashboard runs =="
dash; PI="$(cat "$DATA/dashboard.pid" 2>/dev/null)"
rm -f "$DATA/dashboard-token"
dash
[ "$RC" -ne 0 ] && ok "exit $RC" || fail "exit 0 with no token: $OUT"
has "$OUT" "token file" && has "$OUT" "gaffer dashboard --restart" && ok "says the token file is gone and to --restart" || fail "message: $OUT"
has "$OUT" "No such file" && fail "raw bash error: $OUT" || ok "no raw bash error"

echo "== K: gaffer status reports the pid-file state =="
mkdir -p "$WORK/stub"; printf '#!/usr/bin/env bash\necho Healthy.\n' > "$WORK/stub/doc.sh"; chmod +x "$WORK/stub/doc.sh"
st() { env GAFFER_DATA="$DATA" DISPATCH_API_PORT="$PORT" WG_DOCTOR_CMD="$WORK/stub/doc.sh" FG_DOCTOR_CMD="$WORK/stub/doc.sh" LG_DOCTOR_CMD="$WORK/stub/doc.sh" \
  STATS_CMD="$WORK/stub/doc.sh" REPOS_CMD="$WORK/stub/doc.sh" HUMAN_QUEUE_CMD="$WORK/stub/doc.sh" bash "$RUNNER_DIR/status.sh" 2>&1; }
OUT="$(st)"; has "$OUT" "dashboard running → http://127.0.0.1:$PORT (pid $PI)" && ok "status: running, with its pid" || fail "status running: $(printf '%s' "$OUT" | grep -i dashboard)"
echo "garbage" > "$DATA/dashboard.pid"
OUT="$(st)"; has "$OUT" "pid file is stale: it names 'garbage'" && ok "status: answering, the pid file named as stale" || fail "status stale: $(printf '%s' "$OUT" | grep -i dashboard)"
rm -f "$DATA/dashboard.pid"
OUT="$(st)"; has "$OUT" "no pid file" && has "$OUT" "pid $PI" && ok "status: answering, no pid file, the port's pid named" || fail "status no pid file: $(printf '%s' "$OUT" | grep -i dashboard)"
echo "$PI" > "$DATA/dashboard.pid"; dash --stop
echo "$PI" > "$DATA/dashboard.pid"
OUT="$(st)"; has "$OUT" "dashboard not running" && has "$OUT" "stale" && ok "status: not running, stale pid file named" || fail "status not running: $(printf '%s' "$OUT" | grep -i dashboard)"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "dashboard-lifecycle: ALL $PASS checks passed"; exit 0; fi
echo "dashboard-lifecycle: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
