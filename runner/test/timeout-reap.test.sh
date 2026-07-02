#!/usr/bin/env bash
# =====================================================================
# ORPHAN-REAP: a timed-out / killed agent must leave NO orphaned `claude -p`
# (wallet-drain fix). gaffer_timeout runs the command in its own process group
# and, on ANY teardown path, tears down the WHOLE group (TERM -> KILL escalation);
# it also records the live agent PGID so the tick's crash-cleanup trap can reap a
# survivor as a backstop. This proves, against the REAL gaffer_timeout:
#   AC1  a timed-out command's WHOLE process group is reaped — a background child
#        (a stand-in for `claude -p` + its MCP children) does NOT survive.
#   AC2  the PGID record is written while in-flight and REMOVED on normal
#        completion (so a stale PGID can never be reaped by mistake).
#   AC3  after a timeout the PGID record is cleared and its group is dead.
#   AC4  the perl path forwards SIGTERM/SIGINT to the child group and escalates
#        TERM -> KILL (source assertions — the parent-killed orphan path).
#   AC5  the tick wires the exit-trap reaper: exports GAFFER_TIMEOUT_PGID_FILE and
#        reaps the recorded group inside gaffer_crash_cleanup; the GNU/BSD timeout
#        fallbacks escalate with -k.
#
# Zero deps beyond perl (already required by gaffer_timeout). Run:
#   bash test/timeout-reap.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/timeout-reap.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
export GAFFER_DATA="$WORK/.gaffer"; mkdir -p "$GAFFER_DATA"
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh"

command -v perl >/dev/null 2>&1 || { echo "SKIP: perl not available"; exit 0; }

echo "== AC1/AC3: a timed-out agent leaves NO surviving descendant (a GRANDCHILD too) =="
export CHILD_PIDFILE="$WORK/grandchild.pid"; : > "$CHILD_PIDFILE"
export GAFFER_TIMEOUT_PGID_FILE="$WORK/agent.pgid"
# DETERMINISTIC wallet-drain repro. The wrapped foreground child spawns a GRANDCHILD
# (a stand-in for the lingering MCP server) that IGNORES SIGTERM, then `wait`s on it.
# On timeout the reap TERMs the whole group: the foreground child dies on TERM (so the
# direct-child wait completes and `$gone` is set), but the grandchild ignores TERM and
# would SURVIVE unless the KILL escalation sweeps the whole GROUP. Gating the KILL on
# the foreground child being reaped is the exact orphan-drain bug — this reproduces the
# survivor deterministically (only the group-scoped SIGKILL can reap it).
GRANDCHILD_SH="$WORK/grandchild.sh"
cat > "$GRANDCHILD_SH" <<'GC'
#!/usr/bin/env bash
trap '' TERM                       # ignore SIGTERM — only SIGKILL can reap this
echo $$ > "$CHILD_PIDFILE"
# Block on a construct with no child that TERM would reap out from under us: bash
# ignores TERM, so this loops until the group KILL takes the whole process group down.
while true; do sleep 60; done
GC
chmod +x "$GRANDCHILD_SH"; export GRANDCHILD_SH
gaffer_timeout 1 bash -c 'bash "$GRANDCHILD_SH" & wait' ; rc=$?
[ "$rc" = "124" ] && ok "gaffer_timeout returns 124 on timeout" || fail "expected 124 (got $rc)"
# Give the reap's TERM->KILL group escalation its grace window.
sleep 1
CHILD_PID="$(cat "$CHILD_PIDFILE" 2>/dev/null || true)"
if [ -z "$CHILD_PID" ]; then
  fail "the grandchild never recorded its PID (test setup)"
elif kill -0 "$CHILD_PID" 2>/dev/null; then
  fail "ORPHAN: TERM-ignoring grandchild (MCP-server stand-in) $CHILD_PID survived the timeout"
  kill -KILL "-$CHILD_PID" 2>/dev/null; kill -KILL "$CHILD_PID" 2>/dev/null || true
else
  ok "TERM-ignoring grandchild reaped via the whole-group KILL escalation (zero survivors)"
fi
[ -f "$GAFFER_TIMEOUT_PGID_FILE" ] \
  && fail "PGID record lingered after timeout" \
  || ok "PGID record cleared after timeout"

echo "== AC2: PGID record is written in-flight and removed on normal completion =="
export GAFFER_TIMEOUT_PGID_FILE="$WORK/agent2.pgid"
# In-flight capture: a 5s command prints its recorded PGID, then we assert the
# file existed DURING the run and is gone AFTER it returns.
INFLIGHT="$WORK/inflight"; : > "$INFLIGHT"
( sleep 0.4; [ -s "$GAFFER_TIMEOUT_PGID_FILE" ] && echo yes > "$INFLIGHT" ) &
gaffer_timeout 5 bash -c 'sleep 0.8; true' ; rc=$?
[ "$rc" = "0" ] && ok "fast command still returns its own exit status (0)" || fail "expected 0 (got $rc)"
[ "$(cat "$INFLIGHT" 2>/dev/null)" = "yes" ] \
  && ok "PGID record present WHILE the agent is in-flight" \
  || fail "PGID record was not written during the run"
[ -f "$GAFFER_TIMEOUT_PGID_FILE" ] \
  && fail "PGID record lingered after a normal completion" \
  || ok "PGID record removed on normal completion (never stale)"

echo "== AC4: perl teardown forwards TERM/INT + escalates TERM->KILL (source) =="
cfg="$RUNNER_DIR/factory.config.sh"
grep -q 'SIG{TERM} = sub { $reap->(143) }' "$cfg" \
  && ok "parent forwards SIGTERM to the child group (no orphan on parent kill)" \
  || fail "perl parent does not forward SIGTERM"
grep -q 'SIG{INT}  = sub { $reap->(130) }' "$cfg" \
  && ok "parent forwards SIGINT to the child group" \
  || fail "perl parent does not forward SIGINT"
grep -q 'kill "KILL", -$pid' "$cfg" \
  && ok "reap escalates TERM -> KILL on the process group" \
  || fail "reap does not escalate to SIGKILL"
grep -Eq 'timeout -s TERM -k "\$GAFFER_REAP_GRACE"' "$cfg" \
  && ok "GNU/BSD timeout fallbacks escalate with -k (configurable grace)" \
  || fail "timeout fallbacks missing -k escalation"

echo "== AC5: tick.sh wires the exit-trap reaper =="
tick="$RUNNER_DIR/tick.sh"
grep -q 'export GAFFER_TIMEOUT_PGID_FILE=' "$tick" \
  && ok "tick exports GAFFER_TIMEOUT_PGID_FILE so live agents are recorded" \
  || fail "tick does not export GAFFER_TIMEOUT_PGID_FILE"
grep -q 'gaffer_reap_orphan_agent' "$tick" \
  && ok "tick defines/uses gaffer_reap_orphan_agent" \
  || fail "tick has no orphan reaper"
# The reaper must be invoked from the crash-cleanup path.
awk '/^gaffer_crash_cleanup\(\) \{/{f=1} f&&/gaffer_reap_orphan_agent/{print;exit}' "$tick" | grep -q gaffer_reap_orphan_agent \
  && ok "crash-cleanup invokes the orphan reaper" \
  || fail "crash-cleanup does not invoke the orphan reaper"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
