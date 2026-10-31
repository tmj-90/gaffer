#!/usr/bin/env bash
# =====================================================================
# GATE INTEGRITY, end to end through the REAL tick.sh (lib/stub-tick.sh: a real repo,
# the real dispatch + memory CLIs, a stub `claude` that spends nothing). Each stub
# delivery BREAKS a() (the repo's only test asserts a() === 1) and weakens the gate:
#
#   1. redirect-tests: rewrites scripts.test to a no-op. The DoD gate runs the BASE
#      commit's script instead, so the broken delivery FAILS DoD and never reaches
#      review; the evidence records source base-pinned and an integrity FLAG.
#   2. skip-test: marks the test `test.skip`. DoD passes (the test is skipped) but the
#      integrity row FLAGs it, dispatch's diff carries `test-modified` (high), the
#      agent reviewer's approve is HELD server-side (OBSERVED_RISK_ESCALATED, event
#      with the hold), and a human's approve still goes through.
#   3. delete-test with a human's allow_test_changes set first: the integrity row is
#      PASS with a note naming the deleted test (and the allowance is in the events).
#   4. hook-hide: leaves scripts.test alone but ADDS a pretest that hides the failing
#      test (and a posttest that restores it). The gate runs the base script without
#      the delivery's hooks, so it FAILS; the integrity row flags the added pretest.
#   5. move-base: commits a test.skip, moves `main` onto it (update-ref), commits again. The runner
#      recorded the base commit before the agent ran, so its integrity row and
#      dispatch's server-side scan still see the skip, and the auto-approve is held.
#
# Requires node, git, perl and the built dispatch / memory / crew dists; SKIPs otherwise.
# Cases 6-10 (in-tick retries, package-manager rc files, files hidden from git) are in
# gate-integrity-e2e-retry.test.sh.
# Run: bash runner/test/gate-integrity-e2e.test.sh   (KEEP=1 keeps the temp dir)
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
# shellcheck source=lib/gate-integrity-e2e.sh
source "$HERE/lib/gate-integrity-e2e.sh"

echo "== 1. a delivery that rewrites scripts.test cannot redirect its own gate =="
T1="$(new_ready "Redirect the gate" "deliver a helper")"
echo redirect-tests > "$MODE"; run_tick >/dev/null
[ "$(st "$T1")" != "in_review" ] && ok "1: the broken delivery did NOT reach review (status $(st "$T1"))" \
  || fail "1: #$T1 reached in_review with a redirected test script"
J1="$(dod_json "$T1")"
[ "$(gate_field "$J1" tests status)" = FAIL ] && [[ "$(gate_field "$J1" tests source)" == base-pinned:* ]] \
  && ok "1: the tests gate ran the BASE script and FAILED (source base-pinned)" \
  || fail "1: evidence: $J1"
[ "$(gate_field "$J1" integrity status)" = FLAG ] && ok "1: the integrity row FLAGged the rewritten script" \
  || fail "1: integrity row: $(gate_field "$J1" integrity note)"
grep -q "DoD: integrity FLAG for #$T1" "$GAFFER_DATA/factory.log" && ok "1: the factory log carries the FLAG" \
  || fail "1: no integrity FLAG line in factory.log"
retire "$T1"

echo "== 2. a skipped test: DoD passes, integrity FLAGs, auto-approve is held =="
T2="$(new_ready "Skip the test" "deliver a helper")"
echo skip-test > "$MODE"; run_tick >/dev/null
[ "$(st "$T2")" = "in_review" ] && ok "2: the delivery reached review (the skipped test let DoD pass)" \
  || fail "2: status $(st "$T2")"
J2="$(dod_json "$T2")"
[ "$(gate_field "$J2" integrity status)" = FLAG ] && [[ "$(gate_field "$J2" integrity note)" == *"test.skip in test/a.test.js"* ]] \
  && ok "2: the integrity row FLAGs 'test.skip in test/a.test.js'" || fail "2: evidence: $J2"
ANN="$(cd "$ROOT/packages/dispatch" && node --input-type=module -e '
  const { Dispatch } = await import("./dist/index.js");
  const d = Dispatch.open(process.argv[1]);
  const t = d.resolveTicket(process.argv[2]);
  const a = d.ticketDiff(t.id).repos.flatMap((r) => r.riskAnnotations).find((x) => x.kind === "test-modified");
  process.stdout.write(a ? `${a.severity}|${(a.items || []).join(";")}` : "none");
  d.db.close();
' "$DISPATCH_DB" "$T2" 2>/dev/null)"
[[ "$ANN" == "high|"*"test.skip in test/a.test.js"* ]] && ok "2: dispatch's diff carries test-modified (high) naming the marker" \
  || fail "2: test-modified annotation: $ANN"
review_tick >/dev/null
[ "$(st "$T2")" = "in_review" ] && ok "2: the agent reviewer's approve was HELD — still in_review" \
  || fail "2: status after the agent review: $(st "$T2")"
EV2="$(ticket_events "$T2")"
[[ "$EV2" == *"ticket.autoship_escalated"* ]] && [[ "$EV2" == *"tests modified"* ]] \
  && ok "2: an autoship_escalated event records the test-modified hold" || fail "2: events lack the hold"
# A human approval names the commit it reviewed (an unnamed or moved revision is refused).
wg review approve "$T2" $(wg ticket diff "$T2" --heads 2>/dev/null | sed 's/^/--commit /' | tr '\n' ' ') >/dev/null 2>&1
[ "$(st "$T2")" = "ready_for_merge" ] && ok "2: a human's approve is not held" || fail "2: human approve → $(st "$T2")"
retire "$T2"

echo "== 3. a human's allow_test_changes turns the FLAG into PASS with a note =="
T3="$(new_ready "Drop the obsolete test" "deliver a helper")"
wg ticket allow-test-changes "$T3" --reason "the a() suite is obsolete" >/dev/null 2>&1
echo delete-test > "$MODE"; run_tick >/dev/null
J3="$(dod_json "$T3")"
[ "$(gate_field "$J3" integrity status)" = PASS ] && [[ "$(gate_field "$J3" integrity note)" == "test changes allowed on this ticket by a human: deleted 1 test file (test/a.test.js)"* ]] \
  && ok "3: integrity PASS with a note naming the deleted test" || fail "3: evidence: $J3"
[[ "$(ticket_events "$T3")" == *"ticket.test_changes_allowed"* ]] && ok "3: the allowance is in the ticket's events" \
  || fail "3: no test_changes_allowed event"

retire "$T3"

echo "== 4. an ADDED pretest that hides the failing test cannot pass the gate =="
T4="$(new_ready "Hide the test with a hook" "deliver a helper")"
echo hook-hide > "$MODE"; run_tick >/dev/null
[ "$(st "$T4")" != "in_review" ] && ok "4: the broken delivery did NOT reach review (status $(st "$T4"))" \
  || fail "4: #$T4 reached in_review behind an added pretest"
J4="$(dod_json "$T4")"
[ "$(gate_field "$J4" tests status)" = FAIL ] && [[ "$(gate_field "$J4" tests source)" == base-pinned:*'added script "pretest"'* ]] \
  && ok "4: the tests gate ran the BASE script without the delivery's hooks and FAILED" \
  || fail "4: evidence: $J4"
[ "$(gate_field "$J4" integrity status)" = FLAG ] && [[ "$(gate_field "$J4" integrity note)" == *"pretest added in package.json"* ]] \
  && ok "4: the integrity row FLAGs the added pretest" || fail "4: integrity row: $(gate_field "$J4" integrity note)"
retire "$T4"

echo "== 5. moving the base branch onto the delivery cannot hide a committed test.skip =="
MAIN0="$(git -C "$R" rev-parse main)"
T5="$(new_ready "Move the base" "deliver a helper")"
echo move-base > "$MODE"; run_tick >/dev/null
[ "$(git -C "$R" rev-parse main)" != "$MAIN0" ] && ok "5: (the stub agent did move main)" || fail "5: main did not move"
J5="$(dod_json "$T5")"
[ "$(gate_field "$J5" integrity status)" = FLAG ] && [[ "$(gate_field "$J5" integrity note)" == *"test.skip in test/a.test.js"* ]] \
  && [[ "$(gate_field "$J5" integrity source)" == "base ${MAIN0:0:12} vs worktree" ]] \
  && ok "5: the integrity row scanned from the recorded base ${MAIN0:0:12} and FLAGs the skip" \
  || fail "5: evidence: $J5"
BASE5="$(wg ticket repo-delivery list "$T5" 2>/dev/null | jget '(d[0] && d[0].base_sha) || ""')"
[ "$BASE5" = "$MAIN0" ] && ok "5: the repo delivery records base_sha = the commit main was at when the branch was cut" \
  || fail "5: recorded base_sha '$BASE5' (want $MAIN0)"
ANN5="$(cd "$ROOT/packages/dispatch" && node --input-type=module -e '
  const { Dispatch } = await import("./dist/index.js");
  const d = Dispatch.open(process.argv[1]);
  const t = d.resolveTicket(process.argv[2]);
  const a = d.ticketDiff(t.id).repos.flatMap((r) => r.riskAnnotations).find((x) => x.kind === "test-modified");
  process.stdout.write(a ? `${a.severity}|${(a.items || []).join(";")}` : "none");
  d.db.close();
' "$DISPATCH_DB" "$T5" 2>/dev/null)"
[[ "$ANN5" == "high|"*"test.skip in test/a.test.js"* ]] && ok "5: dispatch's server-side scan still carries test-modified (high)" \
  || fail "5: test-modified annotation: $ANN5"
if [ "$(st "$T5")" = "in_review" ]; then
  review_tick >/dev/null
  [ "$(st "$T5")" = "in_review" ] && ok "5: the agent reviewer's approve was HELD" || fail "5: status after the agent review: $(st "$T5")"
else
  fail "5: status $(st "$T5") (expected in_review: the skipped test lets DoD pass)"
fi
git -C "$R" update-ref refs/heads/main "$MAIN0" >/dev/null 2>&1
retire "$T5"

echo
echo "gate-integrity-e2e: $PASS passed, ${#FAILURES[@]} failed"
[ "${#FAILURES[@]}" -eq 0 ]
