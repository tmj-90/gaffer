#!/usr/bin/env bash
# =====================================================================
# SETTINGS REACH A RUNNING FACTORY — "changes take effect on the NEXT tick".
# ---------------------------------------------------------------------
# factory.config.sh is sourced by a parent (gaffer, loop.sh, a daemon pass) and again
# by every child (tick.sh, worker.sh). The parent EXPORTS what it derived, and the
# child's assign-if-unset used to keep that stale value, so a dashboard edit never
# reached a running loop or `gaffer run --daemon`. Proves, with no agent spawned:
#   1. a child's re-source sees settings.json as it is NOW (changed, added, removed
#      keys; an exported default like GAFFER_CONCURRENCY; a GAFFER_MODE switch);
#   2. the operator's real env still wins over the file, in parent and child;
#   3. a value a parent changed on purpose (gaffer run → DRY_RUN=0) is kept;
#   4. `gaffer run --daemon`: a settings edit between passes reaches the next pass,
#      and the daemon's own per-day cap check reads the edited MAX_TICKS_PER_DAY.
#   5. a RUNNING loop.sh (serial and pool) re-reads MAX_TICKS_PER_DAY before every
#      admission: lowering it mid-run stops the loop at its next tick, a run of edits
#      is followed edit by edit, the operator's env still wins, and a cap that cannot
#      be re-read (not an integer) stops the run — fail closed.
#   6. a settings.json that EXISTS but does not parse mid-run (hand edit, truncated
#      write), or no node to read it, never lowers a ceiling: a child keeps the
#      inherited caps (MAX_TICKS_PER_DAY, GAFFER_DAILY_BUDGET_USD, GAFFER_BUDGET_USD —
#      not the default 50 / OFF), the marker is set, and a running loop (serial and
#      pool) and the daemon stop instead of admitting against defaults.
# Run: bash test/settings-resource.test.sh   (bash 3.2 safe)
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }

PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/settings-resource.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/data"
CFG="$RUNNER_DIR/factory.config.sh"
# probe.sh [times] — source the config (times, default 1) in THIS process, then print.
cat > "$WORK/probe.sh" <<'PROBESH'
#!/usr/bin/env bash
n="${1:-1}"; while [ "$n" -gt 0 ]; do source "$CFG" >/dev/null 2>&1; n=$((n - 1)); done
printf '%s|%s|%s|%s|%s|%s|%s\n' "${GAFFER_DAILY_BUDGET_USD:-}" "${MAX_TICKS_PER_DAY:-}" "${GAFFER_MAX_TURNS:-}" "${REVIEW_MODE:-}" "${GAFFER_CONCURRENCY:-}" "${DRY_RUN:-}" "${GAFFER_REWORK_BUDGET_USD:-}"
PROBESH
cat > "$WORK/mode.sh" <<'MODESH'
#!/usr/bin/env bash
source "$CFG" >/dev/null 2>&1; echo "$REVIEW_MODE ${STRICT_MODE:-} ${GAFFER_STRICT_REQUIRE:-}"
MODESH

echo "== 1-3. parent → child re-source =="
printf '{"GAFFER_DAILY_BUDGET_USD":"5","MAX_TICKS_PER_DAY":"40","GAFFER_MAX_TURNS":"30","REVIEW_MODE":"human","GAFFER_REWORK_BUDGET_USD":"4"}\n' > "$WORK/data/settings.json"
OUT="$(env -i PATH="$PATH" HOME="$HOME" GAFFER_DATA="$WORK/data" GAFFER_MAX_TURNS=55 CFG="$CFG" W="$WORK" bash -c '
  source "$CFG" >/dev/null 2>&1
  echo "P:$(bash "$W/probe.sh" 0)"
  # The dashboard edits the file while the parent keeps running.
  printf "{\"GAFFER_DAILY_BUDGET_USD\":\"1\",\"MAX_TICKS_PER_DAY\":\"3\",\"GAFFER_MAX_TURNS\":\"10\",\"REVIEW_MODE\":\"agent\",\"GAFFER_CONCURRENCY\":\"2\"}\n" > "$GAFFER_DATA/settings.json"
  echo "C:$(bash "$W/probe.sh")"
  echo "O:$(DRY_RUN=0 bash "$W/probe.sh")"
  echo "G:$(bash -c "source \"\$CFG\" >/dev/null 2>&1; bash \"\$W/probe.sh\" 2")"
  printf "{\"GAFFER_MODE\":\"autonomous\"}\n" > "$GAFFER_DATA/settings.json"
  echo "M:$(bash "$W/mode.sh")"
')"
P="$(sed -n 's/^P://p' <<<"$OUT")"; C="$(sed -n 's/^C://p' <<<"$OUT")"; O="$(sed -n 's/^O://p' <<<"$OUT")"
G="$(sed -n 's/^G://p' <<<"$OUT")"; M="$(sed -n 's/^M://p' <<<"$OUT")"
IFS='|' read -r p_day p_max p_turns p_rev _ _ p_rework <<<"$P"
[ "$p_day|$p_max|$p_rev|$p_rework" = "5|40|human|4" ] && ok "parent applied settings.json" || fail "parent: $P"
[ "$p_turns" = 55 ] && ok "parent: the operator's GAFFER_MAX_TURNS wins over the file" || fail "parent turns: $P"
IFS='|' read -r c_day c_max c_turns c_rev c_conc _ c_rework <<<"$C"
[ "$c_day" = 1 ] && ok "child sees the edited daily USD cap (5 → 1)" || fail "child daily cap stale: $C"
[ "$c_max" = 3 ] && ok "child sees the edited MAX_TICKS_PER_DAY (40 → 3)" || fail "child MAX_TICKS_PER_DAY stale: $C"
[ "$c_rev" = agent ] && ok "child sees the edited REVIEW_MODE (human → agent)" || fail "child REVIEW_MODE stale: $C"
[ "$c_conc" = 2 ] && ok "a key the parent held at an EXPORTED default (GAFFER_CONCURRENCY) takes the new file value" || fail "child concurrency stale: $C"
[ "$c_rework" != 4 ] && ok "a key removed from settings.json falls back to its default (rework budget no longer 4)" || fail "child kept the removed GAFFER_REWORK_BUDGET_USD: $C"
[ "$c_turns" = 55 ] && ok "child: the operator's GAFFER_MAX_TURNS still wins over the file" || fail "child turns: $C"
IFS='|' read -r _ _ _ _ _ o_dry _ <<<"$O"
[ "$o_dry" = 0 ] && ok "a value the parent changed on purpose (DRY_RUN=0) is kept" || fail "parent override lost: $O"
[ "$G" = "$C" ] && ok "a grandchild (and a double source in one shell) agrees with the child" || fail "grandchild: $G vs child $C"
read -r m_rev m_strict m_req <<<"$M"
[ "$m_rev|$m_strict|$m_req" = "agent|1|1" ] && ok "a GAFFER_MODE switch in the file re-derives the preset in the child" || fail "mode switch: $M"

echo "== 4. gaffer run --daemon re-reads settings every pass =="
D="$WORK/d2"; mkdir -p "$D"
printf '{"GAFFER_DAILY_BUDGET_USD":"5","MAX_TICKS_PER_DAY":"40"}\n' > "$D/settings.json"
LOG="$WORK/passes.log"; : > "$LOG"
STUB="$WORK/loop.sh"
# Each pass is what loop.sh does first: source the config. Pass 1 then "edits the
# dashboard": a lower USD cap, and MAX_TICKS_PER_DAY=2 with today's count already at 2.
cat > "$STUB" <<STUBSH
#!/usr/bin/env bash
source "$CFG" >/dev/null 2>&1
echo "pass MAX=\$MAX_TICKS_PER_DAY DAY=\$GAFFER_DAILY_BUDGET_USD" >> "$LOG"
n=\$(grep -c '^pass' "$LOG")
if [ "\$n" = 1 ]; then printf '{"GAFFER_DAILY_BUDGET_USD":"0.5","MAX_TICKS_PER_DAY":"40"}\n' > "$D/settings.json"; fi
if [ "\$n" = 2 ]; then printf '%s 2\n' "\$(date +%Y-%m-%d)" > "$D/.daily-ticks"; printf '{"GAFFER_DAILY_BUDGET_USD":"0.5","MAX_TICKS_PER_DAY":"2"}\n' > "$D/settings.json"; fi
exit 0
STUBSH
chmod +x "$STUB"
ERR="$(env -i PATH="$PATH" HOME="$HOME" GAFFER_DATA="$D" GAFFER_LOOP_SH="$STUB" GAFFER_DAEMON_MAX_CYCLES=4 \
  timeout 90 bash "$RUNNER_DIR/gaffer" run --daemon --interval 0 2>&1 >/dev/null)"
L1="$(sed -n 1p "$LOG")"; L2="$(sed -n 2p "$LOG")"; NP="$(grep -c '^pass' "$LOG")"
[ "$L1" = "pass MAX=40 DAY=5" ] && ok "daemon pass 1 used the settings at start" || fail "pass 1: $L1"
[ "$L2" = "pass MAX=40 DAY=0.5" ] && ok "daemon pass 2 saw the edited daily USD cap without a restart" || fail "pass 2 stale: $L2"
[ "$NP" = 2 ] && ok "the daemon's own cap check read the edited MAX_TICKS_PER_DAY=2 and idled" || fail "expected 2 passes then idle, got $NP: $(cat "$LOG")"
grep -q 'per-day cap (MAX_TICKS_PER_DAY=2)' <<<"$ERR" && ok "the idle notice names the edited cap" || fail "no cap notice: $ERR"

echo "== 5. a running loop.sh re-reads the day cap before every tick =="
# A FAKE runner dir: every real file symlinked in, tick.sh replaced by a stub that
# records each call and then "edits the dashboard": after call N it writes
# $SEQ/N.json (when present) over settings.json, as the Settings panel would.
FAKE="$WORK/runner"; mkdir -p "$FAKE"
for f in "$RUNNER_DIR"/*; do
  case "$(basename "$f")" in tick.sh|run-summary.sh|test) ;; *) ln -s "$f" "$FAKE/$(basename "$f")" ;; esac
done
cat > "$FAKE/tick.sh" <<'TICKSH'
#!/usr/bin/env bash
echo "tick MAX=${MAX_TICKS_PER_DAY:-}" >> "${STUB_CALLS:?}"
n="$(grep -c '^tick' "$STUB_CALLS")"
[ -f "$SEQ/$n.json" ] && cp "$SEQ/$n.json" "$GAFFER_DATA/settings.json"
# STUB_COST: each tick "spends" this many dollars in today's usage ledger.
[ -n "${STUB_COST:-}" ] && printf '{"ts":"%s","kind":"delivery","measured":true,"total_cost_usd":%s}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$STUB_COST" >> "$GAFFER_DATA/usage-ledger.jsonl"
echo "TICK_RESULT=worked"
TICKSH
chmod +x "$FAKE/tick.sh"
printf '#!/usr/bin/env bash\nprintf "{}\\n"\n' > "$WORK/noop.sh"; chmod +x "$WORK/noop.sh"
# run_loop <data-dir> <seq-dir> [env...] — the REAL loop.sh, live (DRY_RUN=0), no sleeps.
run_loop() {
  local data="$1" seq="$2"; shift 2
  : > "$WORK/calls"; rm -f "$data/.daily-ticks" "$data/usage-ledger.jsonl"
  env -i PATH="$PATH" HOME="$HOME" "$@" DRY_RUN=0 TICK_SLEEP=0 EMPTY_POLL_LIMIT=10 \
    GAFFER_DATA="$data" GAFFER_LOG="$WORK/factory.log" GAFFER_TICK_OUTER_TIMEOUT=60 \
    DISPATCH_DIR="$WORK/nodist" DISPATCH_DB="$WORK/db.sqlite" MEMORY_DB="$WORK/mem.sqlite" \
    STUB_CALLS="$WORK/calls" SEQ="$seq" \
    LOOP_STATS_CMD="$WORK/noop.sh" LOOP_HQ_CMD="$WORK/noop.sh" LOOP_NOTIFY_EMIT_CMD="$WORK/noop.sh" \
    timeout 120 bash "$FAKE/loop.sh" 2>&1
}
ticks_run() { local n; n="$(grep -c '^tick' "$WORK/calls" 2>/dev/null)"; echo "${n:-0}"; }
day_used() { awk '{print $2}' "$1/.daily-ticks" 2>/dev/null || echo 0; }

# 5a. The reviewer's case: cap 40 → 1 after the first tick, MAX_TICKS=4.
L="$WORK/l1"; S="$WORK/s1"; mkdir -p "$L" "$S"
printf '{"MAX_TICKS_PER_DAY":"40"}\n' > "$L/settings.json"
printf '{"MAX_TICKS_PER_DAY":"1"}\n' > "$S/1.json"
OUT5="$(run_loop "$L" "$S" MAX_TICKS=4)"
[ "$(ticks_run)" = 1 ] && ok "lowering MAX_TICKS_PER_DAY 40 → 1 mid-run stops the loop after 1 tick (was 4)" \
  || fail "loop ran $(ticks_run) tick(s) against a lowered cap of 1: $(tail -3 <<<"$OUT5")"
[ "$(day_used "$L")" = 1 ] && ok "the day counter stays at the lowered cap (1)" || fail "day counter $(day_used "$L") over the cap of 1"
grep -q 'per-day cap (MAX_TICKS_PER_DAY=1' <<<"$OUT5" && ok "the stop line names the edited cap" || fail "no stop line naming MAX_TICKS_PER_DAY=1: $(tail -3 <<<"$OUT5")"

# 5b. A run of edits is followed edit by edit: 40 → 3 after tick 1, → 2 after tick 2.
#     (A refreshed value must not freeze: the second edit has to be seen too.)
L="$WORK/l2"; S="$WORK/s2"; mkdir -p "$L" "$S"
printf '{"MAX_TICKS_PER_DAY":"40"}\n' > "$L/settings.json"
printf '{"MAX_TICKS_PER_DAY":"3"}\n' > "$S/1.json"; printf '{"MAX_TICKS_PER_DAY":"2"}\n' > "$S/2.json"
OUT5="$(run_loop "$L" "$S" MAX_TICKS=5)"
[ "$(ticks_run)" = 2 ] && ok "two successive edits (40 → 3 → 2) both reach the running loop: stopped at 2" \
  || fail "expected 2 ticks after 40 → 3 → 2, ran $(ticks_run): $(cat "$WORK/calls")"
grep -q 'tick MAX=3' "$WORK/calls" && ok "the tick after an edit runs under the edited cap" || fail "tick did not see MAX=3: $(cat "$WORK/calls")"

# 5c. Raising the cap mid-run also reaches the loop (1 → 3).
L="$WORK/l3"; S="$WORK/s3"; mkdir -p "$L" "$S"
printf '{"MAX_TICKS_PER_DAY":"1"}\n' > "$L/settings.json"
printf '{"MAX_TICKS_PER_DAY":"3"}\n' > "$S/1.json"
run_loop "$L" "$S" MAX_TICKS=5 >/dev/null
[ "$(ticks_run)" = 3 ] && ok "raising MAX_TICKS_PER_DAY 1 → 3 mid-run admits up to the new cap" || fail "expected 3 ticks after 1 → 3, ran $(ticks_run)"

# 5d. The operator's real env still wins over a mid-run settings edit.
L="$WORK/l4"; S="$WORK/s4"; mkdir -p "$L" "$S"
printf '{"MAX_TICKS_PER_DAY":"40"}\n' > "$L/settings.json"
printf '{"MAX_TICKS_PER_DAY":"1"}\n' > "$S/1.json"
run_loop "$L" "$S" MAX_TICKS=3 MAX_TICKS_PER_DAY=40 >/dev/null
[ "$(ticks_run)" = 3 ] && ok "an operator-env MAX_TICKS_PER_DAY is not overridden by a mid-run file edit" || fail "operator env lost: ran $(ticks_run)"

# 5e. Fail closed: a cap that cannot be re-read as an integer stops the run.
L="$WORK/l5"; S="$WORK/s5"; mkdir -p "$L" "$S"
printf '{"MAX_TICKS_PER_DAY":"40"}\n' > "$L/settings.json"
printf '{"MAX_TICKS_PER_DAY":"lots"}\n' > "$S/1.json"
OUT5="$(run_loop "$L" "$S" MAX_TICKS=4)"
[ "$(ticks_run)" = 1 ] && grep -q 'could not re-read the per-day caps' <<<"$OUT5" \
  && ok "an unreadable cap (MAX_TICKS_PER_DAY=lots) stops the loop, logged (fail closed)" \
  || fail "unreadable cap: ran $(ticks_run): $(tail -3 <<<"$OUT5")"

# 5f. Pool path (GAFFER_CONCURRENCY=2): each worker re-reads the cap before admission.
L="$WORK/l6"; S="$WORK/s6"; mkdir -p "$L" "$S"
printf '{"MAX_TICKS_PER_DAY":"40"}\n' > "$L/settings.json"
printf '{"MAX_TICKS_PER_DAY":"1"}\n' > "$S/1.json"
OUT5="$(run_loop "$L" "$S" MAX_TICKS=8 GAFFER_CONCURRENCY=2)"
[ "$(ticks_run)" -le 2 ] && [ "$(day_used "$L")" -le 2 ] \
  && ok "a running pool stops once the cap is lowered to 1 ($(ticks_run) tick(s), at most one per worker already admitted; was 8)" \
  || fail "pool ran $(ticks_run) tick(s) (day $(day_used "$L")) against a lowered cap of 1: $(tail -3 <<<"$OUT5")"
grep -q 'per-day cap reached' <<<"$OUT5" && ok "pool workers log the day-cap stop" || fail "no worker day-cap stop: $(tail -5 <<<"$OUT5")"

echo "== 6. an UNREADABLE settings.json mid-run never lowers a ceiling (fail closed) =="
BAD='{"MAX_TICKS_PER_DAY":"2","GAFFER_DAILY_BUDGET_US'   # a truncated write
# 6a. A child re-source keeps the inherited caps and sets the marker; once the file
#     parses again the child derives from it afresh and the marker clears.
U="$WORK/u1"; mkdir -p "$U"
printf '{"MAX_TICKS_PER_DAY":"2","GAFFER_DAILY_BUDGET_USD":"3","GAFFER_BUDGET_USD":"20"}\n' > "$U/settings.json"
cat > "$WORK/capprobe.sh" <<'CAPSH'
#!/usr/bin/env bash
source "$CFG" >/dev/null 2>&1
printf '%s|%s|%s|%s\n' "${MAX_TICKS_PER_DAY:-}" "${GAFFER_DAILY_BUDGET_USD:-OFF}" "${GAFFER_BUDGET_USD:-OFF}" "${_GAFFER_SETTINGS_UNREADABLE:-0}"
CAPSH
# A PATH with no node on it (bash and the coreutils stay) — "node is missing".
NONODE=""; IFS=: read -ra _pd <<<"$PATH"
for d in "${_pd[@]}"; do [ -n "$d" ] && [ ! -x "$d/node" ] && NONODE="${NONODE:+$NONODE:}$d"; done
OUT6="$(env -i PATH="$PATH" HOME="$HOME" GAFFER_DATA="$U" CFG="$CFG" W="$WORK" BAD="$BAD" NONODE="$NONODE" bash -c '
  source "$CFG" >/dev/null 2>&1
  echo "P:$(bash "$W/capprobe.sh")"
  echo "N:$(PATH="$NONODE" bash "$W/capprobe.sh")"
  printf "%s" "$BAD" > "$GAFFER_DATA/settings.json"
  echo "B:$(bash "$W/capprobe.sh")"
  echo "G:$(bash -c "source \"\$CFG\" >/dev/null 2>&1; bash \"\$W/capprobe.sh\"")"
  printf "[1,2]" > "$GAFFER_DATA/settings.json"
  echo "A:$(bash "$W/capprobe.sh")"
  printf "{\"MAX_TICKS_PER_DAY\":\"4\"}" > "$GAFFER_DATA/settings.json"
  echo "F:$(bash "$W/capprobe.sh")"
')"
for k in P N B G A F; do eval "U_$k=\"\$(sed -n 's/^$k://p' <<<\"\$OUT6\")\""; done
[ "$U_P" = "2|3|20|0" ] && ok "parent applied the caps from settings.json" || fail "parent caps: $U_P"
[ "$U_B" = "2|3|20|1" ] && ok "malformed mid-run: the child keeps MAX_TICKS_PER_DAY=2, daily \$3, lifetime \$20 (not 50 / OFF) and sets the marker" \
  || fail "malformed settings.json lowered a ceiling in the child: $U_B (want 2|3|20|1)"
[ "$U_G" = "2|3|20|1" ] && ok "a grandchild under an unreadable file keeps them too" || fail "grandchild: $U_G"
[ "$U_A" = "2|3|20|1" ] && ok "valid JSON that is not an object ([1,2]) is unreadable too" || fail "non-object settings: $U_A"
[ "$U_N" = "2|3|20|1" ] && ok "no node to read settings.json: the caps are kept and the marker is set" || fail "node missing: $U_N"
[ "$U_F" = "4|OFF|OFF|0" ] && ok "once the file parses again the child derives afresh and the marker clears" || fail "after the fix: $U_F"

# 6b. The reviewer's loop case: MAX_TICKS_PER_DAY=2, MAX_TICKS=5, the file breaks after
#     tick 1. Before: the cap fell to 50 and all 5 ticks ran. Now the loop stops.
L="$WORK/l7"; S="$WORK/s7"; mkdir -p "$L" "$S"
printf '{"MAX_TICKS_PER_DAY":"2"}\n' > "$L/settings.json"; printf '%s' "$BAD" > "$S/1.json"
OUT6="$(run_loop "$L" "$S" MAX_TICKS=5)"
[ "$(ticks_run)" = 1 ] && ok "malformed settings.json mid-run stops a MAX_TICKS_PER_DAY=2 loop (1 tick; was 5)" \
  || fail "loop ran $(ticks_run) tick(s) after settings.json broke: $(tail -3 <<<"$OUT6")"
grep -q 'settings.json exists but cannot be parsed' <<<"$OUT6" && ok "the stop line names the unreadable settings.json" || fail "no settings.json stop line: $(tail -3 <<<"$OUT6")"

# 6c. The daily USD cap must not go OFF: cap \$3, \$1.50 per tick, MAX_TICKS=6, the file
#     breaks after tick 1. Before: the cap went OFF and \$9 was spent in 6 ticks.
L="$WORK/l8"; S="$WORK/s8"; mkdir -p "$L" "$S"
printf '{"GAFFER_DAILY_BUDGET_USD":"3"}\n' > "$L/settings.json"; printf '%s' "$BAD" > "$S/1.json"
OUT6="$(run_loop "$L" "$S" MAX_TICKS=6 STUB_COST=1.5)"
SPENT="$(awk -F'"total_cost_usd":' 'NF>1{split($2,a,"}"); s+=a[1]} END{printf "%.2f", s+0}' "$L/usage-ledger.jsonl" 2>/dev/null)"
[ "$(ticks_run)" = 1 ] && awk -v s="$SPENT" 'BEGIN{exit !(s <= 3)}' \
  && ok "with GAFFER_DAILY_BUDGET_USD=3 a malformed settings.json does not turn the cap OFF (1 tick, \$$SPENT spent; was \$9)" \
  || fail "daily cap went OFF: $(ticks_run) tick(s), \$$SPENT spent against \$3: $(tail -3 <<<"$OUT6")"

# 6d. Unreadable before the run starts: no tick at all (nothing to inherit but defaults).
L="$WORK/l9"; S="$WORK/s9"; mkdir -p "$L" "$S"
printf '%s' "$BAD" > "$L/settings.json"
OUT6="$(run_loop "$L" "$S" MAX_TICKS=3)"
[ "$(ticks_run)" = 0 ] && ok "a settings.json that is unreadable at start runs no tick" || fail "ran $(ticks_run) tick(s) on defaults: $(tail -3 <<<"$OUT6")"

# 6e. Pool path: each worker stops on the unreadable file.
L="$WORK/l10"; S="$WORK/s10"; mkdir -p "$L" "$S"
printf '{"MAX_TICKS_PER_DAY":"2"}\n' > "$L/settings.json"; printf '%s' "$BAD" > "$S/1.json"
OUT6="$(run_loop "$L" "$S" MAX_TICKS=8 GAFFER_CONCURRENCY=2)"
[ "$(ticks_run)" -le 2 ] && grep -q 'worker .*settings.json exists but cannot be parsed' <<<"$OUT6" \
  && ok "a running pool stops on the unreadable settings.json ($(ticks_run) tick(s), at most one per worker; was 8)" \
  || fail "pool ran $(ticks_run) tick(s) after settings.json broke: $(tail -5 <<<"$OUT6")"

# 6f. The daemon idles (no pass) while settings.json is unreadable.
D="$WORK/d3"; mkdir -p "$D"; printf '%s' "$BAD" > "$D/settings.json"
LOG="$WORK/passes3.log"; : > "$LOG"
printf '#!/usr/bin/env bash\necho pass >> "%s"\n' "$LOG" > "$WORK/loop3.sh"; chmod +x "$WORK/loop3.sh"
ERR="$(env -i PATH="$PATH" HOME="$HOME" GAFFER_DATA="$D" GAFFER_LOOP_SH="$WORK/loop3.sh" GAFFER_DAEMON_MAX_CYCLES=2 \
  timeout 90 bash "$RUNNER_DIR/gaffer" run --daemon --interval 0 2>&1 >/dev/null)"
[ "$(grep -c '^pass' "$LOG")" = 0 ] && grep -q 'settings.json .* cannot be read — idle' <<<"$ERR" \
  && ok "the daemon runs no pass while settings.json is unreadable, with a notice" \
  || fail "daemon ran $(grep -c '^pass' "$LOG") pass(es): $ERR"

echo; [ "${#FAILURES[@]}" -eq 0 ] && echo "settings-resource: ALL $PASS checks passed" || { echo "settings-resource: ${#FAILURES[@]} FAILURE(S)"; exit 1; }
