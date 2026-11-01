#!/usr/bin/env bash
# =====================================================================
# A DRY RUN previews each ready ticket ONCE and leaves no trace of a delivery
# (exploratory findings cli-runner/F-06, cli-runner/F-07, fresh-user/F-15,
# fresh-user/F-17).
# ---------------------------------------------------------------------
# `gaffer run --dry-run` used to preview the same first ready ticket MAX_TICKS times
# with a TICK_SLEEP between previews (never reaching #2), log each preview as
# "ready=1 → delivering #N" (so `gaffer status` listed previews as deliveries), write
# a memory_primed evidence row per preview, end with "sending closing ping", and warn
# "DRY_RUN=1 is set in your environment" when the operator had passed the flag.
# Driven through the REAL loop.sh + tick.sh with a stub agent (lib/stub-tick.sh):
#   P1. two ready tickets → each is previewed exactly once, then the pass ends
#       (3 ticks: two previews and one empty poll), with no TICK_SLEEP between
#   P2. factory.log holds no "delivering #" line; the preview line says "previewed"
#       and `gaffer status` recent ticks shows it
#   P3. no memory_primed evidence, no delivery metric row, no claim, both still ready
#   P4. no "sending closing ping" on a dry run (and no ping sent)
#   P5. `gaffer run --dry-run` names the flag; DRY_RUN=1 in the environment is named
#       as the environment
# Run: bash runner/test/dry-run-preview.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
command -v perl >/dev/null 2>&1 || { echo "SKIP: perl required (timeout primitive)"; exit 0; }
for f in packages/dispatch/dist/cli/index.js packages/memory/dist/bin/memory.js packages/crew/dist/cli/index.js; do
  [ -f "$ROOT/$f" ] || { echo "SKIP: $f not built (run pnpm -r build)"; exit 0; }
done

STUB_TICK_NAME=dry-run-preview
# shellcheck source=lib/stub-tick.sh
source "$HERE/lib/stub-tick.sh"
has() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }
agent_calls() { find "$CALLS" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' '; }

# A file card for the repo, so a delivery prime has memory to serve (and, before the
# fix, a dry-run prime recorded memory_primed evidence for it).
CANON="$(lg repo-canonical --repo-root "$R" 2>/dev/null)"
lg card upsert --canonical "$CANON" --repo repo --repo-root "$R" --path src/a.js --tldr "helper a returns one" >/dev/null 2>&1
T1="$(new_ready "Add helper a two" "change helper a in src/a.js")"
T2="$(new_ready "Add helper a three" "another helper next to a in src/a.js")"
: > "$GAFFER_DATA/factory.log"

printf '#!/usr/bin/env bash\n{ for a in "$@"; do printf "%%s\\n" "$a"; done; } >> "%s"\n' "$WORK/ping.txt" > "$WORK/notify.sh"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" %q\n' '{"ticketsByStatus":{"in_review":2,"ready":2}}' > "$WORK/stats.sh"
printf '#!/usr/bin/env bash\nprintf "{\\"items\\":[]}\\n"\n' > "$WORK/hq.sh"
chmod +x "$WORK/notify.sh" "$WORK/stats.sh" "$WORK/hq.sh"

echo "== P1. each ready ticket is previewed once, no sleeps between =="
t0="$(date +%s)"
LOUT="$( ( cd "$RUNNER_DIR" && DRY_RUN=1 MAX_TICKS=6 TICK_SLEEP=90 EMPTY_POLL_LIMIT=3 \
  LOOP_STATS_CMD="$WORK/stats.sh" LOOP_HQ_CMD="$WORK/hq.sh" LOOP_NOTIFY_EMIT_CMD="$WORK/notify.sh" \
  bash ./loop.sh 2>&1 ) )"
el=$(( $(date +%s) - t0 ))
LOG="$(cat "$GAFFER_DATA/factory.log")"
n1="$(grep -c "previewed #$T1 " "$GAFFER_DATA/factory.log")"
n2="$(grep -c "previewed #$T2 " "$GAFFER_DATA/factory.log")"
[ "$n1" = 1 ] && [ "$n2" = 1 ] && ok "P1: #$T1 and #$T2 each previewed once" || fail "P1: previews #$T1=$n1 #$T2=$n2; loop: $(printf '%s' "$LOUT" | grep '^tick ' | tr '\n' ' ')"
has "$LOUT" "done after 3 tick(s)" && ok "P1: the pass ended after two previews and one empty poll" || fail "P1: $(printf '%s' "$LOUT" | grep 'done after')"
[ "$el" -lt 90 ] && ok "P1: no TICK_SLEEP between previews (${el}s)" || fail "P1: the dry run took ${el}s (slept between previews)"
has "$LOUT" "tick 1/6 → previewed" && ok "P1: the loop reports 'previewed'" || fail "P1: $(printf '%s' "$LOUT" | grep '^tick 1')"

echo "== P2. no 'delivering' line; status shows the previews =="
has "$LOG" "delivering #" && fail "P2: factory.log has a 'delivering #' line on a dry run" || ok "P2: no 'delivering #' line"
mk() { printf '#!/usr/bin/env bash\nprintf "%%s\\n" %q\n' "$2" > "$1"; chmod +x "$1"; }
mk "$WORK/doc.sh" "Healthy."; mk "$WORK/sstats.sh" '{"ticketsByStatus":{"ready":2}}'; mk "$WORK/empty.sh" "[]"
SOUT="$(WG_DOCTOR_CMD="$WORK/doc.sh" FG_DOCTOR_CMD="$WORK/doc.sh" LG_DOCTOR_CMD="$WORK/doc.sh" \
  STATS_CMD="$WORK/sstats.sh" REPOS_CMD="$WORK/empty.sh" HUMAN_QUEUE_CMD="$WORK/empty.sh" \
  GAFFER_LOG="$GAFFER_DATA/factory.log" DASHBOARD_PROBE_URL="http://127.0.0.1:1/none" \
  bash "$RUNNER_DIR/status.sh" 2>&1 | sed 's/\x1b\[[0-9;]*m//g')"
has "$SOUT" "previewed #$T1" && ok "P2: gaffer status recent ticks shows the dry-run preview" || fail "P2: status recent ticks: $(printf '%s' "$SOUT" | sed -n '/recent ticks/,+3p')"

echo "== P3. nothing recorded, nothing claimed =="
for t in "$T1" "$T2"; do
  ev="$(wg ticket show "$t" 2>/dev/null | jget '(d.evidence||[]).filter(e => e.evidence_type === "memory_primed").length')"
  [ "$ev" = 0 ] && ok "P3: no memory_primed evidence on #$t" || fail "P3: $ev memory_primed row(s) on #$t"
  [ "$(st "$t")" = ready ] && ok "P3: #$t is still ready" || fail "P3: #$t is $(st "$t")"
done
[ ! -s "$GAFFER_DATA/delivery-metrics.jsonl" ] && ok "P3: no delivery metric row" || fail "P3: delivery-metrics.jsonl: $(head -2 "$GAFFER_DATA/delivery-metrics.jsonl")"
[ "$(agent_calls)" = 0 ] && ok "P3: no agent ran" || fail "P3: $(agent_calls) agent call(s)"

echo "== P4. no closing ping on a dry run =="
has "$LOUT" "sending closing ping" && fail "P4: a dry run says 'sending closing ping'" || ok "P4: no 'sending closing ping'"
[ ! -s "$WORK/ping.txt" ] && ok "P4: no ping was sent" || fail "P4: a ping was sent: $(tr '\n' ' ' < "$WORK/ping.txt")"

echo "== P5. the dry-run warning names where DRY_RUN came from =="
printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/loop-stub.sh"; chmod +x "$WORK/loop-stub.sh"
W1="$(env -u DRY_RUN GAFFER_LOOP_SH="$WORK/loop-stub.sh" bash "$RUNNER_DIR/gaffer" run --dry-run 2>&1 | sed 's/\x1b\[[0-9;]*m//g')"
has "$W1" "in your environment" && fail "P5: --dry-run blamed the environment: $W1" || ok "P5: --dry-run does not blame the environment"
has "$W1" "--dry-run" && ok "P5: --dry-run names the flag" || fail "P5: $W1"
W2="$(env DRY_RUN=1 GAFFER_LOOP_SH="$WORK/loop-stub.sh" bash "$RUNNER_DIR/gaffer" run 2>&1 | sed 's/\x1b\[[0-9;]*m//g')"
has "$W2" "DRY_RUN=1 is set in your environment" && ok "P5: DRY_RUN=1 from the environment is named" || fail "P5: $W2"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
