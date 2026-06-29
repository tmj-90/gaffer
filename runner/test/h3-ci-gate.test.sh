#!/usr/bin/env bash
# =====================================================================
# H3 — CI-aware review gate (runner/lib/ci-gate.sh)
# ---------------------------------------------------------------------
# Tests verify:
#   1. gaffer_ci_gate_enabled returns false when GAFFER_REQUIRE_CI=0 (default).
#   2. gaffer_ci_gate_enabled returns true when GAFFER_REQUIRE_CI=1.
#   3. gaffer_parse_checks → "pass" when all checks are passed.
#   4. gaffer_parse_checks → "fail:<name>|<url>" when a check has failed.
#   5. gaffer_parse_checks → "pending" when checks are still in progress.
#   6. gaffer_parse_checks → "unknown" for empty input.
#   7. gaffer_ci_gate returns 0 (proceed) when GAFFER_REQUIRE_CI=0 (flag off).
#   8. gaffer_ci_gate with injectable gh returning green → rc=0.
#   9. gaffer_ci_gate with injectable gh returning red → rc=2 + evidence attached.
#  10. gaffer_ci_gate poll timeout → rc=2 (fail closed, strict default).
#  11. No GitHub remote → gaffer_ci_gate returns 0 (no-op).
#  12. gaffer_ci_gate poll timeout + GAFFER_CI_TIMEOUT_POLICY=proceed → rc=0 (proceed-with-note).
#  13. gaffer_ci_gate no-PR/no-checks (all polls empty) → rc=2 under strict.
#  14. gaffer_ci_gate no-PR/no-checks + GAFFER_CI_TIMEOUT_POLICY=proceed → rc=0.
#
# Uses a real but minimal git repo + a stub dispatch CLI for evidence.
# Run: bash test/h3-ci-gate.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

# Stubs: log is a no-op, gaffer_ci_sleep is a no-op in tests.
log() { :; }
gaffer_ci_sleep() { :; }  # skip real sleep in all tests

# gaffer_has_github_remote is defined in pr-create.sh (which ci-gate.sh depends on).
# Source pr-create.sh first (it is always sourced before ci-gate.sh in config).
# shellcheck source=../lib/pr-create.sh
source "$RUNNER_DIR/lib/pr-create.sh"
# shellcheck source=../lib/ci-gate.sh
source "$RUNNER_DIR/lib/ci-gate.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/h3-ci-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

make_repo() {
  local dir="$1"
  mkdir -p "$dir"
  git -C "$dir" init -q -b main
  git -C "$dir" config user.email "t@x.com"
  git -C "$dir" config user.name "t"
  printf 'x' > "$dir/README.md"
  git -C "$dir" add . && git -C "$dir" commit -q -m "init"
}

REPO_GH="$WORK/repo-gh"
make_repo "$REPO_GH"
git -C "$REPO_GH" remote add origin "https://github.com/org/repo.git"

REPO_NORG="$WORK/repo-norg"
make_repo "$REPO_NORG"

# Stub wg for evidence attachment (records calls to a file).
WG_CALLS="$WORK/wg-calls.txt"
wg() {
  printf '%s\n' "$*" >> "$WG_CALLS"
}

echo "== gaffer_ci_gate_enabled =="

GAFFER_REQUIRE_CI=0
gaffer_ci_gate_enabled && fail "T1 expected disabled when GAFFER_REQUIRE_CI=0" \
  || ok "T1 GAFFER_REQUIRE_CI=0 → disabled"

GAFFER_REQUIRE_CI=1
gaffer_ci_gate_enabled && ok "T2 GAFFER_REQUIRE_CI=1 → enabled" \
  || fail "T2 expected enabled when GAFFER_REQUIRE_CI=1"

echo "== gaffer_parse_checks =="

# T3: all passed.
PASS_OUTPUT="$(printf 'build\tcompleted\tsuccess\thttps://x/1\ntest\tcompleted\tsuccess\thttps://x/2\n')"
_V="$(gaffer_parse_checks "$PASS_OUTPUT")"
[ "$_V" = "pass" ] \
  && ok "T3 all success → pass" \
  || fail "T3 expected 'pass', got '$_V'"

# T4: one failed check.
FAIL_OUTPUT="$(printf 'build\tcompleted\tfailure\thttps://x/fail\ntest\tcompleted\tsuccess\t\n')"
_V="$(gaffer_parse_checks "$FAIL_OUTPUT")"
case "$_V" in
  fail:build*)
    ok "T4 one failed check → fail:<name>" ;;
  *)
    fail "T4 expected 'fail:build*', got '$_V'" ;;
esac

# T5: pending checks.
PENDING_OUTPUT="$(printf 'build\tin_progress\t\thttps://x/1\ntest\tcompleted\tsuccess\t\n')"
_V="$(gaffer_parse_checks "$PENDING_OUTPUT")"
[ "$_V" = "pending" ] \
  && ok "T5 in_progress check → pending" \
  || fail "T5 expected 'pending', got '$_V'"

# T6: empty input → unknown.
_V="$(gaffer_parse_checks "")"
[ "$_V" = "unknown" ] \
  && ok "T6 empty input → unknown" \
  || fail "T6 expected 'unknown', got '$_V'"

echo "== gaffer_ci_gate no-op paths =="

# T7: GAFFER_REQUIRE_CI=0 → rc=0 (no-op, no gh call).
GAFFER_REQUIRE_CI=0
gaffer_ci_gate "1" "$REPO_GH" "gaffer/ticket-1" ""
[ $? = 0 ] \
  && ok "T7 GAFFER_REQUIRE_CI=0 → no-op rc=0" \
  || fail "T7 expected rc=0 for disabled gate"

# T11: no GitHub remote → rc=0 (no-op).
GAFFER_REQUIRE_CI=1
gaffer_ci_gate "11" "$REPO_NORG" "gaffer/ticket-11" ""
[ $? = 0 ] \
  && ok "T11 no GitHub remote → no-op rc=0" \
  || fail "T11 expected rc=0 for no GitHub remote"

echo "== gaffer_ci_gate injectable gh =="

# T8: injectable gh returning green → rc=0.
GH_GREEN="$WORK/gh-green.sh"
printf '#!/bin/sh\nprintf "build\tcompleted\tsuccess\thttps://x/1\n"\n' > "$GH_GREEN"
chmod +x "$GH_GREEN"
GAFFER_REQUIRE_CI=1
GAFFER_GH_BIN="$GH_GREEN"
GAFFER_CI_POLL_ATTEMPTS=1
GAFFER_CI_POLL_INTERVAL_SECS=0
unset GAFFER_CI_TIMEOUT_POLICY

gaffer_ci_gate "2" "$REPO_GH" "gaffer/ticket-2" ""
[ $? = 0 ] \
  && ok "T8 green checks → rc=0 (proceed)" \
  || fail "T8 expected rc=0 for green checks"

# T9: injectable gh returning red → rc=2 + evidence attached.
GH_RED="$WORK/gh-red.sh"
printf '#!/bin/sh\nprintf "build\tcompleted\tfailure\thttps://github.com/org/repo/actions/runs/99\n"\n' > "$GH_RED"
chmod +x "$GH_RED"
GAFFER_GH_BIN="$GH_RED"
: > "$WG_CALLS"

gaffer_ci_gate "3" "$REPO_GH" "gaffer/ticket-3" ""
_CI_RC=$?
[ "$_CI_RC" = "2" ] \
  && ok "T9 red checks → rc=2 (auto-reject signal)" \
  || fail "T9 expected rc=2 for red checks, got $_CI_RC"

grep -q "attach-evidence" "$WG_CALLS" \
  && ok "T9 failing-check evidence attached via wg" \
  || fail "T9 expected attach-evidence call, got: $(cat "$WG_CALLS")"

grep -q "build" "$WG_CALLS" \
  && ok "T9 failing check name recorded in evidence" \
  || fail "T9 expected failing check name 'build' in evidence call"

echo "== gaffer_ci_gate timeout strict mode (default) =="

# T10: poll timeout under strict default → rc=2 (fail closed).
GH_PENDING="$WORK/gh-pending.sh"
printf '#!/bin/sh\nprintf "build\tin_progress\t\thttps://x/1\n"\n' > "$GH_PENDING"
chmod +x "$GH_PENDING"
GAFFER_GH_BIN="$GH_PENDING"
GAFFER_CI_POLL_ATTEMPTS=2
GAFFER_CI_POLL_INTERVAL_SECS=0
unset GAFFER_CI_TIMEOUT_POLICY
: > "$WG_CALLS"

gaffer_ci_gate "4" "$REPO_GH" "gaffer/ticket-4" ""
_CI_RC=$?
[ "$_CI_RC" = "2" ] \
  && ok "T10 poll timeout strict → rc=2 (fail closed)" \
  || fail "T10 expected rc=2 for timeout under strict mode, got $_CI_RC"

grep -q "attach-evidence" "$WG_CALLS" \
  && ok "T10 'CI BLOCKED' evidence attached via wg" \
  || fail "T10 expected attach-evidence call for strict timeout"

echo "== gaffer_ci_gate timeout GAFFER_CI_TIMEOUT_POLICY=proceed =="

# T12: poll timeout + GAFFER_CI_TIMEOUT_POLICY=proceed → rc=0 (proceed-with-note).
GAFFER_CI_TIMEOUT_POLICY=proceed
GAFFER_GH_BIN="$GH_PENDING"
GAFFER_CI_POLL_ATTEMPTS=2
GAFFER_CI_POLL_INTERVAL_SECS=0
: > "$WG_CALLS"

gaffer_ci_gate "12" "$REPO_GH" "gaffer/ticket-12" ""
_CI_RC=$?
[ "$_CI_RC" = "0" ] \
  && ok "T12 poll timeout + GAFFER_CI_TIMEOUT_POLICY=proceed → rc=0 (proceed-with-note)" \
  || fail "T12 expected rc=0 for timeout with proceed policy, got $_CI_RC"

grep -q "attach-evidence" "$WG_CALLS" \
  && ok "T12 proceed-with-note evidence attached via wg" \
  || fail "T12 expected attach-evidence call for proceed note"

grep -qi "proceed" "$WG_CALLS" \
  && ok "T12 'proceed' surfaced in evidence text" \
  || fail "T12 expected 'proceed' in evidence text, got: $(cat "$WG_CALLS")"

echo "== gaffer_ci_gate no-PR / no-checks strict mode =="

# T13: all polls return empty (no PR exists yet) → rc=2 under strict.
GH_EMPTY="$WORK/gh-empty.sh"
printf '#!/bin/sh\n# prints nothing — simulates no PR or no checks\n' > "$GH_EMPTY"
chmod +x "$GH_EMPTY"
GAFFER_GH_BIN="$GH_EMPTY"
GAFFER_CI_POLL_ATTEMPTS=2
GAFFER_CI_POLL_INTERVAL_SECS=0
unset GAFFER_CI_TIMEOUT_POLICY
: > "$WG_CALLS"

gaffer_ci_gate "13" "$REPO_GH" "gaffer/ticket-13" ""
_CI_RC=$?
[ "$_CI_RC" = "2" ] \
  && ok "T13 no-PR/no-checks strict → rc=2 (fail closed)" \
  || fail "T13 expected rc=2 for no-PR strict mode, got $_CI_RC"

grep -q "attach-evidence" "$WG_CALLS" \
  && ok "T13 no-PR evidence attached via wg" \
  || fail "T13 expected attach-evidence call for no-PR case"

# T14: all polls return empty + GAFFER_CI_TIMEOUT_POLICY=proceed → rc=0.
GAFFER_CI_TIMEOUT_POLICY=proceed
GAFFER_GH_BIN="$GH_EMPTY"
GAFFER_CI_POLL_ATTEMPTS=2
GAFFER_CI_POLL_INTERVAL_SECS=0
: > "$WG_CALLS"

gaffer_ci_gate "14" "$REPO_GH" "gaffer/ticket-14" ""
_CI_RC=$?
[ "$_CI_RC" = "0" ] \
  && ok "T14 no-PR/no-checks + GAFFER_CI_TIMEOUT_POLICY=proceed → rc=0" \
  || fail "T14 expected rc=0 for no-PR with proceed policy, got $_CI_RC"

grep -q "attach-evidence" "$WG_CALLS" \
  && ok "T14 proceed note attached even for no-PR case" \
  || fail "T14 expected attach-evidence for no-PR proceed case"

echo ""
echo "Results: $PASS passed, ${#FAILURES[@]} failed"
if [ "${#FAILURES[@]}" -gt 0 ]; then
  printf '  FAIL: %s\n' "${FAILURES[@]}"
  exit 1
fi
exit 0
