#!/usr/bin/env bash
# =====================================================================
# Ctrl-C on `gaffer run --daemon` finishes the current pass, as its banner says
# (exploratory finding cli-runner/F-12).
# ---------------------------------------------------------------------
# A terminal's Ctrl-C sends SIGINT to the whole foreground process group: the daemon
# AND the pass it was running (loop.sh, the tick, the agent). The pass died mid-
# delivery ("runner killed mid-delivery", the ticket back to ready) while the banner
# promised "SIGINT/SIGTERM stops cleanly (finishes the current pass)"; only a TERM to
# the daemon's pid alone did that. Proves, with the REAL `gaffer run --daemon` and a
# STUB pass (GAFFER_LOOP_SH), run in its own process group like a terminal job:
#   D1. SIGINT to the whole group during a pass: the pass runs to its end, no second
#       pass starts, the daemon exits 0 and says it is finishing the pass
#   D2. a second SIGINT stops the pass now: the pass gets TERM (its own stop path)
#   D3. SIGTERM to the daemon's pid still finishes the pass
# Run: bash runner/test/daemon-sigint.test.sh   (bash 3.2 safe)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
command -v perl >/dev/null 2>&1 || { echo "SKIP: perl required (process groups)"; exit 0; }
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
has()  { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/daemon-sigint.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"; trap 'gaffer_test_rm_work "$WORK"' EXIT
mkdir -p "$WORK/data"

# The stub pass: "start", a 4 s piece of work, "end". A TERM ends it early ("termed").
STUB="$WORK/loop.sh"
cat > "$STUB" <<STUBSH
#!/usr/bin/env bash
trap 'echo termed >> "$WORK/events"; exit 143' TERM
echo start >> "$WORK/events"
sleep 4 & wait \$!
echo end >> "$WORK/events"
STUBSH
chmod +x "$STUB"
events() { tr '\n' ' ' < "$WORK/events" 2>/dev/null; }

# start_daemon — `gaffer run --daemon` as a terminal job: its own process group, with
# SIGINT at its default (a background job of a script starts with it ignored).
start_daemon() {
  : > "$WORK/events"; rm -f "$WORK/pgid"
  ( perl -e '$SIG{INT} = "DEFAULT"; setpgrp(0, 0); open(my $f, ">", shift) or die; print $f getpgrp(); close $f; exec @ARGV' \
      "$WORK/pgid" env GAFFER_DATA="$WORK/data" GAFFER_ALLOW_UNCAPPED=1 GAFFER_CLAUDE_AUTH_PROBE=0 GAFFER_LOOP_SH="$STUB" \
      GAFFER_DAEMON_INTERVAL=1 MAX_TICKS_PER_DAY=0 bash "$RUNNER_DIR/gaffer" run --daemon > "$WORK/daemon.out" 2>&1 ) &
  DPID=$!
  local i=0
  while [ "$i" -lt 100 ]; do
    has "$(events)" start && [ -s "$WORK/pgid" ] && break
    sleep 0.1; i=$((i + 1))
  done
  PGID="$(cat "$WORK/pgid" 2>/dev/null)"
}
wait_gone() {  # wait_gone <secs> — 0 when the daemon exited in time
  local i=0
  while kill -0 "$DPID" 2>/dev/null && [ "$i" -lt $(($1 * 10)) ]; do sleep 0.1; i=$((i + 1)); done
  if kill -0 "$DPID" 2>/dev/null; then kill -KILL -- "-$PGID" 2>/dev/null; return 1; fi
  wait "$DPID" 2>/dev/null; return 0
}

echo "== D1. Ctrl-C (SIGINT to the group) finishes the current pass =="
start_daemon
[ -n "$PGID" ] && ok "D1: the pass started (daemon group $PGID)" || fail "D1: the pass never started: $(cat "$WORK/daemon.out")"
kill -INT -- "-$PGID" 2>/dev/null
wait_gone 15 && ok "D1: the daemon exited" || fail "D1: the daemon was still running 15 s after Ctrl-C"
[ "$(events)" = "start end " ] && ok "D1: the pass ran to its end, and no second pass started" || fail "D1: pass events: '$(events)'"
has "$(cat "$WORK/daemon.out")" "finishing the current pass" && ok "D1: the daemon says it is finishing the pass" || fail "D1: output: $(cat "$WORK/daemon.out")"

echo "== D2. a second Ctrl-C stops the pass now =="
start_daemon
kill -INT -- "-$PGID" 2>/dev/null; sleep 0.5; kill -INT -- "-$PGID" 2>/dev/null
wait_gone 15 && ok "D2: the daemon exited" || fail "D2: still running after two Ctrl-Cs"
[ "$(events)" = "start termed " ] && ok "D2: the pass got TERM (its own stop path), not a mid-work kill" || fail "D2: pass events: '$(events)'"

echo "== D3. SIGTERM to the daemon's pid finishes the pass =="
start_daemon
DMAIN="$(pgrep -g "$PGID" -f 'gaffer run --daemon' 2>/dev/null | head -1)"
[ -n "$DMAIN" ] || DMAIN="$PGID"
kill -TERM "$DMAIN" 2>/dev/null
wait_gone 15 && ok "D3: the daemon exited" || fail "D3: still running after SIGTERM"
[ "$(events)" = "start end " ] && ok "D3: the pass ran to its end" || fail "D3: pass events: '$(events)'"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
