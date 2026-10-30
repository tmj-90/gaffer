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
# Run: bash runner/test/run-harness.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
command -v perl >/dev/null 2>&1 || { echo "SKIP: perl required"; exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/run-harness.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
T="$WORK/t"; mkdir -p "$T" "$WORK/root/.gaffer"
mk() { printf '#!/usr/bin/env bash\n%s\n' "$2" > "$T/$1"; }
# A nested run must not write into the outer CI job's step summary or annotations.
harness() { env -u GITHUB_STEP_SUMMARY -u GITHUB_ACTIONS -u GAFFER_TEST_STRICT GAFFER_RUN_STATE_ROOT="$WORK/root" bash "$HERE/run.sh" -j 2 "$@" >"$WORK/out" 2>&1; }

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

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "run-harness: ALL $PASS checks passed"; exit 0
fi
echo "run-harness: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
