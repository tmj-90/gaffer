#!/usr/bin/env bash
# =====================================================================
# MACHINE-CHECKABLE ACs — gaffer_run_ac_checks (lib/ac-checks.sh) against the REAL
# dispatch CLI + a real temp DB.
#   • an AC with a passing check_command → AC satisfied, verified_by=runner:check,
#     a test_output evidence row, a PASS GATE row; function returns 0;
#   • a failing check → AC failed, FAIL GATE row + framed output tail; returns 1;
#   • a prose AC (no check) is not run; no ACs with checks ⇒ count 0 / returns 0;
#   • the check runs IN the worktree (cwd) — proven by a marker file;
#   • tick.sh wires the block after the DoD gates and feeds a failure to the
#     recoverable path (source pins).
# Run: bash runner/test/ac-checks.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CLI="$ROOT/packages/dispatch/dist/cli/index.js"
[ -f "$CLI" ] || { echo "SKIP: dispatch CLI not built ($CLI)"; exit 0; }

P=0; F=0
ok(){ P=$((P + 1)); printf '  ok   %s\n' "$1"; }
no(){ F=$((F + 1)); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ac-checks.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
export GAFFER_DATA="$WORK/data"; mkdir -p "$GAFFER_DATA"
export DISPATCH_DB="$WORK/dispatch.sqlite"
export DISPATCH_DIR="$ROOT/packages/dispatch"
export GAFFER_DOD_TIMEOUT=30 GAFFER_DOD_OUTPUT_TAIL=40
log(){ :; }
wg(){ node "$CLI" --db "$DISPATCH_DB" "$@"; }
# Only `init` creates a database (a missing --db is refused, exploratory finding cli-wg/F-09).
wg init >/dev/null || { echo "FAIL: wg init"; exit 1; }
gaffer_assert_db_vars(){ return 0; }
jget(){ node "$RUNNER_DIR/lib/json-tool.mjs" expr "$1"; }
# The real primitives the lib composes: the gate runner + distiller from lib/dod.sh.
# Faithful relay (same shim the dod-gate + e2e tests use): the bound is not under test
# here, and GNU `timeout` does not exist on macOS — the previous stub made every check
# exit 127 on the macOS CI runner.
gaffer_timeout(){ shift; "$@"; }
# shellcheck source=../lib/dod.sh
source "$RUNNER_DIR/lib/dod.sh"
# shellcheck source=../lib/ac-checks.sh
source "$RUNNER_DIR/lib/ac-checks.sh"

WT="$WORK/wt"; mkdir -p "$WT"
T="$(wg ticket create --title "Checked delivery" 2>"$WORK/create.err")"
NUM="$(printf '%s' "$T" | jget 'd.number ?? d.ticket?.number' 2>/dev/null)"
[ -n "$NUM" ] && [ "$NUM" != "None" ] || { echo "FAIL: \`ticket create\` returned no ticket number — the dispatch CLI contract this test guards (got: ${T:0:200} $(head -c 200 "$WORK/create.err"))"; exit 1; }

echo "== 1: passing + failing checks, prose AC untouched =="
wg ac add "$NUM" -t "marker written" --check 'touch ran-here.marker && test -f ran-here.marker' >/dev/null
wg ac add "$NUM" -t "this one fails" --check 'echo boom-detail >&2; exit 3' >/dev/null
wg ac add "$NUM" -t "prose only" >/dev/null
SHOW="$(wg ticket show "$NUM")"
[ "$(gaffer_ac_check_count "$SHOW")" = "2" ] && ok "gaffer_ac_check_count counts the 2 checked ACs (prose AC excluded)" || no "count wrong: $(gaffer_ac_check_count "$SHOW")"

RES="$WORK/ac.results"; : > "$RES"
gaffer_run_ac_checks "$NUM" "$SHOW" "$WT" "$RES"; rc=$?
[ "$rc" = "1" ] && ok "returns 1 when any check fails" || no "expected rc 1 (got $rc)"
[ -f "$WT/ran-here.marker" ] && ok "the check ran IN the worktree (marker present)" || no "check did not run in the worktree"
grep -q $'^GATE\tac-check\tAC1: marker written\tPASS' "$RES" && ok "PASS GATE row for the passing AC" || no "no PASS row"
grep -q $'^GATE\tac-check\tAC2: this one fails\tFAIL\t3' "$RES" && ok "FAIL GATE row (rc 3) for the failing AC" || no "no FAIL row"
grep -q "boom-detail" "$RES" && ok "the failing check's output tail is framed into the results" || no "output tail missing"
! grep -q "prose only" "$RES" && ok "the prose AC produced no GATE row" || no "prose AC was run"

AFTER="$(wg ticket show "$NUM")"
S1="$(printf '%s' "$AFTER" | jget 'd.acceptanceCriteria.find((a) => a.text === "marker written").status')"
V1="$(printf '%s' "$AFTER" | jget 'd.acceptanceCriteria.find((a) => a.text === "marker written").verified_by')"
S2="$(printf '%s' "$AFTER" | jget 'd.acceptanceCriteria.find((a) => a.text === "this one fails").status')"
S3="$(printf '%s' "$AFTER" | jget 'd.acceptanceCriteria.find((a) => a.text === "prose only").status')"
[ "$S1" = "satisfied" ] && [ "$V1" = "runner:check" ] && ok "passing AC → satisfied, verified_by=runner:check" || no "passing AC state wrong (status=$S1 verified_by=$V1)"
[ "$S2" = "failed" ] && ok "failing AC → failed" || no "failing AC status=$S2"
[ "$S3" = "pending" ] && ok "prose AC stays pending" || no "prose AC status=$S3"
EVN="$(printf '%s' "$AFTER" | jget '(d.evidence || []).filter((e) => e.evidence_type === "test_output" && (e.summary || "").includes("AC check")).length' 2>/dev/null || echo 0)"
[ "$EVN" = "2" ] && ok "two test_output evidence rows (one per executed check)" || no "expected 2 AC-check evidence rows (got $EVN)"

echo "== 2: all checks pass ⇒ returns 0 =="
T2="$(wg ticket create --title "All green")"
N2="$(printf '%s' "$T2" | jget 'd.number ?? d.ticket?.number')"
wg ac add "$N2" -t "true passes" --check 'true' >/dev/null
RES2="$WORK/ac2.results"; : > "$RES2"
gaffer_run_ac_checks "$N2" "$(wg ticket show "$N2")" "$WT" "$RES2" && ok "returns 0 when every check passes" || no "expected rc 0"
[ "$(grep -c '^GATE' "$RES2")" = "1" ] && ok "exactly one GATE row" || no "GATE rows: $(grep -c '^GATE' "$RES2")"

echo "== 3: no checked ACs ⇒ count 0, no-op =="
T3="$(wg ticket create --title "Prose only")"
N3="$(printf '%s' "$T3" | jget 'd.number ?? d.ticket?.number')"
wg ac add "$N3" -t "prose" >/dev/null
[ "$(gaffer_ac_check_count "$(wg ticket show "$N3")")" = "0" ] && ok "count 0 for a ticket with no checked ACs" || no "count should be 0"
RES3="$WORK/ac3.results"; : > "$RES3"
gaffer_run_ac_checks "$N3" "$(wg ticket show "$N3")" "$WT" "$RES3" && [ ! -s "$RES3" ] && ok "no-op returns 0 and writes no rows" || no "no-op misbehaved"

echo "== 3b: a check that reads stdin cannot swallow the later checks =="
# The AC rows are looped on stdin; a check that read stdin used to eat AC-2's row, so
# AC-2 never ran and gaffer_run_ac_checks returned 0.
T4="$(wg ticket create --title "Stdin reader")"
N4="$(printf '%s' "$T4" | jget 'd.number ?? d.ticket?.number')"
wg ac add "$N4" -t "reads stdin" --check 'read x; cat >/dev/null; exit 0' >/dev/null
wg ac add "$N4" -t "then fails" --check 'echo second-fails >&2; exit 1' >/dev/null
RES4="$WORK/ac4.results"; : > "$RES4"
gaffer_run_ac_checks "$N4" "$(wg ticket show "$N4")" "$WT" "$RES4"; rc4=$?
[ "$rc4" = "1" ] && ok "a stdin-reading AC-1 does not swallow AC-2 (returns 1)" || no "expected rc 1 (got $rc4 — AC-2 was swallowed)"
grep -q $'^GATE\tac-check\tAC2: then fails\tFAIL' "$RES4" && ok "AC-2 ran and is recorded FAIL" || no "no AC-2 FAIL row: $(tr '\n' '|' < "$RES4")"
S42="$(wg ticket show "$N4" | jget 'd.acceptanceCriteria.find((a) => a.text === "then fails").status')"
[ "$S42" = "failed" ] && ok "AC-2's verdict reached dispatch (failed)" || no "AC-2 status=$S42"
RES5="$WORK/ac5.results"; : > "$RES5"
CREW_DIR="$WORK/no-crew" gaffer_run_ac_checks "$N4" "$(wg ticket show "$N4")" "$WT" "$RES5"
grep -q 'second-fails' "$RES5" && ok "without the crew dist the failing check's output still lands in the results (tail fallback)" || no "AC output tail lost without the crew dist"

echo "== 4: tick.sh wiring =="
grep -q 'gaffer_run_ac_checks "$NUM" "$SHOW" "$PRIMARY_REPO" "$AC_RESULTS"' "$RUNNER_DIR/tick.sh" && ok "tick.sh runs the AC checks in the primary worktree" || no "tick.sh does not call gaffer_run_ac_checks"
grep -q '_recover_or_park "acceptance-check"' "$RUNNER_DIR/tick.sh" && ok "a failing check feeds the recoverable retry-or-park path" || no "no recoverable handling for AC checks"
grep -q 'lib/ac-checks.sh' "$RUNNER_DIR/factory.config.sh" && ok "factory.config.sh sources lib/ac-checks.sh" || no "lib not sourced"

echo
echo "ac-checks: $P passed, $F failed"
[ "$F" = 0 ]
