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
#   6. retry-redirect (2 attempts): attempt 1 rewrites scripts.test and fails; attempt 2
#      builds on that branch. Its gate still runs the ORIGINAL base script (FAIL,
#      base-pinned) — the retry never re-records the base from attempt 1's tip.
#   7. retry-delete (2 attempts): attempt 1 deletes the test and fails; attempt 2 passes.
#      The integrity row and dispatch still flag the deletion from the original base.
#   8. npmrc-hide: leaves package.json and the tests alone but ADDS a project `.npmrc`
#      with `script-shell=/bin/true`, so `npm test` runs nothing. The integrity row
#      FLAGs the added package-manager config, dispatch carries test-modified (high)
#      and the agent reviewer's approve is HELD.
#   9. npmrc-ignored: the same `.npmrc`, git-ignored through info/exclude so it is never
#      committed. The on-disk check still FLAGs it, and dispatch holds the agent approve
#      on the runner's FLAG (the committed diff alone is clean).
#  10. skipworktree-hide: commits the broken a(), then marks test/a.test.js skip-worktree
#      and skips it ON DISK. git diff and the auto-commit trust the index, so the
#      committed branch looks clean while the gate runs the skipped test. The integrity
#      row FLAGs the hidden file and dispatch holds the agent approve on the runner's FLAG.
#
# Requires node, git, perl and the built dispatch / memory / crew dists; SKIPs otherwise.
# Run: bash runner/test/gate-integrity-e2e.test.sh   (KEEP=1 keeps the temp dir)
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
command -v perl >/dev/null 2>&1 || { echo "SKIP: perl required (timeout primitive)"; exit 0; }
for f in packages/dispatch/dist/cli/index.js packages/memory/dist/bin/memory.js packages/crew/dist/cli/index.js \
         packages/crew/dist/runtime/dod/gateIntegrityCli.js; do
  [ -f "$ROOT/$f" ] || { echo "SKIP: $f not built (run pnpm -r build)"; exit 0; }
done

STUB_TICK_NAME=gate-integrity-e2e
# shellcheck source=lib/stub-tick.sh
source "$HERE/lib/stub-tick.sh"
export GAFFER_MAX_DELIVERY_ATTEMPTS=1   # one attempt per case: the stub repeats itself

# The DoD evidence JSON line (`{"dod":…,"gates":[…]}`) most recently recorded on a ticket.
dod_json() {
  wg ticket show "$1" 2>/dev/null | jget '(() => {
    const ev = (d.evidence || []).filter((e) => e.evidence_type === "test_output" && /^DoD: /.test(e.summary || ""));
    const last = ev[ev.length - 1];
    return last ? last.summary.split("\n")[1] : "";
  })()'
}
gate_field() {  # <json> <gate> <field>
  node -e 'const j=JSON.parse(process.argv[1]||"{}");const g=(j.gates||[]).find(x=>x.gate===process.argv[2]);process.stdout.write(g?String(g[process.argv[3]]??""):"")' "$1" "$2" "$3"
}
ticket_events() { wg ticket show "$1" 2>/dev/null | jget 'JSON.stringify(d.events || [])'; }

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
wg review approve "$T2" >/dev/null 2>&1
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

# In-tick RETRY: attempt 1 weakens the gate and fails DoD, attempt 2 builds on that
# branch. The retry must not re-record the base from the branch tip (which now holds
# attempt 1's commits): the gates and the scan keep judging from the cut commit.
export GAFFER_MAX_DELIVERY_ATTEMPTS=2 GAFFER_TICK_TIMEOUT=240
recorded_base() { wg ticket repo-delivery list "$1" 2>/dev/null | jget '(d[0] && d[0].base_sha) || ""'; }

echo "== 6. retry: a scripts.test rewritten in attempt 1 still cannot redirect attempt 2's gate =="
MAIN6="$(git -C "$R" rev-parse main)"
T6="$(new_ready "Redirect then retry" "deliver a helper")"
echo retry-redirect > "$MODE"; run_tick >/dev/null
[ -e "$CALLS/retried-retry-redirect" ] && grep -qF "delivery for #$T6 — re-invoking agent (attempt 2/2)" "$GAFFER_DATA/factory.log" \
  && ok "6: (the delivery was retried in the same tick)" || fail "6: no in-tick retry happened"
[ "$(st "$T6")" != "in_review" ] && ok "6: the broken delivery did NOT reach review (status $(st "$T6"))" \
  || fail "6: #$T6 reached in_review after a retry on a redirected test script"
J6="$(dod_json "$T6")"
[ "$(gate_field "$J6" tests status)" = FAIL ] && [[ "$(gate_field "$J6" tests source)" == base-pinned:*"${MAIN6:0:12}"* ]] \
  && ok "6: attempt 2's tests gate still ran the ORIGINAL base script (base-pinned from ${MAIN6:0:12}) and FAILED" \
  || fail "6: evidence: $J6"
[ "$(gate_field "$J6" integrity status)" = FLAG ] && [[ "$(gate_field "$J6" integrity source)" == "base ${MAIN6:0:12} vs worktree" ]] \
  && ok "6: attempt 2's integrity row scanned from the original base and FLAGs" || fail "6: integrity: $(gate_field "$J6" integrity status) $(gate_field "$J6" integrity source)"
[ "$(recorded_base "$T6")" = "$MAIN6" ] && ok "6: the recorded base_sha is still the cut commit after the retry" \
  || fail "6: recorded base_sha $(recorded_base "$T6") (want $MAIN6)"
retire "$T6"

echo "== 7. retry: a test deleted in attempt 1 is still flagged after attempt 2 =="
MAIN7="$(git -C "$R" rev-parse main)"
T7="$(new_ready "Delete then retry" "deliver a helper")"
echo retry-delete > "$MODE"; run_tick >/dev/null
[ -e "$CALLS/retried-retry-delete" ] && grep -qF "delivery for #$T7 — re-invoking agent (attempt 2/2)" "$GAFFER_DATA/factory.log" \
  && ok "7: (attempt 1 failed DoD and the delivery was retried in the same tick)" || fail "7: no in-tick retry happened"
[ "$(st "$T7")" = "in_review" ] && ok "7: attempt 2 passed DoD and reached review (where the FLAG holds it for a human)" \
  || fail "7: status $(st "$T7")"
J7="$(dod_json "$T7")"
[ "$(gate_field "$J7" integrity status)" = FLAG ] && [[ "$(gate_field "$J7" integrity note)" == *"deleted 1 test file (test/a.test.js)"* ]] \
  && [[ "$(gate_field "$J7" integrity source)" == "base ${MAIN7:0:12} vs worktree" ]] \
  && ok "7: attempt 2's integrity row FLAGs the test attempt 1 deleted, from the original base" \
  || fail "7: evidence: $J7"
[ "$(recorded_base "$T7")" = "$MAIN7" ] && ok "7: the recorded base_sha is still the cut commit" \
  || fail "7: recorded base_sha $(recorded_base "$T7") (want $MAIN7)"
ANN7="$(cd "$ROOT/packages/dispatch" && node --input-type=module -e '
  const { Dispatch } = await import("./dist/index.js");
  const d = Dispatch.open(process.argv[1]);
  const t = d.resolveTicket(process.argv[2]);
  const a = d.ticketDiff(t.id).repos.flatMap((r) => r.riskAnnotations).find((x) => x.kind === "test-modified");
  process.stdout.write(a ? `${a.severity}|${(a.items || []).join(";")}` : "none");
  d.db.close();
' "$DISPATCH_DB" "$T7" 2>/dev/null)"
[[ "$ANN7" == "high|"*"test/a.test.js"* ]] && [[ "$ANN7" != *"no longer contains"* ]] \
  && ok "7: dispatch's scan names the deleted test (not a rewritten-base excuse)" || fail "7: test-modified annotation: $ANN7"
if ! grep -E "GATE INTEGRITY: #$T7 .*delivery base recorded" "$GAFFER_DATA/factory.log" | grep -v "${MAIN7:0:12}" >/dev/null; then
  ok "7: the factory log never recorded a base other than the cut commit"
else
  fail "7: a later base was recorded: $(grep -E "GATE INTEGRITY: #$T7 " "$GAFFER_DATA/factory.log")"
fi
retire "$T7"

echo "== 8. an ADDED project .npmrc that no-ops npm scripts is flagged and held =="
T8="$(new_ready "Quiet the scripts" "deliver a helper")"
echo npmrc-hide > "$MODE"; run_tick >/dev/null
J8="$(dod_json "$T8")"
[ "$(gate_field "$J8" integrity status)" = FLAG ] && [[ "$(gate_field "$J8" integrity note)" == *"touched package-manager config (.npmrc added)"* ]] \
  && ok "8: the integrity row FLAGs the added .npmrc" || fail "8: evidence: $J8"
ANN8="$(cd "$ROOT/packages/dispatch" && node --input-type=module -e '
  const { Dispatch } = await import("./dist/index.js");
  const d = Dispatch.open(process.argv[1]);
  const t = d.resolveTicket(process.argv[2]);
  const a = d.ticketDiff(t.id).repos.flatMap((r) => r.riskAnnotations).find((x) => x.kind === "test-modified");
  process.stdout.write(a ? `${a.severity}|${(a.items || []).join(";")}` : "none");
  d.db.close();
' "$DISPATCH_DB" "$T8" 2>/dev/null)"
[[ "$ANN8" == "high|"*"added package-manager config .npmrc"* ]] && ok "8: dispatch's diff carries test-modified (high) naming .npmrc" \
  || fail "8: test-modified annotation: $ANN8"
if [ "$(st "$T8")" = "in_review" ]; then
  review_tick >/dev/null
  [ "$(st "$T8")" = "in_review" ] && ok "8: the agent reviewer's approve was HELD — still in_review" \
    || fail "8: status after the agent review: $(st "$T8")"
  [[ "$(ticket_events "$T8")" == *"ticket.autoship_escalated"* ]] && ok "8: an autoship_escalated event records the hold" \
    || fail "8: events lack the hold"
else
  ok "8: the delivery did not reach review (status $(st "$T8")), so nothing could ship"
fi
retire "$T8"

echo "== 9. a git-ignored .npmrc the diff cannot see is still flagged =="
T9="$(new_ready "Quiet the scripts quietly" "deliver a helper")"
echo npmrc-ignored > "$MODE"; run_tick >/dev/null
J9="$(dod_json "$T9")"
[ "$(gate_field "$J9" integrity status)" = FLAG ] && [[ "$(gate_field "$J9" integrity note)" == *"touched package-manager config (.npmrc added)"* ]] \
  && ok "9: the integrity row FLAGs the ignored .npmrc found on disk" || fail "9: evidence: $J9"
if [ "$(st "$T9")" = "in_review" ]; then
  review_tick >/dev/null
  [ "$(st "$T9")" = "in_review" ] && ok "9: the runner's FLAG holds the agent approve (the committed diff alone is clean)" \
    || fail "9: status after the agent review: $(st "$T9")"
  [[ "$(ticket_events "$T9")" == *"runner integrity gate"* ]] && ok "9: the autoship_escalated event names the runner's integrity gate" \
    || fail "9: events lack the runner hold"
else
  fail "9: expected the delivery in review (status $(st "$T9"))"
fi
retire "$T9"

echo "== 10. a test hidden from git (skip-worktree) and skipped on disk is still flagged =="
T10="$(new_ready "Hide the skip from git" "deliver a helper")"
echo skipworktree-hide > "$MODE"; run_tick >/dev/null
J10="$(dod_json "$T10")"
[ "$(gate_field "$J10" tests status)" = PASS ] && ok "10: (the gate ran the skipped test on disk and passed)" \
  || fail "10: tests gate: $J10"
[ "$(gate_field "$J10" integrity status)" = FLAG ] && [[ "$(gate_field "$J10" integrity note)" == *"hidden from git"*"test/a.test.js"* ]] \
  && ok "10: the integrity row FLAGs the skip-worktree test" || fail "10: evidence: $J10"
if [ "$(st "$T10")" = "in_review" ]; then
  review_tick >/dev/null
  [ "$(st "$T10")" = "in_review" ] && ok "10: the agent reviewer's approve was HELD — still in_review" \
    || fail "10: status after the agent review: $(st "$T10") (the broken a() shipped behind a hidden skip)"
else
  fail "10: expected the delivery in review (status $(st "$T10"))"
fi
retire "$T10"

echo
echo "gate-integrity-e2e: $PASS passed, ${#FAILURES[@]} failed"
[ "${#FAILURES[@]}" -eq 0 ]
