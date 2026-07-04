#!/usr/bin/env bash
# =====================================================================
# AFK DAEMON (C1) — gaffer_run_daemon from lib/daemon.sh.
# ---------------------------------------------------------------------
# The portable "walk away and it keeps working" loop: re-run the supervisor pass
# ($GAFFER_LOOP_SH) every N seconds, honouring the per-day cap (gaffer_day_cap_ok),
# until a stop signal finishes the current pass and exits. Proves, with a STUB loop
# (no agent spawned):
#   • it LOOPS: re-runs the supervisor pass GAFFER_DAEMON_MAX_CYCLES times;
#   • it HONOURS the day cap: when gaffer_day_cap_ok is false it idles (loop NOT run);
#   • it STOPS on SIGTERM (graceful: finishes the current pass, then exits).
# Also asserts `gaffer run` wiring exists in the dispatcher.
# Run: bash test/gaffer-run-daemon.test.sh   (bash 3.2 safe)
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
# shellcheck source=../lib/daemon.sh
source "$RUNNER_DIR/lib/daemon.sh"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/daemon-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
CNT="$WORK/passes"; echo 0 > "$CNT"
# Stub supervisor loop: record one pass, no agent, instant.
STUB="$WORK/loop.sh"
cat > "$STUB" <<STUBSH
#!/usr/bin/env bash
n="\$(cat "$CNT")"; echo "\$((n + 1))" > "$CNT"
STUBSH
chmod +x "$STUB"
export GAFFER_LOOP_SH="$STUB"

# 1. WIRING: `gaffer run` exists in the dispatcher and reaches the daemon.
grep -qE '^run\)' "$RUNNER_DIR/gaffer" \
  && ok "dispatcher has a 'run' subcommand" || fail "no 'run' subcommand in runner/gaffer"
grep -q 'gaffer_run_daemon' "$RUNNER_DIR/gaffer" \
  && ok "'gaffer run --daemon' calls gaffer_run_daemon" || fail "run does not call gaffer_run_daemon"

# 2. LOOPS: with no cap and MAX_CYCLES=3, the supervisor pass runs 3 times.
echo 0 > "$CNT"
unset -f gaffer_day_cap_ok 2>/dev/null || true   # no cap defined → never gated
GAFFER_DAEMON_MAX_CYCLES=3 gaffer_run_daemon 0 2>/dev/null
[ "$(cat "$CNT")" = "3" ] && ok "daemon looped 3 passes (re-ran the supervisor loop each cycle)" \
  || fail "expected 3 passes, got $(cat "$CNT")"

# 3. DAY CAP: when gaffer_day_cap_ok is false, the daemon idles — loop NOT run — but
#    still terminates (cycles are bounded, so it never spins forever while capped).
echo 0 > "$CNT"
gaffer_day_cap_ok() { return 1; }   # always over the cap
MAX_TICKS_PER_DAY=5
GAFFER_DAEMON_MAX_CYCLES=3 gaffer_run_daemon 0 2>/dev/null
[ "$(cat "$CNT")" = "0" ] && ok "per-day cap reached → daemon idles, loop.sh not run" \
  || fail "ran the loop $(cat "$CNT") time(s) while over the day cap"
unset -f gaffer_day_cap_ok

# 4. GRACEFUL STOP: a SIGTERM finishes the current pass then exits (no hang).
echo 0 > "$CNT"
( GAFFER_DAEMON_MAX_CYCLES=0 gaffer_run_daemon 1 >/dev/null 2>&1 ) &
DPID=$!
sleep 2                          # ~2 passes at interval 1
kill -TERM "$DPID" 2>/dev/null || true
wait "$DPID" 2>/dev/null || true
[ "$(cat "$CNT")" -ge 1 ] 2>/dev/null && ok "daemon ran ≥1 pass before the stop signal (got $(cat "$CNT"))" \
  || fail "daemon ran no passes before SIGTERM"
if kill -0 "$DPID" 2>/dev/null; then kill -KILL "$DPID" 2>/dev/null; fail "daemon still running after SIGTERM (not graceful)"; else ok "daemon exited on SIGTERM (graceful stop)"; fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "gaffer-run-daemon: ALL $PASS checks passed"
  exit 0
fi
echo "gaffer-run-daemon: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
