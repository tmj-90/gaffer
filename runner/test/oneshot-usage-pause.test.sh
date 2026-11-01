#!/usr/bin/env bash
# =====================================================================
# A ONE-SHOT run never sleeps out a usage-window pause (exploratory finding
# fresh-user/F-13).
# ---------------------------------------------------------------------
# README: "`gaffer run` makes one pass over the ready queue and then exits" and only
# `--daemon` "sleeps until the window resets". loop.sh used to sleep until the pause
# ended (hours) on a one-shot run. Proves, with the REAL loop.sh / worker.sh /
# poll-once.sh / `gaffer run` against a STUB tick.sh (no agent, nothing spent):
#   1. serial loop.sh during a pause: exits promptly with exit 75 and
#      "paused until <time>", and runs no tick.
#   2. a tick that RECORDS a pause mid-run: the pass stops after that tick (exit 75),
#      it does not sleep and does not start another tick.
#   3. the parallel pool (GAFFER_CONCURRENCY=2) exits promptly too (exit 75).
#   4. `gaffer run` (one-shot) passes the 75 through.
#   5. the dashboard Poll (bin/poll-once.sh) refuses at once with "— not polling."
#      and runs no tick.
#   6. the daemon still sleeps (a pass that exits 75 is followed by the pause wait,
#      not a new pass).
# Run: bash runner/test/oneshot-usage-pause.test.sh   (bash 3.2 safe)
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

WORK="$(mktemp -d "${TMPDIR:-/tmp}/oneshot-pause.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
trap 'gaffer_test_rm_work "$WORK"' EXIT
# shellcheck source=lib/isolate.sh
. "$HERE/lib/isolate.sh"; gaffer_test_isolate "$WORK"
PF="$GAFFER_DATA/usage-pause.json"
unset GAFFER_USAGE_PAUSE_DEFAULT_MIN GAFFER_USAGE_PAUSE_FILE
write_pause() {  # write_pause <secs>
  node -e '
    const ms = Date.now() + Number(process.argv[2]) * 1000;
    require("fs").writeFileSync(process.argv[1], JSON.stringify({
      paused_until: new Date(ms).toISOString(), until_ms: ms, kind: "usage_limit",
      basis: "reset", message: "limit", ticket: 7, lane: "delivery",
      recorded_at: new Date().toISOString() }));' "$PF" "$1"
}
clear_pause() { rm -f "$PF"; }

# A FAKE runner dir: every real file symlinked in, tick.sh replaced by a stub that
# records each call and (STUB_PAUSE=1) records a pause the way a refused call does.
FAKE="$WORK/runner"; mkdir -p "$FAKE"
for f in "$RUNNER_DIR"/*; do
  case "$(basename "$f")" in tick.sh|run-summary.sh|test) ;; *) ln -s "$f" "$FAKE/$(basename "$f")" ;; esac
done
cat > "$FAKE/tick.sh" <<STUB
#!/usr/bin/env bash
echo tick >> "$WORK/calls"
if [ "\${STUB_PAUSE:-0}" = 1 ]; then
  node -e 'const ms = Date.now() + 600000; require("fs").writeFileSync(process.argv[1], JSON.stringify({ paused_until: new Date(ms).toISOString(), until_ms: ms, kind: "usage_limit", basis: "reset", message: "limit", recorded_at: new Date().toISOString() }));' "$PF"
  echo "TICK_RESULT=usage_paused"; exit 0
fi
echo "TICK_RESULT=worked"
STUB
chmod +x "$FAKE/tick.sh"
printf '#!/usr/bin/env bash\nprintf "{}\\n"\n' > "$WORK/noop.sh"; chmod +x "$WORK/noop.sh"
calls() { [ -f "$WORK/calls" ] && wc -l < "$WORK/calls" | tr -d ' ' || echo 0; }

# bounded <secs> <outfile> <cmd...> — run in the background; kill it after <secs>.
# Prints the exit code, or "hung" when it had to be killed.
bounded() {
  local secs="$1" out="$2"; shift 2
  ( "$@" > "$out" 2>&1 ) &
  local pid=$! i=0
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt $((secs * 4)) ]; do sleep 0.25; i=$((i + 1)); done
  if kill -0 "$pid" 2>/dev/null; then
    pkill -TERM -P "$pid" 2>/dev/null; kill -TERM "$pid" 2>/dev/null; sleep 0.5
    pkill -KILL -P "$pid" 2>/dev/null; kill -KILL "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
    echo hung; return 0
  fi
  wait "$pid"; echo "$?"
}
loop_env() {
  env DRY_RUN=0 GAFFER_ALLOW_UNCAPPED=1 TICK_SLEEP=0 EMPTY_POLL_LIMIT=1 MAX_TICKS=3 MAX_TICKS_PER_DAY=50 \
    GAFFER_USAGE_PAUSE_POLL_SECS=1 GAFFER_LOG="$WORK/factory.log" DAILY_COUNTER_FILE="$WORK/.daily" \
    DISPATCH_DIR="$WORK/nodist" \
    LOOP_STATS_CMD="$WORK/noop.sh" LOOP_HQ_CMD="$WORK/noop.sh" LOOP_NOTIFY_EMIT_CMD="$WORK/noop.sh" "$@"
}

echo "== 1: serial loop.sh during a pause exits promptly =="
: > "$WORK/calls"; write_pause 600
rc="$(bounded 15 "$WORK/l1.out" loop_env bash "$FAKE/loop.sh")"
[ "$rc" = 75 ] && ok "loop.sh exited 75 (paused) instead of sleeping" || fail "loop.sh rc=$rc: $(tail -5 "$WORK/l1.out")"
has "$(cat "$WORK/l1.out")" "gaffer factory: paused until " && ok "it printed 'paused until <time>'" || fail "no paused line: $(cat "$WORK/l1.out")"
has "$(cat "$WORK/l1.out")" "sleeping until then" && fail "a one-shot pass still claims to sleep" || ok "no 'sleeping until then' on a one-shot pass"
[ "$(calls)" = 0 ] && ok "no tick ran during the pause" || fail "$(calls) tick(s) ran"

echo "== 2: a pause recorded mid-run ends the pass after that tick =="
clear_pause; : > "$WORK/calls"
rc="$(bounded 15 "$WORK/l2.out" loop_env STUB_PAUSE=1 bash "$FAKE/loop.sh")"
[ "$rc" = 75 ] && ok "loop.sh exited 75 after the tick recorded a pause" || fail "rc=$rc: $(tail -5 "$WORK/l2.out")"
[ "$(calls)" = 1 ] && ok "exactly one tick ran" || fail "$(calls) tick(s) ran"

echo "== 3: the parallel pool exits promptly during a pause =="
: > "$WORK/calls"; write_pause 600
rc="$(bounded 20 "$WORK/l3.out" loop_env GAFFER_CONCURRENCY=2 bash "$FAKE/loop.sh")"
[ "$rc" = 75 ] && ok "the pool run exited 75" || fail "pool rc=$rc: $(tail -5 "$WORK/l3.out")"
[ "$(calls)" = 0 ] && ok "no worker ran a tick" || fail "$(calls) tick(s) ran"

echo "== 4: gaffer run (one-shot) passes the 75 through =="
: > "$WORK/calls"; write_pause 600
rc="$(bounded 20 "$WORK/l4.out" loop_env GAFFER_LOOP_SH="$FAKE/loop.sh" bash "$RUNNER_DIR/gaffer" run)"
[ "$rc" = 75 ] && ok "gaffer run exited 75" || fail "gaffer run rc=$rc: $(tail -5 "$WORK/l4.out")"
has "$(cat "$WORK/l4.out")" "paused until " && ok "gaffer run said 'paused until'" || fail "no paused line"

echo "== 5: the dashboard Poll refuses at once =="
: > "$WORK/calls"; write_pause 600
rc="$(bounded 15 "$WORK/l5.out" loop_env GAFFER_POLL_TICK_SH="$FAKE/tick.sh" bash "$RUNNER_DIR/bin/poll-once.sh")"
[ "$rc" = 0 ] && ok "poll exited 0 (the dashboard reads the refusal line)" || fail "poll rc=$rc"
has "$(cat "$WORK/l5.out")" "paused until " && has "$(cat "$WORK/l5.out")" "— not polling." \
  && ok "poll said 'paused until … — not polling.'" || fail "poll output: $(cat "$WORK/l5.out")"
[ "$(calls)" = 0 ] && ok "the poll ran no tick" || fail "$(calls) tick(s) ran"

echo "== 6: the daemon sleeps out the pause after a paused pass =="
clear_pause; : > "$WORK/calls"
DSTUB="$WORK/dloop.sh"
cat > "$DSTUB" <<DS
#!/usr/bin/env bash
echo pass >> "$WORK/calls"
n="\$(wc -l < "$WORK/calls" | tr -d ' ')"
if [ "\$n" = 1 ]; then
  node -e 'const ms = Date.now() + 2000; require("fs").writeFileSync(process.argv[1], JSON.stringify({ paused_until: new Date(ms).toISOString(), until_ms: ms, kind: "usage_limit", basis: "reset", message: "limit", recorded_at: new Date().toISOString() }));' "$PF"
  exit 75
fi
exit 0
DS
chmod +x "$DSTUB"
# shellcheck source=../lib/daemon.sh
( source "$RUNNER_DIR/lib/daemon.sh"
  GAFFER_LOOP_SH="$DSTUB" GAFFER_DAEMON_MAX_CYCLES=3 GAFFER_USAGE_PAUSE_POLL_SECS=1 DRY_RUN=0 gaffer_run_daemon 0 ) > "$WORK/d.out" 2>&1
has "$(cat "$WORK/d.out")" "gaffer daemon: paused until" && ok "the daemon slept on the pause the pass left" || fail "daemon: $(cat "$WORK/d.out")"
[ "$(calls)" = 2 ] && ok "the second pass ran only after the pause" || fail "passes=$(calls)"
clear_pause

echo
printf 'oneshot-usage-pause: %d passed, %d failed\n' "$PASS" "${#FAILURES[@]}"
[ "${#FAILURES[@]}" -eq 0 ] || { printf '  - %s\n' ${FAILURES[@]+"${FAILURES[@]}"}; exit 1; }
