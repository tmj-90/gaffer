#!/usr/bin/env bash
# =====================================================================
# The run summary and the run's own lines say what this run did.
# ---------------------------------------------------------------------
#   1  "landed:" counts only the tickets this run moved to done (updated_at at or
#      after SUMMARY_SINCE, the run start); it used to count every done ticket ever.
#      Without SUMMARY_SINCE it says "(all time)";
#   2  a tick whose delivery the gates PARKED prints "tick 1/1 → parked #N — held for
#      a human …", an EMPTY delivery parked to refining prints "tick 1/1 → parked #N —
#      empty delivery, back to refining …", never "tick → error" (TICK_RESULT is
#      unchanged);
#   3  the daemon banner reads "gaffer daemon: …", not "gaffer gaffer daemon: …".
# Hermetic: stubbed dispatch lists/shows, a fake runner dir whose tick.sh is a stub,
# and a stub loop for the daemon.
# Run: bash runner/test/run-summary-wording.test.sh   (bash 3.2 safe)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
has()  { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/run-summary-wording.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
trap 'gaffer_test_rm_work "$WORK"' EXIT
export GAFFER_DATA="$WORK/data"; mkdir -p "$GAFFER_DATA"

echo "== 1: landed counts this run's landings =="
cat > "$WORK/list.sh" <<'SH'
#!/usr/bin/env bash
case "$1" in done) echo '[{"number":1,"title":"old"},{"number":2,"title":"new"},{"number":3,"title":"older"}]' ;; *) echo '[]' ;; esac
SH
cat > "$WORK/show.sh" <<'SH'
#!/usr/bin/env bash
case "$1" in
  1) echo '{"ticket":{"number":1,"updated_at":"2026-01-01T09:00:00.000Z"},"events":[]}' ;;
  2) echo '{"ticket":{"number":2,"updated_at":"2026-01-01T10:30:00.000Z"},"events":[]}' ;;
  3) echo '{"ticket":{"number":3,"updated_at":"2025-12-01T10:30:00.000Z"},"events":[]}' ;;
esac
SH
chmod +x "$WORK/list.sh" "$WORK/show.sh"
sm() { env SUMMARY_LIST_CMD="$WORK/list.sh" SUMMARY_SHOW_CMD="$WORK/show.sh" GAFFER_BP_FILE="$WORK/none" "$@" bash "$RUNNER_DIR/run-summary.sh" 2>&1; }
OUT="$(sm SUMMARY_SINCE=2026-01-01T10:00:00.000Z)"
has "$OUT" "landed:          1 this run (3 done in all)" && ok "1 landed this run, out of 3 done" || fail "landed line: $(printf '%s' "$OUT" | grep landed)"
OUT="$(sm SUMMARY_SINCE=2027-01-01T00:00:00.000Z)"
has "$OUT" "landed:          0 this run (3 done in all)" && ok "a run that landed nothing says 0" || fail "landed line: $(printf '%s' "$OUT" | grep landed)"
OUT="$(sm SUMMARY_SINCE=)"
has "$OUT" "landed:          3 done (all time)" && ok "without SUMMARY_SINCE: all time, said so" || fail "landed line: $(printf '%s' "$OUT" | grep landed)"

echo "== 2: a parked delivery is not 'tick → error' =="
FAKE="$WORK/runner"; mkdir -p "$FAKE"
for f in "$RUNNER_DIR"/*; do
  case "$(basename "$f")" in tick.sh|run-summary.sh|test) ;; *) ln -s "$f" "$FAKE/$(basename "$f")" ;; esac
done
cat > "$FAKE/tick.sh" <<'SH'
#!/usr/bin/env bash
case "${STUB_TICK:-park}" in
  park) printf '2026-01-01T10:00:00 delivery PARKED for #7 — tests not met (rework_exhausted, 3/3); worktree removed, branch gaffer/ticket-7 PRESERVED, VISIBLE in blocked\n' >> "$GAFFER_LOG" ;;
  empty) printf '2026-01-01T10:00:00 delivery PARKED for #9 — empty; removed worktrees + branch gaffer/ticket-9\n' >> "$GAFFER_LOG" ;;
  error) printf '2026-01-01T10:00:00 delivery FAILED for #8 — a write repo could not be worktree'"'"'d\n' >> "$GAFFER_LOG" ;;
esac
echo "TICK_RESULT=error"
SH
printf '#!/usr/bin/env bash\necho "[]"\n' > "$FAKE/run-summary.sh"
chmod +x "$FAKE/tick.sh" "$FAKE/run-summary.sh"
printf '#!/usr/bin/env bash\nprintf "{}\\n"\n' > "$WORK/noop.sh"; chmod +x "$WORK/noop.sh"
lp() { env DRY_RUN=1 TICK_SLEEP=0 EMPTY_POLL_LIMIT=1 MAX_TICKS=1 MAX_TICKS_PER_DAY=50 GAFFER_LOG="$WORK/factory.log" \
  DAILY_COUNTER_FILE="$WORK/.daily" LOOP_STATS_CMD="$WORK/noop.sh" LOOP_HQ_CMD="$WORK/noop.sh" LOOP_NOTIFY_EMIT_CMD="$WORK/noop.sh" \
  "$@" bash "$FAKE/loop.sh" 2>&1; }
printf '2026-01-01T09:00:00 delivery PARKED for #2 — an EARLIER run\n' > "$WORK/factory.log"
OUT="$(lp STUB_TICK=park)"
has "$OUT" "tick 1/1 → parked #7 — held for a human" && ok "the park is named, with its ticket" || fail "tick line: $(printf '%s' "$OUT" | grep 'tick 1/')"
has "$OUT" "tick 1/1 → error" && fail "still 'tick → error' for a park" || ok "no 'tick → error' for a clean park"
OUT="$(lp STUB_TICK=empty)"
has "$OUT" "tick 1/1 → parked #9 — empty delivery, back to refining (see gaffer status)" && ok "an empty delivery's park says what happened" || fail "empty tick line: $(printf '%s' "$OUT" | grep 'tick 1/')"
has "$OUT" "held for a human" && fail "an empty delivery reads 'held for a human'" || ok "an empty delivery is not 'held for a human'"
OUT="$(lp STUB_TICK=error)"
has "$OUT" "tick 1/1 → error" && ok "a real error still reads error (an earlier run's PARKED line is not this tick's)" || fail "error tick: $(printf '%s' "$OUT" | grep 'tick 1/')"

echo "== 3: the daemon banner =="
printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/loop-stub.sh"; chmod +x "$WORK/loop-stub.sh"
OUT="$(env GAFFER_LOOP_SH="$WORK/loop-stub.sh" GAFFER_DAEMON_MAX_CYCLES=1 bash "$RUNNER_DIR/gaffer" run --daemon --dry-run --interval 1 2>&1)"
has "$OUT" "gaffer daemon: re-running the loop every 1s" && ok "banner: 'gaffer daemon: …'" || fail "banner: $(printf '%s' "$OUT" | head -3)"
has "$OUT" "gaffer gaffer" && fail "doubled prefix: $(printf '%s' "$OUT" | grep 'gaffer gaffer')" || ok "no doubled 'gaffer gaffer'"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "run-summary-wording: ALL $PASS checks passed"; exit 0; fi
echo "run-summary-wording: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
