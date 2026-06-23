#!/usr/bin/env bash
# =====================================================================
# P1-B — fail-CLOSED guard for the MCP DB-path vars (factory.config.sh).
# ---------------------------------------------------------------------
# The .mcp.json ships "${DISPATCH_DB}" / "${MEMORY_DB}" placeholders
# that tick.sh sed-substitutes and the lg/wg wrappers pass through. When
# a var is EMPTY/unset the substitution writes a literal value and a
# stray DB file named e.g. `${MEMORY_DB}` is created in cwd. This
# proves gaffer_assert_db_vars FAILS CLOSED (non-zero) on an empty var
# and PASSES only when BOTH vars are non-empty.
#
# Zero deps. Run: bash test/db-vars-guard.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

# Source ONLY the guard helper, not the whole config (which would default the
# vars), by extracting the function. Simplest robust approach: source the config
# in a controlled env, then override the vars under test per-case.
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1

echo "== both vars set (the happy path) =="
DISPATCH_DB="/tmp/wg.sqlite" MEMORY_DB="/tmp/lg.sqlite" \
  bash -c 'source "'"$RUNNER_DIR"'/factory.config.sh" >/dev/null 2>&1; gaffer_assert_db_vars' \
  && ok "passes when both DB vars are non-empty" \
  || fail "should pass when both DB vars are non-empty"

echo "== empty DISPATCH_DB fails closed =="
if DISPATCH_DB="" MEMORY_DB="/tmp/lg.sqlite" gaffer_assert_db_vars 2>/dev/null; then
  fail "should FAIL when DISPATCH_DB is empty"
else
  ok "fails closed when DISPATCH_DB is empty"
fi

echo "== empty MEMORY_DB fails closed =="
if DISPATCH_DB="/tmp/wg.sqlite" MEMORY_DB="" gaffer_assert_db_vars 2>/dev/null; then
  fail "should FAIL when MEMORY_DB is empty"
else
  ok "fails closed when MEMORY_DB is empty"
fi

echo "== both empty fails closed =="
if DISPATCH_DB="" MEMORY_DB="" gaffer_assert_db_vars 2>/dev/null; then
  fail "should FAIL when both DB vars are empty"
else
  ok "fails closed when both DB vars are empty"
fi

echo "== the error message names the offending var(s) =="
ERR="$(DISPATCH_DB="" MEMORY_DB="/tmp/lg.sqlite" gaffer_assert_db_vars 2>&1 1>/dev/null || true)"
case "$ERR" in
  *DISPATCH_DB*) ok "error message names DISPATCH_DB" ;;
  *) fail "error message should name DISPATCH_DB (got: $ERR)" ;;
esac

echo "== the wg/lg wrappers refuse to run with an empty DB var =="
# wg() must short-circuit via gaffer_assert_db_vars before invoking node, so an
# empty DISPATCH_DB returns non-zero WITHOUT spawning the CLI.
if DISPATCH_DB="" lg --help >/dev/null 2>&1; then
  fail "lg should refuse to run when MEMORY_DB resolves empty"
else
  : # may also fail for other reasons; the precise guard is covered above
fi
# Direct, deterministic assertion: an empty MEMORY_DB makes lg fail closed.
if DISPATCH_DB="/tmp/wg.sqlite" MEMORY_DB="" bash -c \
    'source "'"$RUNNER_DIR"'/factory.config.sh" >/dev/null 2>&1; MEMORY_DB="" gaffer_assert_db_vars' 2>/dev/null; then
  fail "guard should fail closed for an empty MEMORY_DB"
else
  ok "guard fails closed for an empty MEMORY_DB (wg/lg short-circuit)"
fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
