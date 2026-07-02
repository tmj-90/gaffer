#!/usr/bin/env bash
# =====================================================================
# AFK-LOOP Phase 2 — loop-end "come back to this" ping (runner/loop.sh).
# ---------------------------------------------------------------------
# Proves the closing idle notification fired at the END of a run:
#   AC1  When work is waiting, ONE ping fires through the wired dispatch
#        notify sink, carrying the summary "N awaiting review, M decisions"
#        with the correct counts (in_review from stats, decisions from the
#        human-queue) + the dashboard deep-link URL.
#   AC2  NEGATIVE CONTROL: a fully-drained run (nothing in_review, no
#        decisions) fires NO ping and reports "all clear" instead.
#
# Hermetic: drives the REAL loop.sh with MAX_TICKS=0 so NO tick / claude / DB
# work happens — only the end path runs. The three end-path seams
# (LOOP_STATS_CMD · LOOP_HQ_CMD · LOOP_NOTIFY_EMIT_CMD) are stubbed with tiny
# scripts, so no real CLI, DB, build or network is touched (runs even when
# unbuilt). mktemp + trap cleanup.
# Run: bash test/loop-end-ping.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
has()  { case "$1" in *"$2"*) return 0;; *) return 1;; esac; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loop-end-ping-test.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
SINK="$WORK/ping.txt"

# Count seams: each prints the per-case fixture JSON from its env var.
cat > "$WORK/stats.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${STATS_JSON_FIXTURE:-}"
EOF
cat > "$WORK/hq.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${HQ_JSON_FIXTURE:-}"
EOF
# Notify sink: record the full ping argv (one field per line) to $PING_SINK.
cat > "$WORK/notify.sh" <<'EOF'
#!/usr/bin/env bash
{ for a in "$@"; do printf '%s\n' "$a"; done; } >> "${PING_SINK:?}"
EOF
chmod +x "$WORK/stats.sh" "$WORK/hq.sh" "$WORK/notify.sh"

# Drive the real loop.sh end path. MAX_TICKS=0 ⇒ the tick loop body never runs
# (no tick.sh, no claude), so only the closing report + ping execute. DISPATCH_*
# point at nonexistent paths so the config's best-effort `wg` calls fail fast and
# harmlessly (all guarded `|| …` / `|| true`).
run_loop() {  # run_loop <stats-json> <hq-json>
  ( trap - EXIT
    MAX_TICKS=0 DRY_RUN=1 \
    GAFFER_DATA="$WORK/data" \
    GAFFER_LOG="$WORK/factory.log" \
    DISPATCH_DIR="$WORK/nodist" DISPATCH_DB="$WORK/db.sqlite" \
    STATS_JSON_FIXTURE="$1" HQ_JSON_FIXTURE="$2" PING_SINK="$SINK" \
    LOOP_STATS_CMD="$WORK/stats.sh" \
    LOOP_HQ_CMD="$WORK/hq.sh" \
    LOOP_NOTIFY_EMIT_CMD="$WORK/notify.sh" \
    bash "$RUNNER_DIR/loop.sh" 2>&1 )
}

# --- AC1: work waiting → one ping with correct N/M counts -------------
: > "$SINK"
out="$(run_loop '{"ticketsByStatus":{"in_review":3,"blocked":1,"ready":4}}' \
                '{"items":[{"kind":"decision"},{"kind":"decision"},{"kind":"review"}]}')"
ping="$(cat "$SINK")"
[ -s "$SINK" ] && ok "closing ping fires when work is waiting" || fail "no closing ping when work waiting"
has "$ping" "review_needed"        && ok "ping uses the review_needed gate kind" || fail "ping kind wrong/missing"
has "$ping" "3 awaiting review, 2 decisions" \
  && ok "ping carries the correct N/M summary (3 review, 2 decisions)" \
  || fail "ping summary counts wrong; got: $(printf '%s' "$ping" | tr '\n' ' ')"
has "$ping" "http"                 && ok "ping carries a dashboard deep-link URL" || fail "ping missing --url deep-link"
has "$out" "sending closing ping"  && ok "run log announces the closing ping" || fail "run log missing ping line"

# --- AC2: NEGATIVE CONTROL — nothing pending → no ping ----------------
: > "$SINK"
out="$(run_loop '{"ticketsByStatus":{"in_review":0,"blocked":0,"ready":4}}' \
                '{"items":[{"kind":"review"}]}')"
[ -s "$SINK" ] && fail "ping fired on a fully-drained run (should stay silent)" \
              || ok "NEGATIVE CONTROL: no ping when nothing awaits a human"
has "$out" "all clear" && ok "drained run reports 'all clear'" || fail "drained run missing all-clear line"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "  ALL PASS ($PASS checks)"; exit 0
else printf '  %d FAILURE(S), %d passed\n' "${#FAILURES[@]}" "$PASS"; for f in "${FAILURES[@]}"; do echo "   - $f"; done; exit 1; fi
