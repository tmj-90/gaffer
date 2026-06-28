#!/usr/bin/env bash
# =====================================================================
# H4 — real PR creation (runner/lib/pr-create.sh)
# ---------------------------------------------------------------------
# Tests verify:
#   1. gaffer_pr_create_enabled returns false when GAFFER_CREATE_PR=0 (default).
#   2. gaffer_pr_create_enabled returns true when GAFFER_CREATE_PR=1.
#   3. gaffer_has_github_remote detects a GitHub remote correctly.
#   4. gaffer_has_github_remote returns false for a non-GitHub remote.
#   5. gaffer_create_pr is a no-op (rc=1, nothing recorded) when flag is off.
#   6. gaffer_create_pr is a no-op (rc=1) when there is no GitHub remote.
#   7. gaffer_create_pr calls the injected GAFFER_GH_BIN and records pr_url
#      when gh reports a valid URL.
#   8. gaffer_create_pr handles a failing gh gracefully (rc=1, non-fatal).
#
# Zero real-network or dispatch deps. Run: bash test/h4-pr-create.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

# Minimal stubs so pr-create.sh can be sourced standalone.
log() { :; }  # suppress log output in tests

# Source only the pr-create lib (not the full factory.config.sh).
# shellcheck source=../lib/pr-create.sh
source "$RUNNER_DIR/lib/pr-create.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/h4-pr-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# ---------------------------------------------------------------------------
# Helper: set up a minimal git repo
# ---------------------------------------------------------------------------
make_repo() {
  local dir="$1"
  mkdir -p "$dir"
  git -C "$dir" init -q -b main
  git -C "$dir" config user.email "t@x.com"
  git -C "$dir" config user.name "t"
  printf 'x' > "$dir/README.md"
  git -C "$dir" add . && git -C "$dir" commit -q -m "init"
}

# Helper: add a remote to a repo
add_remote() {
  local dir="$1" url="$2"
  git -C "$dir" remote add origin "$url" 2>/dev/null || \
    git -C "$dir" remote set-url origin "$url"
}

echo "== gaffer_pr_create_enabled =="

# T1: default (GAFFER_CREATE_PR unset / 0) → disabled.
GAFFER_CREATE_PR=0
gaffer_pr_create_enabled && fail "T1 expected disabled when GAFFER_CREATE_PR=0" \
  || ok "T1 GAFFER_CREATE_PR=0 → disabled"

# T2: GAFFER_CREATE_PR=1 → enabled.
GAFFER_CREATE_PR=1
gaffer_pr_create_enabled && ok "T2 GAFFER_CREATE_PR=1 → enabled" \
  || fail "T2 expected enabled when GAFFER_CREATE_PR=1"

echo "== gaffer_has_github_remote =="

REPO_GH="$WORK/repo-gh"
REPO_OTHER="$WORK/repo-other"
make_repo "$REPO_GH"
make_repo "$REPO_OTHER"
add_remote "$REPO_GH"    "https://github.com/org/repo.git"
add_remote "$REPO_OTHER" "https://gitlab.com/org/repo.git"

# T3: GitHub remote → true.
gaffer_has_github_remote "$REPO_GH" \
  && ok "T3 GitHub remote detected" \
  || fail "T3 expected GitHub remote to be detected"

# T4: non-GitHub remote → false.
gaffer_has_github_remote "$REPO_OTHER" \
  && fail "T4 expected no GitHub remote for gitlab remote" \
  || ok "T4 non-GitHub remote not detected (gitlab)"

echo "== gaffer_create_pr no-op paths =="

REPO_PR="$WORK/repo-pr"
make_repo "$REPO_PR"
add_remote "$REPO_PR" "https://github.com/org/repo.git"
git -C "$REPO_PR" checkout -b "gaffer/ticket-1-test" >/dev/null 2>&1 || true

# T5: GAFFER_CREATE_PR=0 → no-op (rc=1).
GAFFER_CREATE_PR=0
gaffer_create_pr "1" "$REPO_PR" "gaffer/ticket-1-test" "main" "Test ticket" >/dev/null 2>&1
_RC=$?
[ "$_RC" = "1" ] \
  && ok "T5 GAFFER_CREATE_PR=0 → no-op (rc=1)" \
  || fail "T5 expected rc=1 when flag off, got $_RC"

# T6: no GitHub remote → no-op (rc=1).
REPO_NOGIT="$WORK/repo-nogit"
make_repo "$REPO_NOGIT"
add_remote "$REPO_NOGIT" "https://gitlab.com/org/repo.git"
GAFFER_CREATE_PR=1
gaffer_create_pr "2" "$REPO_NOGIT" "gaffer/ticket-2-test" "main" "Test" >/dev/null 2>&1
_RC=$?
[ "$_RC" = "1" ] \
  && ok "T6 no GitHub remote → no-op (rc=1)" \
  || fail "T6 expected rc=1 for non-GitHub remote, got $_RC"

echo "== gaffer_create_pr injectable gh =="

# T7: injectable GAFFER_GH_BIN that prints a valid URL → rc=0, pr_url returned.
# Stub gh that prints a URL and exits 0.
GH_STUB="$WORK/gh-stub.sh"
printf '#!/bin/sh\necho "https://github.com/org/repo/pull/42"\n' > "$GH_STUB"
chmod +x "$GH_STUB"

GAFFER_CREATE_PR=1
GAFFER_GH_BIN="$GH_STUB"
# Stub out wg (delivery-artifact recording) so it doesn't need dispatch.
wg() { :; }

_OUT="$(gaffer_create_pr "3" "$REPO_PR" "gaffer/ticket-1-test" "main" "Test ticket" 2>/dev/null)"
_RC=$?
[ "$_RC" = "0" ] \
  && ok "T7 injectable gh returning URL → rc=0" \
  || fail "T7 expected rc=0 from gh stub, got $_RC"
printf '%s' "$_OUT" | grep -qF "https://github.com/org/repo/pull/42" \
  && ok "T7 pr_url printed to stdout" \
  || fail "T7 expected pr_url on stdout, got: $_OUT"

# T8: injectable GAFFER_GH_BIN that exits non-zero → rc=1, non-fatal.
GH_FAIL="$WORK/gh-fail.sh"
printf '#!/bin/sh\necho "Error: PR already exists" >&2\nexit 1\n' > "$GH_FAIL"
chmod +x "$GH_FAIL"
GAFFER_GH_BIN="$GH_FAIL"

gaffer_create_pr "4" "$REPO_PR" "gaffer/ticket-1-test" "main" "Test" >/dev/null 2>&1
_RC=$?
[ "$_RC" = "1" ] \
  && ok "T8 failing gh → rc=1 (non-fatal)" \
  || fail "T8 expected rc=1 from failing gh stub, got $_RC"

echo ""
echo "Results: $PASS passed, ${#FAILURES[@]} failed"
if [ "${#FAILURES[@]}" -gt 0 ]; then
  printf '  FAIL: %s\n' "${FAILURES[@]}"
  exit 1
fi
exit 0
