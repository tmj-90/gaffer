#!/usr/bin/env bash
# =====================================================================
# B28 — the per-day tick cap counts SPEND, not polls (lib/budget.sh,
# loop.sh, worker.sh, bin/poll-once.sh).
# ---------------------------------------------------------------------
# Live audit: MAX_TICKS_PER_DAY was bumped on EVERY non-dry tick, including
# `no_work` — so an idle daemon (TICK_SLEEP=30, cap 50) burned the whole day's
# cap in ~37 minutes without spawning a single agent, then sat idle until
# midnight. And the dashboard's Poll button (bin/poll-once.sh) bypassed every
# cap: no day/USD check, no bump, no outer timeout. Proves, with the REAL
# loop.sh / worker.sh / poll-once.sh driven against a STUB tick.sh:
#   1. gaffer_tick_counts_toward_day_cap: no_work is exempt; every other result
#      (worked, error, EMPTY/unknown) counts — the conservative wallet rule.
#   2. loop.sh: three ticks (worked, no_work, no_work) advance the counter by 1.
#   3. worker.sh: same rule in the parallel pool path.
#   4. poll-once.sh: a no_work poll does not bump; a worked poll bumps once; a
#      day cap already at its limit REFUSES the poll before the tick runs; the
#      tick is wrapped in the same GAFFER_TICK_OUTER_TIMEOUT bound.
# Zero deps beyond bash + a timeout primitive. Run: bash test/day-cap-no-work.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/day-cap-no-work.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

echo "== 1: gaffer_tick_counts_toward_day_cap — only no_work is exempt =="
export DAILY_COUNTER_FILE="$WORK/.daily-ticks"
# shellcheck source=../lib/budget.sh
source "$RUNNER_DIR/lib/budget.sh"
if gaffer_tick_counts_toward_day_cap no_work; then fail "no_work must NOT count toward the day cap"; else ok "no_work is exempt (spawned no agent)"; fi
for r in worked reviewed tested clarified idle_drafted maintenance_ran maintenance_drafted paused error ""; do
  gaffer_tick_counts_toward_day_cap "$r" && ok "'${r:-<empty/unknown>}' counts (may have spent)" || fail "'${r:-<empty>}' should count toward the day cap"
done

# ── A FAKE runner dir: every real file symlinked in, tick.sh replaced by a stub
# that prints the next TICK_RESULT from a queue file and records each invocation.
FAKE="$WORK/runner"; mkdir -p "$FAKE"
for f in "$RUNNER_DIR"/*; do
  case "$(basename "$f")" in
    tick.sh|run-summary.sh|test) ;;   # stubbed / skipped (run-summary would probe the DB)
    *) ln -s "$f" "$FAKE/$(basename "$f")" ;;
  esac
done
cat > "$FAKE/tick.sh" <<'EOF'
#!/usr/bin/env bash
echo "tick" >> "${STUB_CALLS:?}"
r="$(head -n1 "${STUB_QUEUE:?}")"; sed -i.bak '1d' "$STUB_QUEUE" 2>/dev/null || tail -n +2 "$STUB_QUEUE" > "$STUB_QUEUE.n" && mv "$STUB_QUEUE.n" "$STUB_QUEUE"
echo "TICK_RESULT=${r:-no_work}"
EOF
chmod +x "$FAKE/tick.sh"
# Inert end-path seams (loop-end ping) so no CLI / DB / network is touched.
cat > "$WORK/noop.sh" <<'EOF'
#!/usr/bin/env bash
printf '{}\n'
EOF
chmod +x "$WORK/noop.sh"

# Common env for every driver: live (DRY_RUN=0) so the bump path is exercised,
# dispatch pointed at nothing (every `wg` call is guarded), no sleeps.
run_driver() {  # run_driver <script> [env assignments...]
  local script="$1"; shift
  ( trap - EXIT
    env "$@" DRY_RUN=0 TICK_SLEEP=0 EMPTY_POLL_LIMIT=10 MAX_TICKS_PER_DAY=50 \
      GAFFER_DATA="$WORK/data" DAILY_COUNTER_FILE="$WORK/.daily-ticks" \
      GAFFER_LOG="$WORK/factory.log" \
      DISPATCH_DIR="$WORK/nodist" DISPATCH_DB="$WORK/db.sqlite" MEMORY_DB="$WORK/mem.sqlite" \
      STUB_CALLS="$WORK/calls" STUB_QUEUE="$WORK/queue" \
      LOOP_STATS_CMD="$WORK/noop.sh" LOOP_HQ_CMD="$WORK/noop.sh" LOOP_NOTIFY_EMIT_CMD="$WORK/noop.sh" \
      bash "$script" 2>&1 )
}
reset_state() { rm -f "$WORK/.daily-ticks" "$WORK/calls"; : > "$WORK/calls"; printf '%s\n' "$@" > "$WORK/queue"; }
day_count() { awk '{print $2}' "$WORK/.daily-ticks" 2>/dev/null || echo 0; }

echo "== 2: loop.sh — worked, no_work, no_work → the day counter advances by ONE =="
reset_state worked no_work no_work
out="$(run_driver "$FAKE/loop.sh" MAX_TICKS=3)"
[ "$(wc -l < "$WORK/calls" | tr -d ' ')" = "3" ] && ok "loop ran the 3 stub ticks" || fail "loop should have run 3 ticks (got $(wc -l < "$WORK/calls"))"
[ "$(day_count)" = "1" ] && ok "day counter = 1 (only the worked tick counted)" || fail "day counter should be 1 (got '$(day_count)'); out: $out"
reset_state no_work no_work no_work
run_driver "$FAKE/loop.sh" MAX_TICKS=3 >/dev/null
[ ! -f "$WORK/.daily-ticks" ] || [ "$(day_count)" = "0" ] \
  && ok "an all-idle loop never touches the day counter" || fail "idle loop bumped the day counter to '$(day_count)'"

echo "== 3: worker.sh (parallel pool path) — same rule =="
reset_state worked no_work error
run_driver "$FAKE/worker.sh" WORKER_MAX_TICKS=3 GAFFER_CONCURRENCY=2 >/dev/null
[ "$(day_count)" = "2" ] && ok "worker: worked + error counted, no_work exempt → 2" || fail "worker day counter should be 2 (got '$(day_count)')"

echo "== 4: bin/poll-once.sh (the dashboard Poll button) goes through the caps =="
# The real poll-once.sh, pointed at the stub tick via its test seam.
reset_state no_work
run_driver "$RUNNER_DIR/bin/poll-once.sh" GAFFER_POLL_TICK_SH="$FAKE/tick.sh" >/dev/null
[ "$(wc -l < "$WORK/calls" | tr -d ' ')" = "1" ] && ok "poll ran the tick" || fail "poll should have run the tick once"
[ ! -f "$WORK/.daily-ticks" ] || [ "$(day_count)" = "0" ] \
  && ok "a no_work poll does not consume the day cap" || fail "no_work poll bumped the counter to '$(day_count)'"
reset_state worked
out="$(run_driver "$RUNNER_DIR/bin/poll-once.sh" GAFFER_POLL_TICK_SH="$FAKE/tick.sh")"
[ "$(day_count)" = "1" ] && ok "a worked poll bumps the day counter once" || fail "worked poll should bump to 1 (got '$(day_count)')"
printf '%s' "$out" | grep -q '^TICK_RESULT=worked' && ok "poll streams the tick's TICK_RESULT line through" || fail "poll output lost the TICK_RESULT line"
# Cap already hit: the poll must REFUSE before running the tick.
reset_state worked
printf '%s 50\n' "$(date +%Y-%m-%d)" > "$WORK/.daily-ticks"
out="$(run_driver "$RUNNER_DIR/bin/poll-once.sh" GAFFER_POLL_TICK_SH="$FAKE/tick.sh")"
[ ! -s "$WORK/calls" ] && ok "poll at the day cap does NOT run the tick" || fail "poll ran the tick despite the day cap"
printf '%s' "$out" | grep -q 'per-day cap' && printf '%s' "$out" | grep -q 'TICK_RESULT=no_work' \
  && ok "poll at the cap logs the reason and reports no_work (exit 0)" || fail "poll at cap should log + report no_work; out: $out"
[ "$(day_count)" = "50" ] && ok "a refused poll leaves the counter untouched" || fail "refused poll changed the counter to '$(day_count)'"
# DRY_RUN previews are never gated and never counted.
reset_state worked
printf '%s 50\n' "$(date +%Y-%m-%d)" > "$WORK/.daily-ticks"
( trap - EXIT; env DRY_RUN=1 GAFFER_DATA="$WORK/data" DAILY_COUNTER_FILE="$WORK/.daily-ticks" MAX_TICKS_PER_DAY=50 \
    DISPATCH_DIR="$WORK/nodist" DISPATCH_DB="$WORK/db.sqlite" STUB_CALLS="$WORK/calls" STUB_QUEUE="$WORK/queue" \
    GAFFER_POLL_TICK_SH="$FAKE/tick.sh" bash "$RUNNER_DIR/bin/poll-once.sh" >/dev/null 2>&1 )
[ -s "$WORK/calls" ] && [ "$(day_count)" = "50" ] && ok "DRY_RUN poll runs (never gated) and never counts" || fail "DRY_RUN poll should run and not count"
# The USD day cap gates the poll too.
reset_state worked
rm -f "$WORK/.daily-ticks"
mkdir -p "$WORK/data"
printf '{"ts":"%s","kind":"delivery","measured":true,"total_cost_usd":5.00}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$WORK/data/usage-ledger.jsonl"
out="$(run_driver "$RUNNER_DIR/bin/poll-once.sh" GAFFER_POLL_TICK_SH="$FAKE/tick.sh" GAFFER_DAILY_BUDGET_USD=1.00 GAFFER_USAGE_LEDGER="$WORK/data/usage-ledger.jsonl")"
[ ! -s "$WORK/calls" ] && printf '%s' "$out" | grep -q 'per-day USD cap' \
  && ok "poll at the USD day cap refuses before spawning" || fail "poll should refuse on the USD cap; out: $out"
# Wiring: the same outer wall-clock bound loop.sh uses.
grep -qE 'gaffer_timeout "\$GAFFER_TICK_OUTER_TIMEOUT" bash "\$GAFFER_POLL_TICK_SH"' "$RUNNER_DIR/bin/poll-once.sh" \
  && ok "poll-once.sh wraps the tick in gaffer_timeout GAFFER_TICK_OUTER_TIMEOUT" || fail "poll-once.sh should wrap the tick in the outer timeout"
grep -q 'gaffer_tick_counts_toward_day_cap' "$RUNNER_DIR/loop.sh" \
  && grep -q 'gaffer_tick_counts_toward_day_cap' "$RUNNER_DIR/worker.sh" \
  && ok "loop.sh and worker.sh gate the bump on gaffer_tick_counts_toward_day_cap" || fail "loop.sh/worker.sh should gate the bump on the result"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
