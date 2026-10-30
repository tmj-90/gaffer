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

echo; [ "${#FAILURES[@]}" -eq 0 ] && echo "settings-resource: ALL $PASS checks passed" || { echo "settings-resource: ${#FAILURES[@]} FAILURE(S)"; exit 1; }
