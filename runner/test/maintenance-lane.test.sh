#!/usr/bin/env bash
# =====================================================================
# MAINTENANCE LANE wiring test (audit item A4).
# ---------------------------------------------------------------------
# Proves how tick.sh routes a quiet idle tick (nothing claimable) into crew's
# deterministic maintenance scheduler, and how the two switches compose:
#   • crew.yaml `loops.maintenance.enabled` is the lane's own switch (edited from
#     Settings → Idle loops); tick.sh ASKS crew (`fg maintain`) whenever crew is
#     built and a crew.yaml exists, and crew answers `disabled` while it is off.
#   • GAFFER_MAINTENANCE is the env override: 0 = kill switch (crew never asked),
#     1 = force (`fg maintain --force`), empty = crew.yaml decides.
#   1. GAFFER_MAINTENANCE=1 + nothing ready → `fg maintain --force`, logs the chosen
#      lane + rationale, TICK_RESULT=maintenance_drafted.
#   2. The crew CLI is invoked with `maintain` (NOT `idle`) — the smart lane, not
#      the fixed scan.
#   3. GAFFER_MAINTENANCE=0 → crew is never invoked; TICK_RESULT=no_work.
#   4. GAFFER_MAINTENANCE unset + crew.yaml switch OFF → crew IS asked (no --force),
#      answers disabled, tick logs the pointer to Settings → Idle loops, no_work.
#   5. GAFFER_MAINTENANCE unset + crew.yaml switch ON → the lane runs → drafted.
#   6. DRY_RUN logs intent without invoking crew.
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
# Records every call (so we can assert `maintain`, `--force`, never `idle`) and
# emits the maintenance-lane report shape tick.sh parses. Honours the crew.yaml
# switch the way the real CLI does: MAINT_ENABLED=0 without --force → `disabled`.
STUB_CREW="$WORK/crew/dist/cli"; mkdir -p "$STUB_CREW"
cat > "$STUB_CREW/index.js" <<'JS'
const fs = require("fs");
const a = process.argv.slice(2);
fs.appendFileSync(process.env.CREW_CALLS, a.join(" ") + "\n");
const out = (o) => process.stdout.write(JSON.stringify(o));
if (a.includes("maintain")) {
  if (process.env.MAINT_ENABLED === "0" && !a.includes("--force")) {
    out({
      ok: true,
      report: {
        chosen: null,
        reason: "maintenance lane disabled (loops.maintenance.enabled=false)",
        outcome: { status: "disabled" },
      },
      events: ["maintenance_lane_finished"],
    });
  } else {
    out({
      ok: true,
      report: {
        chosen: "security_hotspot",
        reason: "lane 'security_hotspot' selected: highest-priority enabled lane not yet run",
        outcome: { status: "draft_created", draftCount: 1 },
      },
      events: ["maintenance_lane_chosen"],
    });
  }
} else {
  out({ ok: true, outcome: { drafts: [] }, events: [] });
}
JS

# Minimal crew config so the `-f "$CREW_CONFIG"` guard passes.
CREW_CONFIG="$WORK/crew.config.yaml"; printf 'factory:\n  name: t\n' > "$CREW_CONFIG"

run_tick() {
  CREW_CALLS="$CREW_CALLS" MAINT_ENABLED="${MAINT_ENABLED:-1}" \
  RUNNER_DIR="$RUNNER_DIR" GAFFER_HOME="$WORK" GAFFER_DATA="$GAFFER_DATA" \
  DISPATCH_DIR="$WORK/dispatch" CREW_DIR="$WORK/crew" CREW_CONFIG="$CREW_CONFIG" \
  DRY_RUN="${DRY_RUN:-0}" REVIEW_MODE=human \
  GAFFER_MAINTENANCE="${GAFFER_MAINTENANCE-}" IDLE_DRAFT_WHEN_IDLE="${IDLE_DRAFT_WHEN_IDLE:-0}" \
    bash "$RUNNER_DIR/tick.sh" 2>>"$GAFFER_DATA/stderr.log"
}
reset_log() { : > "$CREW_CALLS"; : > "$GAFFER_DATA/factory.log"; }

# ── 1. GAFFER_MAINTENANCE=1 → forced lane runs + is logged ───────────────────
reset_log
OUT1="$(GAFFER_MAINTENANCE=1 MAINT_ENABLED=0 run_tick)"
echo "$OUT1" | grep -q '^TICK_RESULT=maintenance_drafted$' \
  && ok "GAFFER_MAINTENANCE=1 forces the lane even with the crew.yaml switch off → maintenance_drafted" \
  || fail "expected maintenance_drafted under force, got: $(echo "$OUT1" | grep '^TICK_RESULT=')"
grep -q "maintenance lane chose 'security_hotspot'" "$GAFFER_DATA/factory.log" 2>/dev/null \
  && ok "logs the chosen lane + rationale" \
  || fail "chosen-lane log line missing"
grep -q 'maintain --force' "$CREW_CALLS" \
  && ok "the override is passed to crew as 'maintain --force'" \
  || fail "crew was not invoked with 'maintain --force' (calls: $(tr '\n' '|' < "$CREW_CALLS"))"

# ── 2. crew CLI invoked with `maintain` (the smart lane), not `idle` ──────────
if grep -qw 'idle' "$CREW_CALLS"; then
  fail "tick must NOT fall through to the fixed 'idle' scan when maintenance ran"
else
  ok "tick does not also run the fixed 'idle' scan"
fi

# ── 3. GAFFER_MAINTENANCE=0 → kill switch: crew never asked ──────────────────
reset_log
OUT3="$(GAFFER_MAINTENANCE=0 IDLE_DRAFT_WHEN_IDLE=0 run_tick)"
echo "$OUT3" | grep -q '^TICK_RESULT=no_work$' \
  && ok "GAFFER_MAINTENANCE=0 + idle OFF → TICK_RESULT=no_work" \
  || fail "expected no_work with the kill switch, got: $(echo "$OUT3" | grep '^TICK_RESULT=')"
if [ -s "$CREW_CALLS" ]; then
  fail "crew CLI must NOT be invoked under GAFFER_MAINTENANCE=0"
else
  ok "crew CLI is not invoked under the kill switch"
fi

# ── 4. unset + crew.yaml switch OFF → crew asked, answers disabled, no_work ──
reset_log
OUT4="$(MAINT_ENABLED=0 IDLE_DRAFT_WHEN_IDLE=0 run_tick)"
echo "$OUT4" | grep -q '^TICK_RESULT=no_work$' \
  && ok "crew.yaml switch off (env unset) → TICK_RESULT=no_work" \
  || fail "expected no_work with the crew.yaml switch off, got: $(echo "$OUT4" | grep '^TICK_RESULT=')"
if grep -q '^.*maintain' "$CREW_CALLS" && ! grep -q -- '--force' "$CREW_CALLS"; then
  ok "crew IS asked (fg maintain, no --force) — crew.yaml decides"
else
  fail "expected a plain 'maintain' call (calls: $(tr '\n' '|' < "$CREW_CALLS"))"
fi
grep -q 'maintenance lane is OFF in crew.yaml' "$GAFFER_DATA/factory.log" 2>/dev/null \
  && ok "tick logs the pointer to Settings → Idle loops when the switch is off" \
  || fail "missing the 'maintenance lane is OFF in crew.yaml' log line"

# ── 5. unset + crew.yaml switch ON → the lane runs ───────────────────────────
reset_log
OUT5="$(MAINT_ENABLED=1 run_tick)"
echo "$OUT5" | grep -q '^TICK_RESULT=maintenance_drafted$' \
  && ok "crew.yaml switch on (env unset) → the lane runs → maintenance_drafted" \
  || fail "expected maintenance_drafted with the crew.yaml switch on, got: $(echo "$OUT5" | grep '^TICK_RESULT=')"

# ── 6. DRY_RUN logs intent without invoking crew ─────────────────────────────
reset_log
OUT6="$(GAFFER_MAINTENANCE=1 DRY_RUN=1 run_tick)"
echo "$OUT6" | grep -q '^TICK_RESULT=no_work$' \
  && ok "DRY_RUN → TICK_RESULT=no_work (nothing drafted)" \
  || fail "DRY_RUN expected no_work, got: $(echo "$OUT6" | grep '^TICK_RESULT=')"
grep -q 'DRY_RUN: would run: fg maintain --force' "$GAFFER_DATA/factory.log" 2>/dev/null \
  && ok "DRY_RUN logs the maintenance intent (with the force flag)" \
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
