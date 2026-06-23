#!/usr/bin/env bash
# =====================================================================
# Dashboard PID tracking (lib/dashboard.sh).
# ---------------------------------------------------------------------
# Proves the precise running-detection that replaced the broad
# `pgrep -f "dist/api/bin.js"`:
#   AC1  gaffer_dashboard_write_pid records the PID under $GAFFER_DATA
#   AC2  gaffer_dashboard_pid returns a LIVE PID whose command matches the
#        dispatch api bin marker
#   AC3  a STALE PID (recorded process is dead) is treated as "not running"
#   AC4  a PID that is alive but is NOT the dispatch api bin is rejected
#        (guards against PID reuse / matching an unrelated process)
#   AC5  a missing/empty PID file degrades gracefully to "not running"
#
# Hermetic: spawns a real `sleep` process whose argv carries the marker
# so `ps -o command=` matches, without ever touching node or a real server.
# Run: bash test/dashboard-pid.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/dashboard-pid-test.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
export GAFFER_DATA="$WORK"
KILL_PIDS=()
cleanup() { for p in "${KILL_PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; rm -rf "$WORK"; }
trap cleanup EXIT

# shellcheck source=../lib/dashboard.sh
source "$RUNNER_DIR/lib/dashboard.sh"

# A stand-in "dashboard" process: a real, long-lived process whose command line
# carries the marker the validator looks for, so ps matching is exercised for real.
# We copy `sleep` to a name that embeds the marker fragment so `ps -o command=`
# reports a path containing "dist/api/bin.js".
MARKER_DIR="$WORK/dist/api"
mkdir -p "$MARKER_DIR"
# A tiny script named bin.js under dist/api/, run with bash, so its command line
# literally contains "dist/api/bin.js" — exactly what the marker matches.
cat > "$MARKER_DIR/bin.js" <<'EOF'
# not real node — a bash sleeper so the command line carries the marker path.
# Trap EXIT/TERM/INT so that killing THIS process also kills its sleep child;
# otherwise the sleeper reparents to init and lingers as an orphan after teardown.
_child=""; trap '[ -n "$_child" ] && kill "$_child" 2>/dev/null || true' EXIT TERM INT
sleep 600 & _child=$!; wait "$_child"
EOF
# Detach stdio so the long-lived sleeper never holds this test's stdout pipe open
# (otherwise the runner blocks waiting for the inherited fd to close).
start_marker_proc() { bash "$MARKER_DIR/bin.js" </dev/null >/dev/null 2>&1 & local p=$!; KILL_PIDS+=("$p"); echo "$p"; }

# An UNRELATED long-lived process (no marker) for the PID-reuse / mismatch case.
start_plain_proc() { sleep 600 </dev/null >/dev/null 2>&1 & local p=$!; KILL_PIDS+=("$p"); echo "$p"; }

echo "== AC1: write_pid records the PID file =="
MARKER_PID="$(start_marker_proc)"
gaffer_dashboard_write_pid "$MARKER_PID"
PIDFILE="$(gaffer_dashboard_pidfile)"
[ -s "$PIDFILE" ] && [ "$(cat "$PIDFILE")" = "$MARKER_PID" ] \
  && ok "PID $MARKER_PID written to $PIDFILE" || fail "PID file not written correctly"

echo "== AC2: a live, command-matching PID is reported running =="
got="$(gaffer_dashboard_pid 2>/dev/null || true)"
[ "$got" = "$MARKER_PID" ] && ok "gaffer_dashboard_pid → live matching PID $got" \
  || fail "expected live matching PID $MARKER_PID, got '$got'"

echo "== AC3: a stale (dead) PID is treated as not running =="
kill "$MARKER_PID" 2>/dev/null; wait "$MARKER_PID" 2>/dev/null || true
# PID file still points at the now-dead process.
if gaffer_dashboard_pid >/dev/null 2>&1; then fail "dead PID should not report running"
else ok "dead recorded PID → not running (graceful)"; fi

echo "== AC4: alive-but-not-our-bin PID is rejected (PID reuse guard) =="
PLAIN_PID="$(start_plain_proc)"
gaffer_dashboard_write_pid "$PLAIN_PID"   # record a non-dashboard process's PID
if gaffer_dashboard_pid >/dev/null 2>&1; then fail "non-dashboard PID should be rejected by command match"
else ok "live PID whose command isn't the api bin → not running"; fi
kill "$PLAIN_PID" 2>/dev/null || true

echo "== AC5: missing / empty PID file degrades gracefully =="
rm -f "$PIDFILE"
gaffer_dashboard_pid >/dev/null 2>&1 && fail "missing PID file should be not-running" || ok "missing PID file → not running"
: > "$PIDFILE"
gaffer_dashboard_pid >/dev/null 2>&1 && fail "empty PID file should be not-running" || ok "empty PID file → not running"
printf 'not-a-number\n' > "$PIDFILE"
gaffer_dashboard_pid >/dev/null 2>&1 && fail "garbage PID file should be not-running" || ok "non-numeric PID file → not running"

# PROOF: the front door + status pane consult the helper, not a broad pgrep.
grep -q 'gaffer_dashboard_pid' "$RUNNER_DIR/gaffer" \
  && ok "gaffer front door uses gaffer_dashboard_pid" || fail "gaffer still not using the helper"
grep -q 'gaffer_dashboard_write_pid' "$RUNNER_DIR/gaffer" \
  && ok "gaffer records the launched PID" || fail "gaffer does not record the PID"
grep -q 'gaffer_dashboard_pid' "$RUNNER_DIR/status.sh" \
  && ok "status pane uses gaffer_dashboard_pid" || fail "status.sh still not using the helper"
! grep -q 'pgrep -f "dist/api/bin.js"' "$RUNNER_DIR/gaffer" \
  && ok "gaffer no longer uses the broad pgrep" || fail "gaffer still uses broad pgrep"
! grep -q 'pgrep -f "dist/api/bin.js"' "$RUNNER_DIR/status.sh" \
  && ok "status.sh no longer uses the broad pgrep" || fail "status.sh still uses broad pgrep"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "  ALL PASS ($PASS checks)"; exit 0
else printf '  %d FAILURE(S), %d passed\n' "${#FAILURES[@]}" "$PASS"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1; fi
