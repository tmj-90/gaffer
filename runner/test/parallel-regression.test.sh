#!/usr/bin/env bash
# =====================================================================
# A-1 — backward-compatibility regression for GAFFER_CONCURRENCY=1.
# ---------------------------------------------------------------------
# The whole feature lands OFF by default: GAFFER_CONCURRENCY=1 MUST be a no-op
# versus the pre-A-1 factory. This guards that contract:
#
#   AC1  loop.sh DEFAULTS GAFFER_CONCURRENCY to 1 (operator opts into N>1).
#   AC2  at concurrency 1 loop.sh runs the SERIAL path and NEVER spawns workers
#        (a DRY_RUN run prints no "parallel mode" / "spawning ... worker" lines).
#   AC3  the serial loop body is byte-for-byte the pre-A-1 loop: the same
#        gaffer_timeout-wrapped tick + gaffer_bump_day_count + no_work handling,
#        with no lock/pool machinery interposed on the single-tick path.
#   AC4  a DRY_RUN GAFFER_CONCURRENCY=1 loop emits the canonical serial markers
#        ("gaffer factory: starting", "tick 1/...", "done after N tick(s)").
#   AC5  config defaults are present + exported (GAFFER_CONCURRENCY,
#        MAX_CONCURRENT_TICKETS_PER_REPO, MAX_CANDIDATES).
#
# Run: bash test/parallel-regression.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

echo "== AC1: GAFFER_CONCURRENCY defaults to 1 in config =="
grep -Eq '^\s*:\s*"\$\{GAFFER_CONCURRENCY:=1\}"' "$RUNNER_DIR/factory.config.sh" \
  && ok "factory.config.sh defaults GAFFER_CONCURRENCY=1" || fail "GAFFER_CONCURRENCY default-1 not found"

echo "== AC5: config knobs present + exported =="
grep -Eq '^\s*:\s*"\$\{MAX_CONCURRENT_TICKETS_PER_REPO:=1\}"' "$RUNNER_DIR/factory.config.sh" \
  && ok "MAX_CONCURRENT_TICKETS_PER_REPO default present" || fail "MAX_CONCURRENT_TICKETS_PER_REPO default missing"
grep -Eq '^\s*:\s*"\$\{MAX_CANDIDATES:=' "$RUNNER_DIR/factory.config.sh" \
  && ok "MAX_CANDIDATES default present" || fail "MAX_CANDIDATES default missing"
grep -Eq 'export GAFFER_CONCURRENCY MAX_CONCURRENT_TICKETS_PER_REPO MAX_CANDIDATES' "$RUNNER_DIR/factory.config.sh" \
  && ok "all three knobs exported" || fail "knobs not all exported"

echo "== AC3: the serial loop body is the canonical pre-A-1 shape =="
# The serial path must still drive a single tick under gaffer_timeout, bump the
# day count, parse TICK_RESULT, and handle no_work — with the pool branch gated
# strictly behind GAFFER_CONCURRENCY>1.
grep -Eq 'if \[ "\$\{GAFFER_CONCURRENCY:-1\}" -gt 1 \]' "$RUNNER_DIR/loop.sh" \
  && ok "pool is gated behind GAFFER_CONCURRENCY>1" || fail "pool gate not found"
grep -q 'out="$(gaffer_timeout "$((GAFFER_TICK_TIMEOUT + 60))" bash "$HERE/tick.sh")"' "$RUNNER_DIR/loop.sh" \
  && ok "serial path still runs the gaffer_timeout-wrapped single tick" || fail "serial tick invocation changed"
grep -q 'echo "tick $ticks/$MAX_TICKS → ${res:-unknown}"' "$RUNNER_DIR/loop.sh" \
  && ok "serial path still prints the canonical per-tick line" || fail "serial per-tick output changed"

# The exact serial loop block must appear verbatim (the pre-A-1 body). We assert
# the contiguous canonical block exists after the serial-path header comment.
serial_block='ticks=0
empties=0
while [ "$ticks" -lt "$MAX_TICKS" ]; do
  if ! gaffer_day_cap_ok; then'
if printf '%s' "$(cat "$RUNNER_DIR/loop.sh")" | grep -qF "$serial_block"; then
  ok "serial loop preamble is byte-identical to the pre-A-1 body"
else
  fail "serial loop preamble diverged from the pre-A-1 body"
fi

echo "== AC2/AC4: DRY_RUN concurrency=1 runs serial, spawns NO workers =="
GD="$(mktemp -d "${TMPDIR:-/tmp}/par-reg.XXXXXX")/x"; mkdir -p "$GD"
OUT="$(GAFFER_DATA="$GD" DISPATCH_DB="$GD/d.sqlite" MEMORY_DB="$GD/m.sqlite" \
       DRY_RUN=1 MAX_TICKS=2 EMPTY_POLL_LIMIT=1 TICK_SLEEP=0 GAFFER_CONCURRENCY=1 \
       perl -e 'alarm 90; exec @ARGV' bash "$RUNNER_DIR/loop.sh" 2>&1)" || true
printf '%s\n' "$OUT" | grep -qiE 'parallel mode|spawning [0-9]+ worker' \
  && fail "concurrency=1 wrongly entered the parallel path" || ok "concurrency=1 stayed on the serial path (no worker pool)"
printf '%s\n' "$OUT" | grep -q 'gaffer factory: starting' && ok "serial run emits the canonical 'starting' banner" || fail "missing 'starting' banner"
printf '%s\n' "$OUT" | grep -qE 'tick 1/[0-9]+ →' && ok "serial run emits the canonical 'tick 1/N →' line" || fail "missing canonical per-tick line"
printf '%s\n' "$OUT" | grep -qE 'gaffer factory: done after [0-9]+ tick' && ok "serial run emits the canonical 'done after N tick(s)'" || fail "missing 'done' line"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"; exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
