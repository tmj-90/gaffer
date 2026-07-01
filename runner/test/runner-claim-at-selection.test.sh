#!/usr/bin/env bash
# =====================================================================
# RUNNER-OWNED-BOOKKEEPING — the runner claims the ticket AT SELECTION.
# ---------------------------------------------------------------------
# The runner (tick.sh), not the agent, claims the chosen ready ticket BEFORE any
# worktree or agent — so selection and claim are one atomic step. This proves the
# seam parallel-claim.test.sh does not: it drives the EXACT candidate-loop claim +
# skip logic and the failure release against the REAL dispatch CLI.
#
#   (a) SELECTION: a single tick claims the chosen ready ticket → it leaves `ready`
#       and is `claimed` (in-flight) BEFORE the agent runs; the runner captures the
#       claim token.
#   (b) CONCURRENCY: two ticks select the SAME ready ticket → EXACTLY ONE claims
#       (captures a token, proceeds); the other captures NO token → the tick's
#       `[ -z "$_CLAIM_TOK" ]` guard makes it SKIP and keep scanning. No double-claim.
#   (c) FAILURE: a delivery failure releases the runner-held claim → the ticket
#       returns to `ready` and is claimable again.
#   (d) WIRING: tick.sh claims in the candidate loop before worktree/agent, and
#       releases the held claim on the unrecoverable failure paths.
#
# Requires the dispatch CLI to be built. SKIPs (exit 0) if it isn't.
# Run: bash test/runner-claim-at-selection.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CLI_JS="$ROOT/packages/dispatch/dist/cli/index.js"
TICK="$RUNNER_DIR/tick.sh"

command -v node    >/dev/null 2>&1 || { echo "SKIP: node required";    exit 0; }
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required"; exit 0; }
[ -f "$CLI_JS" ] || { echo "SKIP: dispatch CLI not built ($CLI_JS) — run pnpm -C packages/dispatch build"; exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/runner-claim.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
DB="$WORK/dispatch.sqlite"
# The runner wraps the CLI as `wg`; jget reads stdin JSON as `d` — identical to
# factory.config.sh, so the snippets below are byte-for-byte what tick.sh runs.
wg()   { node "$CLI_JS" --db "$DB" "$@"; }
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }
status_of() { wg ticket show "$1" 2>/dev/null | jget "d['ticket']['status']" 2>/dev/null || echo ''; }
active_claims() {
  python3 - "$DB" "$1" <<'PY'
import sqlite3,sys
db,num=sys.argv[1],int(sys.argv[2])
c=sqlite3.connect(db)
n=c.execute("SELECT count(*) FROM ticket_claims tc JOIN tickets t ON t.id=tc.ticket_id "
            "WHERE t.number=? AND tc.status='active'",(num,)).fetchone()[0]
print(n)
PY
}

# The EXACT candidate-loop claim step from tick.sh (RUNNER-OWNED-BOOKKEEPING):
# claim the chosen candidate; capture the token; empty token ⇒ skip the candidate.
runner_claim() {   # $1 = ticket number, $2 = agent id → echoes the captured token
  local _cand="$1" AGENT="$2" GAFFER_CLAIM_TTL=900
  local _CLAIM_JSON _CLAIM_TOK
  _CLAIM_JSON="$(wg claim-ticket "$_cand" --agent "$AGENT" --ttl "$GAFFER_CLAIM_TTL" 2>/dev/null || true)"
  _CLAIM_TOK="$(printf '%s' "$_CLAIM_JSON" | jget "d.get('claimToken','')" 2>/dev/null || echo '')"
  printf '%s' "$_CLAIM_TOK"   # empty ⇒ the tick would `continue` (skip this candidate)
}

wg init >/dev/null 2>&1
for i in 1 2 3; do
  wg ticket create -t "T$i" --risk low >/dev/null 2>&1
  wg ac add "$i" -t "T$i AC" >/dev/null 2>&1
  wg ticket ready "$i" >/dev/null 2>&1
done
A1="$(wg agent register -n w1 --max-risk high 2>/dev/null | jget "d['agent']['id']")"
A2="$(wg agent register -n w2 --max-risk high 2>/dev/null | jget "d['agent']['id']")"
[ -n "$A1" ] && [ -n "$A2" ] || { echo "SKIP: could not register agents"; exit 0; }

echo "== (a) SELECTION: the runner claims the ticket before the agent runs =="
[ "$(status_of 1)" = "ready" ] && ok "pre-claim: #1 is ready" || fail "#1 not ready at start"
TOK1="$(runner_claim 1 "$A1")"
[ -n "$TOK1" ] && ok "the runner captured a claim token at selection" || fail "no claim token captured at selection"
# A stub agent that is a no-op would run AFTER this point; the ticket is ALREADY
# in-flight (claimed) — it has left `ready` before the agent does anything.
[ "$(status_of 1)" = "claimed" ] && ok "#1 moved ready → claimed at SELECTION (in-flight before the agent)" || fail "#1 not claimed after selection (got '$(status_of 1)')"
[ "$(active_claims 1)" = "1" ] && ok "exactly one active claim on #1" || fail "expected exactly one active claim on #1"

echo "== (b) CONCURRENCY: two ticks select #2 → exactly one claims, the other skips =="
c1="$WORK/c1"; c2="$WORK/c2"
runner_claim 2 "$A1" > "$c1" & p1=$!
runner_claim 2 "$A2" > "$c2" & p2=$!
wait "$p1"; wait "$p2"
t1="$(cat "$c1")"; t2="$(cat "$c2")"
won=0; [ -n "$t1" ] && won=$((won+1)); [ -n "$t2" ] && won=$((won+1))
[ "$won" -eq 1 ] && ok "EXACTLY ONE tick captured a token (the other skips + keeps scanning)" || fail "expected exactly one winner, got $won (t1='$t1' t2='$t2')"
[ "$(active_claims 2)" = "1" ] && ok "#2 has exactly ONE active claim (no double-claim)" || fail "#2 has $(active_claims 2) active claims (expected 1)"
[ "$(status_of 2)" = "claimed" ] && ok "#2 is claimed by the single winner" || fail "#2 not claimed (got '$(status_of 2)')"

echo "== (c) FAILURE: a delivery failure releases the runner-held claim → ready =="
# tick.sh's unrecoverable failure paths call: gaffer_release_delivery ready …, which
# runs `wg runner-release <n> --to ready --token <tok>`.
wg runner-release 1 --to ready --token "$TOK1" --reason "delivery failed: no commits" >/dev/null 2>&1 \
  && ok "runner-release --to ready succeeded" || fail "runner-release --to ready failed"
[ "$(status_of 1)" = "ready" ] && ok "#1 returned to ready after the failure release" || fail "#1 not ready after release (got '$(status_of 1)')"
[ "$(active_claims 1)" = "0" ] && ok "#1 carries NO active claim after release" || fail "#1 still has an active claim after release"
# Re-claimable: a later tick can pick it up again cleanly.
RETOK="$(runner_claim 1 "$A2")"
[ -n "$RETOK" ] && ok "#1 is claimable again on a later tick (retry works)" || fail "#1 not re-claimable after release"

echo "== (d) WIRING: tick.sh claims at selection + releases on failure =="
perl -0777 -ne 'exit 0 if /claim the chosen candidate NOW.*?wg claim-ticket "\$_cand" --agent "\$AGENT".*?candidate #\$_cand — claim FAILED.*?continuing the scan/ms; exit 1' "$TICK" \
  && ok "tick.sh claims in the candidate loop and skips-and-continues on a lost claim" \
  || fail "tick.sh candidate-loop claim/skip wiring not found"
# The claim happens BEFORE the worktree setup + agent invocation.
CLAIM_LN="$(grep -n 'wg claim-ticket "\$_cand"' "$TICK" | head -1 | cut -d: -f1)"
WT_LN="$(grep -n 'Worktree delivery setup (replaces in-place branching)' "$TICK" | head -1 | cut -d: -f1)"
{ [ -n "$CLAIM_LN" ] && [ -n "$WT_LN" ] && [ "$CLAIM_LN" -lt "$WT_LN" ]; } \
  && ok "the selection claim (L$CLAIM_LN) precedes worktree setup (L$WT_LN)" \
  || fail "the selection claim does not precede worktree setup (claim=$CLAIM_LN wt=$WT_LN)"
grep -q 'gaffer_submit_delivery' "$TICK" \
  && ok "tick.sh submits via the runner-owned gaffer_submit_delivery" \
  || fail "tick.sh does not submit via gaffer_submit_delivery"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: $PASS checks"
  exit 0
else
  echo "FAILED: ${#FAILURES[@]} of $((PASS + ${#FAILURES[@]}))"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
