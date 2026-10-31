#!/usr/bin/env bash
# =====================================================================
# A dollar cap is REQUIRED before a live run (lib/budget.sh gaffer_spend_cap_ok,
# loop.sh, `gaffer run`, bin/poll-once.sh).
# ---------------------------------------------------------------------
# Out of the box only MAX_TICKS_PER_DAY bounded an unattended factory. A live run
# with neither GAFFER_DAILY_BUDGET_USD nor GAFFER_BUDGET_USD set now refuses to
# start, with a one-line fix. Proves, with the REAL loop.sh / gaffer / poll-once.sh
# against a STUB tick.sh (no agent, nothing spent):
#   1. gaffer_spend_cap_ok: dry run ok; live + no cap refuses; a 0 / garbage cap is
#      no cap; either cap > 0 is enough; GAFFER_ALLOW_UNCAPPED=1 opts out.
#   2. loop.sh live + no cap → exit 3, the hint, and NO tick ran.
#   3. loop.sh live + GAFFER_DAILY_BUDGET_USD=5 (or GAFFER_BUDGET_USD=5) runs.
#   3c. GAFFER_ALLOW_UNCAPPED=1 in settings.json is IGNORED (environment only):
#      loop.sh and `gaffer run` still exit 3, the Poll refuses, and nothing runs.
#   4. loop.sh DRY_RUN=1 with no cap still runs (a preview is never refused).
#   5. `gaffer run` refuses before the loop (and before --daemon) — exit 3, the
#      loop stub never starts; `gaffer run --dry-run` is not refused.
#   6. poll-once.sh refuses with a line the dashboard reads as REFUSED.
# run.sh exports GAFFER_ALLOW_UNCAPPED=1 for the stub suite; this test unsets it.
# Run: bash runner/test/spend-cap-required.test.sh   (bash 3.2 safe)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
unset GAFFER_ALLOW_UNCAPPED GAFFER_DAILY_BUDGET_USD GAFFER_BUDGET_USD

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/spend-cap.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
trap 'gaffer_test_rm_work "$WORK"' EXIT

echo "== 1: gaffer_spend_cap_ok =="
# shellcheck source=../lib/budget.sh
source "$RUNNER_DIR/lib/budget.sh"
unset GAFFER_ALLOW_UNCAPPED
chk() {  # chk <want 0|1> <label> [VAR=val ...]
  local want="$1" label="$2"; shift 2
  ( unset DRY_RUN GAFFER_DAILY_BUDGET_USD GAFFER_BUDGET_USD GAFFER_ALLOW_UNCAPPED
    for kv in "$@"; do export "${kv?}"; done
    gaffer_spend_cap_ok ); local rc=$?
  [ "$rc" = "$want" ] && ok "$label" || fail "$label (rc $rc, want $want)"
}
chk 0 "a dry run never needs a cap" DRY_RUN=1
chk 0 "DRY_RUN unset reads as the config default (dry)"
chk 1 "a live run with no cap refuses" DRY_RUN=0
chk 1 "a daily cap of 0 is no cap" DRY_RUN=0 GAFFER_DAILY_BUDGET_USD=0
chk 1 "a non-numeric cap is no cap" DRY_RUN=0 GAFFER_DAILY_BUDGET_USD=abc GAFFER_BUDGET_USD=-3
chk 0 "a daily cap of 5 is enough" DRY_RUN=0 GAFFER_DAILY_BUDGET_USD=5
chk 0 "a lifetime cap alone is enough" DRY_RUN=0 GAFFER_BUDGET_USD=0.50
chk 0 "GAFFER_ALLOW_UNCAPPED=1 opts out" DRY_RUN=0 GAFFER_ALLOW_UNCAPPED=1
chk 1 "GAFFER_ALLOW_UNCAPPED=0 does not" DRY_RUN=0 GAFFER_ALLOW_UNCAPPED=0
hint="$(gaffer_spend_cap_hint)"
case "$hint" in *GAFFER_DAILY_BUDGET_USD*GAFFER_ALLOW_UNCAPPED=1*) ok "the hint names the fix and the opt-out" ;; *) fail "hint: $hint" ;; esac
[ "$(printf '%s' "$hint" | wc -l | tr -d ' ')" = 0 ] && ok "the hint is one line" || fail "hint spans lines"

# ── A FAKE runner dir: every real file symlinked in, tick.sh replaced by a stub.
FAKE="$WORK/runner"; mkdir -p "$FAKE"
for f in "$RUNNER_DIR"/*; do
  case "$(basename "$f")" in
    tick.sh|run-summary.sh|test) ;;
    *) ln -s "$f" "$FAKE/$(basename "$f")" ;;
  esac
done
cat > "$FAKE/tick.sh" <<'EOF'
#!/usr/bin/env bash
echo "tick" >> "${STUB_CALLS:?}"
echo "TICK_RESULT=no_work"
EOF
chmod +x "$FAKE/tick.sh"
printf '#!/usr/bin/env bash\nprintf "{}\\n"\n' > "$WORK/noop.sh"; chmod +x "$WORK/noop.sh"

run_driver() {  # run_driver <script> [env assignments...] — caller's assignments win
  local script="$1"; shift
  ( trap - EXIT
    env -u GAFFER_ALLOW_UNCAPPED -u GAFFER_DAILY_BUDGET_USD -u GAFFER_BUDGET_USD \
      DRY_RUN=0 TICK_SLEEP=0 EMPTY_POLL_LIMIT=1 MAX_TICKS=2 MAX_TICKS_PER_DAY=50 \
      GAFFER_DATA="$WORK/data" DAILY_COUNTER_FILE="$WORK/.daily-ticks" GAFFER_LOG="$WORK/factory.log" \
      DISPATCH_DIR="$WORK/nodist" DISPATCH_DB="$WORK/db.sqlite" MEMORY_DB="$WORK/mem.sqlite" \
      STUB_CALLS="$WORK/calls" \
      LOOP_STATS_CMD="$WORK/noop.sh" LOOP_HQ_CMD="$WORK/noop.sh" LOOP_NOTIFY_EMIT_CMD="$WORK/noop.sh" \
      "$@" bash "$script" 2>&1 )
}
calls() { wc -l < "$WORK/calls" | tr -d ' '; }
reset() { : > "$WORK/calls"; rm -f "$WORK/.daily-ticks"; }
# `gaffer run` against a STUB loop.sh (it only records that it started).
STUBLOOP="$WORK/loop-stub.sh"
printf '#!/usr/bin/env bash\necho loop >> "%s"\n' "$WORK/calls" > "$STUBLOOP"; chmod +x "$STUBLOOP"
gaffer_run() { ( trap - EXIT; env -u GAFFER_ALLOW_UNCAPPED -u GAFFER_DAILY_BUDGET_USD -u GAFFER_BUDGET_USD -u DRY_RUN \
  GAFFER_DATA="$WORK/data" GAFFER_LOOP_SH="$STUBLOOP" GAFFER_DAEMON_MAX_CYCLES=1 "$@" 2>&1 ); }

echo "== 2: loop.sh live with no cap refuses before any tick =="
reset
out="$(run_driver "$FAKE/loop.sh")"; rc=$?
[ "$rc" = 3 ] && ok "loop.sh exits 3 (a setup error, so the daemon backs off)" || fail "loop.sh rc=$rc; out: $out"
[ "$(calls)" = 0 ] && ok "no tick ran" || fail "$(calls) tick(s) ran uncapped"
grep -q 'refusing a live run — no dollar cap is set' <<<"$out" && ok "it says why" || fail "no refusal line: $out"
grep -q 'GAFFER_DAILY_BUDGET_USD (try 5)' <<<"$out" && ok "…and how to fix it" || fail "no fix hint: $out"

echo "== 3: a cap lets the live run start =="
reset
out="$(run_driver "$FAKE/loop.sh" GAFFER_DAILY_BUDGET_USD=5)"; rc=$?
[ "$rc" = 0 ] && [ "$(calls)" = 1 ] && ok "GAFFER_DAILY_BUDGET_USD=5 → the loop ran" || fail "daily cap: rc=$rc calls=$(calls); out: $out"
reset
out="$(run_driver "$FAKE/loop.sh" GAFFER_BUDGET_USD=5)"; rc=$?
[ "$rc" = 0 ] && [ "$(calls)" = 1 ] && ok "GAFFER_BUDGET_USD=5 → the loop ran" || fail "lifetime cap: rc=$rc calls=$(calls); out: $out"
reset
out="$(run_driver "$FAKE/loop.sh" GAFFER_ALLOW_UNCAPPED=1)"; rc=$?
[ "$rc" = 0 ] && [ "$(calls)" = 1 ] && ok "GAFFER_ALLOW_UNCAPPED=1 → the loop ran" || fail "opt-out: rc=$rc calls=$(calls); out: $out"

echo "== 3b: a cap set in settings.json counts (the dashboard path) =="
reset; mkdir -p "$WORK/data"; printf '{"GAFFER_DAILY_BUDGET_USD":"5"}\n' > "$WORK/data/settings.json"
out="$(run_driver "$FAKE/loop.sh")"; rc=$?
[ "$rc" = 0 ] && [ "$(calls)" = 1 ] && ok "a daily budget saved from Settings lets the loop run" || fail "settings cap: rc=$rc calls=$(calls); out: $out"
rm -f "$WORK/data/settings.json"

echo "== 3c: GAFFER_ALLOW_UNCAPPED in settings.json is ignored (environment only) =="
reset; mkdir -p "$WORK/data"; printf '{"GAFFER_ALLOW_UNCAPPED":"1"}\n' > "$WORK/data/settings.json"
out="$(run_driver "$FAKE/loop.sh")"; rc=$?
[ "$rc" = 3 ] && ok "loop.sh: the opt-out in settings.json does not lift the cap (exit 3)" || fail "settings opt-out loop.sh: rc=$rc; out: $out"
[ "$(calls)" = 0 ] && ok "loop.sh: no tick ran" || fail "$(calls) tick(s) ran on a settings.json opt-out"
reset
out="$(gaffer_run bash "$RUNNER_DIR/gaffer" run)"; rc=$?
[ "$rc" = 3 ] && [ "$(calls)" = 0 ] && ok "gaffer run: the opt-out in settings.json does not lift the cap (exit 3, loop not started)" || fail "settings opt-out gaffer run: rc=$rc calls=$(calls); out: $out"

echo "== 4: a dry run is never refused =="
reset; rm -f "$WORK/data/settings.json"
out="$(run_driver "$FAKE/loop.sh" DRY_RUN=1)"; rc=$?
[ "$rc" = 0 ] && [ "$(calls)" = 1 ] && ok "DRY_RUN=1 with no cap still runs" || fail "dry: rc=$rc calls=$(calls); out: $out"

echo "== 5: gaffer run refuses before the loop starts =="
reset
out="$(gaffer_run bash "$RUNNER_DIR/gaffer" run)"; rc=$?
[ "$rc" = 3 ] && [ "$(calls)" = 0 ] && ok "gaffer run: exit 3, loop not started" || fail "gaffer run: rc=$rc calls=$(calls); out: $out"
grep -q 'GAFFER_DAILY_BUDGET_USD (try 5)' <<<"$out" && ok "gaffer run prints the fix" || fail "gaffer run hint: $out"
reset
out="$(gaffer_run bash "$RUNNER_DIR/gaffer" run --daemon --interval 0)"; rc=$?
[ "$rc" = 3 ] && [ "$(calls)" = 0 ] && ok "gaffer run --daemon refuses too (never starts backing off)" || fail "daemon: rc=$rc calls=$(calls); out: $out"
reset
out="$(gaffer_run bash "$RUNNER_DIR/gaffer" run --dry-run)"; rc=$?
[ "$rc" = 0 ] && [ "$(calls)" = 1 ] && ok "gaffer run --dry-run is not refused" || fail "dry gaffer run: rc=$rc calls=$(calls); out: $out"
reset
out="$(gaffer_run GAFFER_DAILY_BUDGET_USD=5 bash "$RUNNER_DIR/gaffer" run)"; rc=$?
[ "$rc" = 0 ] && [ "$(calls)" = 1 ] && ok "gaffer run with a cap starts the loop" || fail "capped gaffer run: rc=$rc calls=$(calls); out: $out"

echo "== 6: the dashboard's Poll button (poll-once.sh) refuses too =="
reset
out="$(run_driver "$RUNNER_DIR/bin/poll-once.sh" GAFFER_POLL_TICK_SH="$FAKE/tick.sh")"; rc=$?
[ "$rc" = 0 ] && [ "$(calls)" = 0 ] && ok "poll: no tick ran, exit 0" || fail "poll: rc=$rc calls=$(calls); out: $out"
grep -qE '^gaffer poll: no dollar cap is set.*— not polling\.$' <<<"$out" \
  && ok "poll prints a refusal the dashboard reads as REFUSED" || fail "poll refusal line: $out"
grep -q '^TICK_RESULT=no_work$' <<<"$out" && ok "poll reports no_work" || fail "poll result: $out"
reset; printf '{"GAFFER_ALLOW_UNCAPPED":"1"}\n' > "$WORK/data/settings.json"
out="$(run_driver "$RUNNER_DIR/bin/poll-once.sh" GAFFER_POLL_TICK_SH="$FAKE/tick.sh")"
[ "$(calls)" = 0 ] && ok "poll: the opt-out in settings.json does not lift the cap" || fail "settings opt-out poll: calls=$(calls); out: $out"
rm -f "$WORK/data/settings.json"
reset
out="$(run_driver "$RUNNER_DIR/bin/poll-once.sh" GAFFER_POLL_TICK_SH="$FAKE/tick.sh" GAFFER_DAILY_BUDGET_USD=5)"
[ "$(calls)" = 1 ] && ok "poll with a cap runs the tick" || fail "capped poll: calls=$(calls); out: $out"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "spend-cap-required: all $PASS passed"; exit 0; fi
echo "spend-cap-required: ${#FAILURES[@]} FAILED (of $((PASS + ${#FAILURES[@]})))"; exit 1
