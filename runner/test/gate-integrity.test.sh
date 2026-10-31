#!/usr/bin/env bash
# =====================================================================
# GATE INTEGRITY (runner/lib/dod.sh + crew gateIntegrityCli) — the runner decides
# "done" by running the repo's gate commands in the delivery worktree, so an agent
# could pass the gate by weakening the tests. These cases drive the REAL
# gaffer_run_dod_gates against a REAL fixture repo (base commit + delivery commits):
#
#   A  base-commit command read: a delivery that rewrites `scripts.test` to `true`
#      while breaking the code is FAILED (the base script runs; source base-pinned),
#      where the same row without a base ref (today's contract) PASSES; an unchanged
#      script runs as registered (source base); a script new in the delivery runs
#      from head; a non-script command is `registered`.
#   B  every marker class FLAGs the integrity row (JS .skip/.only/.todo/xit, pytest
#      skip/xfail, unittest, go t.Skip, rust #[ignore], JUnit @Disabled, RSpec xit,
#      PHPUnit markTestSkipped, ExUnit @tag :skip); a comment or app code does not.
#   C  a deleted and a renamed test file FLAG (committed or only in the worktree);
#      a touched vitest config FLAGs.
#   D  the allow flag (a human's allow_test_changes): FLAG → PASS with a note.
#   E  a clean delivery: integrity PASS; the integrity row never counts as an
#      executed gate and never fails the run; the evidence JSON carries `source`.
#   F  fail toward a human: no base commit / no crew dist → FLAG, gates still run.
#   G  tick.sh passes the base ref + a FRESH allow flag into the gate rows.
#
# Requires git, node and the built crew + dispatch dists. SKIPs (exit 0) otherwise.
# Run: bash test/gate-integrity.test.sh      (bash 3.2-safe)
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CREW_DIR="$ROOT/packages/crew"; export CREW_DIR
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
[ -f "$CREW_DIR/dist/runtime/dod/gateIntegrityCli.js" ] || { echo "SKIP: crew dist not built"; exit 0; }
[ -f "$ROOT/packages/dispatch/dist/services/testIntegrity.js" ] || { echo "SKIP: dispatch dist not built"; exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

gaffer_timeout() { local _s="$1"; shift; "$@"; return $?; }
# shellcheck source=../lib/dod.sh
source "$RUNNER_DIR/lib/dod.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/gate-integrity.XXXXXX")"; WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

# A fixture repo whose `test` script runs every tests/*.test.sh; base is green.
R="$WORK/repo"
mkdir -p "$R/tests" "$R/src"
( cd "$R" && git init -q -b main
  printf '{ "name": "fx", "private": true, "scripts": { "test": "sh tests/run.sh", "lint": "true" } }\n' > package.json
  printf 'for f in tests/*.test.sh; do sh "$f" || exit 1; done\n' > tests/run.sh
  printf 'echo 1\n' > src/value.sh
  printf '[ "$(sh src/value.sh)" = 1 ]\n' > tests/value.test.sh
  printf 'exit 0\n' > tests/other.test.sh
  git add -A && git commit -qm base )

# A fresh delivery worktree off main; the caller's commands run in it.
N=0
delivery() {
  N=$((N+1)); WT="$WORK/wt$N"
  git -C "$R" worktree add -q -b "d$N" "$WT" main >/dev/null 2>&1
}
commit_wt() { git -C "$WT" add -A >/dev/null 2>&1; git -C "$WT" commit -qm "${1:-change}" >/dev/null 2>&1; }
# gates <test_cmd> [base] [allow] → runs the gate rows, sets RC and RES.
gates() {
  RES="$WORK/r$N.$RANDOM.results"
  if [ $# -ge 2 ]; then
    printf 'repo\t%s\t1\t0\t1\t%s\t-\ttrue\t%s\t%s\n' "$WT" "$1" "$2" "${3:-0}" | gaffer_run_dod_gates "$RES"
  else
    printf 'repo\t%s\t1\t0\t1\t%s\t-\ttrue\n' "$WT" "$1" | gaffer_run_dod_gates "$RES"
  fi
  RC=$?
}
row() { grep -E $'^GATE\t'"$1"$'\trepo\t' "$RES" | head -n 1; }
col() { printf '%s' "$1" | awk -F'\t' -v c="$2" '{print $c}'; }

echo "== A: gate commands are read from the BASE commit =="
delivery
printf 'echo 2\n' > "$WT/src/value.sh"     # break the behaviour the test checks
printf '{ "name": "fx", "private": true, "scripts": { "test": "true", "lint": "true" } }\n' > "$WT/package.json"
commit_wt "redirect the gate"
gates "npm test"
[ "$RC" -eq 0 ] && ok "A1 before: without a base ref the rewritten script runs and the broken delivery PASSES (today's hole)" \
  || fail "A1 expected the legacy row to pass on the rewritten script ($(cat "$RES"))"
gates "npm test" main
[ "$RC" -ne 0 ] && ok "A2 after: with the base ref the BASE script runs and the delivery FAILS" \
  || fail "A2 expected the base-pinned test gate to fail ($(cat "$RES"))"
T="$(row tests)"
[ "$(col "$T" 4)" = FAIL ] && [[ "$(col "$T" 7)" == base-pinned:* ]] \
  && ok "A3 the tests row records source base-pinned ($(col "$T" 7 | cut -c1-70)…)" \
  || fail "A3 expected FAIL + base-pinned source, got: $T"
I="$(row integrity)"
[ "$(col "$I" 4)" = FLAG ] && [[ "$(col "$I" 6)" == *'test in package.json'* ]] \
  && ok "A4 the integrity row FLAGs the changed gate script" \
  || fail "A4 expected an integrity FLAG naming the script, got: $I"

delivery
printf '# docs\n' > "$WT/README.md"; commit_wt "docs"
gates "npm test" main
T="$(row tests)"
[ "$RC" -eq 0 ] && [[ "$(col "$T" 7)" == base:* ]] && [ "$(col "$T" 6)" = "npm test" ] \
  && ok "A5 an unchanged script runs as registered (source base)" \
  || fail "A5 expected PASS with source base, got: $T"
delivery
printf '{ "name": "fx", "private": true, "scripts": { "test": "sh tests/run.sh", "lint": "true", "check:new": "true" } }\n' > "$WT/package.json"
commit_wt "new script"
gates "npm run check:new" main
[[ "$(col "$(row tests)" 7)" == head:* ]] && ok "A6 a script new in the delivery runs from head (source head)" \
  || fail "A6 expected source head, got: $(row tests)"
gates "sh tests/run.sh" main
[[ "$(col "$(row tests)" 7)" == registered:* ]] && ok "A7 a non-script command runs as registered (source registered)" \
  || fail "A7 expected source registered, got: $(row tests)"

echo "== B: every skip/focus marker class FLAGs =="
marker_case() {  # <label> <file> <line> <expected marker>
  delivery
  mkdir -p "$WT/$(dirname "$2")"
  printf '%s\n' "$3" >> "$WT/$2"
  commit_wt "$1"
  gates "true" main
  local i; i="$(row integrity)"
  if [ "$(col "$i" 4)" = FLAG ] && [[ "$(col "$i" 6)" == *"$4 in $2"* ]]; then
    ok "B $1: $4 in $2 → FLAG"
  else
    fail "B $1: expected FLAG naming '$4 in $2', got: $i"
  fi
}
marker_case "js .skip"      src/a.test.ts          "it.skip('adds', () => {})"        it.skip
marker_case "js .only"      src/b.spec.js          "describe.only('x', () => {})"     describe.only
marker_case "js .todo"      src/c.test.mjs         "test.todo('later')"               test.todo
marker_case "js xit"        __tests__/d.js         "xit('x', () => {})"               xit
marker_case "pytest skip"   tests/test_api.py      "@pytest.mark.skip(reason='x')"    "@pytest.mark.skip"
marker_case "pytest xfail"  tests/test_api.py      "@pytest.mark.xfail"               "@pytest.mark.xfail"
marker_case "unittest skip" tests/test_unit.py     "@unittest.skip('x')"              "@unittest.skip"
marker_case "go t.Skip"     pkg/x_test.go          "	t.Skip(\"flaky\")"                 t.Skip
marker_case "rust ignore"   src/lib.rs             "#[ignore]"                        "#[ignore]"
marker_case "junit"         src/test/java/ATest.java "  @Disabled"                    "@Disabled"
marker_case "rspec xit"     spec/a_spec.rb         "  xit 'works' do"                 xit
marker_case "phpunit"       tests/ATest.php        "\$this->markTestSkipped('x');"    markTestSkipped
marker_case "exunit"        test/a_test.exs        "  @tag :skip"                     "@tag :skip"
delivery
mkdir -p "$WT/src"; printf '%s\n' "// it.skip('x')" >> "$WT/src/e.test.ts"; printf 'list.skip(2)\n' >> "$WT/src/app.ts"
commit_wt "comment + app code"
gates "true" main
[ "$(col "$(row integrity)" 4)" = PASS ] && ok "B a marker in a comment, or .skip in app code, does not FLAG" \
  || fail "B expected PASS for comment/app-code look-alikes, got: $(row integrity)"

echo "== C: deleted / renamed test files and test config =="
delivery
git -C "$WT" rm -q tests/other.test.sh; commit_wt "delete a test"
gates "true" main
[[ "$(col "$(row integrity)" 6)" == *"deleted 1 test file (tests/other.test.sh)"* ]] \
  && ok "C1 a deleted test file FLAGs" || fail "C1 got: $(row integrity)"
delivery
git -C "$WT" mv tests/other.test.sh tests/other.sh; commit_wt "rename a test"
gates "true" main
[[ "$(col "$(row integrity)" 6)" == *"renamed 1 test file (tests/other.test.sh → tests/other.sh)"* ]] \
  && ok "C2 a test renamed out of the runner's glob FLAGs" || fail "C2 got: $(row integrity)"
delivery
rm -f "$WT/tests/value.test.sh"   # deleted in the worktree only (what the gate runs against)
gates "true" main
[[ "$(col "$(row integrity)" 6)" == *"tests/value.test.sh"* ]] \
  && ok "C3 an UNCOMMITTED deletion in the worktree FLAGs too" || fail "C3 got: $(row integrity)"
delivery
printf 'export default {}\n' > "$WT/vitest.config.ts"; commit_wt "add config"
printf 'export default { test: { exclude: ["**"] } }\n' > "$WT/vitest.config.ts"; commit_wt "exclude all"
git -C "$WT" log --oneline -1 >/dev/null
gates "true" "$(git -C "$WT" rev-parse HEAD~1)"
[[ "$(col "$(row integrity)" 6)" == *"vitest.config.ts modified"* ]] \
  && ok "C4 a modified test-runner config FLAGs" || fail "C4 got: $(row integrity)"

echo "== D: a human's allow_test_changes turns FLAG into PASS with a note =="
delivery
git -C "$WT" rm -q tests/other.test.sh; commit_wt "delete a test (allowed)"
gates "true" main 1
I="$(row integrity)"
[ "$(col "$I" 4)" = PASS ] && [[ "$(col "$I" 6)" == "test changes allowed on this ticket by a human: deleted 1 test file"* ]] \
  && ok "D the allowance makes it PASS, and the note still names what changed" \
  || fail "D expected PASS-with-note, got: $I"

echo "== E: a clean delivery; integrity never counts as a gate nor fails the run =="
delivery
printf 'echo 1 # same\n' > "$WT/src/value.sh"
printf '[ "$(sh src/value.sh)" = 1 ] && true\n' > "$WT/tests/new.test.sh"; commit_wt "clean"
gates "npm test" main
[ "$RC" -eq 0 ] && [ "$(col "$(row integrity)" 4)" = PASS ] \
  && ok "E1 clean delivery: gates pass, integrity PASS" || fail "E1 got rc=$RC: $(cat "$RES")"
delivery
git -C "$WT" rm -q tests/other.test.sh; commit_wt "flagged but green"
RES="$WORK/e2.results"
printf 'repo\t%s\t0\t0\t0\t-\t-\t-\tmain\t0\n' "$WT" | gaffer_run_dod_gates "$RES"; RC=$?
[ "$RC" -eq 0 ] && [ "$(gaffer_dod_executed_count "$RES")" = 0 ] \
  && ok "E2 a FLAG never fails the run, and the integrity row is not an executed gate (zero-gates rule intact)" \
  || fail "E2 rc=$RC executed=$(gaffer_dod_executed_count "$RES"): $(cat "$RES")"
gates "npm test" main
EV="$(gaffer_dod_evidence_summary "$RES" PASS | sed -n 2p)"
node -e '
  const j = JSON.parse(process.argv[1]);
  const t = j.gates.find((g) => g.gate === "tests");
  const i = j.gates.find((g) => g.gate === "integrity");
  if (j.dod !== "PASS" || !t || !/^base:/.test(t.source || "") || !i || i.status !== "FLAG") process.exit(1);
' "$EV" && ok "E3 the evidence JSON carries each gate's source and the integrity FLAG (dod stays PASS)" \
  || fail "E3 evidence JSON: $EV"
[[ "$(gaffer_dod_summary_line "$RES")" == *"1 flag (flagged: integrity@repo)"* ]] \
  && ok "E4 the log summary names the flag" || fail "E4 summary: $(gaffer_dod_summary_line "$RES")"

echo "== F: fail toward a human =="
delivery
gates "npm test" no-such-branch
[ "$RC" -eq 0 ] && [ "$(col "$(row integrity)" 4)" = FLAG ] && [[ "$(col "$(row tests)" 7)" == unresolved:* ]] \
  && ok "F1 an unresolvable base: commands run as registered (source unresolved), integrity FLAGs" \
  || fail "F1 got rc=$RC: $(cat "$RES")"
SAVED_CREW="$CREW_DIR"; CREW_DIR="$WORK/no-crew"
gates "npm test" main
CREW_DIR="$SAVED_CREW"
[ "$RC" -eq 0 ] && [[ "$(col "$(row integrity)" 6)" == *"could not run"* ]] && [ "$(col "$(row integrity)" 4)" = FLAG ] \
  && ok "F2 crew dist missing: integrity FLAGs (never a silent pass), gates still run" \
  || fail "F2 got rc=$RC: $(cat "$RES")"

echo "== G: tick.sh wiring =="
TICK="$RUNNER_DIR/tick.sh"
grep -q '"$_dtest" "$_dtc" "$_dlint" "${rbase:--}" "$_DOD_ALLOW_TESTS"' "$TICK" \
  && ok "G1 tick.sh passes the base ref and the allow flag into every gate row" \
  || fail "G1 tick.sh does not pass base/allow into DOD_ROWS"
grep -q "d.ticket.allow_test_changes === 1" "$TICK" && grep -q '_DOD_ALLOW_TESTS="$(wg ticket show "$NUM"' "$TICK" \
  && ok "G2 the allow flag is read FRESH from dispatch at gate time (fails closed to 0)" \
  || fail "G2 tick.sh does not read allow_test_changes fresh"
[ "$(grep -c 'gaffer_dod_log_integrity "$DOD_RESULTS"' "$TICK")" -ge 2 ] \
  && ok "G3 tick.sh logs the integrity row on both the PASS and FAIL paths" \
  || fail "G3 tick.sh does not log integrity rows"

echo
echo "gate-integrity: $PASS passed, ${#FAILURES[@]} failed"
[ "${#FAILURES[@]}" -eq 0 ]
