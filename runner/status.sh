#!/usr/bin/env bash
# Gaffer factory — single-pane status. Rolls up all three doctors (dispatch,
# crew, memory), the factory's needs-review / blocked counts, and the
# most recent ticks from factory.log into one screen. Non-mutating.
#
# When a ticket needs review or is blocked, it fires a notification through EVERY
# configured channel. UNIFIED with the factory's notify sink: the primary channel
# is the SAME dispatch notify sink the runner's ticket/decision pings use, driven by
# the shared GAFFER_NOTIFY_* env vars — so configuring the dispatch notifier ALSO
# covers these status alerts (no separate-config trap where you wire one and think
# you're covered for both):
#   GAFFER_NOTIFY_WEBHOOK_URL  POST every gate as JSON            (shared sink)
#   GAFFER_NOTIFY_SLACK_URL    Slack incoming-webhook (text)      (shared sink)
#   GAFFER_NOTIFY_DESKTOP=1    native desktop banner              (shared sink)
# Two legacy channels are still honoured ADDITIVELY for back-compat:
#   GAFFER_SLACK_WEBHOOK   Slack incoming-webhook URL  (POSTed a {"text":…})
#   GAFFER_NOTIFY_CMD      any shell command fed the message on stdin (e.g. email:
#                           export GAFFER_NOTIFY_CMD='mail -s gaffer you@example.com')
# With none set the alert still shows in the pane — it just isn't sent out.
#
# The doctor / stats commands are env-overridable (WG_DOCTOR_CMD, FG_DOCTOR_CMD,
# LG_DOCTOR_CMD, STATS_CMD) so this view stays testable without the real CLIs.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=factory.config.sh
source "$HERE/factory.config.sh"

c_grn='\033[1;32m'; c_cya='\033[1;36m'; c_yel='\033[1;33m'; c_red='\033[1;31m'; c_dim='\033[2m'; c_off='\033[0m'
say()  { printf "${c_cya}gaffer${c_off} %s\n" "$*"; }
ok()   { printf "  ${c_grn}✓${c_off} %s\n" "$*"; }
warn() { printf "  ${c_yel}!${c_off} %s\n" "$*"; }
bad()  { printf "  ${c_red}✗${c_off} %s\n" "$*"; }

# Did the caller wire its own doctor seams (the tests do)? Captured BEFORE the
# `:=` defaults below fill them in, so the "dist not built" hint only fires on a
# real run against the bundled CLIs — never when a test stubs the doctors.
_REAL_DOCTORS=0; [ -z "${WG_DOCTOR_CMD:-}" ] && _REAL_DOCTORS=1

# Defaults wire the real CLIs; tests override these to run hermetically.
: "${WG_DOCTOR_CMD:=node $DISPATCH_DIR/dist/cli/index.js --db $DISPATCH_DB doctor}"
: "${FG_DOCTOR_CMD:=env CREW_DISPATCH_DB=$DISPATCH_DB node $CREW_DIR/dist/cli/index.js -c $CREW_CONFIG doctor}"
: "${LG_DOCTOR_CMD:=env MEMORY_DB=$MEMORY_DB node $MEMORY_CLI_BIN doctor}"
: "${STATS_CMD:=node $DISPATCH_DIR/dist/cli/index.js --db $DISPATCH_DB stats --json}"
: "${STATUS_TICKS:=6}"

# Run one doctor, render a one-line PASS/WARN/FAIL roll-up from its output.
# Doctors exit 0 even with warnings, so level keys off rc + the shared phrasing.
# A warning names its FIRST warn check ("Ready (with warnings): <check>"): the bare last
# line said only "with warnings", with no hint which check or how to fix it.
roll_doctor() {
  local name="$1" cmd="$2" out rc summary first
  # No eval: the doctor command is read into an argv array and invoked directly,
  # so nothing in it is re-interpreted as shell (mirrors run-summary.sh).
  local -a dc; read -ra dc <<<"$cmd"
  out="$("${dc[@]}" 2>&1)"; rc=$?
  summary="$(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | tail -1)"
  if [ "$rc" -ne 0 ] || grep -qiE 'unhealthy|✗|\[fail\]|failed' <<<"$out"; then
    bad "$(printf '%-11s %s' "$name" "${summary:-failed (rc=$rc)}")"
  elif grep -qiE 'with warnings|⚠|\[ ! \]|^!' <<<"$out"; then
    first="$(printf '%s\n' "$out" | grep -E '^[[:space:]]*(!|⚠|\[ ! \])' | head -1 \
      | sed -E 's/^[[:space:]]*(!|⚠|\[ ! \])[[:space:]]*//' | cut -c1-100)"
    [ -n "$first" ] && [ "$first" != "$summary" ] && summary="${summary%.}: $first"
    warn "$(printf '%-11s %s' "$name" "$summary")"
  else
    ok "$(printf '%-11s %s' "$name" "$summary")"
  fi
}

# Pull the two human-attention counts (+ a little context) from stats JSON.
read_count() { printf '%s' "$STATS_JSON" | node "$HERE/lib/json-tool.mjs" status-count "$1" 2>/dev/null || echo 0; }

# Send the alert through EVERY configured channel; always report what happened.
# UNIFIED primary path = the same dispatch notify sink the runner's ticket/decision
# pings use (buildNotifierFromEnv over GAFFER_NOTIFY_WEBHOOK_URL / _SLACK_URL /
# _DESKTOP), so one config covers both. Legacy GAFFER_SLACK_WEBHOOK + GAFFER_NOTIFY_CMD
# stay honoured additively (zero regression). Env-overridable emit seam keeps tests
# hermetic. Every channel is best-effort — a send failure never changes the pane.
notify() {
  local msg="$1" sent=""
  # 1) UNIFIED dispatch notify sink (shared GAFFER_NOTIFY_* vars). Only shell out to
  #    the CLI when at least one shared sink is configured; the emit is a no-op
  #    ("enabled:false") otherwise. argv-array invocation (no eval), mirrors the
  #    doctor/stats seams above.
  : "${NOTIFY_EMIT_CMD:=node $DISPATCH_DIR/dist/cli/index.js --db $DISPATCH_DB notify emit}"
  if [ -n "${GAFFER_NOTIFY_WEBHOOK_URL:-}${GAFFER_NOTIFY_SLACK_URL:-}${GAFFER_NOTIFY_DESKTOP:-}" ]; then
    local -a _ne; read -ra _ne <<<"$NOTIFY_EMIT_CMD"
    if "${_ne[@]}" --kind review_needed --detail "$msg" \
        ${GAFFER_DASHBOARD_URL:+--url "$GAFFER_DASHBOARD_URL"} >/dev/null 2>&1; then
      sent="GAFFER_NOTIFY_* sink"
    fi
  fi
  # 2) Legacy Slack incoming-webhook (back-compat).
  if [ -n "${GAFFER_SLACK_WEBHOOK:-}" ]; then
    curl -fsS -X POST -H 'Content-type: application/json' \
      --data "$(printf '{"text":"%s"}' "$msg")" "$GAFFER_SLACK_WEBHOOK" >/dev/null 2>&1 \
      && sent="${sent:+$sent + }GAFFER_SLACK_WEBHOOK"
  fi
  # 3) Legacy local shell command (e.g. email).
  if [ -n "${GAFFER_NOTIFY_CMD:-}" ]; then
    printf '%s\n' "$msg" | sh -c "$GAFFER_NOTIFY_CMD" >/dev/null 2>&1 && sent="${sent:+$sent + }GAFFER_NOTIFY_CMD"
  fi
  if [ -n "$sent" ]; then warn "$msg — notified via $sent"
  else warn "$msg — set GAFFER_NOTIFY_WEBHOOK_URL / GAFFER_NOTIFY_SLACK_URL / GAFFER_NOTIFY_DESKTOP (or legacy GAFFER_NOTIFY_CMD) to be alerted"; fi
}

say "factory status"

# DB-path footgun: onboards land in the wrong place if these disagree.
fg_sqlite="$(grep -E '^[[:space:]]*sqlite_path:' "$CREW_CONFIG" 2>/dev/null | head -1 | sed 's/.*sqlite_path:[[:space:]]*//')"
printf "  %-20s %s\n" "Factory DB:" "$DISPATCH_DB"
printf "  %-20s %s\n" "Crew config:" "$CREW_CONFIG"
if [ "$fg_sqlite" = "$DISPATCH_DB" ]; then printf "  %-20s ${c_grn}same db ✓${c_off}\n" "  → reads:"
else printf "  %-20s ${c_yel}%s  (MISMATCH — onboards land elsewhere!)${c_off}\n" "  → reads:" "${fg_sqlite:-?}"; fi

# Pre-build short-circuit: if the products were never built, the bundled doctor
# CLIs (dist/cli/index.js, MEMORY_CLI_BIN) don't exist and each roll_doctor would
# spew a raw "Cannot find module …" Node error. Detect the missing dist and print
# one clear line instead. Only on a real run (not when a test stubs the doctors).
if [ "$_REAL_DOCTORS" = 1 ] && { [ ! -f "$DISPATCH_DIR/dist/cli/index.js" ] \
  || [ ! -f "$CREW_DIR/dist/cli/index.js" ] || [ ! -f "${MEMORY_CLI_BIN:-/nonexistent}" ]; }; then
  printf "\n  ${c_dim}doctors${c_off}\n"
  bad "not built — run \`bash $HERE/setup.sh\` (or \`pnpm -r build\`) first"
  echo
  exit 0
fi

printf "\n  ${c_dim}doctors${c_off}\n"
roll_doctor dispatch  "$WG_DOCTOR_CMD"
roll_doctor crew "$FG_DOCTOR_CMD"
roll_doctor memory  "$LG_DOCTOR_CMD"

# No eval: argv-array invocation (mirrors run-summary.sh / roll_doctor above).
read -ra _stats_c <<<"$STATS_CMD"; STATS_JSON="$("${_stats_c[@]}" 2>/dev/null)"
review="$(read_count in_review)"; blocked="$(read_count blocked)"; ready="$(read_count ready)"
# Approved but not merged (a conflict a human must resolve, a held merge gate): a
# human's, and its dependents wait behind it — count it toward attention.
merge="$(read_count ready_for_merge)"; [ "$merge" -eq "$merge" ] 2>/dev/null || merge=0
# ACCEPTANCE GATE: an epic whose implementation has all merged but whose acceptance
# ticket has not passed the independent tester is NOT done — "implementation merged"
# is not "build accepted". Count it toward attention so the pane never says all clear
# over an unaccepted build.
unaccepted="$(read_count acceptance_unaccepted)"; [ "$unaccepted" -eq "$unaccepted" ] 2>/dev/null || unaccepted=0
# PAUSED: a delivery that hit a turn/budget/time cap is held with its worktree for a
# human's Continue or Stop — the factory never resumes it on its own. Count it toward
# attention, minus the ones a human already pressed Continue on (the next tick takes
# those). Env-overridable seam (RESUME_REQ_CMD); if the resume queue cannot be read,
# every paused ticket counts as waiting (over-report, never a false all-clear).
paused="$(read_count paused)"; [ "$paused" -eq "$paused" ] 2>/dev/null || paused=0
resume_req=0
if [ "$paused" -gt 0 ]; then
  : "${RESUME_REQ_CMD:=node $DISPATCH_DIR/dist/cli/index.js --db $DISPATCH_DB ticket resume-requested}"
  read -ra _rr_c <<<"$RESUME_REQ_CMD"
  resume_req="$("${_rr_c[@]}" 2>/dev/null | node "$HERE/lib/json-tool.mjs" expr 'Array.isArray(d) ? d.length : 0' 2>/dev/null)"
  [ "$resume_req" -eq "$resume_req" ] 2>/dev/null || resume_req=0
  [ "$resume_req" -gt "$paused" ] && resume_req="$paused"
fi
paused_waiting=$(( paused - resume_req ))
# What's REGISTERED: the repos the factory can deliver into (name → path → default
# branch → stack → DoD gates). `gaffer help` promises "what's registered + what's
# running"; a fresh operator needs the repo NAME here for `wg ticket repo-access set`.
# Env-overridable seam (REPOS_CMD) so the pane stays testable without the real CLI;
# degrades to a hint when nothing is registered or the source is unavailable.
: "${REPOS_CMD:=node $DISPATCH_DIR/dist/cli/index.js --db $DISPATCH_DB repo list}"
read -ra _repos_c <<<"$REPOS_CMD"; REPOS_JSON="$("${_repos_c[@]}" 2>/dev/null)"
repo_lines="$(printf '%s' "$REPOS_JSON" | node "$HERE/lib/json-tool.mjs" status-repo-lines 2>/dev/null)"
printf "\n  ${c_dim}repos (registered)${c_off}\n"
if [ -n "$repo_lines" ]; then printf '%s\n' "$repo_lines"
else printf "    ${c_dim}(none — \`gaffer onboard <path>\` registers one)${c_off}\n"; fi

printf "\n  ${c_dim}work${c_off}\n"
# USAGE WINDOW (lib/usage-pause.mjs): a model call was refused by the plan's usage
# window / a rate limit, and the factory admits no work until the pause ends. Shown
# first, because it is why nothing moves. It lifts on its own; not a human's job.
# (Through lib/usage-pause.sh, which hands node this config's GAFFER_DATA explicitly.)
if declare -F gaffer_usage_pause_active >/dev/null 2>&1 && _usage_line="$(gaffer_usage_pause_active)"; then
  warn "$_usage_line  (no new work starts until then; it lifts on its own — early: node $HERE/lib/usage-pause.mjs clear)"
fi
printf "    needs review: %s    blocked: %s    ready: %s    paused: %s\n" "$review" "$blocked" "$ready" "$paused"
[ "$paused_waiting" -gt 0 ] && printf "    ${c_yel}paused, waiting on you: %s${c_off}  (hit a cap with its work kept — Continue or Stop it on the board, or: gaffer wg ticket continue <n>)\n" "$paused_waiting"
[ "$resume_req" -gt 0 ] && printf "    ${c_dim}paused, Continue pressed: %s (the next tick resumes it)${c_off}\n" "$resume_req"
[ "$unaccepted" -gt 0 ] && printf "    ${c_yel}builds NOT accepted: %s${c_off}  (implementation merged; the acceptance ticket has no tester PASS, or the tester's assertions were not replayed on the revision that landed — run the loop with the tester, or record a human verdict: wg ticket tester-pass <n> --as human)\n" "$unaccepted"
# TESTER REPLAY OFF: no landing replays the tester's tests or records it, so no epic can
# count as accepted while it is off — say so rather than leave the count to explain itself.
case "${GAFFER_TESTER_REPLAY:-1}" in
  1|[Tt][Rr][Uu][Ee]|[Yy][Ee][Ss]|[Oo][Nn]) ;;
  *) printf "    ${c_yel}tester replay OFF: GAFFER_TESTER_REPLAY is %s${c_off}  (landings do not run the independent tester's tests on what lands and record nothing: no epic counts as accepted while it is off)\n" "$GAFFER_TESTER_REPLAY" ;;
esac
# Per-epic acceptance: result, the commit the tester's PASS ran against, and — from the
# runner's TESTER REPLAY record, not from timestamps — which tester assertions passed on
# which LANDED revision. An epic is accepted only on that record (`wg stats`); a build whose
# tester assertions never ran on what landed says so.
acc_rows="$(printf '%s' "$STATS_JSON" | node "$HERE/lib/json-tool.mjs" status-acceptance-rows 2>/dev/null)"
if [ -n "$acc_rows" ]; then
  printf "\n  ${c_dim}builds (acceptance)${c_off}\n"
  # Empty fields arrive as `-` (json-tool): TAB is IFS whitespace, `read` would collapse them.
  while IFS=$'\t' read -r a_name a_result a_ticket a_commit a_replayed a_files _; do
    [ -n "$a_name" ] || continue
    [ "$a_commit" = "-" ] && a_commit=""; [ "$a_replayed" = "-" ] && a_replayed=""; [ "$a_files" = "-" ] && a_files=""
    a_note=""
    if [ -n "$a_replayed" ] && [ -z "$a_files" ]; then
      a_note="  ${c_yel}(landed ${a_replayed:0:12} with NO tester test file replayed — not accepted; re-test so the tester saves its tests)${c_off}"
    elif [ -n "$a_replayed" ]; then
      a_note="  ${c_dim}(tester assertions passed on the landed revision ${a_replayed:0:12}${a_files:+: $a_files})${c_off}"
    elif [ "$a_result" = "unreplayed" ]; then
      a_note="  ${c_yel}(no record that the tester's assertions passed on the revision that landed — not accepted)${c_off}"
    fi
    printf "    %s: %s (acceptance #%s%s)%b\n" "$a_name" "$a_result" "$a_ticket" "${a_commit:+ @ ${a_commit:0:12}}" "$a_note"
  done <<<"$acc_rows"
fi

# What the HUMAN owns: pending decisions the agent delegated, WITH their reasons
# (why the agent needs a human) — not just a count. Env-overridable seam
# (HUMAN_QUEUE_CMD) so this stays testable without the real CLI/DB; it degrades
# to nothing when the queue is empty or the source is unavailable.
: "${HUMAN_QUEUE_CMD:=node $DISPATCH_DIR/dist/cli/index.js --db $DISPATCH_DB human-queue --json}"
read -ra _hq_c <<<"$HUMAN_QUEUE_CMD"; HUMAN_QUEUE_JSON="$("${_hq_c[@]}" 2>/dev/null)"
hq_lines="$(printf '%s' "$HUMAN_QUEUE_JSON" | node "$HERE/lib/json-tool.mjs" status-hq-lines 2>/dev/null)"
if [ -n "$hq_lines" ]; then
  printf "\n  ${c_dim}decisions awaiting you${c_off}\n"
  printf '%s\n' "$hq_lines"
fi

printf "\n  ${c_dim}recent ticks${c_off}\n"
ticks="$(grep -hE 'delivering #|delivery tick for #' "$GAFFER_LOG" 2>/dev/null | tail -n "$STATUS_TICKS")"
if [ -n "$ticks" ]; then printf '%s\n' "$ticks" | sed 's/^/    /'
else printf "    ${c_dim}(none yet — %s)${c_off}\n" "$GAFFER_LOG"; fi

echo
# Precise running-detection: validated recorded PID, not a broad `pgrep -f`. A
# foreground server (`gaffer dashboard --foreground`: compose, systemd, any
# supervisor) writes no PID file — the supervisor owns it — so fall back to probing
# the port's /healthz. That proves something answers there, not that it is THIS
# factory's server, and the line says so.
_dash_url="http://127.0.0.1:${DISPATCH_API_PORT:-8787}"
if _dash_pid="$(gaffer_dashboard_pid 2>/dev/null)"; then
  ok "dashboard running → $_dash_url (pid $_dash_pid)"
elif command -v curl >/dev/null 2>&1 && curl -fsS --max-time 2 "${DASHBOARD_PROBE_URL:-$_dash_url/healthz}" >/dev/null 2>&1; then
  ok "dashboard answering → $_dash_url (no pid file: a foreground/supervised server)"
else
  warn "dashboard not running (\`gaffer dashboard\`)"
fi

# Pending decisions, from the human-queue already fetched. A human_required one blocks
# its ticket (the transition guard hasUnresolvedHumanRequired), so it counts toward
# attention; a lesser one is still owed an answer, so the all-clear line names it
# instead of saying "nothing needs a human" under a list of open decisions.
dec_all="$(printf '%s' "$HUMAN_QUEUE_JSON" | node "$HERE/lib/json-tool.mjs" status-hq-count all 2>/dev/null)"
dec_req="$(printf '%s' "$HUMAN_QUEUE_JSON" | node "$HERE/lib/json-tool.mjs" status-hq-count required 2>/dev/null)"
[ "$dec_all" -eq "$dec_all" ] 2>/dev/null || dec_all=0
[ "$dec_req" -eq "$dec_req" ] 2>/dev/null || dec_req=0

# A ticket needing review, blocked, or approved-but-unmerged — or a blocking decision —
# means a human is wanted → notify.
attention=$(( review + blocked + merge + unaccepted + dec_req + paused_waiting ))
if [ "$attention" -gt 0 ]; then
  reasons=""; [ "$review" -gt 0 ] && reasons="$review awaiting review"
  [ "$blocked" -gt 0 ] && reasons="${reasons:+$reasons, }$blocked blocked"
  [ "$merge" -gt 0 ] && reasons="${reasons:+$reasons, }$merge approved but not merged"
  [ "$unaccepted" -gt 0 ] && reasons="${reasons:+$reasons, }$unaccepted build(s) not accepted"
  [ "$dec_req" -gt 0 ] && reasons="${reasons:+$reasons, }$dec_req decision(s) a human must answer"
  [ "$paused_waiting" -gt 0 ] && reasons="${reasons:+$reasons, }$paused_waiting paused (Continue or Stop)"
  notify "gaffer: $reasons — a human is needed"
elif [ "$dec_all" -gt 0 ]; then
  ok "nothing blocking — $dec_all decision(s) open (answer: gaffer wg decisions resolve <id> --answer \"…\")"
else
  ok "nothing needs a human right now"
fi
