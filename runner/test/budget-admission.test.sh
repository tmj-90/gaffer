#!/usr/bin/env bash
# =====================================================================
# BUDGET ADMISSION — the tick caps hold under a worker POOL, not just at N=1.
# ---------------------------------------------------------------------
# Two defects, both source-traced by the external review:
#   • loop.sh gave each of N workers ceil(MAX_TICKS/N) ticks ⇒ N×ceil(MAX_TICKS/N)
#     in total (MAX_TICKS=10, N=3 ran 12; MAX_TICKS=1, N=4 ran 4).
#   • the day cap was check-then-bump: N workers reading "one slot left" all admitted
#     themselves against it.
# Now: ONE shared per-run counter reserved atomically per tick (gaffer_reserve_run_tick)
# and an atomic day-slot reservation with refund for a non-spending tick
# (gaffer_reserve_day_tick / gaffer_refund_day_tick). Proven with REAL concurrent
# processes hammering the primitives, and with the real loop.sh + worker.sh driving
# a stub tick. Run: bash test/budget-admission.test.sh   (bash 3.2 safe)
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/budget-admission.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
export GAFFER_DATA="$WORK/data"; mkdir -p "$GAFFER_DATA"
export DAILY_COUNTER_FILE="$WORK/.daily-ticks"
# The real lock primitive + budget helpers (factory.config.sh sources lib/budget.sh).
# shellcheck source=../factory.config.sh
GAFFER_LOG="$WORK/factory.log" source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1

echo "== 1: per-run counter — N concurrent reservers never exceed <max> =="
CNT="$WORK/run-ticks"; : > "$CNT"; WINS="$WORK/wins"; : > "$WINS"
for w in 1 2 3 4; do
  ( for _ in $(seq 1 25); do
      gaffer_reserve_run_tick "$CNT" 10 && echo "$w" >> "$WINS"
    done ) &
done
wait
[ "$(cat "$CNT")" = "10" ] && ok "counter stops at exactly 10 (4 workers × 25 attempts)" || fail "counter should be 10, got '$(cat "$CNT")'"
[ "$(wc -l < "$WINS" | tr -d ' ')" = "10" ] && ok "exactly 10 reservations succeeded across the pool" || fail "expected 10 successful reservations, got $(wc -l < "$WINS")"
gaffer_reserve_run_tick "$CNT" 10; [ $? -eq 1 ] && ok "an exhausted budget answers 1 (not an error)" || fail "exhausted budget should return 1"
gaffer_refund_run_tick "$CNT"; [ "$(cat "$CNT")" = "9" ] && ok "a refund hands one slot back" || fail "refund should leave 9, got '$(cat "$CNT")'"

echo "== 2: day slot — MAX_TICKS_PER_DAY=1 with 4 concurrent reservers admits ONE =="
rm -f "$DAILY_COUNTER_FILE"; : > "$WINS"
export MAX_TICKS_PER_DAY=1
for w in 1 2 3 4; do ( gaffer_reserve_day_tick && echo "$w" >> "$WINS" ) & done
wait
[ "$(wc -l < "$WINS" | tr -d ' ')" = "1" ] && ok "exactly one worker owns the last day slot" || fail "expected 1 admission, got $(wc -l < "$WINS")"
[ "$(gaffer_day_count)" = "1" ] && ok "day counter = 1" || fail "day counter should be 1, got '$(gaffer_day_count)'"
gaffer_refund_day_tick; [ "$(gaffer_day_count)" = "0" ] && ok "refund (a no_work tick) returns the slot" || fail "refund should leave 0"
gaffer_refund_day_tick; [ "$(gaffer_day_count)" = "0" ] && ok "refund floors at 0" || fail "refund went negative"
export MAX_TICKS_PER_DAY=0
gaffer_reserve_day_tick && ok "cap 0 (unlimited) always admits" || fail "cap 0 should admit"

echo "== 3: the real loop.sh + worker.sh pool honours MAX_TICKS exactly =="
# A FAKE runner dir: every real file symlinked in, tick.sh replaced by a stub that
# always reports a productive tick (so nothing stops the pool early but the budget).
FAKE="$WORK/runner"; mkdir -p "$FAKE"
for f in "$RUNNER_DIR"/*; do
  case "$(basename "$f")" in tick.sh|run-summary.sh|test) ;; *) ln -s "$f" "$FAKE/$(basename "$f")" ;; esac
done
cat > "$FAKE/tick.sh" <<'STUB'
#!/usr/bin/env bash
echo "tick" >> "${STUB_CALLS:?}"
echo "TICK_RESULT=worked"
STUB
chmod +x "$FAKE/tick.sh"
cat > "$WORK/noop.sh" <<'STUB'
#!/usr/bin/env bash
printf '{}\n'
STUB
chmod +x "$WORK/noop.sh"
run_pool() {  # run_pool <MAX_TICKS> <N> [extra env]
  local mt="$1" n="$2"; shift 2
  : > "$WORK/calls"; rm -f "$DAILY_COUNTER_FILE"
  ( trap - EXIT
    env "$@" DRY_RUN=0 TICK_SLEEP=0 EMPTY_POLL_LIMIT=10 MAX_TICKS="$mt" GAFFER_CONCURRENCY="$n" \
      MAX_TICKS_PER_DAY="${POOL_DAY_CAP:-50}" GAFFER_TICK_OUTER_TIMEOUT=60 \
      GAFFER_DATA="$WORK/data" DAILY_COUNTER_FILE="$DAILY_COUNTER_FILE" GAFFER_LOG="$WORK/factory.log" \
      DISPATCH_DIR="$WORK/nodist" DISPATCH_DB="$WORK/db.sqlite" MEMORY_DB="$WORK/mem.sqlite" \
      STUB_CALLS="$WORK/calls" \
      LOOP_STATS_CMD="$WORK/noop.sh" LOOP_HQ_CMD="$WORK/noop.sh" LOOP_NOTIFY_EMIT_CMD="$WORK/noop.sh" \
      bash "$FAKE/loop.sh" 2>&1 )
}
out="$(run_pool 10 3)"
calls="$(wc -l < "$WORK/calls" | tr -d ' ')"
[ "$calls" = "10" ] && ok "MAX_TICKS=10 across 3 workers ran exactly 10 ticks (was 12)" || fail "expected 10 ticks, ran $calls; out: $(printf '%s' "$out" | tail -3)"
printf '%s' "$out" | grep -q 'ticks=10 ' && ok "loop.sh aggregated ticks=10" || fail "aggregate line should say ticks=10: $(printf '%s' "$out" | grep aggregated)"
[ "$(awk '{print $2}' "$DAILY_COUNTER_FILE")" = "10" ] && ok "day counter = 10 (every productive tick counted once)" || fail "day counter should be 10, got '$(cat "$DAILY_COUNTER_FILE" 2>/dev/null)'"
out="$(run_pool 1 4)"
calls="$(wc -l < "$WORK/calls" | tr -d ' ')"
[ "$calls" = "1" ] && ok "MAX_TICKS=1 across 4 workers ran exactly 1 tick (was 4)" || fail "expected 1 tick, ran $calls"
out="$(POOL_DAY_CAP=3 run_pool 10 4)"
calls="$(wc -l < "$WORK/calls" | tr -d ' ')"
[ "$calls" = "3" ] && ok "MAX_TICKS_PER_DAY=3 across 4 workers admitted exactly 3 ticks" || fail "expected 3 ticks under the day cap, ran $calls"
[ "$(awk '{print $2}' "$DAILY_COUNTER_FILE")" = "3" ] && ok "day counter = 3 (never over the cap)" || fail "day counter should be 3, got '$(cat "$DAILY_COUNTER_FILE")'"
printf '%s' "$out" | grep -q 'per-day cap reached' && ok "workers stopped on the day cap with the logged reason" || fail "expected a 'per-day cap reached' stop"

echo "== 4: a no_work tick under the pool refunds its day slot =="
cat > "$FAKE/tick.sh" <<'STUB'
#!/usr/bin/env bash
echo "tick" >> "${STUB_CALLS:?}"
echo "TICK_RESULT=no_work"
STUB
out="$(run_pool 4 2 EMPTY_POLL_LIMIT=1)"
[ ! -f "$DAILY_COUNTER_FILE" ] || [ "$(awk '{print $2}' "$DAILY_COUNTER_FILE")" = "0" ] \
  && ok "idle pool leaves the day counter at 0 (reserve + refund)" || fail "idle pool left the day counter at '$(cat "$DAILY_COUNTER_FILE")'"

echo "== 5: source pins =="
grep -q 'gaffer_reserve_run_tick "$GAFFER_RUN_TICKS_FILE" "$MAX_TICKS"' "$RUNNER_DIR/worker.sh" \
  && ok "worker.sh reserves against the shared per-run counter" || fail "worker.sh should reserve run ticks atomically"
grep -q 'gaffer_reserve_day_tick' "$RUNNER_DIR/worker.sh" && grep -q 'gaffer_reserve_day_tick' "$RUNNER_DIR/loop.sh" \
  && ok "worker.sh and loop.sh both reserve the day slot before the tick" || fail "day-slot reservation missing in worker.sh/loop.sh"
grep -q 'WORKER_MAX_TICKS=$(( (MAX_TICKS + N - 1) / N ))' "$RUNNER_DIR/loop.sh" \
  && fail "loop.sh still uses the ceil split (N×ceil overshoot)" || ok "the ceil(MAX_TICKS/N) split is gone"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "budget-admission: ALL $PASS checks passed"; exit 0
else echo "budget-admission: ${#FAILURES[@]} FAILED (of $((PASS + ${#FAILURES[@]})))"; exit 1; fi
