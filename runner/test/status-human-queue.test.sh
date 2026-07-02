#!/usr/bin/env bash
# =====================================================================
# gaffer status — "decisions awaiting you" surface (Track 2a).
# ---------------------------------------------------------------------
# Proves status.sh surfaces pending human-decisions WITH their reasons
# (why the agent needs a human) — not just a count. The human-queue
# source is stubbed via HUMAN_QUEUE_CMD so the pane runs hermetically.
# Run: bash test/status-human-queue.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
has()  { case "$1" in *"$2"*) return 0;; *) return 1;; esac; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/status-hq-test.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
LOG="$WORK/factory.log"
: > "$LOG"

mk_echo_script() {  # mk_echo_script <path> <line-to-print…>
  local path="$1"; shift
  { printf '#!/usr/bin/env bash\n'; printf 'printf "%%s\\n" %q\n' "$*"; } > "$path"
  chmod +x "$path"
}
mk_echo_script "$WORK/wg_doctor.sh" "Healthy."
mk_echo_script "$WORK/fg_doctor.sh" "Healthy."
mk_echo_script "$WORK/lg_doctor.sh" "Healthy."

# Stats stub — a clean board so nothing else competes with the queue surface.
cat > "$WORK/stats.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' '{"ticketsByStatus":{"in_review":0,"blocked":0,"ready":1}}'
EOF
chmod +x "$WORK/stats.sh"

# Human-queue stub — emits the JSON fixture given via $HQ_JSON_FIXTURE, exactly
# as the real `dispatch human-queue --json` would.
cat > "$WORK/human_queue.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${HQ_JSON_FIXTURE:-}"
EOF
chmod +x "$WORK/human_queue.sh"

run_status() {  # run_status <human-queue-json>
  HQ_JSON_FIXTURE="$1" \
  WG_DOCTOR_CMD="$WORK/wg_doctor.sh" \
  FG_DOCTOR_CMD="$WORK/fg_doctor.sh" \
  LG_DOCTOR_CMD="$WORK/lg_doctor.sh" \
  STATS_CMD="$WORK/stats.sh" \
  HUMAN_QUEUE_CMD="$WORK/human_queue.sh" \
  GAFFER_LOG="$LOG" \
  bash "$RUNNER_DIR/status.sh" 2>&1
}

DECISION_REASON="Postgres or SQLite for the ledger?"
QUEUE_JSON=$(cat <<EOF
{"items":[
  {"kind":"decision","label":"Decision","reason":"$DECISION_REASON",
   "ticket":{"id":"tk-1","number":12,"title":"Ledger","status":"draft"},
   "decisionId":"dec-1","severity":"human_required","since":"2026-06-01T00:00:00.000Z","waitedMs":3600000},
  {"kind":"review","label":"Review sign-off","reason":"please review",
   "ticket":{"id":"tk-2","number":7,"title":"Ship","status":"in_review"},
   "decisionId":null,"severity":null,"since":"2026-06-01T00:00:00.000Z","waitedMs":120000}
],"counts":{"total":2,"decisions":1,"reviews":1,"readyApprovals":0,"reviewerAssignments":0},
"generatedAt":"2026-06-01T01:00:00.000Z"}
EOF
)

# --- 1: pending decision reason IS surfaced (not just a count) -------
out="$(trap - EXIT; run_status "$QUEUE_JSON")"
has "$out" "decisions awaiting you" && ok "shows a 'decisions awaiting you' section" || fail "missing decisions section"
has "$out" "$DECISION_REASON" && ok "surfaces the decision reason (why the agent needs a human)" || fail "decision reason not shown"
has "$out" "#12" && ok "surfaces the decision's ticket ref" || fail "ticket ref not shown"

# --- 2: a clean queue prints no decisions section -------------------
out="$(trap - EXIT; run_status '{"items":[],"counts":{"total":0}}')"
has "$out" "decisions awaiting you" && fail "showed decisions section on an empty queue" || ok "no decisions section when queue is empty"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "  ALL PASS ($PASS checks)"; exit 0
else printf '  %d FAILURE(S), %d passed\n' "${#FAILURES[@]}" "$PASS"; exit 1; fi
