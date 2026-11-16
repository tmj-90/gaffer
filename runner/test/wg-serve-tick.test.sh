#!/usr/bin/env bash
# =====================================================================
# THE TICK'S DISPATCH SERVER, through the REAL tick.sh with a stub agent
# (lib/stub-tick.sh).
# ---------------------------------------------------------------------
#   T1  a delivery tick uses ONE server: at most 2 one-shot dispatch CLI processes
#       and at most 30 node processes in all for a stub delivery tick (it was ~25 and
#       ~85); the tick reaches in_review as before;
#   T2  no server outlives a tick: after a normal end, after SIGTERM and SIGINT
#       mid-delivery (the trap stops it), and after SIGKILL of the tick alone (the
#       server notices its owner is gone and exits, removing its dir);
#   T3  two ticks at once each run their own server, and both deliver;
#   T4  GAFFER_WG_SERVE=0: the same tick runs every call one-shot and starts no server.
# Run: bash runner/test/wg-serve-tick.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
. "$HERE/lib/skip.sh"
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
command -v node >/dev/null 2>&1 || gaffer_skip "node required"
command -v git >/dev/null 2>&1 || gaffer_skip "git required"
command -v perl >/dev/null 2>&1 || gaffer_skip "perl required (process groups)"
for f in packages/dispatch/dist/cli/index.js packages/dispatch/dist/cli/serve.js packages/memory/dist/bin/memory.js packages/crew/dist/cli/index.js; do
  [ -f "$ROOT/$f" ] || gaffer_skip "$f not built (run pnpm -r build)"
done
if [ "${BASH_VERSINFO[0]}" -lt 4 ] || { [ "${BASH_VERSINFO[0]}" -eq 4 ] && [ "${BASH_VERSINFO[1]}" -lt 4 ]; }; then
  gaffer_skip "served wg needs bash 4.4 or later (the macOS-only /bin/bash 3.2 runs every call one-shot; wg-serve.test.sh checks that)"
fi

STUB_TICK_NAME=wg-serve-tick
# shellcheck source=lib/stub-tick.sh
source "$HERE/lib/stub-tick.sh"
export GAFFER_WG_SERVE=1

# A node that logs every start (installed for the counted tick only).
REAL_NODE="$(command -v node)"
mkdir -p "$WORK/shim"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "$NODE_LOG"\nexec "%s" "$@"\n' "$REAL_NODE" > "$WORK/shim/node"
chmod +x "$WORK/shim/node"

servers_alive() {  # how many servers of THIS world run now
  local n=0 p
  for p in $(pgrep -f "serve.js --fifo $GAFFER_DATA/wg-serve/" 2>/dev/null); do n=$((n + 1)); done
  printf '%s' "$n"
}
dirs_left() { ls -A "$GAFFER_DATA/wg-serve" 2>/dev/null | wc -l | tr -d ' '; }
wait_gone() {  # up to 5 s for every server of this world to exit
  local i; for i in $(seq 1 50); do [ "$(servers_alive)" = 0 ] && return 0; sleep 0.1; done; return 1
}
# A tick in its own process group (how the outer bound signals it). SIGINT is put back to
# its default first: an asynchronous command inherits it ignored, and bash cannot trap a
# signal that was ignored when it started.
bg_tick() {  # <out file>
  ( cd "$RUNNER_DIR" && exec perl -e '$SIG{INT} = "DEFAULT"; setpgrp(0, 0); exec @ARGV' bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" >"$1" ) &
  TP=$!
}

echo "== T1: one server per delivery tick =="
T1="$(new_ready "Served delivery" "deliver a helper")"
export NODE_LOG="$WORK/node.log"; : > "$NODE_LOG"
R="$( cd "$RUNNER_DIR" && PATH="$WORK/shim:$PATH" bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" | grep '^TICK_RESULT=' )"
[ "$R" = "TICK_RESULT=worked" ] && ok "T1: the tick delivered ($R)" || fail "T1: result '$R'"
[ "$(st "$T1")" = "in_review" ] && ok "T1: #$T1 reached in_review" || fail "T1: status=$(st "$T1")"
NODES="$(wc -l < "$NODE_LOG" | tr -d ' ')"
WG1="$(grep -c 'dispatch/dist/cli/index.js' "$NODE_LOG" || true)"
SRV="$(grep -c 'dispatch/dist/cli/serve.js' "$NODE_LOG" || true)"
echo "    node starts: $NODES (one-shot dispatch: $WG1, servers: $SRV)"
[ "$SRV" = 1 ] && ok "T1: the tick started exactly one dispatch server" || fail "T1: $SRV servers started"
[ "$WG1" -le 2 ] && ok "T1: at most 2 one-shot dispatch CLI calls ($WG1; it was ~25)" || fail "T1: $WG1 one-shot dispatch calls: $(grep 'dispatch/dist/cli/index.js' "$NODE_LOG" | sed 's|.*index.js --db [^ ]* ||' | cut -c1-40 | sort | uniq -c | tr '\n' ';')"
[ "$NODES" -le 30 ] && ok "T1: at most 30 node processes for a stub delivery tick ($NODES; it was ~85)" || fail "T1: $NODES node processes"
! grep -q WG_SERVER_FAILED "$GAFFER_DATA/tick.stderr.log" "$GAFFER_DATA/factory.log" 2>/dev/null && ok "T1: no served call failed" || fail "T1: a served call failed: $(grep -h WG_SERVER_FAILED "$GAFFER_DATA/tick.stderr.log" | head -2)"
unset NODE_LOG

echo "== T2: no server outlives a tick =="
[ "$(servers_alive)" = 0 ] && [ "$(dirs_left)" = 0 ] && ok "T2: after a normal end: no server, no dir" || fail "T2: after a normal end: $(servers_alive) servers, $(dirs_left) dirs"
for sig in TERM INT; do
  T="$(new_ready "Killed with $sig" "deliver a helper")"
  echo hang > "$MODE"
  bg_tick "$WORK/t2-$sig.out"
  if wait_hanging; then
    [ "$(servers_alive)" = 1 ] && ok "T2 $sig: the server runs while the agent does" || fail "T2 $sig: $(servers_alive) servers during the tick"
    kill -"$sig" -- "-$TP"; wait "$TP"
    wait_gone && [ "$(dirs_left)" = 0 ] && ok "T2 $sig: after the signal: no server, no dir" || fail "T2 $sig: $(servers_alive) servers, $(dirs_left) dirs left"
    # The crash cleanup's own wg calls ran (served or one-shot): the claim is released.
    s="$(st "$T")"; case "$s" in ready|refining|blocked) ok "T2 $sig: the cleanup released the claim ($s)" ;; *) fail "T2 $sig: #$T left $s" ;; esac
  else
    fail "T2 $sig: the stub agent never started"; kill -KILL -- "-$TP" 2>/dev/null
  fi
  rm -f "$CALLS"/*/hanging
  retire "$T"
done
T="$(new_ready "Tick killed alone" "deliver a helper")"
echo hang > "$MODE"
bg_tick "$WORK/t2-kill.out"
if wait_hanging; then
  kill -KILL "$TP" 2>/dev/null   # the tick's bash alone (perl exec'd it: same pid)
  if wait_gone; then ok "T2 KILL: the server exited by itself once the tick was gone"; else fail "T2 KILL: the server outlived a SIGKILLed tick"; fi
  for _ in $(seq 1 30); do [ "$(dirs_left)" = 0 ] && break; sleep 0.1; done
  [ "$(dirs_left)" = 0 ] && ok "T2 KILL: and removed its dir" || fail "T2 KILL: $(dirs_left) dirs left"
else
  fail "T2 KILL: the stub agent never started"
fi
kill -KILL -- "-$TP" 2>/dev/null; wait "$TP" 2>/dev/null
rm -f "$CALLS"/*/hanging
echo deliver > "$MODE"

echo "== T3: two ticks at once, each with its own server =="
A="$(new_ready "Parallel A" "deliver a helper")"; B="$(new_ready "Parallel B" "deliver a helper")"
rm -f "$GAFFER_DATA/.failed-tickets"
bg_tick "$WORK/t3-a.out"; PA=$TP
bg_tick "$WORK/t3-b.out"; PB=$TP
peak=0
while kill -0 "$PA" 2>/dev/null || kill -0 "$PB" 2>/dev/null; do
  n="$(servers_alive)"; [ "$n" -gt "$peak" ] && peak="$n"
  sleep 0.1
done
wait "$PA" "$PB" 2>/dev/null
echo "    results: $(grep -h '^TICK_RESULT=' "$WORK/t3-a.out" "$WORK/t3-b.out" | tr '\n' ' ') (servers seen at once: $peak)"
[ "$peak" -ge 2 ] && ok "T3: two servers ran at once (one per tick)" || fail "T3: at most $peak server at once"
[ "$(st "$A")" = "in_review" ] && [ "$(st "$B")" = "in_review" ] && ok "T3: both tickets delivered" || fail "T3: A=$(st "$A") B=$(st "$B")"
[ "$(servers_alive)" = 0 ] && [ "$(dirs_left)" = 0 ] && ok "T3: no server or dir left" || fail "T3: $(servers_alive) servers, $(dirs_left) dirs"

echo "== T4: GAFFER_WG_SERVE=0 =="
T4="$(new_ready "One-shot delivery" "deliver a helper")"
export NODE_LOG="$WORK/node0.log"; : > "$NODE_LOG"
R="$( cd "$RUNNER_DIR" && GAFFER_WG_SERVE=0 PATH="$WORK/shim:$PATH" bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" | grep '^TICK_RESULT=' )"
[ "$R" = "TICK_RESULT=worked" ] && [ "$(st "$T4")" = "in_review" ] && ok "T4: the one-shot tick delivered as before" || fail "T4: $R status=$(st "$T4")"
[ "$(grep -c 'dispatch/dist/cli/serve.js' "$NODE_LOG" || true)" = 0 ] && ok "T4: no server started" || fail "T4: a server started"
[ "$(grep -c 'dispatch/dist/cli/index.js' "$NODE_LOG" || true)" -gt 10 ] && ok "T4: every call ran one-shot ($(grep -c 'dispatch/dist/cli/index.js' "$NODE_LOG") of them)" || fail "T4: few one-shot calls"
unset NODE_LOG

echo
echo "wg-serve-tick: $PASS passed, ${#FAILURES[@]} failed"
[ "${#FAILURES[@]}" -eq 0 ]
