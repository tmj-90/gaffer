#!/usr/bin/env bash
# =====================================================================
# STRICT-REQUIRE (C4) — GAFFER_STRICT_REQUIRE=1 makes the OS sandbox honest.
# ---------------------------------------------------------------------
# By default, a provider path that can't supply an OS sandbox warns + DEGRADES
# (sandbox_wrap_cmd returns 0 → run with worktree isolation + the safety hook, no OS
# sandbox). That silent no-op is dishonest on Linux (sandbox-exec is macOS-only). With
# GAFFER_STRICT_REQUIRE=1 the operator demands an OS sandbox, so every unavailable path
# FAILS CLOSED (returns non-zero) and tick.sh refuses to launch the agent. Proves the
# REAL sandbox_wrap_cmd from lib/sandbox.sh. Run: bash test/strict-require.test.sh (3.2 ok)
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
# shellcheck source=../lib/sandbox.sh
source "$RUNNER_DIR/lib/sandbox.sh"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

rc_for() { SANDBOX_PROVIDER="$1" sandbox_wrap_cmd "/tmp/gaffer-wt" "" >/dev/null 2>&1; echo $?; }

# ── DEFAULT (no strict-require): every unavailable provider path DEGRADES (rc 0) ──
unset GAFFER_STRICT_REQUIRE 2>/dev/null || true
[ "$(rc_for none)" = "0" ]    && ok "default: provider 'none' degrades (rc 0)"            || fail "none should degrade by default"
[ "$(rc_for lima)" = "0" ]    && ok "default: provider 'lima' (stub) degrades"           || fail "lima should degrade by default"
[ "$(rc_for made-up)" = "0" ] && ok "default: unknown provider degrades (rc 0)"          || fail "unknown should degrade by default"

# ── GAFFER_STRICT_REQUIRE=1: every unavailable path FAILS CLOSED (rc 1) ──
# (docker is a REAL provider now — when its daemon is up it SUCCEEDS here rather than
# failing closed; its no-daemon fail-closed path is covered in strict-mode.test.sh.)
export GAFFER_STRICT_REQUIRE=1
[ "$(rc_for none)" = "1" ]    && ok "strict-require: provider 'none' FAILS CLOSED (rc 1)"      || fail "none must fail closed under strict-require"
[ "$(rc_for lima)" = "1" ]    && ok "strict-require: provider 'lima' (stub) FAILS CLOSED (rc 1)" || fail "lima must fail closed under strict-require"
[ "$(rc_for made-up)" = "1" ] && ok "strict-require: unknown provider FAILS CLOSED (rc 1)"     || fail "unknown must fail closed under strict-require"

# the refusal is loud + says "fail closed"
MSG="$(SANDBOX_PROVIDER=none sandbox_wrap_cmd /tmp/gaffer-wt "" 2>&1 >/dev/null)"
case "$MSG" in *"fail closed"*) ok "strict-require refusal message says 'fail closed'" ;; *) fail "no fail-closed message (got: $MSG)" ;; esac

# ── a REAL sandbox still works under strict-require (macOS with sandbox-exec) ──
if command -v sandbox-exec >/dev/null 2>&1; then
  [ "$(rc_for sandbox-exec)" = "0" ] \
    && ok "strict-require: sandbox-exec present → real OS sandbox, rc 0 (no refusal)" \
    || fail "sandbox-exec should succeed (rc 0) when present, even under strict-require"
else
  ok "SKIP: sandbox-exec absent (Linux) — the real-sandbox case is macOS-only"
fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "strict-require: ALL $PASS checks passed"
  exit 0
fi
echo "strict-require: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
