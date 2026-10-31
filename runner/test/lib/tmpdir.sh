#!/usr/bin/env bash
# shellcheck shell=bash
# runner/test/lib/tmpdir.sh — a test's temp dir, and the ONLY way it is removed.
#
# External review #6: a test did `WORK="$(mktemp -d …)"; WORK="$(cd "$WORK" && pwd -P)"`
# with `trap 'rm -rf "$WORK"' EXIT` and no failure check. When mktemp failed, WORK was
# empty, `cd ""` stayed put, WORK became the CURRENT DIRECTORY, and the EXIT trap removed
# the checkout the test ran from (.git included) while the test reported its checks as
# passing. So, in every runner test:
#
#   . "$HERE/lib/tmpdir.sh"
#   WORK="$(gaffer_test_tmpdir orphan-recovery)" || exit 70
#   trap 'gaffer_test_rm_work "$WORK"' EXIT
#
# or, keeping a file's own mktemp line, guard it on the next line:
#
#   WORK="$(mktemp -d "${TMPDIR:-/tmp}/x.XXXXXX")"
#   gaffer_test_check_tmp "$WORK" || exit 70
#
# gaffer_test_rm_work REFUSES (prints why, removes nothing, returns 1) a path that is
# empty, relative, ".", "/", $HOME, the directory the test started in, the repository
# root, any ANCESTOR of those, or anything not strictly under a temp root (TMPDIR as it
# was when this file was sourced, the current TMPDIR, or /tmp — each also canonical).
# "Under" is decided on where the path really is (`..` and symlinked parents resolved),
# never on its spelling, and a trailing slash never makes it follow a symlink.
# If this file cannot be sourced, the guards fail (127 → `|| exit 70`) and the cleanup
# is "command not found": nothing is ever removed by accident.
# Portable to macOS bash 3.2; no GNU-only flags. runner/test/no-unchecked-mktemp.test.sh
# keeps the rule for future tests.

_gaffer_test_canon() { (cd "$1" 2>/dev/null && pwd -P) || printf '%s' "$1"; }
_gaffer_test_strip() { # strip trailing slashes (macOS TMPDIR ends in "/"), keep "/"
  local p="$1"
  while [ "${#p}" -gt 1 ] && [ "${p%/}" != "$p" ]; do p="${p%/}"; done
  printf '%s' "$p"
}
# Snapshot at source time: a test that later exports TMPDIR/HOME or cds into its WORK
# must not move the goalposts.
# Sourced twice (a test, then lib/stub-tick.sh)? Keep the FIRST snapshot.
if [ -z "${_GAFFER_TEST_SNAPSHOT:-}" ]; then
  _GAFFER_TEST_SNAPSHOT=1
  _GAFFER_TEST_START_PWD="$(pwd -P 2>/dev/null || pwd)"
  _GAFFER_TEST_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." 2>/dev/null && pwd -P)"
  _GAFFER_TEST_TMP_AT_SOURCE="${TMPDIR:-/tmp}"
  _GAFFER_TEST_HOME_AT_SOURCE="${HOME:-}"
fi

# _gaffer_test_where <path>: where <path> ITSELF really is — `..` and every symlinked
# parent resolved, the last component kept as is (a symlink there is what `rm -rf`
# removes, not its target). A path whose parent does not exist has nothing to remove
# and stays literal. The literal spelling never decides: `/tmp/../home/x` and
# `$TMPDIR/link-to-elsewhere/x` only LOOK like temp paths.
_gaffer_test_where() {
  local p="$1" d b
  if [ -d "$p" ] && [ ! -L "$p" ]; then _gaffer_test_canon "$p"; return 0; fi
  d="$(dirname "$p")"; b="$(basename "$p")"
  case "$b" in . | ..) [ -d "$p" ] && { _gaffer_test_canon "$p"; return 0; } ;; esac
  if [ -d "$d" ]; then
    d="$(_gaffer_test_canon "$d")"
    [ "$d" = "/" ] && d=""
    printf '%s/%s' "$d" "$b"
  else
    printf '%s' "$p"
  fi
}

# _gaffer_test_under_tmp <path>: true when <path> really lies strictly under a temp root
# (its _gaffer_test_where location, against each root's literal and canonical form).
_gaffer_test_under_tmp() {
  local w r root
  w="$(_gaffer_test_where "$1")"
  case "$w" in */../* | */.. | */./* | */.) return 1 ;; esac   # unresolved: never "under"
  for r in "$_GAFFER_TEST_TMP_AT_SOURCE" "${TMPDIR:-/tmp}" /tmp; do
    case "$r" in /*) ;; *) continue ;; esac   # a relative TMPDIR is no temp root
    r="$(_gaffer_test_strip "$r")"
    [ "$r" = "/" ] && continue                # nor is "/"
    for root in "$r" "$(_gaffer_test_canon "$r")"; do
      case "$w" in "$root"/?*) return 0 ;; esac
    done
  done
  return 1
}

# _gaffer_test_unsafe <path> [anywhere]: prints the reason and returns 0 when <path>
# must never be removed; returns 1 when it is removable. "anywhere" drops the temp-root
# requirement (an operator-chosen output dir) but keeps every other refusal.
_gaffer_test_unsafe() {
  local p="$1" mode="${2:-tmp}" c w prot
  case "$p" in
    "") echo "the path is empty"; return 0 ;;
    . | ./ | .. | ../) echo "the path is '$p' (the current or parent directory)"; return 0 ;;
    /*) ;;
    *) echo "the path '$p' is relative"; return 0 ;;
  esac
  p="$(_gaffer_test_strip "$p")"
  [ "$p" = "/" ] && { echo "the path is /"; return 0; }
  # c: what the path FOLLOWS to (a symlink's target too) — refused if that is, or holds,
  # a protected directory, however it is spelled; w: where the path itself is.
  c="$p"; [ -d "$p" ] && c="$(_gaffer_test_canon "$p")"
  [ "$c" = "/" ] && { echo "the path '$p' resolves to /"; return 0; }
  w="$(_gaffer_test_where "$p")"
  [ "$w" = "/" ] && { echo "the path '$p' resolves to /"; return 0; }
  # Protected: $HOME and the directory the test started in (as they were when this file
  # was sourced), the repository root, and the current $HOME / $PWD unless those are
  # themselves inside a temp root (a test that exported HOME=$WORK/home or cd'd into its
  # WORK may still remove its WORK). Equal to, or an ANCESTOR of, any of them: refused.
  for prot in "$_GAFFER_TEST_HOME_AT_SOURCE" "$_GAFFER_TEST_START_PWD" "$_GAFFER_TEST_REPO_ROOT" "${HOME:-}" "$PWD"; do
    [ -n "$prot" ] || continue
    case "$prot" in /*) ;; *) continue ;; esac
    if [ "$prot" != "$_GAFFER_TEST_HOME_AT_SOURCE" ] && [ "$prot" != "$_GAFFER_TEST_START_PWD" ] \
       && [ "$prot" != "$_GAFFER_TEST_REPO_ROOT" ] && _gaffer_test_under_tmp "$prot"; then
      continue
    fi
    prot="$(_gaffer_test_strip "$prot")"
    case "$prot/" in "$p"/* | "$c"/* | "$w"/*) echo "the path '$p' is, or contains, the protected directory '$prot'"; return 0 ;; esac
    if [ -d "$prot" ]; then
      prot="$(_gaffer_test_canon "$prot")"
      case "$prot/" in "$p"/* | "$c"/* | "$w"/*) echo "the path '$p' is, or contains, the protected directory '$prot'"; return 0 ;; esac
    fi
  done
  [ "$mode" = anywhere ] && return 1
  _gaffer_test_under_tmp "$p" || { echo "the path '$p' is not under a temp root (it is really '$w'; TMPDIR=${TMPDIR:-<unset>})"; return 0; }
  return 1
}

# gaffer_test_check_tmp <path> [file]: 0 when <path> is a real, removable temp dir (or,
# with a second argument "file", a temp FILE); otherwise a clear message and 70.
gaffer_test_check_tmp() {
  local p="${1:-}" kind="${2:-dir}" why=""
  if [ "$kind" = file ]; then
    { [ -n "$p" ] && [ -f "$p" ]; } || why="mktemp did not create a temp file (got '$p')"
  else
    { [ -n "$p" ] && [ -d "$p" ]; } || why="mktemp did not create a temp directory (got '$p')"
  fi
  if [ -z "$why" ]; then why="$(_gaffer_test_unsafe "$p")" || return 0; fi
  printf '%s: refusing to run: %s; TMPDIR=%s (nothing was deleted)\n' "$(basename "${0:-test}")" "$why" "${TMPDIR:-<unset>}" >&2
  return 70
}

# gaffer_test_tmpdir <prefix> [file]: create a temp dir (or file) under ${TMPDIR:-/tmp}
# and print its canonical path. On failure: a clear message and exit 70 (from the
# command substitution — the caller adds `|| exit 70`).
gaffer_test_tmpdir() {
  local prefix="${1:-gaffer-test}" kind="${2:-dir}" root d
  root="$(_gaffer_test_strip "${TMPDIR:-/tmp}")"
  if [ "$kind" = file ]; then
    d="$(mktemp "$root/$prefix.XXXXXX" 2>/dev/null)" || d=""
  else
    d="$(mktemp -d "$root/$prefix.XXXXXX" 2>/dev/null)" || d=""
    if [ -n "$d" ] && [ -d "$d" ]; then d="$(_gaffer_test_canon "$d")"; fi
  fi
  gaffer_test_check_tmp "$d" "$kind" || exit 70
  printf '%s\n' "$d"
}

# gaffer_test_rm_work [--anywhere] <path>...: remove each temp path, refusing anything
# unsafe (see the header). --anywhere is for an operator-chosen output dir that need not
# live under a temp root (scripts/ui-regression's UI_REGRESS_OUT); it keeps every other
# refusal (empty, ".", "/", $HOME, the start dir, the repo root, their ancestors).
gaffer_test_rm_work() {
  local p why rc=0 mode=tmp
  if [ "${1:-}" = "--anywhere" ]; then mode=anywhere; shift; fi
  for p in "$@"; do
    if why="$(_gaffer_test_unsafe "$p" "$mode")"; then
      printf '%s: NOT removing: %s\n' "$(basename "${0:-test}")" "$why" >&2
      rc=1
      continue
    fi
    # The checked spelling, trailing slashes stripped: `rm -rf link/` would empty the
    # link's TARGET, `rm -rf link` removes only the link.
    rm -rf "$(_gaffer_test_strip "$p")"
  done
  return "$rc"
}
