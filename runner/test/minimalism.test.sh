#!/usr/bin/env bash
# =====================================================================
# MINIMALISM post-condition validation (lib/minimalism.sh).
# ---------------------------------------------------------------------
# Proves, against a REAL git repo + the REAL functions:
#   AC1  gaffer_diff_stats computes files + lines (added+deleted) from a diff
#   AC2  a missing smallest-change note FAILS the post-condition (return 1)
#   AC3  a present note with a small diff PASSES (return 0, verdict ok)
#   AC4  an oversized diff (over a cap) FLAGS but does NOT fail (return 2)
#   AC5  caps are configurable (OVERSIZED_MAX_LINES / OVERSIZED_MAX_FILES)
#   AC6  MINIMALISM_ENFORCE=0 downgrades a missing note to a flag (return 2)
#   AC7  the config keys are present + commented in factory.config.sh
#
# Zero deps; needs only git. Run: bash test/minimalism.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

# Defaults the functions read.
export OVERSIZED_MAX_LINES=400 OVERSIZED_MAX_FILES=12 MINIMALISM_ENFORCE=1
# shellcheck source=../lib/minimalism.sh
source "$RUNNER_DIR/lib/minimalism.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/minimalism-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

REPO="$WORK/repo"
git init -q -b main "$REPO"
git -C "$REPO" config user.email gaffer@test; git -C "$REPO" config user.name gaffer-test
printf 'a\nb\nc\n' > "$REPO/file.txt"
git -C "$REPO" add -A && git -C "$REPO" commit -q -m base
git -C "$REPO" checkout -q -b gaffer/ticket-1
# One file, 2 lines added, 1 deleted → 2 files? no: 1 file, 3 churn.
printf 'a\nB\nc\nd\n' > "$REPO/file.txt"   # change line2 (b→B) + add line d → 2 added, 1 deleted
git -C "$REPO" commit -q -am change

echo "== AC1: gaffer_diff_stats computes files + lines =="
read -r F L <<< "$(gaffer_diff_stats "$REPO" main)"
[ "$F" = "1" ] && ok "files-changed = 1" || fail "files-changed should be 1 (got $F)"
[ "${L:-0}" -ge 2 ] && ok "lines-changed counted (=$L, added+deleted)" || fail "lines-changed should be >=2 (got $L)"

echo "== AC2: missing smallest-change note FAILS =="
V="$(gaffer_check_minimalism 1 10 "")"; RC=$?
if [ "$RC" -eq 1 ] && [ "$V" = "missing_note" ]; then
  ok "no note → verdict=missing_note, return 1 (FAILS): ${GAFFER_MINIMALISM_REASON:-}"
else
  fail "missing note should fail (rc=$RC, verdict=$V)"
fi
# Whitespace-only note counts as missing too.
V="$(gaffer_check_minimalism 1 10 "   ")"; RC=$?
[ "$RC" -eq 1 ] && ok "whitespace-only note still treated as missing" || fail "whitespace note should fail (rc=$RC)"

echo "== AC3: present note + small diff PASSES =="
V="$(gaffer_check_minimalism 1 10 "smallest-change: edited one line in file.txt")"; RC=$?
if [ "$RC" -eq 0 ] && [ "$V" = "ok" ]; then
  ok "note present + small diff → verdict=ok, return 0"
else
  fail "small diff with note should pass (rc=$RC, verdict=$V)"
fi

echo "== AC4: oversized diff FLAGS but does NOT fail =="
V="$(gaffer_check_minimalism 1 500 "smallest-change: big but necessary")"; RC=$?
if [ "$RC" -eq 2 ] && [ "$V" = "oversized_diff" ]; then
  ok "over line cap → verdict=oversized_diff, return 2 (flag, not fail): ${GAFFER_MINIMALISM_REASON:-}"
else
  fail "oversized lines should flag (rc=$RC, verdict=$V)"
fi
V="$(gaffer_check_minimalism 20 10 "smallest-change: many files")"; RC=$?
[ "$RC" -eq 2 ] && [ "$V" = "oversized_diff" ] && ok "over file cap → oversized_diff flag" || fail "oversized files should flag (rc=$RC, v=$V)"

echo "== AC5: caps are configurable =="
( export OVERSIZED_MAX_LINES=5 OVERSIZED_MAX_FILES=12
  V="$(gaffer_check_minimalism 1 6 "note")"; RC=$?
  [ "$RC" -eq 2 ] && [ "$V" = "oversized_diff" ] ) \
  && ok "lower OVERSIZED_MAX_LINES=5 makes a 6-line diff oversized" \
  || fail "configurable line cap not honoured"
( export OVERSIZED_MAX_LINES=0 OVERSIZED_MAX_FILES=0
  V="$(gaffer_check_minimalism 999 9999 "note")"; RC=$?
  [ "$RC" -eq 0 ] && [ "$V" = "ok" ] ) \
  && ok "caps of 0 disable the oversized check" \
  || fail "cap=0 should disable oversized detection"

echo "== AC6: MINIMALISM_ENFORCE=0 downgrades a missing note to a flag =="
( export MINIMALISM_ENFORCE=0
  V="$(gaffer_check_minimalism 1 10 "")"; RC=$?
  [ "$RC" -eq 2 ] ) \
  && ok "MINIMALISM_ENFORCE=0 → missing note returns 2 (flag, not fail)" \
  || fail "enforce=0 should not hard-fail a missing note"

echo "== AC7: config keys present + commented =="
for k in 'MINIMALISM_ENFORCE:=1' 'OVERSIZED_MAX_LINES:=400' 'OVERSIZED_MAX_FILES:=12'; do
  grep -Eq "^: \"\\\$\{$k\}\"" "$RUNNER_DIR/factory.config.sh" \
    && ok "$k default present in factory.config.sh" \
    || fail "$k default missing from factory.config.sh"
done

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
