#!/usr/bin/env bash
# =====================================================================
# Guard: no runner test creates a temp dir it does not check, or removes one unsafely.
# ---------------------------------------------------------------------
# External review #6: orphan-recovery.test.sh did `WORK="$(mktemp -d …)"`, then
# `WORK="$(cd "$WORK" && pwd -P)"` and `trap 'rm -rf "$WORK"' EXIT`. When mktemp failed,
# WORK became the current directory and the trap deleted the checkout the test ran from
# (.git included), while the test reported 11 passing checks. The rule
# (runner/test/lib/mktemp-lint.mjs, helpers in runner/test/lib/tmpdir.{sh,mjs}):
#
#   N1  static, over every shell and .mjs file under runner/test and
#       scripts/ui-regression: each mktemp / gaffer_test_tmpdir / temp-producing
#       function result is checked right after it is created (T1), no mktemp result is
#       used before it can be checked (T2), no temp root is removed with a bare
#       `rm -rf "$VAR"` instead of gaffer_test_rm_work (T3), and no .mjs calls
#       mkdtempSync( directly instead of gafferMkdtemp (M1)
#   N2  the linter catches the shapes it exists for, and allows the guarded ones
#       (else N1 is vacuous)
#   N3  gaffer_test_rm_work refuses ".", "/", "", $HOME, the start dir, the repo root,
#       an ancestor of them and a path outside the temp roots, and removes a real
#       temp dir; gaffer_test_tmpdir exits 70 with the message when mktemp fails
#
# Run: bash runner/test/no-unchecked-mktemp.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
# shellcheck source=lib/tmpdir.sh
. "$HERE/lib/tmpdir.sh"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
LINT="$HERE/lib/mktemp-lint.mjs"

echo "== N1: every temp dir in the test tree is checked and removed safely =="
FILES=()
while IFS= read -r f; do FILES+=("$f"); done < <(find "$RUNNER_DIR/test" "$ROOT/scripts/ui-regression" -type f \( -name '*.sh' -o -name '*.mjs' \) 2>/dev/null | sort)
[ "${#FILES[@]}" -gt 150 ] && ok "N1 scanning ${#FILES[@]} files" || fail "N1 found only ${#FILES[@]} files to scan (wrong root?)"
HITS="$(node "$LINT" "${FILES[@]}")"; rc=$?
if [ "$rc" = 0 ] && [ -z "$HITS" ]; then
  ok "N1 no unchecked mktemp, no bare rm -rf of a temp root, no direct mkdtempSync"
else
  fail "N1 unchecked temp dirs / unsafe cleanup (see runner/test/lib/tmpdir.sh):"
  printf '%s\n' "$HITS" | sed "s#^$ROOT/#      #" | head -200
fi

echo "== N2: the linter catches the shapes it exists for =="
WORK="$(gaffer_test_tmpdir no-unchecked-mktemp)" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
probe() { # <name> <ext> <body> → the rule ids the linter reports (sorted, space-joined)
  printf '%s\n' "$3" >"$WORK/$1.$2"
  node "$LINT" "$WORK/$1.$2" | awk -F': ' '{print $2}' | sort -u | tr '\n' ' ' | sed 's/ $//'
}
bad() { local got; got="$(probe "$1" "$2" "$4")"; [ "$got" = "$3" ] && ok "N2 flags $1 ($3)" || fail "N2 $1: expected [$3], got [$got]"; }
good() { local got; got="$(probe "$1" "$2" "$3")"; [ -z "$got" ] && ok "N2 allows $1" || fail "N2 $1 wrongly flagged: [$got]"; }
bad  unchecked-canon sh "T1 T3" 'WORK="$(mktemp -d "${TMPDIR:-/tmp}/x.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
trap '"'"'rm -rf "$WORK"'"'"' EXIT'
bad  unchecked-file sh T1 'FN="$(mktemp)"'
bad  extended sh T2 'R="$(mktemp -d)/bare.git"'
bad  inline-arg sh T2 'git init -q "$(mktemp -d)"'
bad  fn-result sh T1 'mk() {
  local D; D="$(mktemp -d)"
  gaffer_test_check_tmp "$D" || exit 70
  echo "$D"
}
D="$(mk)"; git -C "$D" init -q'
bad  bare-rm sh T3 'WORK="$(mktemp -d)" || exit 70
rm -rf "$WORK"'
bad  dirname-rm sh T3 'WORK="$(mktemp -d)" || exit 70
rm -rf "$(dirname "$WORK")"'
bad  iso-rm sh T3 'gaffer_test_isolate; trap '"'"'rm -rf "$GAFFER_TEST_ISO"'"'"' EXIT'
bad  mkdtemp mjs M1 'import { mkdtempSync } from "node:fs";
const W = mkdtempSync("/tmp/x-");'
good guarded-next sh 'WORK="$(mktemp -d "${TMPDIR:-/tmp}/x.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
trap '"'"'gaffer_test_rm_work "$WORK"'"'"' EXIT'
good guarded-inline sh 'WORK="$(mktemp -d)"
[ -n "$WORK" ] && [ -d "$WORK" ] || exit 70'
good guarded-or-exit sh 'WORK="$(gaffer_test_tmpdir x)" || exit 70'
good name-only sh 'L="$(mktemp -u "${TMPDIR:-/tmp}/lk.XXXX")"'
good subpath-rm sh 'WORK="$(mktemp -d)" || exit 70
rm -rf "$WORK/sub"'
good heredoc-body sh 'cat >"$X" <<'"'"'SH'"'"'
D="$(mktemp -d)"; rm -rf "$D"
SH'
good comment sh '# WORK="$(mktemp -d)"; rm -rf "$WORK"'
good helper mjs 'import { gafferMkdtemp } from "./lib/tmpdir.mjs";
const W = gafferMkdtemp("/tmp/x-");'

echo "== N3: the safe removal refuses what must survive, and removes a temp dir =="
refuses() { local why; why="$(gaffer_test_rm_work "$2" 2>&1)" && fail "N3 removed $1 ($2)" \
  || { grep -q 'NOT removing' <<<"$why" && ok "N3 refuses $1" || fail "N3 $1: no refusal message: $why"; }; }
refuses "an empty path" ""
refuses "." "."
refuses "/" "/"
refuses "\$HOME" "$HOME"
refuses "the repository root" "$ROOT"
refuses "an ancestor of the repository root" "$(dirname "$ROOT")"
refuses "a relative path" "runner"
refuses "a directory outside every temp root" "$RUNNER_DIR/test/lib"
[ -d "$ROOT/.git" ] || [ -f "$ROOT/.git" ] && ok "N3 the checkout's .git is still there" || fail "N3 the checkout's .git vanished"
T="$(gaffer_test_tmpdir rmwork-probe)" || exit 70
mkdir -p "$T/a/b"; echo x >"$T/a/b/f"
gaffer_test_rm_work "$T" && [ ! -e "$T" ] && ok "N3 removes a real temp dir" || fail "N3 did not remove $T"
mkdir -p "$WORK/stub"; printf '#!/bin/sh\nexit 1\n' >"$WORK/stub/mktemp"; chmod +x "$WORK/stub/mktemp"
OUT="$(PATH="$WORK/stub:$PATH" bash -c '. "$1"; W="$(gaffer_test_tmpdir probe)" || exit $?; echo "SHOULD-NOT-RUN $W"' _ "$HERE/lib/tmpdir.sh" 2>&1)"; rc=$?
[ "$rc" = 70 ] && ok "N3 gaffer_test_tmpdir: a failing mktemp exits 70" || fail "N3 expected rc 70, got $rc: $OUT"
grep -q 'refusing to run' <<<"$OUT" && ! grep -q SHOULD-NOT-RUN <<<"$OUT" && ok "N3 … with the clear message, and nothing after it runs" || fail "N3 message missing or the caller continued: $OUT"
OUT="$(TMPDIR="$WORK/no-such" node --input-type=module -e "import { gafferMkdtemp } from '$HERE/lib/tmpdir.mjs'; import { join } from 'node:path'; import { tmpdir } from 'node:os'; gafferMkdtemp(join(tmpdir(), 'p-')); console.log('SHOULD-NOT-RUN');" 2>&1)"; rc=$?
[ "$rc" = 70 ] && grep -q 'refusing to run' <<<"$OUT" && ! grep -q SHOULD-NOT-RUN <<<"$OUT" \
  && ok "N3 gafferMkdtemp: a missing TMPDIR exits 70 with the message" || fail "N3 gafferMkdtemp rc $rc: $OUT"
OUT="$(cd "$WORK" && TMPDIR=. node --input-type=module -e "import { gafferMkdtemp } from '$HERE/lib/tmpdir.mjs'; import { join } from 'node:path'; import { tmpdir } from 'node:os'; gafferMkdtemp(join(tmpdir(), 'p-')); console.log('SHOULD-NOT-RUN');" 2>&1)"; rc=$?
[ "$rc" = 70 ] && ! ls -d "$WORK"/p-* >/dev/null 2>&1 \
  && ok "N3 gafferMkdtemp: a relative TMPDIR is refused and its stray dir removed" || fail "N3 relative TMPDIR rc $rc: $OUT"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "no-unchecked-mktemp: ALL $PASS checks passed"
  exit 0
fi
echo "no-unchecked-mktemp: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]})) checks FAILED"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
