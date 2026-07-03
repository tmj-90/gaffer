#!/usr/bin/env bash
# =====================================================================
# gaffer status — single-pane roll-up + notification tests.
# ---------------------------------------------------------------------
# Runs status.sh hermetically: the three doctors, the stats source, the
# factory log and the notification channel are all stubbed via env so no
# real CLI, DB or network is touched. Proves:
#   1. It rolls up ALL THREE doctors (dispatch, crew, memory).
#   2. It shows recent ticks from factory.log.
#   3. A notification FIRES (channel invoked) when a ticket needs review.
#   4. A notification FIRES when a ticket is blocked.
#   5. NO notification when nothing needs a human.
#   6. Doctor health rolls up to warn / fail, not a blanket pass.
# Run: bash test/status.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
has()  { case "$1" in *"$2"*) return 0;; *) return 1;; esac; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/status-test.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
SINK="$WORK/notified.txt"
LOG="$WORK/factory.log"
printf '%s\n' \
  "2026-06-21T20:00:00 ready=3 → delivering #5 ('Add a stale-lore review digest') in /repo [stack=node]" \
  "2026-06-21T20:05:00 delivery tick for #5 finished (rc=0)" > "$LOG"

# The doctor/stats seams are spawned as discrete argv (no shell, no eval), so a
# stub that emits a multi-word line must be a real executable rather than a quoted
# `echo "a b"` string (which `read -ra` would split). Tiny scripts mirror the
# real `node …/cli doctor` shape and keep the seam contract honest.
mk_echo_script() {  # mk_echo_script <path> <line-to-print…>
  local path="$1"; shift
  { printf '#!/usr/bin/env bash\n'; printf 'printf "%%s\\n" %q\n' "$*"; } > "$path"
  chmod +x "$path"
}
mk_echo_script "$WORK/wg_doctor.sh" "Healthy."
mk_echo_script "$WORK/fg_doctor.sh" "Ready (with warnings)."
mk_echo_script "$WORK/lg_doctor.sh" "Ready."
mk_echo_script "$WORK/lg_doctor_bad.sh" "UNHEALTHY: db missing"
# Stats stub: prints the JSON it is given via $STATS_JSON_FIXTURE (no shell quoting).
cat > "$WORK/stats.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${STATS_JSON_FIXTURE:-}"
EOF
chmod +x "$WORK/stats.sh"

# Stubbed seams shared by every case. Each doctor stub echoes a summary line; the
# stats stub emits the per-case JSON from $STATS_JSON_FIXTURE.
run_status() {
  STATS_JSON_FIXTURE="$1" \
  WG_DOCTOR_CMD="$WORK/wg_doctor.sh" \
  FG_DOCTOR_CMD="$WORK/fg_doctor.sh" \
  LG_DOCTOR_CMD="$WORK/lg_doctor.sh" \
  STATS_CMD="$WORK/stats.sh" \
  GAFFER_LOG="$LOG" \
  GAFFER_NOTIFY_CMD="cat >> $SINK" \
  bash "$RUNNER_DIR/status.sh" 2>&1
}

# --- 1 + 2: roll-up of three doctors and recent ticks ---------------
out="$(trap - EXIT; run_status '{"ticketsByStatus":{"in_review":2,"blocked":0,"ready":3}}')"
for d in dispatch crew memory; do
  has "$out" "$d" && ok "rolls up doctor: $d" || fail "missing doctor in roll-up: $d"
done
has "$out" "delivery tick for #5" && ok "shows a recent tick from factory.log" || fail "recent tick not shown"

# --- 3: notification fires when a ticket needs review ---------------
: > "$SINK"
out="$(trap - EXIT; run_status '{"ticketsByStatus":{"in_review":2,"blocked":0,"ready":3}}')"
[ -s "$SINK" ] && ok "notification channel invoked on needs-review" || fail "channel NOT invoked on needs-review"
has "$out" "notified via" && ok "pane reports the alert was sent" || fail "pane did not report the alert"
has "$(cat "$SINK")" "awaiting review" && ok "alert message names the reason" || fail "alert message missing reason"

# --- 4: notification fires when a ticket is blocked -----------------
: > "$SINK"
run_status '{"ticketsByStatus":{"in_review":0,"blocked":1,"ready":3}}' >/dev/null
[ -s "$SINK" ] && ok "notification channel invoked on blocked" || fail "channel NOT invoked on blocked"
has "$(cat "$SINK")" "blocked" && ok "alert message names blocked reason" || fail "alert missing blocked reason"

# --- 5: no notification when nothing needs a human ------------------
: > "$SINK"
out="$(trap - EXIT; run_status '{"ticketsByStatus":{"in_review":0,"blocked":0,"ready":3}}')"
[ -s "$SINK" ] && fail "channel invoked when nothing needs a human" || ok "no notification when queue is clear"
has "$out" "nothing needs a human" && ok "pane confirms nothing needs a human" || fail "missing clear-queue line"

# --- 5b: UNIFIED sink — GAFFER_NOTIFY_* routes through the dispatch emit seam --
# Proves the config unification: setting a MAIN dispatch notify var
# (GAFFER_NOTIFY_WEBHOOK_URL) — not the legacy GAFFER_NOTIFY_CMD/SLACK_WEBHOOK —
# makes status alerts fire through the SAME `notify emit` sink the runner's
# ticket/decision pings use. No separate-config trap.
EMIT_SINK="$WORK/emit.txt"; : > "$EMIT_SINK"
cat > "$WORK/notify_emit.sh" <<'EOF'
#!/usr/bin/env bash
{ for a in "$@"; do printf '%s\n' "$a"; done; } >> "${EMIT_SINK:?}"
EOF
chmod +x "$WORK/notify_emit.sh"
out="$(trap - EXIT; \
  STATS_JSON_FIXTURE='{"ticketsByStatus":{"in_review":2,"blocked":0,"ready":1}}' \
  WG_DOCTOR_CMD="$WORK/wg_doctor.sh" FG_DOCTOR_CMD="$WORK/fg_doctor.sh" \
  LG_DOCTOR_CMD="$WORK/lg_doctor.sh" STATS_CMD="$WORK/stats.sh" GAFFER_LOG="$LOG" \
  GAFFER_NOTIFY_WEBHOOK_URL="https://hooks.example.test/hook" \
  EMIT_SINK="$EMIT_SINK" NOTIFY_EMIT_CMD="$WORK/notify_emit.sh" \
  bash "$RUNNER_DIR/status.sh" 2>&1)"
[ -s "$EMIT_SINK" ] && ok "unified GAFFER_NOTIFY_* routes through the dispatch emit sink" || fail "unified sink not invoked"
has "$(cat "$EMIT_SINK")" "review_needed" && ok "unified emit carries the gate kind" || fail "unified emit missing kind"
has "$out" "GAFFER_NOTIFY_* sink" && ok "pane reports the unified sink was used" || fail "pane did not name the unified sink"

# --- 6: doctor health rolls up to warn / fail ----------------------
out="$(trap - EXIT; STATS_JSON_FIXTURE='{"ticketsByStatus":{}}' \
       WG_DOCTOR_CMD="$WORK/wg_doctor.sh" FG_DOCTOR_CMD="$WORK/fg_doctor.sh" \
       LG_DOCTOR_CMD="$WORK/lg_doctor_bad.sh" \
       STATS_CMD="$WORK/stats.sh" GAFFER_LOG="$LOG" \
       bash "$RUNNER_DIR/status.sh" 2>&1)"
has "$out" "✗" && ok "an unhealthy doctor rolls up as fail" || fail "unhealthy doctor not flagged"
has "$out" "!" && ok "a warning doctor rolls up as warn" || fail "warning doctor not flagged"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "  ALL PASS ($PASS checks)"; exit 0
else printf '  %d FAILURE(S), %d passed\n' "${#FAILURES[@]}" "$PASS"; exit 1; fi
