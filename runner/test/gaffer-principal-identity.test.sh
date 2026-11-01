#!/usr/bin/env bash
# =====================================================================
# `gaffer approve` and `gaffer merge` honour GAFFER_PRINCIPAL_TOKEN (CLI IDENTITY).
# ---------------------------------------------------------------------
#   1  with the token, approve asks dispatch who it is, records the approval as the
#      principal (no --reviewer $USER is passed, the token reaches dispatch) and says so;
#   2  with the token, --reviewer is refused (the identity is the principal's);
#   3  a scope refusal from dispatch passes through, exit != 0;
#   4  with the token, merge asks dispatch whether the principal may change the ticket
#      first, and a refusal stops it before the merge lane runs;
#   5  without the token, approve still records $USER (unchanged).
# Hermetic: a fake dispatch CLI (DISPATCH_DIR) records every call and its token.
# Run: bash runner/test/gaffer-principal-identity.test.sh   (bash 3.2 safe)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
has()  { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/gaffer-principal.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
export GAFFER_DATA="$WORK/data"; mkdir -p "$GAFFER_DATA"
unset NO_COLOR GAFFER_PRINCIPAL_TOKEN

# A fake dispatch CLI. Every call is logged with the token it saw. Ticket 7 is outside
# the principal's scope: approving it, or asking --can-write for it, is SCOPE_DENIED.
FD="$WORK/fakedispatch"; mkdir -p "$FD/dist/cli"
cat > "$FD/dist/cli/index.js" <<'JS'
const a = process.argv.slice(2).filter((x, i, all) => x !== "--db" && all[i - 1] !== "--db");
const fs = require("node:fs");
const tok = process.env.GAFFER_PRINCIPAL_TOKEN || "-";
fs.appendFileSync(process.env.CALLS, `[${tok}] ${a.join(" ")}\n`);
const denied = { ok: false, code: "SCOPE_DENIED", message: "This credential is scoped to repos app; ticket #7 also touches svc." };
if (a[0] === "whoami") {
  if (a.includes("--can-write") && a[a.indexOf("--can-write") + 1] === "7") { console.error(JSON.stringify(denied)); process.exit(1); }
  console.log(JSON.stringify(tok === "-" ? { ok: true, actor: { type: "human", id: process.env.USER }, authenticated: false }
    : { ok: true, actor: { type: "human", id: "app-bot" }, authenticated: true, principal: { name: "app-bot" } }));
  process.exit(0);
}
if (a[0] === "review" && a[1] === "approve") {
  if (a[2] === "7") { console.error(JSON.stringify(denied)); process.exit(1); }
  console.log(JSON.stringify({ ok: true, status: "ready_for_merge", event: "e1", policy: {} }));
  process.exit(0);
}
process.exit(0);
JS
export CALLS="$WORK/calls"
SHA=abc123def4567890abc123def4567890abc12345
run() { RC=0; OUT="$(env DISPATCH_DIR="$FD" "$@" 2>&1 </dev/null)" || RC=$?; }

echo "== 1: approve as the principal =="
: > "$CALLS"
run GAFFER_PRINCIPAL_TOKEN=gfp_test_token bash "$RUNNER_DIR/gaffer" approve 5 --commit "demo=$SHA"
[ "$RC" -eq 0 ] && ok "exit 0" || fail "rc=$RC: $OUT"
has "$OUT" "approved ticket 5 as app-bot" && ok "names the principal it approved as" || fail "summary: $OUT"
CALL="$(grep 'review approve' "$CALLS")"
has "$CALL" "[gfp_test_token] review approve 5" && ok "the token reached dispatch's approve" || fail "approve call: $CALL"
has "$CALL" "--reviewer" && fail "passed --reviewer: $CALL" || ok "no --reviewer \$USER under a principal"

echo "== 2: --reviewer is refused under a principal =="
: > "$CALLS"
run GAFFER_PRINCIPAL_TOKEN=gfp_test_token bash "$RUNNER_DIR/gaffer" approve 5 --reviewer someone --commit "demo=$SHA"
[ "$RC" -ne 0 ] && ok "refused (rc=$RC)" || fail "accepted --reviewer: $OUT"
if grep 'review approve' "$CALLS" >/dev/null 2>&1; then fail "approve ran: $(cat "$CALLS")"; else ok "nothing approved"; fi

echo "== 3: a scope refusal passes through =="
run GAFFER_PRINCIPAL_TOKEN=gfp_test_token bash "$RUNNER_DIR/gaffer" approve 7 --commit "svc=$SHA"
[ "$RC" -ne 0 ] && ok "exit $RC" || fail "rc=0: $OUT"
has "$OUT" "SCOPE_DENIED" && ok "the refusal names SCOPE_DENIED" || fail "output: $OUT"

echo "== 4: merge checks the principal may change the ticket first =="
: > "$CALLS"
run GAFFER_PRINCIPAL_TOKEN=gfp_test_token bash "$RUNNER_DIR/gaffer" merge 7
[ "$RC" -eq 1 ] && ok "exit 1" || fail "rc=$RC: $OUT"
has "$OUT" "SCOPE_DENIED" && ok "the refusal names SCOPE_DENIED" || fail "output: $OUT"
has "$(cat "$CALLS")" "[gfp_test_token] whoami --can-write 7" && ok "asked whoami --can-write with the token" || fail "calls: $(cat "$CALLS")"

echo "== 5: without the token, approve records \$USER =="
: > "$CALLS"
run USER=tom bash "$RUNNER_DIR/gaffer" approve 5 --commit "demo=$SHA"
[ "$RC" -eq 0 ] && ok "exit 0" || fail "rc=$RC: $OUT"
has "$(grep 'review approve' "$CALLS")" "[-] review approve 5 --reviewer tom" && ok "approve as \$USER, no token" || fail "calls: $(cat "$CALLS")"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS)"; exit 0; fi
echo "FAIL (${#FAILURES[@]} failed, $PASS passed)"; exit 1
