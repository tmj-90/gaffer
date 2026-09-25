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
trap 'rm -rf "$WORK"' EXIT
export GAFFER_DATA="$WORK/data"; mkdir -p "$GAFFER_DATA"
export DISPATCH_DB="$WORK/dispatch.sqlite"
export DISPATCH_DIR="$ROOT/packages/dispatch"
export GAFFER_DOD_TIMEOUT=30 GAFFER_DOD_OUTPUT_TAIL=40
log(){ :; }
wg(){ node "$CLI" --db "$DISPATCH_DB" "$@"; }
gaffer_assert_db_vars(){ return 0; }
jget(){ python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }
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
T="$(wg ticket create --title "Checked delivery" --json 2>/dev/null || wg ticket create --title "Checked delivery")"
NUM="$(printf '%s' "$T" | jget "d.get('number') or d.get('ticket',{}).get('number')" 2>/dev/null)"
[ -n "$NUM" ] && [ "$NUM" != "None" ] || { echo "SKIP: could not create a ticket via the CLI (got: ${T:0:120})"; exit 0; }

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
S1="$(printf '%s' "$AFTER" | jget "[a for a in d['acceptanceCriteria'] if a['text']=='marker written'][0]['status']")"
V1="$(printf '%s' "$AFTER" | jget "[a for a in d['acceptanceCriteria'] if a['text']=='marker written'][0]['verified_by']")"
S2="$(printf '%s' "$AFTER" | jget "[a for a in d['acceptanceCriteria'] if a['text']=='this one fails'][0]['status']")"
S3="$(printf '%s' "$AFTER" | jget "[a for a in d['acceptanceCriteria'] if a['text']=='prose only'][0]['status']")"
[ "$S1" = "satisfied" ] && [ "$V1" = "runner:check" ] && ok "passing AC → satisfied, verified_by=runner:check" || no "passing AC state wrong (status=$S1 verified_by=$V1)"
[ "$S2" = "failed" ] && ok "failing AC → failed" || no "failing AC status=$S2"
[ "$S3" = "pending" ] && ok "prose AC stays pending" || no "prose AC status=$S3"
EVN="$(printf '%s' "$AFTER" | jget "len([e for e in d.get('evidence',[]) if e.get('evidence_type')=='test_output' and 'AC check' in (e.get('summary') or '')])" 2>/dev/null || echo 0)"
[ "$EVN" = "2" ] && ok "two test_output evidence rows (one per executed check)" || no "expected 2 AC-check evidence rows (got $EVN)"

echo "== 2: all checks pass ⇒ returns 0 =="
T2="$(wg ticket create --title "All green")"
N2="$(printf '%s' "$T2" | jget "d.get('number') or d.get('ticket',{}).get('number')")"
wg ac add "$N2" -t "true passes" --check 'true' >/dev/null
RES2="$WORK/ac2.results"; : > "$RES2"
gaffer_run_ac_checks "$N2" "$(wg ticket show "$N2")" "$WT" "$RES2" && ok "returns 0 when every check passes" || no "expected rc 0"
[ "$(grep -c '^GATE' "$RES2")" = "1" ] && ok "exactly one GATE row" || no "GATE rows: $(grep -c '^GATE' "$RES2")"

echo "== 3: no checked ACs ⇒ count 0, no-op =="
T3="$(wg ticket create --title "Prose only")"
N3="$(printf '%s' "$T3" | jget "d.get('number') or d.get('ticket',{}).get('number')")"
wg ac add "$N3" -t "prose" >/dev/null
[ "$(gaffer_ac_check_count "$(wg ticket show "$N3")")" = "0" ] && ok "count 0 for a ticket with no checked ACs" || no "count should be 0"
RES3="$WORK/ac3.results"; : > "$RES3"
gaffer_run_ac_checks "$N3" "$(wg ticket show "$N3")" "$WT" "$RES3" && [ ! -s "$RES3" ] && ok "no-op returns 0 and writes no rows" || no "no-op misbehaved"

echo "== 4: tick.sh wiring =="
grep -q 'gaffer_run_ac_checks "$NUM" "$SHOW" "$PRIMARY_REPO" "$AC_RESULTS"' "$RUNNER_DIR/tick.sh" && ok "tick.sh runs the AC checks in the primary worktree" || no "tick.sh does not call gaffer_run_ac_checks"
grep -q '_recover_or_park "acceptance-check"' "$RUNNER_DIR/tick.sh" && ok "a failing check feeds the recoverable retry-or-park path" || no "no recoverable handling for AC checks"
grep -q 'lib/ac-checks.sh' "$RUNNER_DIR/factory.config.sh" && ok "factory.config.sh sources lib/ac-checks.sh" || no "lib not sourced"

echo
echo "ac-checks: $P passed, $F failed"
[ "$F" = 0 ]
