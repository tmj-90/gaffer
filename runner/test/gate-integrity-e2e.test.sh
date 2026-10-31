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

echo
echo "gate-integrity-e2e: $PASS passed, ${#FAILURES[@]} failed"
[ "${#FAILURES[@]}" -eq 0 ]
