#!/usr/bin/env bash
# Gaffer factory — single-pane status. Rolls up all three doctors (dispatch,
# crew, memory), the factory's needs-review / blocked counts, and the
# most recent ticks from factory.log into one screen. Non-mutating.
#
# When a ticket needs review or is blocked, it fires a notification through the
# first configured channel:
#   GAFFER_SLACK_WEBHOOK   Slack incoming-webhook URL  (POSTed a {"text":…})
#   GAFFER_NOTIFY_CMD      any shell command fed the message on stdin (e.g. email:
#                           export GAFFER_NOTIFY_CMD='mail -s gaffer you@example.com')
# With neither set the alert still shows in the pane — it just isn't sent out.
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
: "${FG_DOCTOR_CMD:=node $CREW_DIR/dist/cli/index.js -c $CREW_CONFIG doctor}"
: "${LG_DOCTOR_CMD:=env MEMORY_DB=$MEMORY_DB node $MEMORY_CLI_BIN doctor}"
: "${STATS_CMD:=node $DISPATCH_DIR/dist/cli/index.js --db $DISPATCH_DB stats --json}"
: "${STATUS_TICKS:=6}"

# Run one doctor, render a one-line PASS/WARN/FAIL roll-up from its output.
# Doctors exit 0 even with warnings, so level keys off rc + the shared phrasing.
roll_doctor() {
  local name="$1" cmd="$2" out rc summary
  # No eval: the doctor command is read into an argv array and invoked directly,
  # so nothing in it is re-interpreted as shell (mirrors run-summary.sh).
  local -a dc; read -ra dc <<<"$cmd"
  out="$("${dc[@]}" 2>&1)"; rc=$?
  summary="$(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | tail -1)"
  if [ "$rc" -ne 0 ] || printf '%s' "$out" | grep -qiE 'unhealthy|✗|\[fail\]|failed'; then
    bad "$(printf '%-11s %s' "$name" "${summary:-failed (rc=$rc)}")"
  elif printf '%s' "$out" | grep -qiE 'with warnings|⚠|\[ ! \]|^!'; then
    warn "$(printf '%-11s %s' "$name" "$summary")"
  else
    ok "$(printf '%-11s %s' "$name" "$summary")"
  fi
}

# Pull the two human-attention counts (+ a little context) from stats JSON.
read_count() { printf '%s' "$STATS_JSON" | python3 -c "import sys,json;print((json.load(sys.stdin).get('ticketsByStatus',{}) or {}).get('$1',0))" 2>/dev/null || echo 0; }

# Send the alert through the first configured channel; always report what happened.
notify() {
  local msg="$1" sent=""
  if [ -n "${GAFFER_SLACK_WEBHOOK:-}" ]; then
    curl -fsS -X POST -H 'Content-type: application/json' \
      --data "$(printf '{"text":"%s"}' "$msg")" "$GAFFER_SLACK_WEBHOOK" >/dev/null 2>&1 && sent="Slack"
  fi
  if [ -n "${GAFFER_NOTIFY_CMD:-}" ]; then
    printf '%s\n' "$msg" | sh -c "$GAFFER_NOTIFY_CMD" >/dev/null 2>&1 && sent="${sent:+$sent + }GAFFER_NOTIFY_CMD"
  fi
  if [ -n "$sent" ]; then warn "$msg — notified via $sent"
  else warn "$msg — set GAFFER_SLACK_WEBHOOK or GAFFER_NOTIFY_CMD to be alerted"; fi
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
printf "\n  ${c_dim}work${c_off}\n"
printf "    needs review: %s    blocked: %s    ready: %s\n" "$review" "$blocked" "$ready"

# What the HUMAN owns: pending decisions the agent delegated, WITH their reasons
# (why the agent needs a human) — not just a count. Env-overridable seam
# (HUMAN_QUEUE_CMD) so this stays testable without the real CLI/DB; it degrades
# to nothing when the queue is empty or the source is unavailable.
: "${HUMAN_QUEUE_CMD:=node $DISPATCH_DIR/dist/cli/index.js --db $DISPATCH_DB human-queue --json}"
read -ra _hq_c <<<"$HUMAN_QUEUE_CMD"; HUMAN_QUEUE_JSON="$("${_hq_c[@]}" 2>/dev/null)"
hq_lines="$(printf '%s' "$HUMAN_QUEUE_JSON" | python3 -c '
import sys, json
try:
    q = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for i in (q.get("items") or []):
    if i.get("kind") != "decision":
        continue
    t = i.get("ticket")
    ref = ("#%s" % t["number"]) if t and t.get("number") is not None else "-"
    reason = " ".join((i.get("reason") or "").split())
    print("    %s  %s" % (ref, reason))
' 2>/dev/null)"
if [ -n "$hq_lines" ]; then
  printf "\n  ${c_dim}decisions awaiting you${c_off}\n"
  printf '%s\n' "$hq_lines"
fi

printf "\n  ${c_dim}recent ticks${c_off}\n"
ticks="$(grep -hE 'delivering #|delivery tick for #' "$GAFFER_LOG" 2>/dev/null | tail -n "$STATUS_TICKS")"
if [ -n "$ticks" ]; then printf '%s\n' "$ticks" | sed 's/^/    /'
else printf "    ${c_dim}(none yet — %s)${c_off}\n" "$GAFFER_LOG"; fi

echo
# Precise running-detection: validated recorded PID, not a broad `pgrep -f`.
if _dash_pid="$(gaffer_dashboard_pid 2>/dev/null)"; then
  ok "dashboard running → http://127.0.0.1:${DISPATCH_API_PORT:-8787} (pid $_dash_pid)"
else
  warn "dashboard not running (\`gaffer dashboard\`)"
fi

# A ticket needing review or blocked means a human is wanted → notify.
attention=$(( review + blocked ))
if [ "$attention" -gt 0 ]; then
  reasons=""; [ "$review" -gt 0 ] && reasons="$review awaiting review"
  [ "$blocked" -gt 0 ] && reasons="${reasons:+$reasons, }$blocked blocked"
  notify "gaffer: $reasons — a human is needed"
else
  ok "nothing needs a human right now"
fi
