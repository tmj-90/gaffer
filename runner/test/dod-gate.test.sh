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
#   PART B  INTEGRATION (the REAL dispatch CLI): an EXHAUSTED DoD rework parks a
#     CLAIMED delivery to the VISIBLE `blocked` column (rework_exhausted) via
#     `wg runner-release`, releasing the claim + recording the structured feedback
#     and a ticket.blocked event — proving the ticket is never lost to a human.
#
#   PART C  the tick.sh enforcement + escalation/real-feedback wiring is present.
#
#   PART E  REAL-FEEDBACK extraction: the distiller keeps the actual failing test +
#     assertion (vitest + maven), drops the summary/count line, and falls back to a
#     tail when no framework signal matches; the extractor round-trips it.
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
grep -qE $'^GATE\ttests\trepo\tFAIL' "$RES" \
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
grep -qE $'^GATE\ttests\trepo\tSKIP\t0\tno command configured' "$RES" \
  && ok "A3 the un-configured gate is logged as SKIP (not FAIL)" \
  || fail "A3 expected a SKIP/no-command row for tests ($(cat "$RES"))"

# A4: a gate DISABLED by config is not run even with a failing command.
RES="$WORK/a4.results"
printf 'repo\t%s\t0\t0\t0\tfalse\t-\tfalse\n' "$WT" | gaffer_run_dod_gates "$RES"; A4_RC=$?
[ "$A4_RC" -eq 0 ] && ok "A4 disabled gates are not run (failing cmd ignored)" \
  || fail "A4 expected rc=0 when all gates are disabled ($(cat "$RES"))"
grep -qE $'^GATE\ttests\trepo\tSKIP\t0\tgate disabled by config' "$RES" \
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
grep -qE $'^GATE\ttests\trepo\tFAIL' "$RES" \
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
echo "== PART B: an exhausted DoD rework parks a CLAIMED delivery to VISIBLE blocked (real dispatch) =="
# RUNNER-OWNED-BOOKKEEPING + REWORK LOOP: the runner holds the claim and never submits
# a failing delivery for review. When the rework loop exhausts, tick.sh parks the
# runner-held claim to the VISIBLE `blocked` column (rework_exhausted) via
# `wg runner-release`, preserving the branch — a human always sees the parked ticket
# (never the invisible `refining`/draft column). This exercises that exact path.
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
  WG ac add "$TNUM" -t "DoD integration AC" >/dev/null 2>&1   # GUARD A: ≥1 AC to ready
  WG ticket ready "$TNUM" >/dev/null 2>&1
  # The runner claims the ticket at selection and HOLDS the token for the whole
  # delivery (it never submits a failing one). Drive to that state.
  AGENT="$(WG agent register -n dod-agent --max-risk high 2>/dev/null \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['agent']['id'])" 2>/dev/null || echo '')"
  CLAIM="$(WG claim-ticket "$TNUM" -a "$AGENT" 2>&1 \
    | python3 -c "import sys,json;print(json.load(sys.stdin).get('claimToken',''))" 2>/dev/null || echo '')"
  CUR="$(WG ticket show "$TNUM" 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)['ticket']['status'])" 2>/dev/null || echo '')"
  if [ "$CUR" != "claimed" ] || [ -z "$CLAIM" ]; then
    echo "  SKIP: could not drive #$TNUM to claimed (got '$CUR') — skipping the park assertions"
  else
    ok "B fixture: #$TNUM is claimed (the runner holds the delivery claim)"

    # Run the DoD gate for this repo against a non-empty delivery worktree.
    WTB="$WORK/wt-b"; mkdir -p "$WTB"
    RESB="$WORK/b.results"
    # tests=on, typecheck none, lint none; test_command "false" → the gate FAILS.
    printf 'repo\t%s\t1\t1\t1\tfalse\t-\t-\n' "$WTB" | gaffer_run_dod_gates "$RESB"; B_RC=$?
    [ "$B_RC" -ne 0 ] && ok "B the DoD gate FAILS for the repo whose test_command fails" \
      || fail "B expected the DoD gate to fail for a failing test_command"

    # The EXACT failure-handling tick.sh runs when rework EXHAUSTS: record evidence,
    # then park the runner-held claim to the VISIBLE blocked column (rework_exhausted).
    EVB="$(gaffer_dod_evidence_summary "$RESB" FAIL)"
    WG attach-evidence "$TNUM" --type test_output --summary "$EVB" >/dev/null 2>&1 \
      && ok "B recorded the FAIL checklist as evidence on #$TNUM" \
      || fail "B could not record DoD evidence on #$TNUM"
    WG runner-release "$TNUM" --to blocked --token "$CLAIM" \
      --reason "Definition of Done failed after 3 attempts (branch preserved)" \
      --reason-code rework_exhausted --attempt 3 --max 3 >/dev/null 2>&1 \
      && ok "B parked #$TNUM to blocked via runner-release (the exhausted-rework path)" \
      || fail "B could not park #$TNUM to blocked via runner-release"

    NEW="$(WG ticket show "$TNUM" 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)['ticket']['status'])" 2>/dev/null || echo '')"
    [ "$NEW" = "blocked" ] && ok "B #$TNUM moved claimed → blocked (VISIBLE column, never invisible refining)" \
      || fail "B expected #$TNUM in blocked after the exhausted-rework park (got '$NEW')"

    # The structured rework_exhausted feedback surfaces on the card, and the claim is
    # released (no dangling claim on a parked ticket).
    WG ticket show "$TNUM" 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
t = d['ticket']
fb = t.get('last_review_feedback')
fb = json.loads(fb) if isinstance(fb, str) and fb.strip() else (fb or {})
assert fb.get('code') == 'rework_exhausted', fb
assert fb.get('attempt') == 3 and fb.get('maxAttempts') == 3, fb
# the runner-held claim is released as part of the park (claim.released event)
rel = [e for e in (d.get('events') or []) if e.get('event_type') == 'claim.released']
assert rel, 'expected a claim.released event on the parked ticket (no dangling claim)'
" 2>/dev/null \
      && ok "B the card carries rework_exhausted (attempt 3/3) and the claim is released" \
      || fail "B expected rework_exhausted feedback + released claim on #$TNUM"

    # A ticket.blocked event is on the activity trail (the human-unblock gate).
    WG ticket show "$TNUM" 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
evs = [e for e in (d.get('events') or []) if e.get('event_type') == 'ticket.blocked']
assert evs, 'no ticket.blocked event on the trail'
" 2>/dev/null \
      && ok "B a ticket.blocked event is recorded (activity trail + unblock gate)" \
      || fail "B expected a ticket.blocked event on #$TNUM"
  fi
fi

# ---------------------------------------------------------------------
echo "== PART E: REAL-FEEDBACK extraction (distiller + extractor) =="
# The crux of (b): the next attempt must see the ACTUAL failing test + assertion,
# not the count/summary line or a blind tail. Cover vitest AND mvn.
VITEST_OUT="$WORK/vitest.out"
cat > "$VITEST_OUT" <<'VEOF'
 RUN  v1.6.0
 ❯ src/sum.test.ts (1 test | 1 failed)
   ✕ adds numbers
 FAIL  src/sum.test.ts > adds numbers
AssertionError: expected 3 to be 4
 ❯ src/sum.test.ts:5:23
 Test Files  1 failed (1)
      Tests  1 failed (1)
VEOF
V_DISTILLED="$(gaffer_dod_distill_output "$VITEST_OUT" 40)"
printf '%s' "$V_DISTILLED" | grep -q 'AssertionError: expected 3 to be 4' \
  && ok "E vitest: the distiller keeps the real assertion (expected 3 to be 4)" \
  || fail "E vitest: distiller lost the assertion ($V_DISTILLED)"
printf '%s' "$V_DISTILLED" | grep -q 'adds numbers' \
  && ok "E vitest: the distiller keeps the failing test name" \
  || fail "E vitest: distiller lost the failing test name ($V_DISTILLED)"
printf '%s' "$V_DISTILLED" | grep -q 'Test Files  1 failed' \
  && fail "E vitest: distiller kept the summary COUNT line (should drop it)" \
  || ok "E vitest: the distiller DROPS the summary count line (not a blind tail)"

MVN_OUT="$WORK/mvn.out"
cat > "$MVN_OUT" <<'MEOF'
[INFO] Running com.example.CalcTest
[ERROR] Tests run: 1, Failures: 1 <<< FAILURE!
org.opentest4j.AssertionFailedError: expected: <4> but was: <3>
	at com.example.CalcTest.testAdd(CalcTest.java:12)
MEOF
M_DISTILLED="$(gaffer_dod_distill_output "$MVN_OUT" 40)"
printf '%s' "$M_DISTILLED" | grep -q 'expected: <4> but was: <3>' \
  && ok "E maven: the distiller keeps the real assertion (expected <4> but was <3>)" \
  || fail "E maven: distiller lost the assertion ($M_DISTILLED)"

# The extractor round-trips a framed results block back to feedback text.
RESE="$WORK/e.results"
printf 'repo\t%s\t1\t0\t0\tsh -c "echo AssertionError: boom; echo \\"  at f.ts:1:2\\"; exit 1"\t-\t-\n' "$WT" \
  | gaffer_run_dod_gates "$RESE" || true
E_FB="$(gaffer_dod_extract_failure "$RESE")"
printf '%s' "$E_FB" | grep -q 'AssertionError: boom' \
  && ok "E the extractor pulls the distilled real failure out of the results file" \
  || fail "E extractor lost the failure ($E_FB)"
printf '%s' "$E_FB" | grep -q 'failing gate: tests@repo' \
  && ok "E the extracted feedback names the failing gate" \
  || fail "E extractor did not name the failing gate ($E_FB)"

# Fallback: output with NO framework signal still yields the tail (never empty).
NOSIG="$WORK/nosig.out"
printf 'random line one\nrandom line two\n' > "$NOSIG"
N_DISTILLED="$(gaffer_dod_distill_output "$NOSIG" 40)"
printf '%s' "$N_DISTILLED" | grep -q 'random line two' \
  && ok "E no-signal output falls back to the tail (a failure is never lost)" \
  || fail "E fallback tail lost the output ($N_DISTILLED)"

# ---------------------------------------------------------------------
echo "== PART C: tick.sh enforcement wiring is present =="
grep -q 'Stabilisation gate 2.5: DEFINITION OF DONE' "$RUNNER_DIR/tick.sh" \
  && ok "C tick.sh has the DoD stabilisation gate" \
  || fail "C tick.sh missing the DoD gate block"
grep -q 'gaffer_run_dod_gates' "$RUNNER_DIR/tick.sh" \
  && ok "C tick.sh invokes gaffer_run_dod_gates (runner-run, not the agent)" \
  || fail "C tick.sh does not call gaffer_run_dod_gates"
# RUNNER-OWNED-BOOKKEEPING + REWORK LOOP: a DoD failure no longer review-rejects an
# in_review ticket (the runner holds the claim and has NOT submitted). It routes
# through _recover_or_park, which retries (staying VISIBLY in_progress) then parks the
# held claim to the VISIBLE `blocked` column (rework_exhausted) via the runner-release
# path — the branch is preserved, and a human always sees the parked ticket.
grep -q '_recover_or_park "definition-of-done"' "$RUNNER_DIR/tick.sh" \
  && ok "C a DoD failure reworks via _recover_or_park (auto-reject, not the human)" \
  || fail "C tick.sh missing the DoD _recover_or_park path"
perl -0777 -ne 'exit 0 if /Cap OR per-ticket cost ceiling hit.*?gaffer_release_delivery blocked "\$_reason" rework_exhausted/ms; exit 1' "$RUNNER_DIR/tick.sh" \
  && ok "C an exhausted-rework park releases the held claim to the VISIBLE blocked column (rework_exhausted)" \
  || fail "C _recover_or_park does not park the runner-held claim to blocked/rework_exhausted"
# The rework path must NOT route to refining (invisible draft column) — it stays
# in_progress while reworking (runner-rework) and lands in blocked when exhausted.
# Scope the check to the _recover_or_park function BODY (other tick.sh park paths —
# submit-failed, bootstrap — legitimately still use refining and are out of scope).
perl -0777 -ne 'if (/_recover_or_park\(\) \{(.*?)\n  \}/ms) { exit(($1 =~ /gaffer_release_delivery refining/) ? 0 : 1) } exit 1' "$RUNNER_DIR/tick.sh" \
  && fail "C the rework park path still routes to refining (should be blocked — invisible to a human)" \
  || ok "C the rework park path does NOT route to refining (retired for visibility)"
grep -q 'wg runner-rework "\$NUM"' "$RUNNER_DIR/tick.sh" \
  && ok "C a retry surfaces the rework attempt on the card (runner-rework, stays in_progress)" \
  || fail "C tick.sh does not surface the rework attempt via runner-rework"
# The re-invocation must feed the DISTILLED real failure (not just the gate summary).
grep -q 'gaffer_dod_extract_failure "\$DOD_RESULTS"' "$RUNNER_DIR/tick.sh" \
  && ok "C a DoD failure extracts the REAL failure (assertion) to feed the next attempt" \
  || fail "C tick.sh does not extract the real DoD failure for the next attempt"
grep -q 'PROMPT\$_REWORK_BLOCK' "$RUNNER_DIR/tick.sh" \
  && ok "C the re-invoked agent gets the real-failure REVIEW FEEDBACK block appended to its prompt" \
  || fail "C tick.sh does not append the rework feedback block to the re-invocation prompt"
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

# ---------------------------------------------------------------------
echo "== PART D: FIX-6 — zero-gate enforcement and GAFFER_ALLOW_NO_DOD opt-out =="
# D1: a delivery where ZERO DoD gates executed must be a FAIL, not just a warning.
#     Verify that gaffer_dod_executed_count returns 0 for an all-skip run (the
#     condition tick.sh checks) and that tick.sh handles it as a hard fail.
RES="$WORK/d1.results"
printf 'repo\t%s\t1\t1\t1\t-\t-\t-\n' "$WT" | gaffer_run_dod_gates "$RES"; D1_RC=$?
[ "$D1_RC" -eq 0 ] \
  && ok "D1 all-skip run returns rc=0 from gaffer_run_dod_gates (gate itself is neutral)" \
  || fail "D1 expected rc=0 from an all-skip run ($(cat "$RES"))"
D1_COUNT="$(gaffer_dod_executed_count "$RES")"
[ "$D1_COUNT" -eq 0 ] \
  && ok "D1 gaffer_dod_executed_count=0 confirmed — triggers tick.sh zero-gate fail path" \
  || fail "D1 expected 0 executed gates, got $D1_COUNT"
# tick.sh must FAIL (not just warn) when count=0 and GAFFER_ALLOW_NO_DOD is unset:
grep -q 'GAFFER_ALLOW_NO_DOD' "$RUNNER_DIR/tick.sh" \
  && ok "D1 tick.sh has the GAFFER_ALLOW_NO_DOD guard (not just a warning)" \
  || fail "D1 tick.sh is missing the GAFFER_ALLOW_NO_DOD gate"
grep -qF 'zero DoD gates executed' "$RUNNER_DIR/tick.sh" \
  && ok "D1 tick.sh fails with a zero-gates-executed message (not a silent pass)" \
  || fail "D1 tick.sh does not have the zero-gates-executed FAIL message"

# D2: GAFFER_ALLOW_NO_DOD=1 is the explicit opt-out that allows zero-gate deliveries.
grep -qE "GAFFER_ALLOW_NO_DOD.*=.*['\"]?1['\"]?" "$RUNNER_DIR/tick.sh" \
  && ok "D2 GAFFER_ALLOW_NO_DOD=1 is the explicit opt-out in tick.sh" \
  || fail "D2 tick.sh missing the GAFFER_ALLOW_NO_DOD=1 opt-out guard"
# The opt-out must emit a visible warning (not a silent bypass):
grep -q 'GAFFER_ALLOW_NO_DOD=1 waiver' "$RUNNER_DIR/tick.sh" \
  && ok "D2 the opt-out path logs a visible WARNING (not a silent bypass)" \
  || fail "D2 tick.sh opt-out path must log a visible waiver warning"

# D3: GAFFER_ALLOW_NO_DOD is documented in factory.config.sh (one-liner for operators).
grep -q 'GAFFER_ALLOW_NO_DOD' "$RUNNER_DIR/factory.config.sh" \
  && ok "D3 GAFFER_ALLOW_NO_DOD is documented in factory.config.sh" \
  || fail "D3 GAFFER_ALLOW_NO_DOD must be documented in factory.config.sh"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
