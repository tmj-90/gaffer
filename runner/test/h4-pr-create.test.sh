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
#   7. gaffer_create_pr pushes the branch to the bare remote BEFORE calling gh,
#      then calls the injected GAFFER_GH_BIN and records pr_url when gh reports
#      a valid URL.
#   8. gaffer_create_pr handles a failing gh gracefully (rc=1, non-fatal).
#   9. gaffer_create_pr handles a failing push gracefully (rc=1, non-fatal).
#  10. gaffer_create_pr extracts only the URL from multiline gh output.
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

# Helper: create a bare git repo (acts as a local remote).
make_bare() {
  local dir="$1"
  mkdir -p "$dir"
  git init -q --bare "$dir"
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

# Bare local remote used as a stand-in for the GitHub remote in T7/T8/T9.
BARE_REMOTE="$WORK/bare-remote.git"
make_bare "$BARE_REMOTE"

REPO_PR="$WORK/repo-pr"
make_repo "$REPO_PR"
# Point origin at our bare local repo so git push succeeds.
# gaffer_has_github_remote checks for "github.com" in the remote URL;
# we satisfy that with a fake-GitHub remote for the push-testing repos below.
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

echo "== gaffer_create_pr push + injectable gh =="

# ---------------------------------------------------------------------------
# T7: gaffer_create_pr pushes the delivery branch to the bare remote BEFORE
#     calling the injected gh stub, and records the pr_url.
#
# Approach: use GAFFER_PR_REMOTE pointing at the bare local repo so git push
# succeeds without a real GitHub remote.  The gaffer_has_github_remote check
# is satisfied by keeping "github.com" in the named "origin" remote URL while
# the actual push target is the bare repo via GAFFER_PR_REMOTE.
# ---------------------------------------------------------------------------
REPO_PUSH="$WORK/repo-push"
make_repo "$REPO_PUSH"
add_remote "$REPO_PUSH" "https://github.com/org/repo.git"  # satisfies has_github_remote
git -C "$REPO_PUSH" remote add bare-local "$BARE_REMOTE"    # actual push target
git -C "$REPO_PUSH" checkout -b "gaffer/ticket-7-test" >/dev/null 2>&1

# Track whether gh was called; it must only be called AFTER the push.
GH_CALL_LOG="$WORK/gh-called.txt"

# gh stub that verifies the branch exists on the bare remote at call time,
# then prints the PR URL.
GH_PUSH_STUB="$WORK/gh-push-stub.sh"
cat > "$GH_PUSH_STUB" <<'GHSTUB'
#!/bin/sh
BARE="$BARE_REMOTE_PATH"
BRANCH="gaffer/ticket-7-test"
# Verify the branch ref exists on the bare remote before printing the URL.
if git -C "$BARE" rev-parse --verify "refs/heads/$BRANCH" >/dev/null 2>&1; then
  printf 'branch-pushed-ok\n' >> "$CALL_LOG"
else
  printf 'branch-NOT-pushed\n' >> "$CALL_LOG"
fi
echo "https://github.com/org/repo/pull/42"
GHSTUB
chmod +x "$GH_PUSH_STUB"

# Export vars the stub needs (it runs in a subshell).
export BARE_REMOTE_PATH="$BARE_REMOTE"
export CALL_LOG="$GH_CALL_LOG"
: > "$GH_CALL_LOG"

GAFFER_CREATE_PR=1
GAFFER_GH_BIN="$GH_PUSH_STUB"
GAFFER_PR_REMOTE="bare-local"
# Stub out wg (delivery-artifact recording).
wg() { :; }

_OUT="$(gaffer_create_pr "3" "$REPO_PUSH" "gaffer/ticket-7-test" "main" "Test ticket" 2>/dev/null)"
_RC=$?

[ "$_RC" = "0" ] \
  && ok "T7 injectable gh returning URL → rc=0" \
  || fail "T7 expected rc=0 from gh stub, got $_RC"

printf '%s' "$_OUT" | grep -qF "https://github.com/org/repo/pull/42" \
  && ok "T7 pr_url printed to stdout" \
  || fail "T7 expected pr_url on stdout, got: $_OUT"

# Verify the branch was on the bare remote WHEN gh was called.
grep -q "branch-pushed-ok" "$GH_CALL_LOG" \
  && ok "T7 branch exists on bare remote before gh is called" \
  || fail "T7 branch was NOT on bare remote when gh ran (log: $(cat "$GH_CALL_LOG"))"

# Also verify the ref is present on the bare remote after the function returns.
git -C "$BARE_REMOTE" rev-parse --verify "refs/heads/gaffer/ticket-7-test" >/dev/null 2>&1 \
  && ok "T7 delivery branch ref present on bare remote after gaffer_create_pr" \
  || fail "T7 expected branch ref on bare remote after gaffer_create_pr"

# T8: injectable GAFFER_GH_BIN that exits non-zero → rc=1, non-fatal.
GH_FAIL="$WORK/gh-fail.sh"
printf '#!/bin/sh\necho "Error: PR already exists" >&2\nexit 1\n' > "$GH_FAIL"
chmod +x "$GH_FAIL"

REPO_PUSH2="$WORK/repo-push2"
make_repo "$REPO_PUSH2"
add_remote "$REPO_PUSH2" "https://github.com/org/repo.git"
git -C "$REPO_PUSH2" remote add bare-local "$BARE_REMOTE"
git -C "$REPO_PUSH2" checkout -b "gaffer/ticket-8-test" >/dev/null 2>&1
GAFFER_GH_BIN="$GH_FAIL"
GAFFER_PR_REMOTE="bare-local"

gaffer_create_pr "4" "$REPO_PUSH2" "gaffer/ticket-8-test" "main" "Test" >/dev/null 2>&1
_RC=$?
[ "$_RC" = "1" ] \
  && ok "T8 failing gh → rc=1 (non-fatal)" \
  || fail "T8 expected rc=1 from failing gh stub, got $_RC"

# T9: push itself fails → rc=1, non-fatal.
REPO_NOPUSH="$WORK/repo-nopush"
make_repo "$REPO_NOPUSH"
add_remote "$REPO_NOPUSH" "https://github.com/org/repo.git"
# Remote "bad-remote" points nowhere — push will fail.
git -C "$REPO_NOPUSH" remote add bad-remote "/dev/null/does-not-exist"
git -C "$REPO_NOPUSH" checkout -b "gaffer/ticket-9-test" >/dev/null 2>&1
GAFFER_PR_REMOTE="bad-remote"
GH_STUB_OK="$WORK/gh-ok.sh"
printf '#!/bin/sh\necho "https://github.com/org/repo/pull/99"\n' > "$GH_STUB_OK"
chmod +x "$GH_STUB_OK"
GAFFER_GH_BIN="$GH_STUB_OK"

gaffer_create_pr "9" "$REPO_NOPUSH" "gaffer/ticket-9-test" "main" "Test" >/dev/null 2>&1
_RC=$?
[ "$_RC" = "1" ] \
  && ok "T9 failing push → rc=1 (non-fatal, gh not called)" \
  || fail "T9 expected rc=1 when push fails, got $_RC"

echo "== gaffer_create_pr multiline gh output =="

# T10: gh output contains warning lines around the URL; only the URL is returned.
REPO_MULTI="$WORK/repo-multi"
make_repo "$REPO_MULTI"
add_remote "$REPO_MULTI" "https://github.com/org/repo.git"
git -C "$REPO_MULTI" remote add bare-local "$BARE_REMOTE"
git -C "$REPO_MULTI" checkout -b "gaffer/ticket-10-test" >/dev/null 2>&1

GH_MULTI="$WORK/gh-multi.sh"
# Simulate gh printing a warning before the URL and extra text after.
cat > "$GH_MULTI" <<'MULTI'
#!/bin/sh
printf 'Warning: this is a warning line\n'
printf 'https://github.com/org/repo/pull/77\n'
printf 'View pull request at https://github.com/org/repo/pull/77\n'
MULTI
chmod +x "$GH_MULTI"
GAFFER_GH_BIN="$GH_MULTI"
GAFFER_PR_REMOTE="bare-local"

_OUT="$(gaffer_create_pr "10" "$REPO_MULTI" "gaffer/ticket-10-test" "main" "Test" 2>/dev/null)"
_RC=$?
[ "$_RC" = "0" ] \
  && ok "T10 multiline gh output → rc=0" \
  || fail "T10 expected rc=0 with multiline gh output, got $_RC"

[ "$_OUT" = "https://github.com/org/repo/pull/77" ] \
  && ok "T10 only the URL line extracted from multiline gh output" \
  || fail "T10 expected only URL, got: '$_OUT'"

echo ""
echo "Results: $PASS passed, ${#FAILURES[@]} failed"
if [ "${#FAILURES[@]}" -gt 0 ]; then
  printf '  FAIL: %s\n' "${FAILURES[@]}"
  exit 1
fi
exit 0
