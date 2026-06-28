#!/usr/bin/env bash
# =====================================================================
# MAINTENANCE LANE wiring test (audit item A4).
# ---------------------------------------------------------------------
# Proves tick.sh routes a quiet idle tick (nothing claimable) into crew's
# deterministic maintenance scheduler when GAFFER_MAINTENANCE=1, and that the
# behaviour is UNCHANGED when the toggle is OFF (regression):
#   1. GAFFER_MAINTENANCE=1 + nothing ready → tick invokes `fg maintain` (the
#      scheduler-chosen single loop), logs the chosen lane + rationale, and
#      reports TICK_RESULT=maintenance_drafted.
#   2. The crew CLI is invoked with the `maintain` subcommand (NOT `idle`),
#      proving the smart prioritised lane is used, not the fixed scan.
#   3. With GAFFER_MAINTENANCE unset (default), the maintenance lane is skipped
#      entirely — today's path is taken and the tick falls through to no_work
#      (no crew CLI call at all when IDLE_DRAFT_WHEN_IDLE is also off).
#
# Hermetic: stub `dispatch` + `crew` CLIs stand in for the real servers, so no
# real factory state is touched and Claude is never invoked. Zero deps.
# Run: bash test/maintenance-lane.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/maint-test.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
cleanup() { [ "${BASHPID:-}" = "$$" ] && rm -rf "$WORK"; }
trap cleanup EXIT

GAFFER_DATA="$WORK/gaffer-data"; mkdir -p "$GAFFER_DATA"
CREW_CALLS="$GAFFER_DATA/crew-calls.log"; : > "$CREW_CALLS"

# ── Stub dispatch CLI ───────────────────────────────────────────────────────
# Answers the reads the idle path makes before maintenance: nothing ready /
# in_review / draft, so the tick reaches the maintenance gate with an empty queue.
STUB_DISPATCH="$WORK/dispatch/dist/cli"; mkdir -p "$STUB_DISPATCH"
cat > "$STUB_DISPATCH/index.js" <<'JS'
const a = process.argv.slice(2);
const has = (...t) => t.every((x) => a.includes(x));
const out = (o) => process.stdout.write(JSON.stringify(o));
if (has("agent", "register")) out({ agent: { id: "stub-agent" } });
else if (has("ticket", "list")) out([]); // nothing ready / in_review / draft
else out({});
JS

# ── Stub crew CLI ───────────────────────────────────────────────────────────
# Records every call (so we can assert `maintain`, not `idle`, is used) and
# emits the maintenance-lane report shape tick.sh parses (chosen / reason /
# outcome.status / outcome.draftCount).
STUB_CREW="$WORK/crew/dist/cli"; mkdir -p "$STUB_CREW"
cat > "$STUB_CREW/index.js" <<'JS'
const fs = require("fs");
const a = process.argv.slice(2);
fs.appendFileSync(process.env.CREW_CALLS, a.join(" ") + "\n");
const out = (o) => process.stdout.write(JSON.stringify(o));
if (a.includes("maintain")) {
  out({
    ok: true,
    report: {
      chosen: "security_hotspot",
      reason: "lane 'security_hotspot' selected: highest-priority enabled lane not yet run",
      outcome: { status: "draft_created", draftCount: 1 },
    },
    events: ["maintenance_lane_chosen"],
  });
} else {
  out({ ok: true, outcome: { drafts: [] }, events: [] });
}
JS

# Minimal crew config so the `-f "$CREW_CONFIG"` guard passes.
CREW_CONFIG="$WORK/crew.config.yaml"; printf 'factory:\n  name: t\n' > "$CREW_CONFIG"

run_tick() {
  CREW_CALLS="$CREW_CALLS" \
  RUNNER_DIR="$RUNNER_DIR" GAFFER_HOME="$WORK" GAFFER_DATA="$GAFFER_DATA" \
  DISPATCH_DIR="$WORK/dispatch" CREW_DIR="$WORK/crew" CREW_CONFIG="$CREW_CONFIG" \
  DRY_RUN="${DRY_RUN:-0}" REVIEW_MODE=human \
  GAFFER_MAINTENANCE="${GAFFER_MAINTENANCE:-0}" IDLE_DRAFT_WHEN_IDLE="${IDLE_DRAFT_WHEN_IDLE:-0}" \
    bash "$RUNNER_DIR/tick.sh" 2>>"$GAFFER_DATA/stderr.log"
}

# ── 1. GAFFER_MAINTENANCE=1 → scheduler-chosen lane runs + is logged ─────────
: > "$CREW_CALLS"
OUT1="$(GAFFER_MAINTENANCE=1 run_tick)"
echo "$OUT1" | grep -q '^TICK_RESULT=maintenance_drafted$' \
  && ok "maintenance lane drafts → TICK_RESULT=maintenance_drafted" \
  || fail "expected maintenance_drafted, got: $(echo "$OUT1" | grep '^TICK_RESULT=')"

grep -q "maintenance lane chose 'security_hotspot'" "$GAFFER_DATA/factory.log" 2>/dev/null \
  && ok "logs the chosen lane + rationale" \
  || fail "chosen-lane log line missing"

# ── 2. crew CLI invoked with `maintain` (the smart lane), not `idle` ──────────
if grep -q 'maintain' "$CREW_CALLS"; then
  ok "tick invokes crew 'maintain' (scheduler-chosen loop)"
else
  fail "crew 'maintain' subcommand was not invoked"
fi
if grep -qw 'idle' "$CREW_CALLS"; then
  fail "tick must NOT fall through to the fixed 'idle' scan when maintenance ran"
else
  ok "tick does not also run the fixed 'idle' scan"
fi

# ── 3. toggle OFF → today's behaviour unchanged (regression) ─────────────────
: > "$CREW_CALLS"
OUT3="$(GAFFER_MAINTENANCE=0 IDLE_DRAFT_WHEN_IDLE=0 run_tick)"
echo "$OUT3" | grep -q '^TICK_RESULT=no_work$' \
  && ok "maintenance OFF + idle OFF → unchanged: TICK_RESULT=no_work" \
  || fail "expected no_work with maintenance off, got: $(echo "$OUT3" | grep '^TICK_RESULT=')"
if [ -s "$CREW_CALLS" ]; then
  fail "crew CLI must NOT be invoked when the maintenance lane is off"
else
  ok "crew CLI is not invoked when the maintenance lane is off"
fi

# ── 4. DRY_RUN logs intent without invoking crew ─────────────────────────────
: > "$CREW_CALLS"
OUT4="$(GAFFER_MAINTENANCE=1 DRY_RUN=1 run_tick)"
grep -q 'DRY_RUN: would run: fg maintain' "$GAFFER_DATA/factory.log" 2>/dev/null \
  && ok "DRY_RUN logs the maintenance intent" \
  || fail "DRY_RUN maintenance intent not logged"
if [ -s "$CREW_CALLS" ]; then
  fail "DRY_RUN must not actually invoke crew"
else
  ok "DRY_RUN does not invoke crew"
fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS ($PASS checks)"; exit 0
else
  printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
fi
