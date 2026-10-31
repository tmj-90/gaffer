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
#   10. strict containment log line.
#   11. A lane that FILED NOTHING (no_findings / deduped / chose none) is no_work —
#      the scans are zero-cost greps, so they must drain the pool and stay off the
#      day cap; only a tick that ran the paid backlog planner (spent) and filed
#      nothing is maintenance_ran. GAFFER_MAINTENANCE=1 with no lane enabled says so.
#   12. The legacy IDLE_DRAFT_WHEN_IDLE scan reads crew's REAL `crew idle` shape
#      ({ok, report:{loops,totalDrafts}, filed}) — it used to read outcome.drafts,
#      which crew never prints, so every scan logged 0 drafts and reported no_work.
#   13. The idle crew calls carry the factory's memory + planner wiring
#      (MEMORY_DB, MEMORY_MCP_BIN, GAFFER_DECOMPOSE_SCRIPT, CLAUDE_BIN).
#
# The feature-backlog step (its own switch, run before this lane) is pinned OFF here
# (GAFFER_IDLE_FEATURE_BACKLOG=0) so these crew-call assertions are about the lane
# only; feature-backlog-live.test.sh covers that step.
#
# Hermetic: stub `dispatch` + `crew` CLIs stand in for the real servers, so no
# real factory state is touched and Claude is never invoked. Zero deps.
# Run: bash test/maintenance-lane.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/maint-test.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
cleanup() { [ "${BASHPID:-}" = "$$" ] && gaffer_test_rm_work "$WORK"; }
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
fs.appendFileSync(
  process.env.CREW_CALLS + ".env",
  ["MEMORY_DB", "MEMORY_MCP_BIN", "GAFFER_DECOMPOSE_SCRIPT", "CLAUDE_BIN"]
    .map((k) => `${k}=${process.env[k] || ""}`)
    .join(" ") + "\n",
);
const out = (o) => process.stdout.write(JSON.stringify(o));
const filed = (n) => Number(process.env.MAINT_FILED || n);
const spent = process.env.MAINT_SPENT === "1";
if (a.includes("maintain")) {
  if (process.env.MAINT_FAIL === "1") {
    // What the real CLI does on an invalid crew.yaml: error JSON on stderr,
    // nothing on stdout, exit 1.
    process.stderr.write('{"ok":false,"code":"INVALID_CONFIG","message":"bad crew.yaml"}\n');
    process.exit(1);
  }
  if (process.env.MAINT_STATUS) {
    const chosen = process.env.MAINT_CHOSEN || "documentation";
    out({
      ok: true,
      report: { chosen, reason: "r", outcome: { status: process.env.MAINT_STATUS } },
      filed: filed(0),
      spent,
      events: (process.env.MAINT_EVENTS || "").split(",").filter(Boolean),
    });
    process.exit(0);
  }
  if (process.env.MAINT_CHOSEN === "none") {
    // What the real CLI prints when the lane is on but no idle loop is enabled.
    out({ ok: true, report: { chosen: null, reason: "no maintenance lane enabled", outcome: null }, filed: 0, spent: false, events: [] });
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
      filed: filed(1),
      spent,
      events: ["maintenance_lane_chosen"],
    });
  }
} else {
  // The REAL `crew idle` shape (cli/index.ts): report.{loops,totalDrafts} + filed/spent.
  // IDLE_OLD_SHAPE drops filed/spent (a crew built before they existed).
  const total = Number(process.env.IDLE_TOTAL || 0);
  const body = {
    ok: true,
    report: { loops: [{ id: "documentation", outcome: { status: "no_findings" } }], totalDrafts: total, selfImprovePromoted: 0 },
    events: [],
  };
  if (process.env.IDLE_OLD_SHAPE !== "1") Object.assign(body, { filed: total, spent });
  out(body);
}
JS

# Minimal crew config so the `-f "$CREW_CONFIG"` guard passes.
CREW_CONFIG="$WORK/crew.config.yaml"; printf 'factory:\n  name: t\n' > "$CREW_CONFIG"

run_tick() {
  CREW_CALLS="$CREW_CALLS" MAINT_ENABLED="${MAINT_ENABLED:-1}" \
  MAINT_FAIL="${MAINT_FAIL:-0}" MAINT_STATUS="${MAINT_STATUS:-}" \
  MAINT_CHOSEN="${MAINT_CHOSEN:-}" MAINT_FILED="${MAINT_FILED:-}" MAINT_SPENT="${MAINT_SPENT:-0}" \
  MAINT_EVENTS="${MAINT_EVENTS:-}" \
  IDLE_TOTAL="${IDLE_TOTAL:-0}" IDLE_OLD_SHAPE="${IDLE_OLD_SHAPE:-0}" \
  MEMORY_DB="$GAFFER_DATA/memory.sqlite" MEMORY_MCP_BIN="$WORK/memory-mcp.js" CLAUDE_BIN="$WORK/stub-claude" \
  GAFFER_STRICT_REQUIRE="${GAFFER_STRICT_REQUIRE:-0}" GAFFER_IDLE_HOST_EXEC="${GAFFER_IDLE_HOST_EXEC:-0}" \
  RUNNER_DIR="$RUNNER_DIR" GAFFER_HOME="$WORK" GAFFER_DATA="$GAFFER_DATA" \
  DISPATCH_DIR="$WORK/dispatch" CREW_DIR="$WORK/crew" CREW_CONFIG="$CREW_CONFIG" \
  DRY_RUN="${DRY_RUN:-0}" REVIEW_MODE=human \
  GAFFER_MAINTENANCE="${GAFFER_MAINTENANCE-}" IDLE_DRAFT_WHEN_IDLE="${IDLE_DRAFT_WHEN_IDLE:-0}" \
  GAFFER_IDLE_FEATURE_BACKLOG="${GAFFER_IDLE_FEATURE_BACKLOG-0}" \
    bash "$RUNNER_DIR/tick.sh" 2>>"$GAFFER_DATA/stderr.log"
}
reset_log() { : > "$CREW_CALLS"; : > "$CREW_CALLS.env"; : > "$GAFFER_DATA/factory.log"; }

# ── 0. this file has no redirect glued to the next command ───────────────────
# A `>/dev/null` fused with the following word (e.g. `>/dev/nullreset_log`)
# silently drops a case's setup tick into a stray file and the suite still passes.
glued_redirects() {
  grep -nE '>[[:space:]]*/dev/null[^[:space:];|&)]' "${BASH_SOURCE[0]}" \
    | grep -vE '^[0-9]+:[[:space:]]*#' | grep -v 'grep -nE'
}
if [ -n "$(glued_redirects)" ]; then
  fail "a /dev/null redirect is glued to the next word: $(glued_redirects | head -3)"
else
  ok "no /dev/null redirect is glued to the next command"
fi

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
# A known non-drafting status is a healthy run — but it filed nothing and the scans
# call no model, so it is an EMPTY poll (no_work), not a productive maintenance_ran.
reset_log
OUT10="$(MAINT_STATUS=no_findings run_tick)"
grep -q '^TICK_RESULT=no_work$' <<<"$OUT10" \
  && grep -q "maintenance lane chose 'documentation'" "$GAFFER_DATA/factory.log" 2>/dev/null \
  && ok "a lane that ran but filed nothing (no_findings) → logged as a run, TICK_RESULT=no_work" \
  || fail "expected no_work + a chose-line for no_findings, got: $(echo "$OUT10" | grep '^TICK_RESULT=')"
if grep -q 'maintenance lane FAILED' "$GAFFER_DATA/factory.log" 2>/dev/null; then
  fail "a healthy no_findings run must not be logged as FAILED"
else
  ok "…and it is not logged as FAILED"
fi

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

# ── 11. filed nothing → no_work; spent → maintenance_ran; no lane → hint ────────
reset_log
OUT12="$(MAINT_STATUS=no_findings MAINT_SPENT=1 run_tick)"
grep -q '^TICK_RESULT=maintenance_ran$' <<<"$OUT12" \
  && ok "filed nothing but ran the paid backlog planner (spent) → maintenance_ran (counts on the day cap)" \
  || fail "expected maintenance_ran when spent, got: $(echo "$OUT12" | grep '^TICK_RESULT=')"
reset_log
OUT13="$(MAINT_STATUS=no_findings MAINT_FILED=2 run_tick)"
grep -q '^TICK_RESULT=maintenance_drafted$' <<<"$OUT13" \
  && ok "the lane filed nothing but ingest / the backlog / lore gap filed 2 (filed) → maintenance_drafted" \
  || fail "expected maintenance_drafted from filed=2, got: $(echo "$OUT13" | grep '^TICK_RESULT=')"
reset_log
OUT14="$(GAFFER_MAINTENANCE=1 MAINT_CHOSEN=none run_tick)"
grep -q '^TICK_RESULT=no_work$' <<<"$OUT14" \
  && ok "GAFFER_MAINTENANCE=1 with no lane enabled → no_work (was a productive maintenance_ran)" \
  || fail "expected no_work with no lane enabled, got: $(echo "$OUT14" | grep '^TICK_RESULT=')"
grep -q 'no maintenance loop is enabled — turn on at least one lane' "$GAFFER_DATA/factory.log" 2>/dev/null \
  && ok "…and the log says to enable a lane (the env var only overrides the master switch)" \
  || fail "missing the 'no maintenance loop is enabled' hint"
reset_log
MAINT_STATUS=no_repos MAINT_CHOSEN=coverage run_tick >/dev/null
grep -q 'the coverage lane needs a repo coverage_command' "$GAFFER_DATA/factory.log" 2>/dev/null \
  && ok "coverage lane answering no_repos → the log names the missing coverage_command" \
  || fail "missing the coverage_command hint for coverage/no_repos"

# ── 12. legacy IDLE_DRAFT_WHEN_IDLE reads the real crew idle shape ─────────────
reset_log
OUT15="$(GAFFER_MAINTENANCE=0 IDLE_DRAFT_WHEN_IDLE=1 IDLE_TOTAL=3 run_tick)"
grep -q '^TICK_RESULT=idle_drafted$' <<<"$OUT15" \
  && ok "fg idle filing 3 drafts → TICK_RESULT=idle_drafted (was no_work)" \
  || fail "expected idle_drafted for 3 drafts, got: $(echo "$OUT15" | grep '^TICK_RESULT=')"
grep -q 'idle scan filed 3 item' "$GAFFER_DATA/factory.log" 2>/dev/null \
  && ok "…and logs the real count (was always '0 draft(s)')" \
  || fail "the idle scan log line should carry the real count"
reset_log
OUT16="$(GAFFER_MAINTENANCE=0 IDLE_DRAFT_WHEN_IDLE=1 IDLE_TOTAL=2 IDLE_OLD_SHAPE=1 run_tick)"
grep -q '^TICK_RESULT=idle_drafted$' <<<"$OUT16" \
  && ok "an older crew without 'filed' → falls back to report.totalDrafts" \
  || fail "expected idle_drafted from report.totalDrafts, got: $(echo "$OUT16" | grep '^TICK_RESULT=')"
reset_log
OUT17="$(GAFFER_MAINTENANCE=0 IDLE_DRAFT_WHEN_IDLE=1 IDLE_TOTAL=0 run_tick)"
grep -q '^TICK_RESULT=no_work$' <<<"$OUT17" \
  && ok "fg idle filing nothing → no_work" \
  || fail "expected no_work for an empty idle scan, got: $(echo "$OUT17" | grep '^TICK_RESULT=')"

# ── 13. a feature parked after failed plans → the log says how to retry ──────
reset_log
MAINT_STATUS=no_findings MAINT_SPENT=1 MAINT_EVENTS=feature_backlog_failed,feature_backlog_parked run_tick >/dev/null
grep -q "feature backlog: a feature's plan failed on every attempt" "$GAFFER_DATA/factory.log" 2>/dev/null \
  && grep -q "feature-backlog-failures.json" "$GAFFER_DATA/factory.log" 2>/dev/null \
  && ok "a feature parked after failed plans → the log says idle ticks stop claiming it and where to retry" \
  || fail "missing the parked-feature hint"
reset_log
MAINT_STATUS=no_findings MAINT_SPENT=1 MAINT_EVENTS=feature_backlog_failed run_tick >/dev/null
grep -q 'maintain' "$CREW_CALLS" \
  && ! grep -q "feature backlog: a feature's plan failed" "$GAFFER_DATA/factory.log" 2>/dev/null \
  && ok "…and stays quiet for a failure under the cap (the tick did run crew maintain)" \
  || fail "the parked hint fired for a failure that did not park the feature, or the tick never ran"

# ── 14. the idle crew calls carry the memory + planner wiring ─────────────────
reset_log
MAINT_ENABLED=1 run_tick >/dev/null
# The env line below must come from THIS tick's own crew call, not a leftover
# from an earlier case: exactly one crew call, and it is `maintain`.
[ "$(grep -c . "$CREW_CALLS")" -eq 1 ] && grep -q 'maintain' "$CREW_CALLS" \
  && [ "$(grep -c . "$CREW_CALLS.env")" -eq 1 ] \
  && ok "the wiring check reads its own setup tick (one crew maintain call recorded)" \
  || fail "the wiring check's setup tick did not run exactly one crew maintain call: $(cat "$CREW_CALLS")"
ENVLINE="$(head -1 "$CREW_CALLS.env")"
grep -q "MEMORY_DB=$GAFFER_DATA/memory.sqlite" <<<"$ENVLINE" \
  && grep -q "MEMORY_MCP_BIN=$WORK/memory-mcp.js" <<<"$ENVLINE" \
  && grep -q "GAFFER_DECOMPOSE_SCRIPT=$RUNNER_DIR/bin/decompose.mjs" <<<"$ENVLINE" \
  && grep -q "CLAUDE_BIN=$WORK/stub-claude" <<<"$ENVLINE" \
  && ok "fg maintain gets MEMORY_DB, MEMORY_MCP_BIN, GAFFER_DECOMPOSE_SCRIPT and CLAUDE_BIN" \
  || fail "fg maintain env missing the idle wiring: $ENVLINE"
reset_log
GAFFER_MAINTENANCE=0 IDLE_DRAFT_WHEN_IDLE=1 run_tick >/dev/null
grep -q "GAFFER_DECOMPOSE_SCRIPT=$RUNNER_DIR/bin/decompose.mjs" "$CREW_CALLS.env" \
  && grep -q "MEMORY_MCP_BIN=$WORK/memory-mcp.js" "$CREW_CALLS.env" \
  && ok "fg idle gets the same wiring" \
  || fail "fg idle env missing the idle wiring: $(cat "$CREW_CALLS.env")"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS ($PASS checks)"; exit 0
else
  printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
fi
