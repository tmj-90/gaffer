#!/usr/bin/env bash
# =====================================================================
# runner/test/run.sh — the runner test harness itself. Drives it over throwaway
# fixture tests and proves:
#   H1  a FAILING test fails the run even when a passing test runs after it (the
#       bare `for t in …; do bash "$t"; done` loop reported only the last status)
#   H2  exit 77 is a SKIP — listed, not counted as a pass, not a failure
#   H3  GAFFER_TEST_STRICT=1: a skip off lib/skip.sh's allowlist ("dispatch CLI not
#       built") fails the test; an allowlisted one ("docker daemon unavailable")
#       does not; a section skip ("SKIP: …" from a passing test) is held to the same
#   H4  the claude TRIPWIRE: `claude -p …` (PATH or $CLAUDE_BIN) fails the run and is
#       named in the summary; `claude --version` is allowed
#   H5  operator-state guard: a file written under the checkout's .gaffer during the
#       run fails a strict run and only warns otherwise
#   H6  isolation: tests see a private GAFFER_DATA and no inherited DISPATCH_DB
#   H7  the per-test wall-clock cap kills a hung test and reports TIMED OUT
#   H8  argument parsing: the `--` pnpm 10 forwards (`pnpm test:runner -- -j 2`) is
#       dropped, not run as a "test"; an unknown option, a missing FILE or a bad -j
#       is a usage error (exit 2), never a run
#   H9  sharding: `--shard K/N` / GAFFER_RUN_SHARD=K/N over the REAL test set — the
#       shards partition it exactly for N=2 and N=3 (union == all, pairwise
#       disjoint), the assignment is identical across invocations and between the
#       flag and the env var, a K/N out of range (or malformed) is a usage error, a
#       sharded run runs only its shard and names it in the banner, and an outer
#       GAFFER_RUN_SHARD (a CI shard job running this file) never leaks into a test
# Run: bash runner/test/run-harness.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
command -v perl >/dev/null 2>&1 || { echo "SKIP: perl required"; exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/run-harness.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
T="$WORK/t"; mkdir -p "$T" "$WORK/root/.gaffer"
mk() { printf '#!/usr/bin/env bash\n%s\n' "$2" > "$T/$1"; }
# A nested run must not write into the outer CI job's step summary or annotations.
# Nor be sharded by the outer CI job's GAFFER_RUN_SHARD.
harness() { env -u GITHUB_STEP_SUMMARY -u GITHUB_ACTIONS -u GAFFER_TEST_STRICT -u GAFFER_RUN_SHARD GAFFER_RUN_STATE_ROOT="$WORK/root" bash "$HERE/run.sh" -j 2 "$@" >"$WORK/out" 2>&1; }

echo "== H1: a failure is not hidden by a later pass =="
mk a-fail.test.sh 'echo "FAIL: deliberate"; exit 1'
mk z-pass.test.sh 'echo ok; exit 0'
harness "$T/a-fail.test.sh" "$T/z-pass.test.sh"; rc=$?
[ "$rc" -ne 0 ] && ok "H1 run exits non-zero (rc $rc) when the FIRST test fails and the last passes" || fail "H1 run exited 0 with a failing test"
grep -q 'a-fail.test.sh — exit 1' "$WORK/out" && ok "H1 the failing test is named in the summary" || fail "H1 summary lacks the failure: $(tail -5 "$WORK/out")"
harness "$T/z-pass.test.sh"; rc=$?
[ "$rc" -eq 0 ] && ok "H1 control: an all-pass run exits 0" || fail "H1 all-pass run exited $rc: $(tail -5 "$WORK/out")"

echo "== H2: exit 77 is a skip =="
mk skip.test.sh '. "'"$HERE"'/lib/skip.sh"; gaffer_skip "docker daemon unavailable"'
harness "$T/skip.test.sh" "$T/z-pass.test.sh"; rc=$?
[ "$rc" -eq 0 ] && ok "H2 a skipped test does not fail a non-strict run" || fail "H2 rc $rc: $(tail -5 "$WORK/out")"
grep -q '1 passed, 1 skipped, 0 failed' "$WORK/out" && ok "H2 the skip is counted as a skip, not a pass" || fail "H2 counts wrong: $(grep 'Runner tests' "$WORK/out")"
grep -q 'skip.test.sh: docker daemon unavailable' "$WORK/out" && ok "H2 the skip reason is listed" || fail "H2 reason not listed"

echo "== H3: strict mode holds skips to the allowlist =="
mk notbuilt.test.sh 'echo "SKIP: dispatch CLI not built (x) — run pnpm -r build"; exit 0'
mk section.test.sh 'echo "  ok   a real check"; echo "  SKIP: node:sqlite unavailable"; exit 0'
harness "$T/notbuilt.test.sh"; rc=$?
[ "$rc" -eq 0 ] && ok "H3 non-strict: a not-built skip is reported, not failed" || fail "H3 non-strict rc $rc"
harness --strict "$T/notbuilt.test.sh"; rc=$?
[ "$rc" -ne 0 ] && grep -q 'strict: skip not on the allowlist' "$WORK/out" \
  && ok "H3 strict: 'dispatch CLI not built' FAILS (CI builds dispatch)" || fail "H3 strict let a not-built skip pass (rc $rc)"
harness --strict "$T/section.test.sh"; rc=$?
[ "$rc" -ne 0 ] && ok "H3 strict: an off-allowlist SECTION skip in a passing test fails too" || fail "H3 strict section skip passed (rc $rc)"
harness --strict "$T/skip.test.sh"; rc=$?
[ "$rc" -eq 0 ] && ok "H3 strict: an allowlisted skip (docker) still passes" || fail "H3 strict failed an allowlisted skip (rc $rc): $(tail -5 "$WORK/out")"
mk legacy-ok-skip.test.sh 'echo "  ok   SKIP AC10 — dispatch CLI not built"; exit 0'
harness --strict "$T/legacy-ok-skip.test.sh"; rc=$?
[ "$rc" -ne 0 ] && ok "H3 strict: a legacy 'ok SKIP …' line is a skip, not a pass" || fail "H3 'ok SKIP' line slipped through"

echo "== H4: the claude tripwire =="
mk model.test.sh 'claude -p "do something expensive" --model x; echo "rc=$?"; exit 0'
mk modelbin.test.sh '"$CLAUDE_BIN" -p "via CLAUDE_BIN"; exit 0'
mk version.test.sh 'claude --version >/dev/null || exit 1; exit 0'
harness -v "$T/model.test.sh"; rc=$?
[ "$rc" -ne 0 ] && grep -q 'claude tripwire: 1 real model call' "$WORK/out" \
  && ok "H4 a bare \`claude -p\` fails the run and is counted" || fail "H4 tripwire missed claude -p (rc $rc): $(tail -8 "$WORK/out")"
grep -q 'model.test.sh	cwd=.*argv=-p do something expensive' "$WORK/out" && ok "H4 the hit names the test and its argv" || fail "H4 hit lacks test/argv"
grep -q 'rc=97' "$WORK/out" && ok "H4 the tripwire call exits 97 (never reaches a real claude)" || fail "H4 tripwire exit code"
harness "$T/modelbin.test.sh"; rc=$?
[ "$rc" -ne 0 ] && ok "H4 \$CLAUDE_BIN points at the tripwire too" || fail "H4 CLAUDE_BIN not tripwired"
CLAUDE_BIN=/bin/false harness "$T/modelbin.test.sh"; rc=$?
[ "$rc" -ne 0 ] && ok "H4 an operator's exported CLAUDE_BIN is replaced, not inherited" || fail "H4 inherited CLAUDE_BIN"
harness "$T/version.test.sh"; rc=$?
[ "$rc" -eq 0 ] && ok "H4 \`claude --version\` is allowed" || fail "H4 --version tripped (rc $rc)"

echo "== H5: operator-state guard =="
mk polluter.test.sh 'echo x > "'"$WORK"'/root/.gaffer/dispatch.sqlite"; exit 0'
harness "$T/polluter.test.sh"; rc=$?
[ "$rc" -eq 0 ] && grep -q '^- .gaffer/dispatch.sqlite' "$WORK/out" \
  && ok "H5 non-strict: the write is reported, run still passes" || fail "H5 non-strict (rc $rc): $(tail -8 "$WORK/out")"
harness --strict "$T/polluter.test.sh"; rc=$?
[ "$rc" -ne 0 ] && grep -q 'operator state written during the run: .gaffer/dispatch.sqlite' "$WORK/out" \
  && ok "H5 strict: the write fails the run" || fail "H5 strict let operator-state pollution pass (rc $rc)"

echo "== H6: isolation =="
mk iso.test.sh '[ -z "${DISPATCH_DB:-}" ] || { echo "FAIL: inherited DISPATCH_DB=$DISPATCH_DB"; exit 1; }
case "$GAFFER_DATA" in "'"$ROOT"'"/*) echo "FAIL: GAFFER_DATA in the checkout"; exit 1 ;; esac
[ -d "$GAFFER_DATA" ] || { echo "FAIL: private GAFFER_DATA missing"; exit 1; }'
DISPATCH_DB="$ROOT/.gaffer/dispatch.sqlite" GAFFER_DATA="$ROOT/.gaffer" harness "$T/iso.test.sh"; rc=$?
[ "$rc" -eq 0 ] && ok "H6 a test sees a private GAFFER_DATA and no inherited DISPATCH_DB" || fail "H6 isolation broken: $(grep FAIL "$WORK/out" | head -2)"

echo "== H7: the per-test cap =="
mk hang.test.sh 'sleep 30'
GAFFER_RUN_CAP_SH=1 harness "$T/hang.test.sh"; rc=$?
[ "$rc" -ne 0 ] && grep -q 'hang.test.sh — TIMED OUT (1s)' "$WORK/out" && ok "H7 a hung test is killed and reported TIMED OUT" || fail "H7 cap (rc $rc): $(tail -5 "$WORK/out")"

echo "== H8: argument parsing =="
harness -- -j 1 "$T/z-pass.test.sh"; rc=$?
[ "$rc" -eq 0 ] && grep -q '1 passed, 0 skipped, 0 failed' "$WORK/out" && grep -q -- '-j 1' "$WORK/out" \
  && ok "H8 \`-- -j 1 FILE\`: the \`--\` is dropped and -j after it still applies" || fail "H8 '--' mishandled (rc $rc): $(tail -5 "$WORK/out")"
harness --jobs 2 "$T/z-pass.test.sh"; rc=$?
[ "$rc" -eq 2 ] && grep -q "unknown option '--jobs'" "$WORK/out" \
  && ok "H8 an unknown option is a usage error (exit 2)" || fail "H8 unknown option (rc $rc): $(tail -3 "$WORK/out")"
harness "$T/no-such.test.sh"; rc=$?
[ "$rc" -eq 2 ] && grep -q 'no such test file' "$WORK/out" \
  && ok "H8 a missing FILE is a usage error, not a run" || fail "H8 missing file (rc $rc): $(tail -3 "$WORK/out")"
harness -j x "$T/z-pass.test.sh"; rc=$?
[ "$rc" -eq 2 ] && ok "H8 a non-numeric -j is a usage error" || fail "H8 -j x (rc $rc): $(tail -3 "$WORK/out")"
# The real pnpm path (CONTRIBUTING.md documents it), when pnpm is on PATH.
if command -v pnpm >/dev/null 2>&1; then
  (cd "$ROOT" && env -u GITHUB_STEP_SUMMARY -u GITHUB_ACTIONS -u GAFFER_TEST_STRICT -u GAFFER_RUN_SHARD GAFFER_RUN_STATE_ROOT="$WORK/root" \
    pnpm --silent test:runner -- -j 1 "$T/z-pass.test.sh") >"$WORK/out" 2>&1; rc=$?
  [ "$rc" -eq 0 ] && grep -q '1 passed, 0 skipped, 0 failed' "$WORK/out" \
    && ok "H8 \`pnpm test:runner -- -j 1 FILE\` runs exactly that FILE" || fail "H8 pnpm path (rc $rc): $(tail -5 "$WORK/out")"
fi

echo "== H9: sharding =="
# --list prints what a run would run, so the partition is checked over all ~200 real
# test files without running them. C collation: the comparison, not the shard, is
# what needs a fixed order.
lst() { env -u GAFFER_RUN_SHARD bash "$HERE/run.sh" --list "$@" 2>&1 | LC_ALL=C sort; }
lst >"$WORK/all"
n_all=$(wc -l <"$WORK/all" | tr -d ' ')
[ "$n_all" -gt 50 ] && ok "H9 --list (no shard) lists the whole real set ($n_all files)" || fail "H9 --list gave $n_all files: $(head -3 "$WORK/all")"
for N in 2 3; do
  : >"$WORK/union"; sum=0; empty=0
  for k in $(seq 1 "$N"); do
    lst --shard "$k/$N" >"$WORK/s$k"
    c=$(wc -l <"$WORK/s$k" | tr -d ' '); sum=$((sum + c)); [ "$c" -gt 0 ] || empty=1
    cat "$WORK/s$k" >>"$WORK/union"
  done
  LC_ALL=C sort "$WORK/union" >"$WORK/union.sorted"
  cmp -s "$WORK/union.sorted" "$WORK/all" && ok "H9 N=$N: the union of the shards is exactly the full set" \
    || fail "H9 N=$N union != all: $(diff "$WORK/union.sorted" "$WORK/all" | head -4 | tr '\n' ' ')"
  [ "$sum" -eq "$n_all" ] && [ -z "$(LC_ALL=C uniq -d "$WORK/union.sorted")" ] \
    && ok "H9 N=$N: the shards are pairwise disjoint (sizes sum to $n_all, no file twice)" \
    || fail "H9 N=$N overlap: sizes sum to $sum of $n_all; twice: $(LC_ALL=C uniq -d "$WORK/union.sorted" | head -3 | tr '\n' ' ')"
  [ "$empty" -eq 0 ] && ok "H9 N=$N: no shard is empty" || fail "H9 N=$N: an empty shard"
done
lst --shard 2/3 >"$WORK/a"; lst --shard 2/3 >"$WORK/b"
(cd "$ROOT/runner" && env GAFFER_RUN_SHARD=2/3 bash test/run.sh --list | LC_ALL=C sort) >"$WORK/c"
lst --shard=2/3 >"$WORK/d"
cmp -s "$WORK/a" "$WORK/b" && ok "H9 the assignment is stable across two invocations" || fail "H9 2/3 differs between two invocations"
cmp -s "$WORK/a" "$WORK/c" && cmp -s "$WORK/a" "$WORK/d" \
  && ok "H9 GAFFER_RUN_SHARD=2/3, --shard 2/3 and --shard=2/3 (from another cwd) pick the same files" \
  || fail "H9 env / flag / cwd disagree on shard 2/3"
for bad in 0/3 4/3 3/0 1/ x/2 2 -1/2; do
  harness --shard "$bad" "$T/z-pass.test.sh"; rc=$?
  [ "$rc" -eq 2 ] && grep -q 'needs K/N' "$WORK/out" && ! grep -q 'Runner tests' "$WORK/out" \
    && ok "H9 --shard $bad is a usage error (exit 2), not a run" || fail "H9 --shard $bad (rc $rc): $(tail -3 "$WORK/out")"
done
env GAFFER_RUN_SHARD=5/4 bash "$HERE/run.sh" --list >"$WORK/out" 2>&1; rc=$?
[ "$rc" -eq 2 ] && ok "H9 GAFFER_RUN_SHARD=5/4 is a usage error too" || fail "H9 env 5/4 (rc $rc)"
# A real sharded run over fixtures: it runs exactly its shard's files and says so.
for x in p1 p2 p3 p4 p5; do mk "shard-$x.test.sh" 'echo ok; exit 0'; done
SF=("$T"/shard-p*.test.sh)
harness --shard 1/2 --list "${SF[@]}"; n1=$(grep -c 'shard-p' "$WORK/out")
harness --shard 2/2 --list "${SF[@]}"; n2=$(grep -c 'shard-p' "$WORK/out")
harness --shard 1/2 "${SF[@]}"; rc=$?
[ "$rc" -eq 0 ] && grep -q "run.sh: shard 1/2: $n1 of 5 test file(s)" "$WORK/out" && grep -q "$n1 passed, 0 skipped, 0 failed" "$WORK/out" \
  && [ $((n1 + n2)) -eq 5 ] && grep -q '(shard 1/2)' "$WORK/out" \
  && ok "H9 a sharded run runs only its $n1 of 5 fixtures and names the shard in the banner and summary" \
  || fail "H9 sharded run (rc $rc, $n1+$n2): $(grep -E 'run.sh:|Runner tests' "$WORK/out" | tr '\n' ' ')"
mk shard-leak.test.sh '[ -z "${GAFFER_RUN_SHARD:-}" ] || { echo "FAIL: inherited GAFFER_RUN_SHARD=$GAFFER_RUN_SHARD"; exit 1; }'
env -u GITHUB_STEP_SUMMARY -u GITHUB_ACTIONS -u GAFFER_TEST_STRICT GAFFER_RUN_STATE_ROOT="$WORK/root" GAFFER_RUN_SHARD=1/1 \
  bash "$HERE/run.sh" -j 1 "$T/shard-leak.test.sh" >"$WORK/out" 2>&1; rc=$?
[ "$rc" -eq 0 ] && ok "H9 a test never inherits the run's GAFFER_RUN_SHARD" || fail "H9 GAFFER_RUN_SHARD leaked into a test: $(grep FAIL "$WORK/out" | head -1)"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "run-harness: ALL $PASS checks passed"; exit 0
fi
echo "run-harness: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
