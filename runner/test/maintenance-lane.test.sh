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
#   7-9. A FAILED `crew maintain` (rc≠0 / empty stdout / unknown status) is logged
#      as FAILED and falls through to the legacy scan + no_work — never reported
#      as a healthy maintenance_ran.
#
# The feature-backlog step (its own switch, run before this lane) is pinned OFF here
# (GAFFER_IDLE_FEATURE_BACKLOG=0) so these crew-call assertions are about the lane
# only; feature-backlog-live.test.sh covers that step.
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
  if (process.env.MAINT_FAIL === "1") {
    // What the real CLI does on an invalid crew.yaml: error JSON on stderr,
    // nothing on stdout, exit 1.
    process.stderr.write('{"ok":false,"code":"INVALID_CONFIG","message":"bad crew.yaml"}\n');
    process.exit(1);
  }
  if (process.env.MAINT_STATUS) {
    out({ ok: true, report: { chosen: "docs", reason: "r", outcome: { status: process.env.MAINT_STATUS } } });
    process.exit(0);
  }
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
  MAINT_FAIL="${MAINT_FAIL:-0}" MAINT_STATUS="${MAINT_STATUS:-}" \
  GAFFER_STRICT_REQUIRE="${GAFFER_STRICT_REQUIRE:-0}" GAFFER_IDLE_HOST_EXEC="${GAFFER_IDLE_HOST_EXEC:-0}" \
  RUNNER_DIR="$RUNNER_DIR" GAFFER_HOME="$WORK" GAFFER_DATA="$GAFFER_DATA" \
  DISPATCH_DIR="$WORK/dispatch" CREW_DIR="$WORK/crew" CREW_CONFIG="$CREW_CONFIG" \
  DRY_RUN="${DRY_RUN:-0}" REVIEW_MODE=human \
  GAFFER_MAINTENANCE="${GAFFER_MAINTENANCE-}" IDLE_DRAFT_WHEN_IDLE="${IDLE_DRAFT_WHEN_IDLE:-0}" \
  GAFFER_IDLE_FEATURE_BACKLOG="${GAFFER_IDLE_FEATURE_BACKLOG-0}" \
    bash "$RUNNER_DIR/tick.sh" 2>>"$GAFFER_DATA/stderr.log"
}
reset_log() { : > "$CREW_CALLS"; : > "$GAFFER_DATA/factory.log"; }

# ── 1. GAFFER_MAINTENANCE=1 → forced lane runs + is logged ───────────────────
reset_log
OUT1="$(GAFFER_MAINTENANCE=1 MAINT_ENABLED=0 run_tick)"
grep -q '^TICK_RESULT=maintenance_drafted$' <<<"$OUT1" \
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
grep -q '^TICK_RESULT=no_work$' <<<"$OUT3" \
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
grep -q '^TICK_RESULT=no_work$' <<<"$OUT4" \
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
grep -q '^TICK_RESULT=maintenance_drafted$' <<<"$OUT5" \
  && ok "crew.yaml switch on (env unset) → the lane runs → maintenance_drafted" \
  || fail "expected maintenance_drafted with the crew.yaml switch on, got: $(echo "$OUT5" | grep '^TICK_RESULT=')"

# ── 6. DRY_RUN logs intent without invoking crew ─────────────────────────────
reset_log
OUT6="$(GAFFER_MAINTENANCE=1 DRY_RUN=1 run_tick)"
grep -q '^TICK_RESULT=no_work$' <<<"$OUT6" \
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

# ── 7. crew maintain FAILS (rc=1, empty stdout) → not a healthy "ran" ────────
# A broken crew.yaml used to read as "chose none, no_op" → maintenance_ran on every
# idle tick: hidden, and a productive result kept workers from ever draining.
reset_log
OUT7="$(MAINT_FAIL=1 IDLE_DRAFT_WHEN_IDLE=0 run_tick)"
grep -q '^TICK_RESULT=no_work$' <<<"$OUT7" \
  && ok "a failed crew maintain → TICK_RESULT=no_work (not maintenance_ran)" \
  || fail "expected no_work when crew maintain fails, got: $(echo "$OUT7" | grep '^TICK_RESULT=')"
grep -q 'maintenance lane FAILED (rc=1): {"ok":false,"code":"INVALID_CONFIG"' "$GAFFER_DATA/factory.log" 2>/dev/null \
  && ok "the failure is logged with crew's rc and first stderr line" \
  || fail "missing the 'maintenance lane FAILED (rc=1): …' log line"
if grep -q "maintenance lane chose" "$GAFFER_DATA/factory.log" 2>/dev/null; then
  fail "a failed run must not be logged as a chosen lane"
else
  ok "a failed run is not logged as a chosen lane"
fi

# ── 8. a failed lane falls through to the legacy idle scan ───────────────────
reset_log
OUT8="$(MAINT_FAIL=1 IDLE_DRAFT_WHEN_IDLE=1 run_tick)"
grep -qw 'idle' "$CREW_CALLS" \
  && ok "IDLE_DRAFT_WHEN_IDLE=1 still runs the legacy idle scan after a failed lane" \
  || fail "the legacy idle scan did not run after a failed lane (calls: $(tr '\n' '|' < "$CREW_CALLS"))"
grep -q '^TICK_RESULT=no_work$' <<<"$OUT8" \
  && ok "…and the tick still ends no_work when the scan drafts nothing" \
  || fail "expected no_work after the fall-through, got: $(echo "$OUT8" | grep '^TICK_RESULT=')"

# ── 9. an unknown outcome status is a failure, not a run ─────────────────────
reset_log
OUT9="$(MAINT_STATUS=exploded IDLE_DRAFT_WHEN_IDLE=0 run_tick)"
grep -q '^TICK_RESULT=no_work$' <<<"$OUT9" \
  && grep -q 'maintenance lane FAILED (rc=0)' "$GAFFER_DATA/factory.log" 2>/dev/null \
  && ok "an unknown outcome status → FAILED + no_work" \
  || fail "expected FAILED + no_work for an unknown status, got: $(echo "$OUT9" | grep '^TICK_RESULT=')"
# A known non-drafting status still reports a run.
reset_log
OUT10="$(MAINT_STATUS=no_findings run_tick)"
grep -q '^TICK_RESULT=maintenance_ran$' <<<"$OUT10" \
  && ok "a known status (no_findings) still reports maintenance_ran" \
  || fail "expected maintenance_ran for no_findings, got: $(echo "$OUT10" | grep '^TICK_RESULT=')"

# ── 10. strict containment: the tick says idle repo commands won't run on the host ─
reset_log
OUT11="$(GAFFER_STRICT_REQUIRE=1 MAINT_ENABLED=1 run_tick)"
grep -q 'GAFFER_STRICT_REQUIRE is on — idle loops will NOT run repo commands' "$GAFFER_DATA/factory.log" 2>/dev/null \
  && ok "GAFFER_STRICT_REQUIRE=1 → the tick logs that idle repo commands are refused on the host" \
  || fail "missing the strict-mode idle host-exec log line (result: $(echo "$OUT11" | grep '^TICK_RESULT='))"
reset_log
GAFFER_STRICT_REQUIRE=1 GAFFER_IDLE_HOST_EXEC=1 MAINT_ENABLED=1 run_tick >/dev/null
if grep -q 'idle loops will NOT run repo commands' "$GAFFER_DATA/factory.log" 2>/dev/null; then
  fail "GAFFER_IDLE_HOST_EXEC=1 should silence the strict-mode refusal line"
else
  ok "GAFFER_IDLE_HOST_EXEC=1 opts back in (no refusal line)"
fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS ($PASS checks)"; exit 0
else
  printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
fi
