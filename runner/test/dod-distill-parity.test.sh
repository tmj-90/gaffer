#!/usr/bin/env bash
# =====================================================================
# LOAD-BEARING byte-identity test for the DoD distill/extract strangler
# port (runner/lib/dod.sh → packages/crew TS). Mirrors the precedent
# runner/test/mcp-render-parity.test.sh EXACTLY in shape and discipline.
# ---------------------------------------------------------------------
# It drives the SAME two seams tick.sh/dod.sh call — gaffer_dod_distill_output
# and gaffer_dod_extract_failure — BOTH ways on the SAME fixture corpus: the
# legacy awk (GAFFER_DOD_DISTILL=awk) and the typed node port
# (GAFFER_DOD_DISTILL=ts, dodDistillCli.js → distillOutput/extractFailure) —
# and asserts the two outputs are BYTE-IDENTICAL (cmp -s, incl. ordering,
# whitespace, the Unicode marks, and the trailing newline). This is the guard
# that stops the two paths drifting once the default flips to ts.
#
# The crew unit test (packages/crew/test/dod-distill.test.ts) proves the pure
# FUNCTIONS against exact expected strings; THIS test proves the live node
# ENTRYPOINT + the live awk agree end to end, through the exact functions
# dod.sh calls, across the real framework corpora + edge cases.
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CREW_DIR="$ROOT/packages/crew"
DOD_CLI="$CREW_DIR/dist/runtime/dod/dodDistillCli.js"

command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
[ -f "$DOD_CLI" ] || { echo "SKIP: crew not built ($DOD_CLI) — run pnpm --filter crew build"; exit 0; }

# dod.sh runs standalone (its distill/extract helpers need only awk + node).
# Provide the gaffer_timeout stub the module's other helpers reference, exactly
# like runner/test/dod-gate.test.sh does.
gaffer_timeout() { local s="$1"; shift; "$@"; return $?; }
# shellcheck source=../lib/dod.sh
source "$RUNNER_DIR/lib/dod.sh"
export CREW_DIR   # the seam reads $CREW_DIR to locate the typed dist bin

WORK="$(mktemp -d "${TMPDIR:-/tmp}/dod-distill-parity.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
CORPUS="$WORK/corpus"; mkdir -p "$CORPUS"

pass=0
fail=0
ok() { echo "  ok   $1"; pass=$((pass + 1)); }
no() { echo "  FAIL $1"; fail=$((fail + 1)); }

# distill_case <label> <fixture-file> <max>
# Runs BOTH branches through the real seam on the same file + max, asserts
# byte-identity (cmp -s covers the trailing newline and the empty-output case).
distill_case() {
  local label="$1" f="$2" max="$3"
  local a="$WORK/out.awk" t="$WORK/out.ts"
  GAFFER_DOD_DISTILL=awk gaffer_dod_distill_output "$f" "$max" > "$a" 2>/dev/null
  GAFFER_DOD_DISTILL=ts  gaffer_dod_distill_output "$f" "$max" > "$t" 2>/dev/null
  if cmp -s "$a" "$t"; then
    ok "distill $label (max=$max) — awk and ts are byte-identical"
  else
    echo "----- diff (awk left, ts right) -----" >&2
    diff "$a" "$t" >&2 || true
    no "distill $label (max=$max) — awk and ts DIVERGED"
  fi
}

# extract_case <label> <results-file>
extract_case() {
  local label="$1" f="$2"
  local a="$WORK/out.awk" t="$WORK/out.ts"
  GAFFER_DOD_DISTILL=awk gaffer_dod_extract_failure "$f" > "$a" 2>/dev/null
  GAFFER_DOD_DISTILL=ts  gaffer_dod_extract_failure "$f" > "$t" 2>/dev/null
  if cmp -s "$a" "$t"; then
    ok "extract $label — awk and ts are byte-identical"
  else
    echo "----- diff (awk left, ts right) -----" >&2
    diff "$a" "$t" >&2 || true
    no "extract $label — awk and ts DIVERGED"
  fi
}

# ── DISTILL corpus ───────────────────────────────────────────────────
# go test (note the tab-separated final FAIL line).
printf '%s\n' \
  '=== RUN   TestAdd' \
  '--- FAIL: TestAdd (0.00s)' \
  '    add_test.go:10: expected 4 got 3' \
  'FAIL' \
  'exit status 1' \
  > "$CORPUS/go.log"
printf 'FAIL\texample/add\t0.002s\n' >> "$CORPUS/go.log"

# pytest.
printf '%s\n' \
  '    def test_add():' \
  '>       assert add(1, 2) == 4' \
  '=========================== short test summary info ============================' \
  'FAILED tests/test_add.py::test_add - assert 3 == 4' \
  > "$CORPUS/pytest.log"
printf 'E       assert 3 == 4\n' >> "$CORPUS/pytest.log"
printf 'tests/test_add.py:5: AssertionError\n' >> "$CORPUS/pytest.log"

# vitest (Unicode ✕ / ❯).
printf '%s\n' \
  ' RUN  v1.6.0' \
  ' ❯ src/sum.test.ts (1 test | 1 failed)' \
  '   ✕ adds numbers' \
  ' FAIL  src/sum.test.ts > adds numbers' \
  'AssertionError: expected 3 to be 4' \
  ' ❯ src/sum.test.ts:5:23' \
  ' Test Files  1 failed (1)' \
  '      Tests  1 failed (1)' \
  > "$CORPUS/vitest.log"

# jest (Unicode ●, expect/Expected/Received, stack ref).
printf '%s\n' \
  ' FAIL  src/sum.test.js' \
  '  ● Calc › adds' \
  '    expect(received).toBe(expected)' \
  '    Expected: 4' \
  '    Received: 3' \
  '      at Object.<anonymous> (src/sum.test.js:5:19)' \
  > "$CORPUS/jest.log"

# maven surefire (tab-led stack frame).
printf '%s\n' \
  '[INFO] Running com.example.CalcTest' \
  '[ERROR] Tests run: 1, Failures: 1 <<< FAILURE!' \
  'org.opentest4j.AssertionFailedError: expected: <4> but was: <3>' \
  > "$CORPUS/maven.log"
printf '\tat com.example.CalcTest.testAdd(CalcTest.java:12)\n' >> "$CORPUS/maven.log"

# No-signal log → tail fallback.
printf '%s\n' 'Building project...' 'Compiling module A' 'Compiling module B' 'Done in 4.2s' \
  > "$CORPUS/nosig.log"

# No-signal log WITH interior blanks (tail fallback drops blanks → fewer lines).
printf '%s\n' 'first line' '' '   ' 'last line' > "$CORPUS/blanks.log"

# Empty file (both paths print nothing).
: > "$CORPUS/empty.log"

# Large all-signal log (exercises the MAX cap: more signal lines than MAX).
: > "$CORPUS/big.log"
for i in $(seq 1 60); do printf 'FAIL case %s\n' "$i" >> "$CORPUS/big.log"; done

for f in go pytest vitest jest maven nosig blanks empty; do
  distill_case "$f" "$CORPUS/$f.log" 40
done
# MAX-cap parity at several caps (fewer, equal, more than the signal count).
distill_case "big" "$CORPUS/big.log" 2
distill_case "big" "$CORPUS/big.log" 40
distill_case "big" "$CORPUS/big.log" 60
distill_case "go-capped" "$CORPUS/go.log" 3
# Missing input file: `[ -f ] || return 0` in BOTH branches → nothing, identical.
distill_case "missing-file" "$CORPUS/does-not-exist.log" 40

# ── EXTRACT corpus ───────────────────────────────────────────────────
# One frame (with a trailing blank body line the extractor must drop).
{
  printf 'GATE\ttests\tapp\tFAIL\t1\texited 1: npm test\n'
  printf -- '---DOD-OUTPUT tests@app---\n'
  printf 'AssertionError: boom\n'
  printf '  at f.ts:1:2\n'
  printf '\n'
  printf -- '---END-DOD-OUTPUT---\n'
} > "$CORPUS/res-one.results"

# Two frames.
{
  printf -- '---DOD-OUTPUT tests@app---\n'
  printf 'boom one\n'
  printf -- '---END-DOD-OUTPUT---\n'
  printf -- '---DOD-OUTPUT lint@app---\n'
  printf 'boom two\n'
  printf -- '---END-DOD-OUTPUT---\n'
} > "$CORPUS/res-many.results"

# No frame at all.
printf 'GATE\ttests\trepo\tPASS\t0\tnpm test\n' > "$CORPUS/res-none.results"

# Header with a trailing --- plus trailing whitespace, and body outside a frame.
{
  printf 'noise before any frame\n'
  printf -- '---DOD-OUTPUT tests@app---  \n'
  printf 'inside\n'
  printf -- '---END-DOD-OUTPUT---\n'
  printf 'noise after the frame\n'
} > "$CORPUS/res-ws.results"

for r in res-one res-many res-none res-ws; do
  extract_case "$r" "$CORPUS/$r.results"
done
# Missing results file: both paths print nothing.
extract_case "missing-file" "$CORPUS/does-not-exist.results"

echo "dod-distill-parity: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
