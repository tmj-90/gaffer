#!/usr/bin/env bash
# =====================================================================
# gaffer status — "decisions awaiting you" surface (Track 2a).
# ---------------------------------------------------------------------
# Proves status.sh surfaces pending human-decisions WITH their reasons
# (why the agent needs a human) — not just a count. The human-queue
# source is stubbed via HUMAN_QUEUE_CMD so the pane runs hermetically.
# Run: bash test/status-human-queue.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
has()  { case "$1" in *"$2"*) return 0;; *) return 1;; esac; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/status-hq-test.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
trap 'gaffer_test_rm_work "$WORK"' EXIT
# Private operator state: status.sh sources factory.config.sh, which would otherwise
# read the checkout's .gaffer (settings.json APPLIED, dispatch.sqlite opened
# read-write) when this runs directly — see lib/isolate.sh.
# shellcheck source=lib/isolate.sh
. "$HERE/lib/isolate.sh"; gaffer_test_isolate "$WORK"
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

# --- 3: a ~2 KB intake question with no ticket: one short line, the decision id shown --
LONG="Onboarding intake for 'notes'. Please answer: $(for i in $(seq 1 40); do printf '%s. [topic-%s] What is the intended behaviour here, and who owns it? ' "$i" "$i"; done)"
DEC_ID="3f9a1c2e-7b4d-4e8a-9c1f-0a2b3c4d5e6f"
mkq() {  # mkq <severity> <reason> [n] — n pending decisions with no ticket
  local sev="$1" reason="$2" n="${3:-1}" i items=""
  for i in $(seq 1 "$n"); do
    items="${items:+$items,}{\"kind\":\"decision\",\"label\":\"Decision\",\"reason\":\"$reason\",\"ticket\":null,\"decisionId\":\"${DEC_ID%?}$i\",\"severity\":\"$sev\",\"since\":\"2026-06-01T00:00:00.000Z\",\"waitedMs\":1}"
  done
  printf '{"items":[%s],"counts":{"total":%s}}' "$items" "$n"
}
out="$(trap - EXIT; run_status "$(mkq human_required "$LONG")")"
# Characters, not bytes (the line ends in a multi-byte "…").
longest="$(printf '%s\n' "$out" | grep -F "${DEC_ID:0:8}" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(Math.max(0,...d.split("\n").map(l=>[...l].length))))')"
[ "$longest" -gt 0 ] && [ "$longest" -le 120 ] && ok "a 2 KB reason renders as one line of at most 120 chars ($longest)" || fail "decision line is $longest chars"
has "$out" "${DEC_ID:0:8}" && ok "the decision id (short) is the ref when there is no ticket" || fail "decision id not shown: $out"
has "$out" "[required]" && ok "severity shown" || fail "severity not shown"
has "$out" "nothing needs a human" && fail "said 'nothing needs a human' over a human_required decision" || ok "no 'nothing needs a human' while a human_required decision is open"
has "$out" "1 decision(s) a human must answer" && ok "a human_required decision counts toward attention (notify)" || fail "required decision not counted: $(printf '%s' "$out" | tail -2)"

# --- 4: a human_preferred decision: not blocking, but the all-clear names it ---------
out="$(trap - EXIT; run_status "$(mkq human_preferred "Which colour?")")"
has "$out" "nothing blocking — 1 decision(s) open" && ok "human_preferred → 'nothing blocking — 1 decision(s) open'" || fail "preferred: $(printf '%s' "$out" | tail -2)"
has "$out" "a human is needed" && fail "human_preferred fired the attention notify" || ok "human_preferred does not notify"
has "$out" "decisions resolve" && ok "the all-clear line names the CLI to answer it" || fail "no resolve hint"

# --- 5: many decisions: capped, with a '+N more' line ---------------------------------
out="$(trap - EXIT; run_status "$(mkq human_preferred "q" 8)")"
[ "$(printf '%s\n' "$out" | grep -c '\[preferred\]')" = "5" ] && ok "at most 5 decisions listed" || fail "listed $(printf '%s\n' "$out" | grep -c '\[preferred\]')"
has "$out" "+3 more" && ok "'+3 more' line for the rest" || fail "no '+N more' line"

# --- 6: a doctor warning names its first warn check -------------------------------------
cat > "$WORK/fg_doctor_warn.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "Crew doctor" "  ✓ Config found" "  ! Repos configured — no repositories in crew.yaml" "  ! Active agents — 0 configured" "Ready (with warnings)."
EOF
chmod +x "$WORK/fg_doctor_warn.sh"
out="$(trap - EXIT; HQ_JSON_FIXTURE='{"items":[]}' WG_DOCTOR_CMD="$WORK/wg_doctor.sh" FG_DOCTOR_CMD="$WORK/fg_doctor_warn.sh" \
  LG_DOCTOR_CMD="$WORK/lg_doctor.sh" STATS_CMD="$WORK/stats.sh" HUMAN_QUEUE_CMD="$WORK/human_queue.sh" GAFFER_LOG="$LOG" \
  bash "$RUNNER_DIR/status.sh" 2>&1)"
has "$out" "Ready (with warnings): Repos configured — no repositories in crew.yaml" \
  && ok "the doctor roll-up names its first warning" || fail "doctor line: $(printf '%s\n' "$out" | grep crew)"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "  ALL PASS ($PASS checks)"; exit 0
else printf '  %d FAILURE(S), %d passed\n' "${#FAILURES[@]}" "$PASS"; exit 1; fi
