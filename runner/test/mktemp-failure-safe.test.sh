#!/usr/bin/env bash
# =====================================================================
# A failed mktemp must never cost the checkout a test ran from (external review #6).
# ---------------------------------------------------------------------
# The reviewer forced mktemp to fail in a disposable clone: orphan-recovery.test.sh
# turned its empty WORK into the current directory (`cd "" && pwd -P`), wrote its
# fixtures there, reported 11 passing checks, and its EXIT trap `rm -rf`'d the clone's
# .git. This drives representative tests from inside a scratch git checkout of the
# CURRENT tree under two failure modes:
#
#   M1  a stub `mktemp` first on PATH that exits 1
#   M2  TMPDIR pointing at a directory that does not exist
#
# and asserts, per test and mode: it exits non-zero, quickly, with the
# "refusing to run" message (lib/tmpdir.sh / lib/tmpdir.mjs), and afterwards the
# checkout's .git, HEAD, working tree and a marker in its root are intact, as are
# markers outside TMPDIR (a sibling dir and $HOME). Under M1 a .mjs test (Node's
# mkdtemp does not use the mktemp binary) may also pass normally; it must still leave
# everything intact.
#
# Run: bash runner/test/mktemp-failure-safe.test.sh [test-file ...]
#      (default: orphan-recovery.test.sh e2e-tick-live.test.sh build-log.test.mjs)
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
# shellcheck source=lib/tmpdir.sh
. "$HERE/lib/tmpdir.sh"

command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

SCR="$(gaffer_test_tmpdir mktemp-failure-safe)" || exit 70
trap 'gaffer_test_rm_work "$SCR"' EXIT

CASES=("$@")
[ "${#CASES[@]}" -gt 0 ] || CASES=(orphan-recovery.test.sh e2e-tick-live.test.sh build-log.test.mjs)

# The scratch checkout: the runner/ tree AS IT IS ON DISK (tracked + untracked, not
# ignored), committed into a fresh repo, with packages/ and node_modules/ linked in
# read-only for the tests that need the built CLIs. A clone of HEAD would test the
# last commit instead of the working tree.
make_checkout() { # <dir>
  local d="$1" list="$SCR/files.$$"
  mkdir -p "$d"
  (cd "$ROOT" && git ls-files -co --exclude-standard runner) | while IFS= read -r f; do
    [ -e "$ROOT/$f" ] && printf '%s\n' "$f"
  done >"$list"
  (cd "$ROOT" && tar -cf - -T "$list") | (cd "$d" && tar -xf -) || return 1
  for l in packages node_modules; do [ -e "$ROOT/$l" ] && ln -s "$ROOT/$l" "$d/$l"; done
  printf 'packages\nnode_modules\n' >"$d/.gitignore"
  echo "do not delete" >"$d/MARKER"
  git -C "$d" init -q -b main
  git -C "$d" -c user.email=t@e -c user.name=t add -A >/dev/null 2>&1
  git -C "$d" -c user.email=t@e -c user.name=t commit -qm checkout >/dev/null 2>&1
}

# A stub mktemp that always fails.
STUB="$SCR/stub-bin"; mkdir -p "$STUB"
printf '#!/bin/sh\necho "mktemp: stub failure" >&2\nexit 1\n' >"$STUB/mktemp"; chmod +x "$STUB/mktemp"

run_case() { # <test-file> <mode: stub|notmp>
  local t="$1" mode="$2" co="$SCR/co-$1-$2" home="$SCR/home-$1-$2" side="$SCR/side-$1-$2" ctmp="$SCR/tmp-$1-$2"
  local head rc t0 t1 out="$SCR/out-$1-$2" interp=bash tmpv
  case "$t" in *.mjs) interp=node ;; esac
  make_checkout "$co" || { fail "$t/$mode: could not build the scratch checkout"; return; }
  head="$(git -C "$co" rev-parse HEAD)"
  mkdir -p "$home" "$side" "$ctmp"; echo keep >"$home/MARKER"; echo keep >"$side/MARKER"
  if [ "$mode" = stub ]; then tmpv="$ctmp"; else tmpv="$SCR/no-such-tmpdir"; fi
  t0="$(date +%s)"
  if [ "$mode" = stub ]; then
    (cd "$co" && HOME="$home" TMPDIR="$tmpv" PATH="$STUB:$PATH" perl -e 'alarm shift; exec @ARGV' 120 "$interp" "runner/test/$t") >"$out" 2>&1
  else
    (cd "$co" && HOME="$home" TMPDIR="$tmpv" perl -e 'alarm shift; exec @ARGV' 120 "$interp" "runner/test/$t") >"$out" 2>&1
  fi
  rc=$?
  t1="$(date +%s)"
  local tag="$t [$([ "$mode" = stub ] && echo 'mktemp stub exits 1' || echo 'TMPDIR missing')]"
  if [ "$mode" = stub ] && [ "$interp" = node ]; then
    { [ "$rc" = 0 ] || [ "$rc" = 70 ]; } && ok "$tag: node's mkdtemp needs no mktemp binary: rc $rc (passed or refused, never half-ran)" \
      || fail "$tag: rc $rc: $(tail -3 "$out" | tr '\n' ' ')"
  else
    [ "$rc" != 0 ] && ok "$tag: exits non-zero (rc $rc)" || fail "$tag: exited 0 — it ran with no temp dir: $(tail -2 "$out" | tr '\n' ' ')"
    [ $((t1 - t0)) -le 30 ] && ok "$tag: stops quickly ($((t1 - t0))s)" || fail "$tag: took $((t1 - t0))s to stop"
    grep -q 'refusing to run' "$out" && ok "$tag: says why (refusing to run …)" || fail "$tag: no clear message: $(tail -3 "$out" | tr '\n' ' ')"
  fi
  [ -d "$co/.git" ] && [ "$(git -C "$co" rev-parse HEAD 2>/dev/null)" = "$head" ] \
    && ok "$tag: the checkout's .git and HEAD are intact" || fail "$tag: the checkout's .git was damaged or removed"
  [ -f "$co/MARKER" ] && [ -f "$co/runner/tick.sh" ] && ok "$tag: the checkout's working tree is intact" || fail "$tag: files in the checkout were removed"
  local st
  st="$(git -C "$co" status --porcelain 2>&1)" && [ -z "$st" ] && ok "$tag: nothing written into the checkout" \
    || fail "$tag: the checkout is not clean: $(printf '%s' "$st" | head -3 | tr '\n' ' ')"
  [ -f "$home/MARKER" ] && [ -f "$side/MARKER" ] && ok "$tag: nothing outside TMPDIR removed (\$HOME, a sibling dir)" \
    || fail "$tag: a marker outside TMPDIR was removed"
}

for t in "${CASES[@]}"; do
  [ -f "$HERE/$t" ] || { fail "no such test: $t"; continue; }
  echo "== $t =="
  run_case "$t" stub
  run_case "$t" notmp
done

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "mktemp-failure-safe: ALL $PASS checks passed"
  exit 0
fi
echo "mktemp-failure-safe: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]})) checks FAILED"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
