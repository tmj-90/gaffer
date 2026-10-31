#!/usr/bin/env bash
# =====================================================================
# The dashboard token never sits in a world-readable file (runner/gaffer +
# packages/dispatch/src/api/bin.ts).
# ---------------------------------------------------------------------
# The first `gaffer dashboard` used to leave: $GAFFER_DATA 0755, dashboard-token 0600,
# and dashboard.log 0644 holding "Authorization: Bearer <the token>" — the server
# echoed a freshly generated token to stdout and the runner sent stdout there.
# Against the REAL built API server on a scratch port, proves:
#   • a fresh start: data dir 0700, dashboard.log 0600, the token NOT in the log;
#   • an existing 0755 dir and 0644 log (an older install) are tightened;
#   • a log that already leaked a token is deleted and the token ROTATED (the
#     leaked value no longer authenticates);
#   • the already-up path keeps the log 0600 and re-prints the ?token= login URL.
# Needs packages/dispatch built (dist/api/bin.js) and curl; skips cleanly otherwise.
# Run: bash test/dashboard-token-log.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
API_BIN="$RUNNER_DIR/../packages/dispatch/dist/api/bin.js"
[ -f "$API_BIN" ] || { echo "  SKIP: dispatch not built ($API_BIN)"; exit 0; }
command -v curl >/dev/null 2>&1 || { echo "  SKIP: curl not on PATH"; exit 0; }

PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/dashboard-token-log.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
DATA="$WORK/data"
PORT=$(( 20000 + RANDOM % 20000 ))
stop_server() {
  local p; p="$(cat "$DATA/dashboard.pid" 2>/dev/null || true)"
  [ -n "$p" ] && kill "$p" 2>/dev/null; sleep 0.3; rm -f "$DATA/dashboard.pid"
}
trap 'stop_server; gaffer_test_rm_work "$WORK"' EXIT
dash() { env GAFFER_DATA="$DATA" DISPATCH_API_PORT="$PORT" bash "$RUNNER_DIR/gaffer" dashboard "$@" 2>&1; }

echo "== an older install: 0755 dir, 0644 log that leaked a token =="
mkdir -p "$DATA"; chmod 755 "$DATA"
LEAKED="leakedTOKENvalue_0123456789abcdefABCDEF"
printf '%s' "$LEAKED" > "$DATA/dashboard-token"; chmod 600 "$DATA/dashboard-token"
printf 'dispatch-api: generated a new dashboard token\n  Authenticate mutating requests with:  Authorization: Bearer %s\n' "$LEAKED" > "$DATA/dashboard.log"
chmod 644 "$DATA/dashboard.log"
OUT="$(dash)"
[ "$(mode "$DATA")" = "700" ] && ok "data dir tightened to 0700" || fail "data dir mode $(mode "$DATA")"
[ "$(mode "$DATA/dashboard.log")" = "600" ] && ok "dashboard.log recreated 0600" || fail "log mode $(mode "$DATA/dashboard.log")"
NEW="$(cat "$DATA/dashboard-token" 2>/dev/null)"
[ -n "$NEW" ] && [ "$NEW" != "$LEAKED" ] && ok "the leaked token was rotated" || fail "token not rotated (now '$NEW')"
[[ "$OUT" == *"rotated"* ]] && ok "the operator is told the token was rotated" || fail "no rotation notice: $OUT"
code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $LEAKED" "http://127.0.0.1:$PORT/api/dashboard")"
[ "$code" = "401" ] && ok "the leaked token no longer authenticates (401)" || fail "leaked token got HTTP $code"
code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $NEW" "http://127.0.0.1:$PORT/api/dashboard")"
[ "$code" = "200" ] && ok "the new token authenticates (200)" || fail "new token got HTTP $code"
grep -qF "$NEW" "$DATA/dashboard.log" && fail "the new token was written to dashboard.log" || ok "the token is NOT in dashboard.log"
grep -qF "$LEAKED" "$DATA/dashboard.log" && fail "the leaked token survived in dashboard.log" || ok "the leaked log line is gone"
grep -q "dashboard-token" "$DATA/dashboard.log" && ok "the log names the token FILE instead" || fail "log does not reference the token file: $(cat "$DATA/dashboard.log")"
[[ "$OUT" == *"?token=$NEW"* ]] && ok "gaffer dashboard still prints the login URL" || fail "no ?token= login URL: $OUT"

echo "== already up: the log stays 0600 =="
chmod 644 "$DATA/dashboard.log"
OUT="$(dash)"
[[ "$OUT" == *"already up"* ]] && [ "$(mode "$DATA/dashboard.log")" = "600" ] \
  && ok "already-up path re-tightens the log to 0600" || fail "already up: mode $(mode "$DATA/dashboard.log") out=$OUT"
[[ "$OUT" == *"?token=$NEW"* ]] && ok "already-up path prints the login URL again (?token=)" || fail "already up: no ?token= URL: $OUT"
stop_server

echo "== a fresh factory: nothing leaks from the first start =="
rm -rf "$DATA"
( umask 022; mkdir -p "$DATA" )
OUT="$(dash)"
TOK="$(cat "$DATA/dashboard-token" 2>/dev/null)"
[ -n "$TOK" ] && ok "a token was generated" || fail "no token generated: $OUT"
[ "$(mode "$DATA")" = "700" ] && [ "$(mode "$DATA/dashboard.log")" = "600" ] && [ "$(mode "$DATA/dashboard-token")" = "600" ] \
  && ok "dir 0700, log 0600, token 0600" || fail "modes: dir $(mode "$DATA") log $(mode "$DATA/dashboard.log") token $(mode "$DATA/dashboard-token")"
[ -n "$TOK" ] && ! grep -qF "$TOK" "$DATA/dashboard.log" && ok "the generated token is not in dashboard.log" || fail "token found in dashboard.log"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "dashboard-token-log: ALL $PASS checks passed"
  exit 0
fi
echo "dashboard-token-log: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
