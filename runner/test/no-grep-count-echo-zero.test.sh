#!/usr/bin/env bash
# =====================================================================
# Guard: no `grep -c … || echo 0` in the runner's bash (exploratory finding
# fresh-user/F-18).
# ---------------------------------------------------------------------
# `grep -c` prints its count AND exits 1 when the count is 0, so
# `n="$(… | grep -c pat || echo 0)"` captures "0<newline>0". tick.sh logged
# "cards: primed delivery #1 with 0⏎0 file card(s)" and a numeric test on the value
# quietly read as false. Use `n="$(… | grep -c pat || true)"` and `${n:-0}`.
#   C1  static: no such idiom in runner/*.sh, runner/gaffer, runner/lib, runner/bin
#       (comments ignored)
#   C2  the idiom really does double the zero under pipefail, and the replacement
#       does not (so C1 guards a real fault)
# Run: bash runner/test/no-grep-count-echo-zero.test.sh   (bash 3.2 safe)
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

RE='grep[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*-[a-zA-Z]*c[a-zA-Z]*[[:space:]][^|]*\|\|[[:space:]]*echo[[:space:]]+0'
echo "== C1: no grep -c … || echo 0 =="
FILES=("$RUNNER_DIR"/*.sh "$RUNNER_DIR"/gaffer "$RUNNER_DIR"/lib/*.sh "$RUNNER_DIR"/bin/*.sh)
HITS="$(grep -nE "$RE" "${FILES[@]}" 2>/dev/null | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#')"
if [ -z "$HITS" ]; then ok "C1 no \`grep -c … || echo 0\` in the runner's bash (${#FILES[@]} files)"
else fail "C1 grep -c … || echo 0 captures '0⏎0' on a zero count — use '|| true' and \${n:-0}:"; printf '%s\n' "$HITS" | sed "s#^$RUNNER_DIR/#      #"; fi
for shape in 'n="$(printf x | grep -c . || echo 0)"' 'n="$(cmd | sed d | grep -c "^  - \[" 2>/dev/null || echo 0)"'; do
  [ "$(grep -cE "$RE" <<<"$shape")" = 1 ] && ok "C1 regex catches: $shape" || fail "C1 regex misses: $shape"
done
[ "$(grep -cE "$RE" <<<'n="$(cmd | grep -c . || true)"')" = 0 ] && ok "C1 regex allows the || true form" || fail "C1 regex flags the fix"

echo "== C2: the idiom doubles the zero; the fix does not =="
bad="$(printf '%s\n' "" | grep -c . || echo 0)"
good="$(printf '%s\n' "" | grep -c . || true)"; good="${good:-0}"
[ "$bad" = "$(printf '0\n0')" ] && ok "C2 '|| echo 0' yields '0⏎0' on a zero count" || fail "C2 idiom gave '$bad'"
[ "$good" = 0 ] && ok "C2 '|| true' yields '0'" || fail "C2 fix gave '$good'"
two="$(printf 'a\nb\n' | grep -c . || true)"
[ "${two:-0}" = 2 ] && ok "C2 '|| true' keeps a non-zero count" || fail "C2 count gave '$two'"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
