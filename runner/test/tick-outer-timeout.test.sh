#!/usr/bin/env bash
# =====================================================================
# TICK OUTER TIMEOUT + REAPER GRACE (finding 6 — loop.sh / worker.sh / factory.config.sh)
# ---------------------------------------------------------------------
# One delivery may legitimately run the WHOLE rework ladder: up to
# GAFFER_MAX_DELIVERY_ATTEMPTS agent calls, EACH bounded by GAFFER_TICK_TIMEOUT
# (that is exactly why GAFFER_CLAIM_TTL is sized attempts × timeout + 300). The
# per-tick OUTER wall-clock wrapper used to be sized GAFFER_TICK_TIMEOUT + 60,
# which forbids the ladder: whenever attempt 1 used most of one timeout window,
# attempts 2..N — including the strong-model FINAL attempt — were killed mid-run.
# AND on that outer kill, gaffer_timeout's process-group reaper gave only ~2s of
# TERM->KILL grace, so the tick crash-trap's claim-release (a node/HTTP `wg`
# call) was SIGKILLed mid-flight — stranding the ticket `claimed` for the rest
# of its ~95-min lease.
#
#   AC1  GAFFER_TICK_OUTER_TIMEOUT covers the WHOLE ladder: >= attempts × timeout
#        (mirrors the GAFFER_CLAIM_TTL math) and re-derives from overrides.
#   AC2  the outer bound stays INSIDE the claim lease with headroom for the
#        reaper grace, so a reaped tick's claim-release lands on a LIVE lease.
#   AC3  loop.sh (serial path) and worker.sh both wrap tick.sh in the sized
#        outer bound; the old (GAFFER_TICK_TIMEOUT + 60) math is gone.
#   AC4  reaper grace (behavioral, real gaffer_timeout): a TERM-trapping child
#        whose cleanup ("claim release") takes LONGER than the old ~2s grace
#        COMPLETES it before the group KILL — the claim is released.
#   AC5  the grace is configurable (GAFFER_REAP_GRACE) and the KILL escalation
#        STILL fires: a cleanup longer than the configured grace is still
#        reaped (the timeout defense is intact, never removed).
#   AC6  the GNU/BSD `timeout` fallbacks escalate with the SAME configurable grace.
#
# Zero deps beyond perl (already required by gaffer_timeout). Run:
#   bash runner/test/tick-outer-timeout.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
CFG="$RUNNER_DIR/factory.config.sh"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tick-outer.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
export GAFFER_DATA="$WORK/.gaffer"; mkdir -p "$GAFFER_DATA"

command -v perl >/dev/null 2>&1 || { echo "SKIP: perl not available"; exit 0; }

# Derive the config in a CHILD bash with the sizing inputs pinned/unset, so
# values exported by an outer shell (or this test's own source below) can never
# leak into the `:=` defaults under assertion.
#   derive <var-to-print> [K=V ...]
derive() {
  local want="$1"; shift
  env "$@" GAFFER_DATA="$GAFFER_DATA" bash -c '
    unset GAFFER_TICK_OUTER_TIMEOUT GAFFER_CLAIM_TTL GAFFER_REAP_GRACE 2>/dev/null
    source "$1" >/dev/null 2>&1
    eval "printf \"%s\" \"\${$2:-}\""
  ' _ "$CFG" "$want"
}

echo "== AC1: the outer tick bound covers the whole rework ladder =="
# Defaults: 3 attempts × 1800s. The ladder needs >= 5400s; the OLD bound was
# 1800 + 60 = 1860s — attempt 2 could never fit (today's bug).
T_DEF="$(derive GAFFER_TICK_TIMEOUT)"
A_DEF="$(derive GAFFER_MAX_DELIVERY_ATTEMPTS)"
OUTER_DEF="$(derive GAFFER_TICK_OUTER_TIMEOUT)"
if [ -z "$OUTER_DEF" ]; then
  fail "AC1 GAFFER_TICK_OUTER_TIMEOUT is not defined by factory.config.sh"
else
  [ "$OUTER_DEF" -ge $((A_DEF * T_DEF)) ] 2>/dev/null \
    && ok "AC1 default outer bound ${OUTER_DEF}s covers the full ladder (${A_DEF} × ${T_DEF}s = $((A_DEF * T_DEF))s)" \
    || fail "AC1 default outer bound ${OUTER_DEF}s < ladder requirement $((A_DEF * T_DEF))s — attempts 2..${A_DEF} get killed mid-run"
fi
# Overrides re-derive: 5 attempts × 10s ⇒ outer >= 50s (and scales DOWN too, so
# the guard still fires promptly on small configs instead of inheriting 5520s).
OUTER_OVR="$(derive GAFFER_TICK_OUTER_TIMEOUT GAFFER_TICK_TIMEOUT=10 GAFFER_MAX_DELIVERY_ATTEMPTS=5)"
if [ -z "$OUTER_OVR" ]; then
  fail "AC1 outer bound missing under overrides"
else
  { [ "$OUTER_OVR" -ge 50 ] && [ "$OUTER_OVR" -le 300 ]; } 2>/dev/null \
    && ok "AC1 outer bound re-derives from overrides (5 × 10s → ${OUTER_OVR}s)" \
    || fail "AC1 outer bound does not track attempts × timeout under overrides (got ${OUTER_OVR}s for 5 × 10s)"
fi

echo "== AC2: outer bound + reaper grace fit INSIDE the claim lease =="
TTL_DEF="$(derive GAFFER_CLAIM_TTL)"
GRACE_DEF="$(derive GAFFER_REAP_GRACE)"
if [ -z "$OUTER_DEF" ] || [ -z "$GRACE_DEF" ]; then
  fail "AC2 outer bound / reaper grace not defined — cannot hold the lease invariant"
else
  [ $((OUTER_DEF + GRACE_DEF)) -lt "$TTL_DEF" ] 2>/dev/null \
    && ok "AC2 outer kill + grace (${OUTER_DEF}s + ${GRACE_DEF}s) < claim TTL ${TTL_DEF}s — the crash-trap release runs on a live lease" \
    || fail "AC2 outer kill + grace (${OUTER_DEF:-?}s + ${GRACE_DEF:-?}s) does not fit inside claim TTL ${TTL_DEF}s"
fi

echo "== AC3: loop.sh + worker.sh wrap tick.sh in the sized outer bound =="
for f in loop.sh worker.sh; do
  grep -q 'gaffer_timeout "\$GAFFER_TICK_OUTER_TIMEOUT" bash "\$HERE/tick.sh"' "$RUNNER_DIR/$f" \
    && ok "AC3 $f wraps tick.sh in \$GAFFER_TICK_OUTER_TIMEOUT" \
    || fail "AC3 $f does not wrap tick.sh in the ladder-sized outer bound"
  grep -q 'GAFFER_TICK_TIMEOUT + 60' "$RUNNER_DIR/$f" \
    && fail "AC3 $f still carries the old single-attempt (GAFFER_TICK_TIMEOUT + 60) bound" \
    || ok "AC3 $f dropped the old single-attempt bound"
done

# ── Behavioral half: the REAL gaffer_timeout against a tick stand-in whose TERM
# trap performs a slow "claim release" (the wg node/HTTP call), exactly the shape
# of tick.sh's crash trap (gaffer_on_signal → gaffer_crash_cleanup → release).
# shellcheck source=../factory.config.sh
source "$CFG"

STUB="$WORK/slow-release-tick.sh"
cat > "$STUB" <<'SH'
#!/usr/bin/env bash
# tick.sh stand-in: on TERM, run a claim release taking $RELEASE_SECS (the wg
# node/HTTP call the crash trap makes), record success, exit 143 — the same
# TERM → cleanup → exit shape as gaffer_on_signal.
on_term() {
  sleep "$RELEASE_SECS"
  echo released > "$RELEASED_FILE"
  exit 143
}
trap on_term TERM
sleep 60 & wait
SH
chmod +x "$STUB"

echo "== AC4: the reaper grace lets a slow claim-release COMPLETE =="
# Release takes 4s — longer than the old hardcoded ~2s TERM->KILL grace, which
# SIGKILLed the release mid-flight and stranded the claim (today's bug repro).
export RELEASED_FILE="$WORK/released.ac4"; rm -f "$RELEASED_FILE"
export RELEASE_SECS=4
unset GAFFER_TIMEOUT_PGID_FILE 2>/dev/null || true
gaffer_timeout 1 bash "$STUB"; rc=$?
[ "$rc" = "124" ] && ok "AC4 outer timeout still reports 124 (the defense is intact)" \
  || fail "AC4 expected exit 124 from the outer timeout (got $rc)"
[ -f "$RELEASED_FILE" ] \
  && ok "AC4 claim-release (4s) completed inside the TERM->KILL grace — no stranded claim" \
  || fail "AC4 STRANDED CLAIM: the ~2s reaper grace SIGKILLed the claim-release mid-flight"

echo "== AC5: the grace is configurable and the KILL escalation still fires =="
# With a deliberately tiny grace, a release SLOWER than the grace must still be
# reaped — proving the group-KILL defense was tightened, not removed.
export RELEASED_FILE="$WORK/released.ac5"; rm -f "$RELEASED_FILE"
export RELEASE_SECS=8
start=$SECONDS
GAFFER_REAP_GRACE=1 gaffer_timeout 1 bash "$STUB"; rc=$?
elapsed=$((SECONDS - start))
[ "$rc" = "124" ] && ok "AC5 timeout still reports 124 under a tiny grace" \
  || fail "AC5 expected exit 124 (got $rc)"
[ -f "$RELEASED_FILE" ] \
  && fail "AC5 a release slower than the grace was allowed to finish — KILL escalation gone" \
  || ok "AC5 release slower than the configured grace is still KILLed (defense intact)"
[ "$elapsed" -lt 6 ] \
  && ok "AC5 group KILL fired promptly after the 1s grace (~${elapsed}s total, not the 8s release)" \
  || fail "AC5 reap took ${elapsed}s — the KILL did not fire at the configured grace"

echo "== AC6: GNU/BSD timeout fallbacks escalate with the configurable grace =="
grep -Eq 'timeout -s TERM -k "\$GAFFER_REAP_GRACE"' "$CFG" \
  && ok "AC6 timeout/gtimeout fallbacks use -k \$GAFFER_REAP_GRACE" \
  || fail "AC6 fallbacks still hardcode the TERM->KILL grace"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
