#!/usr/bin/env bash
# =====================================================================
# preflight.sh loads the safety hook's rules, not only the core's syntax.
# ---------------------------------------------------------------------
# The decision lives in runner/lib/hook/*.mjs behind safety-hook-core.mjs, so
# `node --check safety-hook-core.mjs` no longer sees a missing or broken rule
# module. preflight loads the core once: a copy of the runner with a lib/hook/
# module or lib/dangerous-commands.mjs gone must show a ✗ (the hook would block
# every tool call), and the intact runner a ✓. tick.sh's up-front check
# (gaffer_assert_safety_hook) refuses a runner without lib/hook/ before it launches
# an agent, naming the directory.
# Zero deps. Run: bash test/preflight-hook-rules.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/preflight-hook-rules.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT

pf() { env GAFFER_HOME="$WORK/home" GAFFER_DATA="$WORK/data" GAFFER_REGISTRY_PROBE=0 bash "$1/preflight.sh" 2>&1; }
LOADS="✓ safety hook rules load"
BROKEN="✗ safety hook rules do not load"

echo "== the intact runner =="
OUT="$(pf "$RUNNER_DIR")"
[[ "$OUT" == *"$LOADS"* ]] && ok "preflight loads the hook's rules (✓)" \
  || fail "no '$LOADS' line: $(printf '%s' "$OUT" | grep -i 'safety hook')"

echo "== a copy without one lib/hook module =="
mkdir -p "$WORK/copy"
cp -R "$RUNNER_DIR/safety-hook.mjs" "$RUNNER_DIR/safety-hook-core.mjs" "$RUNNER_DIR/preflight.sh" "$WORK/copy/"
mkdir -p "$WORK/copy/lib"
cp -R "$RUNNER_DIR/lib/hook" "$RUNNER_DIR/lib/dangerous-commands.mjs" "$WORK/copy/lib/"
cp "$RUNNER_DIR"/lib/*.sh "$WORK/copy/lib/" 2>/dev/null
for f in "$RUNNER_DIR"/*.sh; do cp "$f" "$WORK/copy/"; done
cp -R "$RUNNER_DIR/config" "$WORK/copy/"
OUT="$(pf "$WORK/copy")"
[[ "$OUT" == *"$LOADS"* ]] && ok "the copy loads before anything is removed" \
  || fail "copy baseline: $(printf '%s' "$OUT" | grep -i 'safety hook')"
mv "$WORK/copy/lib/hook/reads.mjs" "$WORK/reads.mjs"
OUT="$(pf "$WORK/copy")"
[[ "$OUT" == *"$BROKEN"* ]] && ok "a missing lib/hook module is a ✗" \
  || fail "missing module not caught: $(printf '%s' "$OUT" | grep -i 'safety hook')"
[[ "$OUT" == *"✓ safety hook core parses"* ]] && ok "(the core alone still parses, which is why the load check is needed)" \
  || fail "core parse line changed: $(printf '%s' "$OUT" | grep -i 'safety hook')"
mv "$WORK/reads.mjs" "$WORK/copy/lib/hook/reads.mjs"

echo "== a copy without the deny-list =="
rm "$WORK/copy/lib/dangerous-commands.mjs"
OUT="$(pf "$WORK/copy")"
[[ "$OUT" == *"$BROKEN"* ]] && ok "a missing lib/dangerous-commands.mjs is a ✗" \
  || fail "missing deny-list not caught: $(printf '%s' "$OUT" | grep -i 'safety hook')"

echo "== tick.sh's up-front check (gaffer_assert_safety_hook) names lib/hook =="
cp "$RUNNER_DIR/lib/dangerous-commands.mjs" "$WORK/copy/lib/"
ASSERT_FN="$(sed -n '/^gaffer_assert_safety_hook() {$/,/^}$/p' "$RUNNER_DIR/tick.sh")"
[ -n "$ASSERT_FN" ] || fail "gaffer_assert_safety_hook() not found in tick.sh"
assert_in() {  # $1 = runner dir; prints the log line, exits with the function's status
  ( RUNNER_DIR="$1"; log() { printf '%s\n' "$*"; }; eval "$ASSERT_FN"; gaffer_assert_safety_hook )
}
OUT="$(assert_in "$WORK/copy")" && ok "the intact copy passes the up-front check" \
  || fail "intact copy refused: $OUT"
mv "$WORK/copy/lib/hook" "$WORK/hook-away"
if OUT="$(assert_in "$WORK/copy")"; then
  fail "a runner without lib/hook passes the up-front check (the tick would launch an agent whose hook blocks every call)"
else
  [[ "$OUT" == *"lib/hook"* ]] && ok "a runner without lib/hook is refused up front, naming lib/hook" \
    || fail "refused without naming lib/hook: $OUT"
fi
mv "$WORK/hook-away" "$WORK/copy/lib/hook"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
