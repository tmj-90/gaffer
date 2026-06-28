#!/usr/bin/env bash
# =====================================================================
# DEFINITION OF DONE (I3) — enforced DoD gate (runner/lib/dod.sh + tick.sh).
# ---------------------------------------------------------------------
# The runner runs the enabled DoD gates (tests/typecheck/lint) DETERMINISTICALLY
# in the delivery worktree BEFORE a ticket may rest in the human review lane. A
# failing gate AUTO-REJECTS the delivery back to rework with the gate output as
# evidence; a human never spends time on a failed gate.
#
#   PART A  UNIT (gaffer_run_dod_gates against real worktrees):
#     A1  a FAILING test_command fails the gate (rc=1) and names the gate;
#     A2  all gates passing → the gate passes (rc=0);
#     A3  a gate with NO command configured is SKIPPED (logged), not failed;
#     A4  a gate DISABLED by config is not run (its failing cmd is ignored);
#     A5  RESILIENCE — a gate command that errors to spawn (127) is a FAIL,
#         not a crash;
#     A6  GAFFER_DOD=0 (off) → gaffer_dod_enabled is false (today's behaviour);
#     A7  the evidence summary carries a parseable JSON line + the failing tail.
#
#   PART B  INTEGRATION (the REAL dispatch CLI): a DoD FAILURE on an in_review
#     ticket review-rejects it (in_review → refining) AND records the failing
#     checklist as evidence — proving the delivery never reaches the human lane.
#
#   PART C  the tick.sh enforcement wiring is present (parks, never submits).
#
# Zero non-dispatch deps. Run: bash test/dod-gate.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
WG_CLI="$RUNNER_DIR/../packages/dispatch/dist/cli/index.js"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

# A minimal gaffer_timeout so dod.sh runs standalone (the real one is in
# factory.config.sh; here we exercise dod.sh in isolation). It must relay the
# command's exit status faithfully so the gate verdicts are real.
gaffer_timeout() { local s="$1"; shift; "$@"; return $?; }
# shellcheck source=../lib/dod.sh
source "$RUNNER_DIR/lib/dod.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/dod-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
WT="$WORK/wt"; mkdir -p "$WT"   # a stand-in delivery worktree (cwd of each gate)

echo "== PART A: gaffer_run_dod_gates unit cases =="

# A1: a failing test_command fails the gate and names it.
RES="$WORK/a1.results"
printf 'repo\t%s\t1\t1\t1\tfalse\t-\ttrue\n' "$WT" | gaffer_run_dod_gates "$RES"; A1_RC=$?
[ "$A1_RC" -ne 0 ] && ok "A1 failing test_command → gate FAILS (rc=$A1_RC)" \
  || fail "A1 expected a non-zero gate result for a failing test_command"
grep -qE '^GATE\ttests\trepo\tFAIL' "$RES" \
  && ok "A1 the FAILing gate is recorded by name (tests)" \
  || fail "A1 expected a FAIL row for the tests gate ($(cat "$RES"))"

# A2: all gates passing → pass.
RES="$WORK/a2.results"
printf 'repo\t%s\t1\t1\t1\ttrue\t-\ttrue\n' "$WT" | gaffer_run_dod_gates "$RES"; A2_RC=$?
[ "$A2_RC" -eq 0 ] && ok "A2 all gates pass/skip → gate PASSES (rc=0)" \
  || fail "A2 expected rc=0 when every gate passes ($(cat "$RES"))"

# A3: an enabled gate with NO command configured is SKIPPED, not failed.
RES="$WORK/a3.results"
printf 'repo\t%s\t1\t1\t1\t-\t-\t-\n' "$WT" | gaffer_run_dod_gates "$RES"; A3_RC=$?
[ "$A3_RC" -eq 0 ] && ok "A3 no command configured → gate PASSES (nothing to fail)" \
  || fail "A3 expected rc=0 when no commands are configured ($(cat "$RES"))"
grep -qE '^GATE\ttests\trepo\tSKIP\t0\tno command configured' "$RES" \
  && ok "A3 the un-configured gate is logged as SKIP (not FAIL)" \
  || fail "A3 expected a SKIP/no-command row for tests ($(cat "$RES"))"

# A4: a gate DISABLED by config is not run even with a failing command.
RES="$WORK/a4.results"
printf 'repo\t%s\t0\t0\t0\tfalse\t-\tfalse\n' "$WT" | gaffer_run_dod_gates "$RES"; A4_RC=$?
[ "$A4_RC" -eq 0 ] && ok "A4 disabled gates are not run (failing cmd ignored)" \
  || fail "A4 expected rc=0 when all gates are disabled ($(cat "$RES"))"
grep -qE '^GATE\ttests\trepo\tSKIP\t0\tgate disabled by config' "$RES" \
  && ok "A4 a disabled gate is logged as SKIP/disabled" \
  || fail "A4 expected a SKIP/disabled row for tests ($(cat "$RES"))"

# A4b (R1 LOW): gaffer_dod_executed_count reports ZERO for an all-SKIP run, and
# the executed count for a run that actually ran gates.
RES="$WORK/a4b_skip.results"
printf 'repo\t%s\t1\t1\t1\t-\t-\t-\n' "$WT" | gaffer_run_dod_gates "$RES"
[ "$(gaffer_dod_executed_count "$RES")" -eq 0 ] \
  && ok "A4b an all-SKIP run reports ZERO executed gates (warn trigger)" \
  || fail "A4b expected 0 executed gates for an all-SKIP run ($(cat "$RES"))"
RES="$WORK/a4b_run.results"
printf 'repo\t%s\t1\t1\t1\ttrue\t-\ttrue\n' "$WT" | gaffer_run_dod_gates "$RES"
[ "$(gaffer_dod_executed_count "$RES")" -eq 2 ] \
  && ok "A4b a run with two real commands reports 2 executed gates" \
  || fail "A4b expected 2 executed gates ($(cat "$RES"))"

# A5: RESILIENCE — a command that errors to spawn (127) is a FAIL, not a crash.
RES="$WORK/a5.results"
printf 'repo\t%s\t1\t0\t0\t__gaffer_no_such_cmd__\t-\t-\n' "$WT" \
  | gaffer_run_dod_gates "$RES"; A5_RC=$?
[ "$A5_RC" -ne 0 ] && ok "A5 a non-spawnable gate command → FAIL (no crash)" \
  || fail "A5 expected a non-zero result for an unrunnable command"
grep -qE '^GATE\ttests\trepo\tFAIL' "$RES" \
  && ok "A5 the unrunnable gate is recorded as a FAIL" \
  || fail "A5 expected a FAIL row for the unrunnable command ($(cat "$RES"))"

# A6: GAFFER_DOD off → enforcement disabled (today's behaviour).
( GAFFER_DOD=0; gaffer_dod_enabled ) \
  && fail "A6 GAFFER_DOD=0 should DISABLE enforcement" \
  || ok "A6 GAFFER_DOD=0 → gaffer_dod_enabled is false (no enforcement)"
( GAFFER_DOD=1; gaffer_dod_enabled ) \
  && ok "A6 GAFFER_DOD=1 → enforcement on" \
  || fail "A6 GAFFER_DOD=1 should ENABLE enforcement"

# A7: the evidence summary is machine-parseable (JSON line) + carries the tail.
RES="$WORK/a7.results"
printf 'repo\t%s\t1\t0\t0\tsh -c "echo BOOM_MARKER; exit 3"\t-\t-\n' "$WT" \
  | gaffer_run_dod_gates "$RES" || true
EV="$(gaffer_dod_evidence_summary "$RES" FAIL)"
printf '%s\n' "$EV" | head -1 | grep -q '^DoD: FAIL' \
  && ok "A7 evidence summary opens with the DoD verdict line" \
  || fail "A7 expected a 'DoD: FAIL' first line ($EV)"
printf '%s\n' "$EV" | sed -n '2p' | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
assert d['dod'] == 'FAIL', d
assert any(g['gate']=='tests' and g['status']=='FAIL' for g in d['gates']), d
" 2>/dev/null \
  && ok "A7 the JSON line parses with the failing tests gate" \
  || fail "A7 expected a parseable JSON line naming the failing gate"
printf '%s' "$EV" | grep -q 'BOOM_MARKER' \
  && ok "A7 the failing command's output tail is captured for evidence" \
  || fail "A7 expected the failing output (BOOM_MARKER) in the evidence"

# A8: RESILIENCE — the evidence summary survives python3 being unavailable (awk
# fallback) and still emits a parseable JSON line carrying the verdict.
RES="$WORK/a8.results"
printf 'repo\t%s\t1\t0\t0\tfalse\t-\t-\n' "$WT" | gaffer_run_dod_gates "$RES" || true
EV8="$( python3() { return 127; }; gaffer_dod_evidence_summary "$RES" FAIL )"
printf '%s\n' "$EV8" | sed -n '2p' | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
assert d['dod'] == 'FAIL', d
assert any(g['gate']=='tests' and g['status']=='FAIL' for g in d['gates']), d
" 2>/dev/null \
  && ok "A8 the awk fallback emits a parseable JSON verdict when python3 is unavailable" \
  || fail "A8 expected a parseable fallback JSON line ($EV8)"

# ---------------------------------------------------------------------
echo "== PART B: a DoD failure auto-rejects an in_review ticket (real dispatch) =="
if [ ! -f "$WG_CLI" ]; then
  echo "  SKIP: dispatch CLI not built at $WG_CLI — skipping the integration part"
else
  DB="$WORK/wg.sqlite"
  WG() { node "$WG_CLI" --db "$DB" "$@"; }
  REPO="$WORK/repo"
  git init -q -b main "$REPO"
  git -C "$REPO" config user.email gaffer@test; git -C "$REPO" config user.name gaffer-test
  printf 'base\n' > "$REPO/README.md"; git -C "$REPO" add -A; git -C "$REPO" commit -q -m base
  WG init >/dev/null 2>&1
  # A repo whose test_command FAILS — the DoD gate must reject any delivery for it.
  WG repo add -n repo --path "$REPO" --branch main --stack typescript --test "false" >/dev/null 2>&1
  TNUM="$(WG ticket create -t "DoD integration ticket" -p solo_loose --risk low 2>&1 \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['ticket']['number'])")"
  WG repo link "$TNUM" repo >/dev/null 2>&1
  WG ticket ready "$TNUM" >/dev/null 2>&1
  # Drive it to in_review the way a delivery would: register an agent, claim the
  # chosen ticket → submit for review with the claim token.
  AGENT="$(WG agent register -n dod-agent --max-risk high 2>/dev/null \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['agent']['id'])" 2>/dev/null || echo '')"
  CLAIM="$(WG claim-ticket "$TNUM" -a "$AGENT" 2>&1 \
    | python3 -c "import sys,json;print(json.load(sys.stdin).get('claimToken',''))" 2>/dev/null || echo '')"
  WG submit "$TNUM" --token "$CLAIM" >/dev/null 2>&1 || true
  CUR="$(WG ticket show "$TNUM" 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)['ticket']['status'])" 2>/dev/null || echo '')"
  if [ "$CUR" != "in_review" ]; then
    echo "  SKIP: could not drive #$TNUM to in_review (got '$CUR') — skipping the reject assertions"
  else
    ok "B fixture: #$TNUM is in_review (delivery would await the human gate)"

    # Run the DoD gate for this repo against a non-empty delivery worktree.
    WTB="$WORK/wt-b"; mkdir -p "$WTB"
    RESB="$WORK/b.results"
    # tests=on, typecheck none, lint none; test_command "false" → the gate FAILS.
    printf 'repo\t%s\t1\t1\t1\tfalse\t-\t-\n' "$WTB" | gaffer_run_dod_gates "$RESB"; B_RC=$?
    [ "$B_RC" -ne 0 ] && ok "B the DoD gate FAILS for the repo whose test_command fails" \
      || fail "B expected the DoD gate to fail for a failing test_command"

    # The EXACT failure-handling tick.sh runs: record evidence, then review-reject.
    SUM="$(gaffer_dod_summary_line "$RESB")"
    EVB="$(gaffer_dod_evidence_summary "$RESB" FAIL)"
    WG attach-evidence "$TNUM" --type test_output --summary "$EVB" >/dev/null 2>&1 \
      && ok "B recorded the FAIL checklist as evidence on #$TNUM" \
      || fail "B could not record DoD evidence on #$TNUM"
    WG review reject "$TNUM" --to refining --reviewer factory-dod \
      --reason "Definition of Done failed: $SUM" >/dev/null 2>&1 \
      && ok "B review-rejected #$TNUM (the auto-reject path)" \
      || fail "B could not review-reject #$TNUM to refining"

    NEW="$(WG ticket show "$TNUM" 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)['ticket']['status'])" 2>/dev/null || echo '')"
    [ "$NEW" = "refining" ] && ok "B #$TNUM moved in_review → refining (never reached the human lane)" \
      || fail "B expected #$TNUM in refining after the DoD reject (got '$NEW')"
    [ "$NEW" != "in_review" ] && ok "B #$TNUM is NOT awaiting human review after the DoD failure" \
      || fail "B #$TNUM is still in_review — the DoD reject did not take"

    # The evidence is durably attached + parseable for the next attempt / the board.
    EVCOUNT="$(WG ticket show "$TNUM" 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
ev = [e for e in (d.get('evidence') or []) if str(e.get('summary') or '').startswith('DoD: ')]
print(len(ev))
" 2>/dev/null || echo 0)"
    [ "${EVCOUNT:-0}" -ge 1 ] && ok "B the DoD evidence row is durably attached to #$TNUM" \
      || fail "B expected a 'DoD: …' evidence row on #$TNUM (found $EVCOUNT)"
  fi
fi

# ---------------------------------------------------------------------
echo "== PART C: tick.sh enforcement wiring is present =="
grep -q 'Stabilisation gate 2.5: DEFINITION OF DONE' "$RUNNER_DIR/tick.sh" \
  && ok "C tick.sh has the DoD stabilisation gate" \
  || fail "C tick.sh missing the DoD gate block"
grep -q 'gaffer_run_dod_gates' "$RUNNER_DIR/tick.sh" \
  && ok "C tick.sh invokes gaffer_run_dod_gates (runner-run, not the agent)" \
  || fail "C tick.sh does not call gaffer_run_dod_gates"
grep -q 'reviewer factory-dod' "$RUNNER_DIR/tick.sh" \
  && ok "C a DoD failure review-rejects to refining (auto-reject, not the human)" \
  || fail "C tick.sh missing the DoD review-reject path"
# Fail-CLOSED on an unresolvable config: an unparseable dispatch payload must NOT
# pretend "no commands" and ship unverified work — it parks instead.
grep -q '@@DOD_PARSE_OK@@' "$RUNNER_DIR/tick.sh" \
  && ok "C tick.sh fails CLOSED when gate commands can't be resolved (no fail-open)" \
  || fail "C tick.sh missing the parse-sentinel fail-closed guard"
# The gate must sit BEFORE the delivery is recorded/submitted.
DOD_LINE="$(grep -n 'Stabilisation gate 2.5: DEFINITION OF DONE' "$RUNNER_DIR/tick.sh" | head -1 | cut -d: -f1)"
REC_LINE="$(grep -n 'Deterministically record the TOP-LEVEL delivery' "$RUNNER_DIR/tick.sh" | head -1 | cut -d: -f1)"
if [ -n "$DOD_LINE" ] && [ -n "$REC_LINE" ] && [ "$DOD_LINE" -lt "$REC_LINE" ]; then
  ok "C the DoD gate runs BEFORE the delivery is recorded (line $DOD_LINE < $REC_LINE)"
else
  fail "C the DoD gate must precede delivery recording (dod=$DOD_LINE rec=$REC_LINE)"
fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
