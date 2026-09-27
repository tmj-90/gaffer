#!/usr/bin/env bash
# =====================================================================
# DoD TEXT PROCESSING — gaffer_dod_distill_output / _extract_failure /
# _summary_line / _executed_count (lib/dod.sh) run the typed CLI
# (packages/crew dodDistillCli.js). Their outputs over a corpus of real test-runner
# logs (go, pytest, vitest, jest, maven, no-signal, blanks, empty, capped) and
# results files are pinned to fixtures/typed-seams/dod-distill/<case>.txt,
# captured from the awk implementations the CLI replaced (proven byte-identical
# by the former parity test). These are FEEDBACK helpers: without the crew build
# they print nothing and exit 0 (the callers' `|| tail` backstops still apply).
# LC_ALL=C pins byte semantics across the ubuntu + macOS matrix.
# Run: bash runner/test/dod-distill-golden.test.sh   (SEAM_GOLDEN_CAPTURE=1 to re-pin)
# =====================================================================
set -uo pipefail
export LC_ALL=C LC_CTYPE=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CREW_DIR="$ROOT/packages/crew"
DOD_CLI="$CREW_DIR/dist/runtime/dod/dodDistillCli.js"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
[ -f "$DOD_CLI" ] || { echo "SKIP: crew not built ($DOD_CLI) — run pnpm --filter crew build"; exit 0; }
gaffer_timeout() { local s="$1"; shift; "$@"; return $?; }
# shellcheck source=../lib/dod.sh
source "$RUNNER_DIR/lib/dod.sh"
# shellcheck source=lib/seam-golden.sh
source "$HERE/lib/seam-golden.sh"
export CREW_DIR
WORK="$(mktemp -d "${TMPDIR:-/tmp}/dod-distill-golden.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
CORPUS="$WORK/corpus"; mkdir -p "$CORPUS"
pass=0; fail=0
ok() { echo "  ok   $1"; pass=$((pass + 1)); }
no() { echo "  FAIL $1"; fail=$((fail + 1)); }

distill_case() { # <name> <file> <max>
  gaffer_dod_distill_output "$2" "$3" > "$WORK/out" 2>/dev/null
  seam_golden dod-distill "distill-$1" "$WORK/out" "distill $1 (max=$3)"
}
extract_case() { gaffer_dod_extract_failure "$2" > "$WORK/out" 2>/dev/null; seam_golden dod-distill "extract-$1" "$WORK/out" "extract $1"; }
summary_case() { gaffer_dod_summary_line "$2" > "$WORK/out" 2>/dev/null; seam_golden dod-distill "summary-$1" "$WORK/out" "summary $1"; }
count_case()   { gaffer_dod_executed_count "$2" > "$WORK/out" 2>/dev/null; seam_golden dod-distill "count-$1" "$WORK/out" "executed-count $1"; }

# ── DISTILL corpus ──
printf '%s\n' '=== RUN   TestAdd' '--- FAIL: TestAdd (0.00s)' '    add_test.go:10: expected 4 got 3' 'FAIL' 'exit status 1' > "$CORPUS/go.log"
printf 'FAIL\texample/add\t0.002s\n' >> "$CORPUS/go.log"
printf '%s\n' '    def test_add():' '>       assert add(1, 2) == 4' '=========================== short test summary info ============================' 'FAILED tests/test_add.py::test_add - assert 3 == 4' > "$CORPUS/pytest.log"
printf 'E       assert 3 == 4\n' >> "$CORPUS/pytest.log"
printf 'tests/test_add.py:5: AssertionError\n' >> "$CORPUS/pytest.log"
printf '%s\n' ' RUN  v1.6.0' ' ❯ src/sum.test.ts (1 test | 1 failed)' '   ✕ adds numbers' ' FAIL  src/sum.test.ts > adds numbers' 'AssertionError: expected 3 to be 4' ' ❯ src/sum.test.ts:5:23' ' Test Files  1 failed (1)' '      Tests  1 failed (1)' > "$CORPUS/vitest.log"
printf '%s\n' ' FAIL  src/sum.test.js' '  ● Calc › adds' '    expect(received).toBe(expected)' '    Expected: 4' '    Received: 3' '      at Object.<anonymous> (src/sum.test.js:5:19)' > "$CORPUS/jest.log"
printf '%s\n' '[INFO] Running com.example.CalcTest' '[ERROR] Tests run: 1, Failures: 1 <<< FAILURE!' 'org.opentest4j.AssertionFailedError: expected: <4> but was: <3>' > "$CORPUS/maven.log"
printf '\tat com.example.CalcTest.testAdd(CalcTest.java:12)\n' >> "$CORPUS/maven.log"
printf '%s\n' 'Building project...' 'Compiling module A' 'Compiling module B' 'Done in 4.2s' > "$CORPUS/nosig.log"
printf '%s\n' 'first line' '' '   ' 'last line' > "$CORPUS/blanks.log"
: > "$CORPUS/empty.log"
: > "$CORPUS/big.log"
for i in $(seq 1 60); do printf 'FAIL case %s\n' "$i" >> "$CORPUS/big.log"; done
for f in go pytest vitest jest maven nosig blanks empty; do distill_case "$f" "$CORPUS/$f.log" 40; done
distill_case big-2 "$CORPUS/big.log" 2
distill_case big-40 "$CORPUS/big.log" 40
distill_case big-60 "$CORPUS/big.log" 60
distill_case go-capped "$CORPUS/go.log" 3
distill_case missing-file "$CORPUS/does-not-exist.log" 40

# ── EXTRACT corpus ──
{ printf 'GATE\ttests\tapp\tFAIL\t1\texited 1: npm test\n'; printf -- '---DOD-OUTPUT tests@app---\n'; printf 'AssertionError: boom\n'; printf '  at f.ts:1:2\n'; printf '\n'; printf -- '---END-DOD-OUTPUT---\n'; } > "$CORPUS/res-one.results"
{ printf -- '---DOD-OUTPUT tests@app---\n'; printf 'boom one\n'; printf -- '---END-DOD-OUTPUT---\n'; printf -- '---DOD-OUTPUT lint@app---\n'; printf 'boom two\n'; printf -- '---END-DOD-OUTPUT---\n'; } > "$CORPUS/res-many.results"
printf 'GATE\ttests\trepo\tPASS\t0\tnpm test\n' > "$CORPUS/res-none.results"
{ printf 'noise before any frame\n'; printf -- '---DOD-OUTPUT tests@app---  \n'; printf 'inside\n'; printf -- '---END-DOD-OUTPUT---\n'; printf 'noise after the frame\n'; } > "$CORPUS/res-ws.results"
for r in res-one res-many res-none res-ws; do extract_case "$r" "$CORPUS/$r.results"; done
extract_case missing-file "$CORPUS/does-not-exist.results"

# ── SUMMARY / COUNT corpus ──
{ printf 'GATE\ttests\tapp-web\tPASS\t0\tnpm test\n'; printf 'GATE\ttypecheck\tapp-web\tFAIL\t2\texited 2: tsc\n'; printf -- '---DOD-OUTPUT typecheck@app-web---\nsrc/x.ts:3:1 error\n---END-DOD-OUTPUT---\n'; printf 'GATE\tlint\tapp-web\tSKIP\t0\tno command configured\n'; printf 'GATE\ttests\tapp-api\tFAIL\t1\texited 1: pytest\n'; } > "$CORPUS/res-mixed.results"
printf 'GATE\ttests\trepo\tSKIP\t0\tgate disabled by config\nGATE\tlint\trepo\tSKIP\t0\tno command configured\n' > "$CORPUS/res-allskip.results"
printf 'GATE\ttests\tr\tPASS\t0\tt\nGATE\tlint\tr\tPASS\t0\tl\n' > "$CORPUS/res-allpass.results"
: > "$CORPUS/res-empty.results"
for r in res-mixed res-allskip res-allpass res-empty res-none; do summary_case "$r" "$CORPUS/$r.results"; count_case "$r" "$CORPUS/$r.results"; done

# Feedback helpers stay fail-soft without the crew build: nothing printed, exit 0.
out="$(CREW_DIR="$WORK/nope" gaffer_dod_distill_output "$CORPUS/go.log" 40 2>/dev/null)"; rc=$?
[ "$rc" -eq 0 ] && [ -z "$out" ] && ok "distill without the crew dist → empty, rc 0 (fail-soft feedback)" || no "distill missing dist: rc=$rc out='$out'"
out="$(CREW_DIR="$WORK/nope" gaffer_dod_summary_line "$CORPUS/res-mixed.results" 2>/dev/null)"; rc=$?
[ "$rc" -eq 0 ] && [ -z "$out" ] && ok "summary without the crew dist → empty, rc 0" || no "summary missing dist: rc=$rc out='$out'"

echo ""; echo "dod-distill-golden: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
